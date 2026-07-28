param(
  [Parameter(Mandatory = $true)]
  [string]$OutputPath,

  [Parameter(Mandatory = $true)]
  [string]$Event
)

$ErrorActionPreference = 'Stop'

# Claude Code hooks feed their payload on stdin. Nothing here needs it, but the stream has to be
# drained or the CLI can block waiting for this process to consume it.
try {
  [Console]::In.ReadToEnd() | Out-Null
} catch {
  # A hook invoked without a piped stdin is fine; the event alone is the signal.
}

try {
  $payload = [ordered]@{
    event      = $Event
    signaledAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  }

  $directory = Split-Path -Parent $OutputPath
  if (-not (Test-Path -LiteralPath $directory -PathType Container)) {
    New-Item -ItemType Directory -Path $directory -Force | Out-Null
  }

  $temporaryPath = "$OutputPath.$PID.tmp"
  $payload | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $temporaryPath -Encoding UTF8
  Move-Item -LiteralPath $temporaryPath -Destination $OutputPath -Force
} catch {
  # A missed signal only costs the caller its timeout; it must never break the conversation.
}
