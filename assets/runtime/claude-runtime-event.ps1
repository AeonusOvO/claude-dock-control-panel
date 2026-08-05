param(
  [Parameter(Mandatory = $true)][string]$OutputDirectory,
  [Parameter(Mandatory = $true)][string]$Event,
  [Parameter(Mandatory = $true)][string]$SessionId,
  [Parameter(Mandatory = $true)][int]$LaunchGeneration,
  [Parameter(Mandatory = $true)][int]$PtyGeneration
)

$ErrorActionPreference = 'Stop'

function Copy-SafeText([object]$Value, [int]$Limit) {
  if ($null -eq $Value) { return $null }
  $text = [string]$Value
  if ($text.Length -gt $Limit) { return $text.Substring(0, $Limit) }
  return $text
}

try {
  $hookPayload = $null
  $rawInput = [Console]::In.ReadToEnd()
  if (-not [string]::IsNullOrWhiteSpace($rawInput) -and $rawInput.Length -le 1048576) {
    $hookPayload = $rawInput | ConvertFrom-Json
  }

  $eventId = [Guid]::NewGuid().ToString('N')
  $payload = [ordered]@{
    event             = $Event
    eventId           = $eventId
    sessionId         = $SessionId
    launchGeneration  = $LaunchGeneration
    ptyGeneration     = $PtyGeneration
    signaledAt        = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  }

  if ($null -ne $hookPayload) {
    $payload.taskId = Copy-SafeText $hookPayload.task_id 160
    $payload.agentId = Copy-SafeText $hookPayload.agent_id 160
    $payload.agentType = Copy-SafeText $hookPayload.agent_type 120
    $description = $hookPayload.subject
    if ($null -eq $description) { $description = $hookPayload.description }
    $payload.description = Copy-SafeText $description 240
    $payload.failureKind = Copy-SafeText $hookPayload.error_type 80

    $backgroundTasks = @()
    foreach ($task in @($hookPayload.background_tasks)) {
      if ($backgroundTasks.Count -ge 50) { break }
      $backgroundTasks += [ordered]@{
        id          = Copy-SafeText $task.id 160
        description = Copy-SafeText $task.description 240
        kind        = Copy-SafeText $task.type 80
      }
    }
    if ($backgroundTasks.Count -gt 0) { $payload.backgroundTasks = $backgroundTasks }
  }

  if (-not (Test-Path -LiteralPath $OutputDirectory -PathType Container)) {
    New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
  }
  $finalPath = Join-Path $OutputDirectory "event-$([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())-$eventId.json"
  $temporaryPath = "$finalPath.$PID.tmp"
  $payload | ConvertTo-Json -Depth 6 -Compress | Set-Content -LiteralPath $temporaryPath -Encoding UTF8
  Move-Item -LiteralPath $temporaryPath -Destination $finalPath
} catch {
  # Activity reporting is observational and must never interrupt Claude Code.
}
