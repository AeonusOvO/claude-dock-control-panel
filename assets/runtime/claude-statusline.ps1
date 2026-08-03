param(
  [Parameter(Mandatory = $true)]
  [string]$OutputPath
)

$ErrorActionPreference = 'Stop'

try {
  # Claude Code writes the payload as UTF-8. [Console]::In would decode it with the machine's
  # ANSI/OEM codepage (GBK on Chinese Windows), where a multi-byte session_name can even swallow
  # the closing quote and break the JSON — that is why resumed sessions with Chinese titles
  # produced no metrics at all. Read the raw stream and decode UTF-8 explicitly.
  $reader = New-Object System.IO.StreamReader(
    [Console]::OpenStandardInput(),
    (New-Object System.Text.UTF8Encoding($false))
  )
  try {
    $rawInput = $reader.ReadToEnd()
  } finally {
    $reader.Dispose()
  }
  $status = $rawInput | ConvertFrom-Json
  $contextSize = $status.context_window.context_window_size
  $usedPercentage = $status.context_window.used_percentage
  $contextUsed = $null

  if ($null -ne $contextSize -and $null -ne $usedPercentage) {
    $contextUsed = [Math]::Round(
      ([double]$contextSize * [double]$usedPercentage) / 100
    )
  }

  $payload = [ordered]@{
    capturedAt          = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    contextWindowSize   = $contextSize
    contextWindowUsed   = $contextUsed
    effortLevel         = $status.effort.level
    inputTokens         = $status.context_window.total_input_tokens
    linesAdded          = $status.cost.total_lines_added
    linesRemoved        = $status.cost.total_lines_removed
    modelDisplayName    = $status.model.display_name
    modelId             = $status.model.id
    outputTokens        = $status.context_window.total_output_tokens
    rateLimitFiveHour   = $status.rate_limits.five_hour.used_percentage
    rateLimitSevenDay   = $status.rate_limits.seven_day.used_percentage
    sessionCostUsd      = $status.cost.total_cost_usd
    sessionDurationMs   = $status.cost.total_duration_ms
    sessionId           = $status.session_id
    sessionName         = $status.session_name
  }

  $directory = Split-Path -Parent $OutputPath
  if (-not (Test-Path -LiteralPath $directory -PathType Container)) {
    New-Item -ItemType Directory -Path $directory -Force | Out-Null
  }

  $temporaryPath = "$OutputPath.$PID.tmp"
  $payload | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $temporaryPath -Encoding UTF8
  Move-Item -LiteralPath $temporaryPath -Destination $OutputPath -Force

  $modelName = if ($status.model.display_name) { $status.model.display_name } else { 'Claude' }
  $percentText = if ($null -ne $usedPercentage) {
    '{0:N1}%' -f [double]$usedPercentage
  } else {
    'waiting'
  }
  $costText = if ($null -ne $status.cost.total_cost_usd) {
    '${0:N4}' -f [double]$status.cost.total_cost_usd
  } else {
    '-'
  }

  Write-Output "ClaudeDock | $modelName | context $percentText | estimate $costText"
} catch {
  Write-Output 'ClaudeDock | metrics unavailable'
}
