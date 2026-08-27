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

const PROCESS_LABELS: Readonly<Record<string, string>> = {
  application: 'Electron 应用',
  'claude-cli': 'Claude CLI',
  'codex-cli': 'Codex CLI',
  'network-diagnostics': '网络诊断进程',
  'oauth-browser': 'OAuth 浏览器',
  renderer: 'Renderer',
  terminal: '终端进程',
};

const PROBE_KIND_LABELS = {
  api: 'API',
  dns: 'DNS',
  https: 'HTTPS',
  oauth: 'OAuth',
  path: '路径',
  tls: 'TLS',
  version: '版本',
  websocket: 'WebSocket',
} as const;

const ACTION_LABELS = {
  background: '后台无额度预检',
  'cli-launch': 'CLI 启动预检',
  'cloud-task': '云端任务预检',
  'first-request': '首次请求预检',
  login: '登录预检',
  'provider-switch': '提供商切换预检',
} as const;

const formatCheckedAt = (checkedAt: number): string =>
  new Intl.DateTimeFormat('zh-CN', {
    dateStyle: 'short',
    timeStyle: 'medium',
  }).format(checkedAt);

/**
 * Dedicated renderer owner for a paused Claude launch. It keeps only display-safe diagnostics, the
 * opaque decision ID, and the exact renderer launch token; no generic preflight event can settle it.
 */
export class ClaudeLaunchPreflightDecisionController {
  private readonly bypassButton = requiredElement<HTMLButtonElement>(
    '#claude-launch-preflight-bypass',
  );
  private readonly decisionDialog = requiredElement<HTMLDialogElement>(
    '#claude-launch-preflight-dialog',
  );
  private readonly details = requiredElement<HTMLDetailsElement>(
    '#claude-launch-preflight-details',
  );
  private disposed = false;
  private readonly failedItems = requiredElement<HTMLUListElement>(
    '#claude-launch-preflight-failed-items',
  );
  private readonly meta = requiredElement<HTMLElement>('#claude-launch-preflight-meta');
  private pending: PendingLaunchDecision | undefined;
  private pendingInternalCloseEvents = 0;
  private readonly waiting: PendingLaunchDecision[] = [];
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
      if (this.pendingInternalCloseEvents > 0) {
        this.pendingInternalCloseEvents -= 1;
      } else if (this.pending && !this.pending.inProgress) {
        void this.decide('cancel');
      }
    });
  }

  public present(
    token: ClaudeLaunchAttemptToken,
    paused: PausedClaudeLaunch,
  ): Promise<ClaudeLaunchDecisionSettlement> {
    if (this.disposed || !this.dependencies.launchAttempts.isCurrent(token)) {
      return Promise.resolve({ status: 'stale' });
    }
    return new Promise((resolve) => {
      const pending: PendingLaunchDecision = {
        decisionId: paused.decisionId,
        diagnostics: paused.diagnostics,
        inProgress: false,
        resolve,
        settled: false,
        token: { ...token },
      };
      if (this.pending) {
        this.waiting.push(pending);
      } else {
        this.activate(pending);
      }
    });
  }

  /** Cancels only decisions whose session/PTY disappeared; a foreground switch is presentation-only. */
  public reconcileWorkspace(workspace: WorkspaceState): void {
    const pending = this.pending;
    if (pending && !this.decisionIsCurrent(pending, workspace)) {
      if (!pending.inProgress) {
        void this.decide('cancel');
      } else {
        void window.controlPanel.decideClaudeLaunchPreflight({
          choice: 'cancel',
          decisionId: pending.decisionId,
        });
        this.releasePending(pending, { status: 'stale' }, true);
      }
    }
    for (const queued of [...this.waiting]) {
      if (!this.decisionIsCurrent(queued, workspace)) this.cancelWaiting(queued);
    }
  }

  public dispose(): void {
    this.disposed = true;
    const pending = this.pending;
    if (pending) {
      void window.controlPanel.decideClaudeLaunchPreflight({
        choice: 'cancel',
        decisionId: pending.decisionId,
      });
      this.releasePending(pending, { status: 'stale' }, true);
    }
    for (const queued of [...this.waiting]) this.cancelWaiting(queued);
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
    pending.resolve(outcome);
    if (!this.activateNext()) this.closeDialog();
  }

  private activate(pending: PendingLaunchDecision): void {
    this.pending = pending;
    this.render(pending.diagnostics);
    this.setBusy(false);
    if (!this.decisionDialog.open) this.decisionDialog.showModal();
    this.recheckButton.focus();
  }

  private activateNext(): boolean {
    if (this.disposed) return false;
    const next = this.waiting.shift();
    if (!next) return false;
    this.activate(next);
    return true;
  }

  private cancelWaiting(pending: PendingLaunchDecision): void {
    const index = this.waiting.indexOf(pending);
    if (index < 0 || pending.settled) return;
    this.waiting.splice(index, 1);
    pending.settled = true;
    void window.controlPanel.decideClaudeLaunchPreflight({
      choice: 'cancel',
      decisionId: pending.decisionId,
    });
    this.dependencies.launchAttempts.cancel(pending.token);
    this.dependencies.refreshLaunchControls(pending.token.sessionId);
    pending.resolve({ status: 'stale' });
  }

  private decisionIsCurrent(pending: PendingLaunchDecision, workspace: WorkspaceState): boolean {
    return (
      workspace.sessions.some(({ id }) => id === pending.token.sessionId) &&
      this.dependencies.launchAttempts.isCurrent(pending.token)
    );
  }

  private closeDialog(): void {
    if (!this.decisionDialog.open) return;
    this.pendingInternalCloseEvents += 1;
    this.decisionDialog.close();
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
    const scope = diagnostics.scope === 'conversation' ? '会话网络会话' : '应用网络会话';
    const disposition =
      diagnostics.status === 'blocked'
        ? '当前网络检查阻止了这次启动。你可以取消、重新检查，或仅为这一次继续连接。'
        : '当前网络检查发现异常。你可以先查看详情，再决定如何处理这一次启动。';
    const freshness = diagnostics.freshness === 'fresh' ? '当前缓存有效' : '未知';
    this.meta.textContent = `${diagnostics.providerLabel}（${diagnostics.provider}） · ${ACTION_LABELS[diagnostics.action]} · ${scope} · 采集时间：${formatCheckedAt(diagnostics.checkedAt)} · 新鲜度：${freshness}。${disposition}`;
    this.failedItems.replaceChildren(
      ...diagnostics.failedItems.map((item) => {
        const row = document.createElement('li');
        row.dataset.status = item.status;
        row.textContent = `${item.status === 'failed' ? '失败' : '警告'} · ${item.label} · 方法：${PROBE_KIND_LABELS[item.kind]} · 进程：${PROCESS_LABELS[item.process] ?? item.process} · ${item.required ? '必需提供商证据' : '可选证据'}${item.target ? ` · 目标：${item.target}` : ''} · 采集时间：${formatCheckedAt(item.checkedAt)} · ${item.detail}`;
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
