// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ClaudeLaunchAttemptRegistry } from '../../src/renderer/platform/claude-launch-attempt';
import { ClaudeLaunchPreflightDecisionController } from '../../src/renderer/platform/claude-launch-preflight-decision';
import { launchPauseDiagnostics } from '../helpers/renderer-preflight-fixture';

const installDialogSurface = (): void => {
  document.body.innerHTML = `
    <dialog id="claude-launch-preflight-dialog">
      <p id="claude-launch-preflight-summary"></p>
      <p id="claude-launch-preflight-meta"></p>
      <details id="claude-launch-preflight-details"></details>
      <ul id="claude-launch-preflight-failed-items"></ul>
      <ul id="claude-launch-preflight-reasons"></ul>
      <button id="claude-launch-preflight-bypass"></button>
      <button id="claude-launch-preflight-recheck"></button>
      <button id="claude-launch-preflight-cancel"></button>
    </dialog>`;
  HTMLDialogElement.prototype.showModal = function showModal(): void {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function close(): void {
    this.open = false;
    queueMicrotask(() => this.dispatchEvent(new Event('close')));
  };
};

describe('Claude launch preflight decision controller', () => {
  beforeEach(() => {
    installDialogSurface();
  });

  it('presents simultaneous paused launches FIFO instead of cancelling an earlier session', async () => {
    const decideClaudeLaunchPreflight = vi.fn(async () => ({ status: 'cancelled' as const }));
    Object.defineProperty(window, 'controlPanel', {
      configurable: true,
      value: { decideClaudeLaunchPreflight },
    });
    const launchAttempts = new ClaudeLaunchAttemptRegistry();
    const firstToken = launchAttempts.begin('session-1', {});
    const secondToken = launchAttempts.begin('session-2', {});
    const controller = new ClaudeLaunchPreflightDecisionController({
      launchAttempts,
      refreshLaunchControls: vi.fn(),
    });

    const first = controller.present(firstToken, {
      decisionId: 'decision-1',
      diagnostics: launchPauseDiagnostics('first decision'),
      status: 'paused',
    });
    const second = controller.present(secondToken, {
      decisionId: 'decision-2',
      diagnostics: launchPauseDiagnostics('second decision'),
      status: 'paused',
    });

    expect(document.querySelector('#claude-launch-preflight-summary')?.textContent).toBe(
      'first decision',
    );
    expect(decideClaudeLaunchPreflight).not.toHaveBeenCalled();

    document.querySelector<HTMLButtonElement>('#claude-launch-preflight-cancel')?.click();
    await expect(first).resolves.toEqual({ status: 'cancelled' });
    expect(document.querySelector('#claude-launch-preflight-summary')?.textContent).toBe(
      'second decision',
    );
    expect(document.querySelector<HTMLDialogElement>('#claude-launch-preflight-dialog')?.open).toBe(
      true,
    );

    document.querySelector<HTMLButtonElement>('#claude-launch-preflight-cancel')?.click();
    await expect(second).resolves.toEqual({ status: 'cancelled' });
    expect(decideClaudeLaunchPreflight).toHaveBeenNthCalledWith(1, {
      choice: 'cancel',
      decisionId: 'decision-1',
    });
    expect(decideClaudeLaunchPreflight).toHaveBeenNthCalledWith(2, {
      choice: 'cancel',
      decisionId: 'decision-2',
    });

    const thirdToken = launchAttempts.begin('session-3', {});
    const third = controller.present(thirdToken, {
      decisionId: 'decision-3',
      diagnostics: launchPauseDiagnostics('third decision'),
      status: 'paused',
    });
    await Promise.resolve();
    expect(document.querySelector('#claude-launch-preflight-summary')?.textContent).toBe(
      'third decision',
    );
    expect(document.querySelector<HTMLDialogElement>('#claude-launch-preflight-dialog')?.open).toBe(
      true,
    );
    expect(decideClaudeLaunchPreflight).toHaveBeenCalledTimes(2);
    document.querySelector<HTMLButtonElement>('#claude-launch-preflight-cancel')?.click();
    await expect(third).resolves.toEqual({ status: 'cancelled' });
  });
});
