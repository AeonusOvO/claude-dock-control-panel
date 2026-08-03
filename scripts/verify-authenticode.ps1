param(
  [string]$OutputDirectory = "outputs",
  [Parameter(Mandatory = $true)]
  [string]$ExpectedSubject,
  [switch]$InstallSmoke
)

$ErrorActionPreference = "Stop"
$package = Get-Content -Raw -Encoding utf8 "package.json" | ConvertFrom-Json
$version = [string]$package.version
$resolvedOutput = (Resolve-Path -LiteralPath $OutputDirectory).Path
$installerPath = Join-Path $resolvedOutput "ClaudeDock-Setup-$version-x64.exe"

function Assert-TrustedSignature {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Path
  )

  $signature = Get-AuthenticodeSignature -FilePath $Path
  if ($signature.Status -ne [System.Management.Automation.SignatureStatus]::Valid) {
    throw "Authenticode is not valid for $Path. Status: $($signature.Status)."
  }
  if (!$signature.SignerCertificate -or $signature.SignerCertificate.Subject -ne $ExpectedSubject) {
    throw "Authenticode signer for $Path does not match the approved subject."
  }
  $codeSigningEku = $signature.SignerCertificate.EnhancedKeyUsageList |
    Where-Object { $_.ObjectId.Value -eq "1.3.6.1.5.5.7.3.3" }
  if (!$codeSigningEku) {
    throw "Authenticode signer for $Path does not have the Code Signing EKU."
  }
  if (!$signature.TimeStamperCertificate) {
    throw "Authenticode timestamp is missing for $Path."
  }

  [pscustomobject]@{
    File = $Path
    Signer = $signature.SignerCertificate.Subject
    Status = [string]$signature.Status
    TimestampSubject = $signature.TimeStamperCertificate.Subject
  }
}

$results = [System.Collections.Generic.List[object]]::new()
$results.Add((Assert-TrustedSignature -Path $installerPath))

$unpackedDirectory = Join-Path $resolvedOutput "win-unpacked"
$unpackedApp = Get-ChildItem -LiteralPath $unpackedDirectory -Filter "*.exe" |
  Where-Object { $_.Name -ne "elevate.exe" } |
  Sort-Object Length -Descending |
  Select-Object -First 1
if (!$unpackedApp) {
  throw "The unpacked application executable was not found."
}
$results.Add((Assert-TrustedSignature -Path $unpackedApp.FullName))

if ($InstallSmoke) {
  $smokeRoot = Join-Path ([System.IO.Path]::GetTempPath()) "claudedock-install-smoke-$PID"
  $resolvedTemp = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
  $resolvedSmoke = [System.IO.Path]::GetFullPath($smokeRoot)
  if (!$resolvedSmoke.StartsWith($resolvedTemp, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to use an install smoke directory outside the system temp directory."
  }
  if (Test-Path -LiteralPath $resolvedSmoke) {
    throw "The install smoke directory already exists: $resolvedSmoke"
  }

  $install = Start-Process -FilePath $installerPath -ArgumentList @("/S", "/D=$resolvedSmoke") -Wait -PassThru
  if ($install.ExitCode -ne 0) {
    throw "Silent installer smoke test failed with exit code $($install.ExitCode)."
  }

  $installedApp = Get-ChildItem -LiteralPath $resolvedSmoke -Filter "*.exe" |
    Where-Object { $_.Name -notlike "Uninstall*" } |
    Sort-Object Length -Descending |
    Select-Object -First 1
  $uninstaller = Get-ChildItem -LiteralPath $resolvedSmoke -Filter "Uninstall*.exe" |
    Select-Object -First 1
  if (!$installedApp -or !$uninstaller) {
    throw "Installed application or uninstaller was not found after the smoke install."
  }
  $results.Add((Assert-TrustedSignature -Path $installedApp.FullName))
  $results.Add((Assert-TrustedSignature -Path $uninstaller.FullName))

  $uninstall = Start-Process -FilePath $uninstaller.FullName -ArgumentList "/S" -Wait -PassThru
  if ($uninstall.ExitCode -ne 0) {
    throw "Silent uninstaller smoke test failed with exit code $($uninstall.ExitCode)."
  }
  $deadline = [DateTime]::UtcNow.AddSeconds(30)
  while ((Test-Path -LiteralPath $resolvedSmoke) -and [DateTime]::UtcNow -lt $deadline) {
    Start-Sleep -Milliseconds 250
  }
  if (Test-Path -LiteralPath $resolvedSmoke) {
    throw "The silent uninstaller did not remove the smoke installation directory."
  }
}

$results | ConvertTo-Json -Depth 3
