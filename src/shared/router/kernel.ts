import type {
  CcSwitchInstallationState,
  ClaudeRouterManagementState,
  RouterKernelId,
  RouterKernelState,
} from '../contracts';

/**
 * Chooses one authoritative router kernel from observable process state. CCR wins the active label
 * when both are running, while `conflict` stays explicit so the UI never pretends the overlap is
 * safe. Installed-but-stopped managers do not take ownership of Claude Code configuration.
 */
export const selectRouterKernelState = (
  ccr: ClaudeRouterManagementState,
  ccSwitch: CcSwitchInstallationState,
  checkedAt = Date.now(),
): RouterKernelState => {
  const ccrActive = ccr.gatewayState === 'running' || ccr.serviceRunning;
  const active: RouterKernelId = ccrActive ? 'ccr' : ccSwitch.running ? 'cc-switch' : 'none';
  return {
    active,
    ccSwitch,
    checkedAt,
    conflict: ccrActive && ccSwitch.running,
    ccr,
  };
};
