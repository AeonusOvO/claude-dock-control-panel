import { vi } from 'vitest';
import type { ConversationSnapshot } from '../../src/shared/conversation/native';
import type {
  ClaudeProjectState,
  TerminalStatus,
  WorkspaceState,
} from '../../src/shared/contracts';

export const terminalStatus = (
  ptyGeneration = 1,
  overrides: Partial<TerminalStatus> = {},
): TerminalStatus => ({
  cwd: 'D:\\Project',
  id: 'session-1',
  phase: 'running',
  ptyGeneration,
  shell: 'powershell.exe',
  title: 'Project',
  ...overrides,
});

export const terminalWorkspace = (status: TerminalStatus = terminalStatus()): WorkspaceState => ({
  activeSessionId: status.id,
  projects: [
    {
      lastActiveAt: 1,
      missing: false,
      name: 'Project',
      open: true,
      path: status.cwd,
      remembered: true,
      sessionIds: [status.id],
    },
  ],
  sessions: [status],
});

export const claudeProjectState = (
  overrides: Partial<ClaudeProjectState> = {},
): ClaudeProjectState => ({
  active: false,
  allowBypassPermissions: true,
  config: {
    apiKeyHelperPolicy: 'inherit',
    authMode: 'existing',
    baseUrl: '',
    credentialConfigured: false,
    model: 'default',
    preset: 'anthropic',
    protocol: 'anthropic',
    provider: 'anthropic',
  },
  cwd: 'D:\\Project',
  installation: {
    installationKind: 'native',
    installed: true,
    message: 'Claude Code 已就绪。',
    security: 'ready',
    version: 'test',
  },
  sessionId: 'session-1',
  speed: {
    availability: 'available',
    canSelectFast: true,
    detail: '可切换 Claude Fast。',
    mechanism: 'claude-native-fast',
    model: 'claude-sonnet-5',
    preference: 'standard',
    status: 'standard',
  },
  stateRevision: 1,
  ...overrides,
});

export const nativeSnapshot = (
  overrides: Partial<ConversationSnapshot> = {},
): ConversationSnapshot => ({
  capabilities: {
    attachments: { image: true },
    effort: {
      applied: 'high',
      options: ['low', 'high', 'ultracode'],
      requested: 'high',
      supportsUltraWorkflow: true,
    },
    evidence: 'runtime',
    fast: { mechanism: 'service-tier', state: 'off' },
    model: 'claude-sonnet-5',
    models: [
      {
        attachments: { image: true },
        effortOptions: ['low', 'high', 'ultracode'],
        id: 'claude-sonnet-5',
        label: 'Claude Sonnet 5',
        supportsFast: true,
        supportsUltraWorkflow: true,
      },
    ],
    permissionModes: ['default', 'acceptEdits', 'bypassPermissions', 'dontAsk'],
    profileKey: 'test-profile',
    revision: 1,
    runtime: 'claude',
    verifiedAt: 1,
  },
  commands: [],
  conversationId: 'conversation-1',
  interactions: [],
  messages: [],
  ownerKind: 'native',
  phase: 'idle',
  projectPath: 'D:\\Project',
  revision: 1,
  runtime: 'claude',
  sequence: 1,
  tasks: [],
  usage: {},
  ...overrides,
});

export interface FakeTerminalControl {
  readonly fitAddons: FakeFitAddon[];
  readonly terminals: FakeTerminal[];
  acknowledgeNextWrite: (terminal?: FakeTerminal) => void;
  autoAcknowledgeWrites: boolean;
  proposedDimensions?: { cols: number; rows: number };
  uninstall: () => void;
}

export class FakeFitAddon {
  public constructor(private readonly control: FakeTerminalControl) {}

  public proposeDimensions(): { cols: number; rows: number } | undefined {
    return this.control.proposedDimensions;
  }
}

export class FakeTerminal {
  public readonly buffer = {
    active: {
      baseY: 0,
      getLine: (row: number) => {
        const value = this.screen[row];
        return value === undefined ? undefined : { translateToString: () => value };
      },
      length: 0,
    },
  };
  public bracketedPasteMode = false;
  public cols = 80;
  public readonly customKeyHandlers: Array<(event: KeyboardEvent) => boolean> = [];
  public disposed = false;
  public focused = false;
  public readonly loadedAddons: unknown[] = [];
  public options: Record<string, unknown>;
  public readonly pasteCalls: string[] = [];
  public readonly pendingWriteCallbacks: Array<() => void> = [];
  public resized: Array<{ cols: number; rows: number }> = [];
  public rows = 24;
  public selection = '';
  public readonly unicode = { activeVersion: '' };
  public readonly writes: string[] = [];
  private readonly dataListeners = new Set<(data: string) => void>();
  private screen: string[] = [];

