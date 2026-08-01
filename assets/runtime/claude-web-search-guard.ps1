param(
  [Parameter(Mandatory = $true)]
  [string]$AllowedAgent
)

$ErrorActionPreference = 'Stop'

try {
  $rawInput = [Console]::In.ReadToEnd()
  $payload = $rawInput | ConvertFrom-Json
} catch {
  # A malformed hook payload must not make all web access unusable. The launch prompt remains the
  # primary routing rule, and the runtime compatibility fallback still handles an upstream 400.
  exit 0
}

if ($payload.agent_type -eq $AllowedAgent) {
  exit 0
}

[Console]::Error.WriteLine(
  "ClaudeDock keeps web research at high effort in the $AllowedAgent subagent. " +
  "Delegate this same research task with the Agent tool using subagent_type '$AllowedAgent' " +
  'instead of calling WebSearch or WebFetch in the main conversation. Keep the main effort unchanged.'
)
exit 2
