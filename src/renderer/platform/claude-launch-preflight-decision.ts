import type {
  ClaudeLaunchOutcome,
  ClaudeLaunchPreflightDecisionOutcome,
  ClaudeLaunchPauseDiagnostics,
  WorkspaceState,
} from '../../shared/contracts';
import type {
  ClaudeLaunchAttemptRegistry,
  ClaudeLaunchAttemptToken,
} from './claude-launch-attempt';

type ClaudeLaunchDecisionSettlement = Exclude<
  ClaudeLaunchPreflightDecisionOutcome,
  { status: 'paused' }
>;

type PausedClaudeLaunch = Extract<ClaudeLaunchOutcome, { status: 'paused' }>;

interface PendingLaunchDecision {
  decisionId: string;
  diagnostics: ClaudeLaunchPauseDiagnostics;
  inProgress: boolean;
  resolve: (outcome: ClaudeLaunchDecisionSettlement) => void;
  settled: boolean;
  token: ClaudeLaunchAttemptToken;
}

export interface ClaudeLaunchPreflightDecisionControllerDependencies {
  readonly launchAttempts: ClaudeLaunchAttemptRegistry;
  readonly refreshLaunchControls: (sessionId: string) => void;
}

const requiredElement = <T extends HTMLElement>(selector: string): T => {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing required element: ${selector}`);
  return element;
};

/**
 * Dedicated renderer owner for a paused Claude launch. It keeps only display-safe diagnostics, the
 * opaque decision ID, and the exact renderer launch token; no generic preflight event can settle it.
 */
export class ClaudeLaunchPreflightDecisionController {
  private readonly bypassButton = requiredElement<HTMLButtonElement>(
    '#claude-launch-preflight-bypass',
  );
  private closingInternally = false;
  private readonly decisionDialog = requiredElement<HTMLDialogElement>(
    '#claude-launch-preflight-dialog',
  );
  private readonly details = requiredElement<HTMLDetailsElement>(
    '#claude-launch-preflight-details',
  );
  private readonly failedItems = requiredElement<HTMLUListElement>(
    '#claude-launch-preflight-failed-items',
  );
  private readonly meta = requiredElement<HTMLElement>('#claude-launch-preflight-meta');
  private pending: PendingLaunchDecision | undefined;
  private readonly reasons = requiredElement<HTMLUListElement>('#claude-launch-preflight-reasons');
  private readonly recheckButton = requiredElement<HTMLButtonElement>(
    '#claude-launch-preflight-recheck',
  );
  private readonly cancelButton = requiredElement<HTMLButtonElement>(
    '#claude-launch-preflight-cancel',
  );
  private readonly summary = requiredElement<HTMLElement>('#claude-launch-preflight-summary');

  public constructor(
    private readonly dependencies: ClaudeLaunchPreflightDecisionControllerDependencies,
  ) {
    this.bypassButton.addEventListener('click', () => {
      void this.decide('bypass');
    });
    this.cancelButton.addEventListener('click', () => {
      void this.decide('cancel');
    });
    this.recheckButton.addEventListener('click', () => {
      void this.decide('recheck');
    });
    this.decisionDialog.addEventListener('cancel', (event) => {
      event.preventDefault();
      void this.decide('cancel');
    });
    this.decisionDialog.addEventListener('click', (event) => {
      if (event.target === this.decisionDialog) void this.decide('cancel');
    });
    this.decisionDialog.addEventListener('close', () => {
      if (!this.closingInternally && this.pending && !this.pending.inProgress) {
        void this.decide('cancel');
      }
    });
  }

  public present(
    token: ClaudeLaunchAttemptToken,
    paused: PausedClaudeLaunch,
  ): Promise<ClaudeLaunchDecisionSettlement> {
    if (!this.dependencies.launchAttempts.isCurrent(token)) {
      return Promise.resolve({ status: 'stale' });
    }
    this.supersedePending();
    return new Promise((resolve) => {
      this.pending = {
        decisionId: paused.decisionId,
        diagnostics: paused.diagnostics,
        inProgress: false,
        resolve,
        settled: false,
        token: { ...token },
      };
      this.render(paused.diagnostics);
      this.setBusy(false);
      if (!this.decisionDialog.open) this.decisionDialog.showModal();
      this.recheckButton.focus();
    });
  }

  /** Cancels a dialog after a project/session/PTY reconciliation makes its exact token stale. */
  public reconcileWorkspace(workspace: WorkspaceState): void {
    const pending = this.pending;
    if (!pending) return;
    const session = workspace.sessions.find(({ id }) => id === pending.token.sessionId);
    if (
      workspace.activeSessionId === pending.token.sessionId &&
      session &&
      this.dependencies.launchAttempts.isCurrent(pending.token)
    ) {
      return;
    }
    if (!pending.inProgress) {
      void this.decide('cancel');
      return;
    }
    void window.controlPanel.decideClaudeLaunchPreflight({
      choice: 'cancel',
      decisionId: pending.decisionId,
    });
    this.releasePending(pending, { status: 'stale' }, true);
  }

  public dispose(): void {
    const pending = this.pending;
    if (!pending) return;
    void window.controlPanel.decideClaudeLaunchPreflight({
      choice: 'cancel',
      decisionId: pending.decisionId,
    });
    this.releasePending(pending, { status: 'stale' }, true);
  }

  private async decide(choice: 'bypass' | 'cancel' | 'recheck'): Promise<void> {
    const pending = this.pending;
    if (!pending || pending.inProgress || pending.settled) return;
    if (choice !== 'cancel' && !this.dependencies.launchAttempts.isCurrent(pending.token)) {
      this.releasePending(pending, { status: 'stale' }, false);
      return;
    }
    pending.inProgress = true;
    this.setBusy(true);
    try {
      const outcome = await window.controlPanel.decideClaudeLaunchPreflight({
        choice,
        decisionId: pending.decisionId,
      });
      if (this.pending !== pending || pending.settled) return;
      if (!this.dependencies.launchAttempts.isCurrent(pending.token)) {
        this.releasePending(pending, { status: 'stale' }, false);
        return;
      }
      if (outcome.status === 'paused') {
        pending.decisionId = outcome.decisionId;
        pending.diagnostics = outcome.diagnostics;
        pending.inProgress = false;
        this.render(outcome.diagnostics);
        this.setBusy(false);
        this.recheckButton.focus();
        return;
      }
      this.releasePending(pending, outcome, outcome.status !== 'completed');
    } catch {
      if (this.pending === pending && !pending.settled) {
        this.releasePending(pending, { status: 'stale' }, true);
      }
    }
  }

  private releasePending(
    pending: PendingLaunchDecision,
    outcome: ClaudeLaunchDecisionSettlement,
    releaseToken: boolean,
  ): void {
    if (this.pending !== pending || pending.settled) return;
    pending.settled = true;
    this.pending = undefined;
    if (releaseToken) {
      this.dependencies.launchAttempts.cancel(pending.token);
      this.dependencies.refreshLaunchControls(pending.token.sessionId);
    }
    this.closeDialog();
    pending.resolve(outcome);
  }

  private supersedePending(): void {
    const pending = this.pending;
    if (!pending) return;
    void window.controlPanel.decideClaudeLaunchPreflight({
      choice: 'cancel',
      decisionId: pending.decisionId,
    });
    this.releasePending(pending, { status: 'stale' }, true);
  }

  private closeDialog(): void {
    if (!this.decisionDialog.open) return;
    this.closingInternally = true;
    this.decisionDialog.close();
    this.closingInternally = false;
  }

  private setBusy(busy: boolean): void {
    for (const button of [this.bypassButton, this.cancelButton, this.recheckButton]) {
      button.disabled = busy;
      button.setAttribute('aria-busy', String(busy));
    }
    this.decisionDialog.dataset.busy = String(busy);
  }

  private render(diagnostics: ClaudeLaunchPauseDiagnostics): void {
    this.summary.textContent = diagnostics.summary;
    this.meta.textContent =
      diagnostics.status === 'blocked'
        ? '当前网络检查阻止了这次启动。你可以取消、重新检查，或仅为这一次继续连接。'
        : '当前网络检查发现异常。你可以先查看详情，再决定如何处理这一次启动。';
    this.failedItems.replaceChildren(
      ...diagnostics.failedItems.map((item) => {
        const row = document.createElement('li');
        row.dataset.status = item.status;
        row.textContent = item.label;
        return row;
      }),
    );
    this.reasons.replaceChildren(
      ...diagnostics.reasons.map((reason) => {
        const row = document.createElement('li');
        row.textContent = reason;
        return row;
      }),
    );
    this.details.open = false;
  }
}
