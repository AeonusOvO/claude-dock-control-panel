param(
  [Parameter(Mandatory = $true)][string]$PipeName,
  [Parameter(Mandatory = $true)][string]$Token,
  [Parameter(Mandatory = $true)][string]$SessionId,
  [Parameter(Mandatory = $true)][int]$LaunchGeneration
)

$ErrorActionPreference = 'Stop'
$pipe = $null
$reader = $null
$writer = $null

try {
  $rawInput = [Console]::In.ReadToEnd()
  if ([string]::IsNullOrWhiteSpace($rawInput) -or $rawInput.Length -gt 1048576) { exit 0 }
  $hookPayload = $rawInput | ConvertFrom-Json
  $toolName = [string]$hookPayload.tool_name
  if ([string]::IsNullOrWhiteSpace($toolName)) { $toolName = 'Claude tool' }
  if ($toolName.Length -gt 120) { $toolName = $toolName.Substring(0, 120) }

  $suggestions = @()
  foreach ($suggestion in @($hookPayload.permission_suggestions)) {
    if ($suggestions.Count -ge 20) { break }
    $suggestions += $suggestion
  }

  $payload = [ordered]@{
    token = $Token
    sessionId = $SessionId
    launchGeneration = $LaunchGeneration
    toolName = $toolName
    suggestions = $suggestions
  } | ConvertTo-Json -Depth 12 -Compress

  $pipe = [System.IO.Pipes.NamedPipeClientStream]::new(
    '.',
    $PipeName,
    [System.IO.Pipes.PipeDirection]::InOut,
    [System.IO.Pipes.PipeOptions]::Asynchronous
  )
  $pipe.Connect(10000)
  $pipe.ReadMode = [System.IO.Pipes.PipeTransmissionMode]::Byte
  $reader = [System.IO.StreamReader]::new($pipe, [System.Text.UTF8Encoding]::new($false))
  $writer = [System.IO.StreamWriter]::new($pipe, [System.Text.UTF8Encoding]::new($false))
  $writer.AutoFlush = $true
  $writer.WriteLine($payload)

  $readTask = $reader.ReadLineAsync()
  if (-not $readTask.Wait([TimeSpan]::FromSeconds(600))) { exit 0 }
  $response = $readTask.Result
  if (-not [string]::IsNullOrWhiteSpace($response) -and $response.Length -le 65536) {
    [Console]::Out.WriteLine($response)
  }
} catch {
  # No response means Claude Code falls back to its native permission prompt. Never auto-allow.
} finally {
  if ($null -ne $writer) { $writer.Dispose() }
  if ($null -ne $reader) { $reader.Dispose() }
  if ($null -ne $pipe) { $pipe.Dispose() }
}
