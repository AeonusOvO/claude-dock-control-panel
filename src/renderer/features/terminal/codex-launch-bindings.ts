import { requiredElement } from '../../platform/dom';
import type { CodexLaunchActions } from './codex-launch-actions';
import type { CodexLaunchAccountActions } from './codex-launch-account';
import type { CodexLaunchDeps } from './codex-launch-dependencies';

const codexPrimaryAction = requiredElement<HTMLButtonElement>('#codex-primary-action');
const codexInstallButton = requiredElement<HTMLButtonElement>('#codex-install');
const codexLoginButton = requiredElement<HTMLButtonElement>('#codex-login');
const codexDeviceCode = requiredElement<HTMLElement>('#codex-device-code');
const codexDeviceLoginAction = requiredElement<HTMLButtonElement>('#codex-device-login-action');
const codexCancelLogin = requiredElement<HTMLButtonElement>('#codex-cancel-login');
const codexCopyDeviceCode = requiredElement<HTMLButtonElement>('#codex-copy-device-code');
const codexLogout = requiredElement<HTMLButtonElement>('#codex-logout');
const codexLaunchNew = requiredElement<HTMLButtonElement>('#codex-launch-new');
const codexLaunchContinue = requiredElement<HTMLButtonElement>('#codex-launch-continue');
const codexLaunchResume = requiredElement<HTMLButtonElement>('#codex-launch-resume');
const runClaudeButton = requiredElement<HTMLButtonElement>('#run-claude');

export const bindCodexLaunchControls = (
  deps: CodexLaunchDeps,
  actions: CodexLaunchActions,
  accountActions: CodexLaunchAccountActions,
): void => {
  const { activeDevelopmentRuntime, showToast, terminalFeature } = deps;

  runClaudeButton.addEventListener('click', () => {
    if (activeDevelopmentRuntime() === 'codex') {
      void actions.prepareAndLaunchCodex();
    } else {
      void terminalFeature.launchClaudeTerminal('new');
    }
  });
  codexPrimaryAction.addEventListener('click', () => {
    void actions.prepareAndLaunchCodex();
  });
  codexInstallButton.addEventListener('click', () => {
    void actions.installOrUpdateCodex();
  });
  codexLoginButton.addEventListener('click', () => {
    void actions.startCodexLogin('browser', false);
  });
  codexDeviceLoginAction.addEventListener('click', () => {
    void actions.startCodexLogin('device-code', true);
  });
  codexCancelLogin.addEventListener('click', () => {
    accountActions.cancelCodexLogin();
  });
  codexLogout.addEventListener('click', () => {
    accountActions.logoutCodex();
  });
  codexCopyDeviceCode.addEventListener('click', () => {
    const code = codexDeviceCode.textContent?.trim();
    if (!code || code === '—') {
      return;
    }
    void window.controlPanel.writeClipboardText(code).then((copied) => {
      showToast(
        copied ? '设备验证码已复制。' : '无法复制设备验证码。',
        copied ? 'success' : 'error',
      );
    });
  });
  codexLaunchNew.addEventListener('click', () => {
    void actions.launchCodex('new');
  });
  codexLaunchContinue.addEventListener('click', () => {
    void actions.launchCodex('continue');
  });
  codexLaunchResume.addEventListener('click', () => {
    void actions.launchCodex('resume');
  });
};
