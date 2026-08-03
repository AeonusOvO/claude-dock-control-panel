param(
  [Parameter(Mandatory = $true)]
  [string]$OutputPath,

  [Parameter(Mandatory = $true)]
  [string]$Event
)

$ErrorActionPreference = 'Stop'

# Claude Code hooks feed their payload on stdin. Stop signals are only useful for the main thread:
# a search subagent finishing must not restore the parent's effort while the parent is still working.
$hookPayload = $null
try {
  $rawInput = [Console]::In.ReadToEnd()
  if (-not [string]::IsNullOrWhiteSpace($rawInput)) {
    $hookPayload = $rawInput | ConvertFrom-Json
  }
} catch {
  # A hook invoked without valid piped input is fine; non-Stop events only need the event name.
}

if ($Event -eq 'Stop' -and $null -ne $hookPayload.agent_id) {
  exit 0
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