  public constructor(
    options: Record<string, unknown>,
    private readonly control: FakeTerminalControl,
  ) {
    this.options = options;
    this.cols = typeof options.cols === 'number' ? options.cols : 80;
    this.rows = typeof options.rows === 'number' ? options.rows : 24;
  }

  public attachCustomKeyEventHandler(listener: (event: KeyboardEvent) => boolean): void {
    this.customKeyHandlers.push(listener);
  }

  public clear(): void {
    this.screen = [];
    this.buffer.active.length = 0;
  }

  public dispose(): void {
    this.disposed = true;
    this.customKeyHandlers.length = 0;
    this.dataListeners.clear();
  }

  public emitData(data: string): void {
    for (const listener of this.dataListeners) listener(data);
  }

  public focus(): void {
    this.focused = true;
  }

  public getSelection(): string {
    return this.selection;
  }

  public hasSelection(): boolean {
    return this.selection.length > 0;
  }

  public loadAddon(addon: unknown): void {
    this.loadedAddons.push(addon);
  }

  public onData(listener: (data: string) => void): { dispose: () => void } {
    this.dataListeners.add(listener);
    return { dispose: () => this.dataListeners.delete(listener) };
  }

  public open(container: HTMLElement): void {
    Object.defineProperty(container, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({
        bottom: 480,
        height: 480,
        left: 0,
        right: 800,
        toJSON: () => ({}),
        top: 0,
        width: 800,
        x: 0,
        y: 0,
      }),
    });
  }

  public paste(data: string): void {
    this.pasteCalls.push(data);
    const normalized = data.replace(/\r?\n/g, '\r');
    const escape = String.fromCharCode(27);
    this.emitData(
      this.bracketedPasteMode ? `${escape}[200~${normalized}${escape}[201~` : normalized,
    );
  }

  public refresh(): void {}

  public resize(cols: number, rows: number): void {
    this.cols = cols;
    this.rows = rows;
    this.resized.push({ cols, rows });
  }

  public selectAll(): void {}

  public setScreen(lines: readonly string[]): void {
    this.screen = [...lines];
    this.buffer.active.length = this.screen.length;
  }

  public write(data: string, callback?: () => void): void {
    this.writes.push(data);
    if (!callback) return;
    if (this.control.autoAcknowledgeWrites) callback();
    else this.pendingWriteCallbacks.push(callback);
  }
}

export const installFakeTerminalModules = (): FakeTerminalControl => {
  const terminals: FakeTerminal[] = [];
  const fitAddons: FakeFitAddon[] = [];
  const control: FakeTerminalControl = {
    acknowledgeNextWrite: (terminal = terminals[0]) => terminal?.pendingWriteCallbacks.shift()?.(),
    autoAcknowledgeWrites: true,
    fitAddons,
    proposedDimensions: { cols: 100, rows: 30 },
    terminals,
    uninstall: () => {
      vi.doUnmock('@xterm/addon-fit');
      vi.doUnmock('@xterm/addon-unicode11');
      vi.doUnmock('@xterm/addon-webgl');
      vi.doUnmock('@xterm/xterm');
      vi.resetModules();
    },
  };

  vi.doMock('@xterm/xterm', () => ({
    Terminal: class extends FakeTerminal {
      public constructor(options: Record<string, unknown>) {
        super(options, control);
        terminals.push(this);
      }
    },
  }));
  vi.doMock('@xterm/addon-fit', () => ({
    FitAddon: class extends FakeFitAddon {
      public constructor() {
        super(control);
        fitAddons.push(this);
      }
    },
  }));
  vi.doMock('@xterm/addon-unicode11', () => ({ Unicode11Addon: class {} }));
  vi.doMock('@xterm/addon-webgl', () => ({
    WebglAddon: class {
      public dispose(): void {}
      public onContextLoss(): void {}
    },
  }));

  return control;
};
