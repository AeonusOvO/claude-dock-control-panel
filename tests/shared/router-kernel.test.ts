import { describe, expect, it } from 'vitest';
import type {
  CcSwitchInstallationState,
  ClaudeRouterManagementState,
} from '../../src/shared/contracts';
import { selectRouterKernelState } from '../../src/shared/router/kernel';

const ccr = (running: boolean): ClaudeRouterManagementState => ({
  canUninstall: true,
  checkedAt: 1,
  endpoint: 'http://127.0.0.1:3456',
  gatewayState: running ? 'running' : 'stopped',
  installed: true,
  installationKind: 'npm',
  manageable: true,
  managementAvailable: running,
  message: '',
  providers: [],
  serviceRunning: running,
});

const ccSwitch = (running: boolean): CcSwitchInstallationState => ({
  checkedAt: 1,
  installed: true,
  message: '',
  protocolRegistered: true,
  residuals: [],
  running,
  uninstallable: true,
});

describe('router kernel authority', () => {
  it('selects only a running manager as authoritative', () => {
    expect(selectRouterKernelState(ccr(false), ccSwitch(false), 10).active).toBe('none');
    expect(selectRouterKernelState(ccr(true), ccSwitch(false), 10).active).toBe('ccr');
    expect(selectRouterKernelState(ccr(false), ccSwitch(true), 10).active).toBe('cc-switch');
  });

  it('makes simultaneous ownership an explicit conflict', () => {
    const state = selectRouterKernelState(ccr(true), ccSwitch(true), 10);
    expect(state.active).toBe('ccr');
    expect(state.conflict).toBe(true);
  });
});
