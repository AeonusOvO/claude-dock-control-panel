import type { ArtifactCreateResult } from '../shared/contracts';

export interface ArtifactThemePayload {
  appearance: 'dark' | 'light';
  variables: Record<string, string>;
}

export interface ArtifactControllerOptions {
  create: (html: string) => Promise<ArtifactCreateResult>;
  destroy: (artifactId: string) => Promise<boolean>;
  getTheme: () => ArtifactThemePayload;
  onActiveChange: (artifactIds: string[]) => void;
  onError: (message: string) => void;
}

interface ActiveArtifact {
  frame: HTMLIFrameElement;
  mount: HTMLElement;
  stop: () => void;
}

interface PendingArtifactRun {
  artifactId?: string;
  cancelled: boolean;
  mount: HTMLElement;
  settle: () => void;
  settled: Promise<void>;
}

interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: Record<string, unknown>;
}

const MIN_ARTIFACT_HEIGHT = 240;
const MAX_ARTIFACT_HEIGHT = 1_200;
const MAX_MESSAGE_LENGTH = 64 * 1024;
const ARTIFACT_ID_PATTERN = /^artifact-[0-9a-f-]{36}$/;

class ArtifactRunCancelledError extends Error {
  public constructor() {
    super('Artifact mount was removed before creation completed.');
    this.name = 'ArtifactRunCancelledError';
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const parseNotification = (value: unknown): JsonRpcNotification | undefined => {
  if (!isRecord(value) || value.jsonrpc !== '2.0' || typeof value.method !== 'string') {
    return undefined;
  }
  try {
    if (JSON.stringify(value).length > MAX_MESSAGE_LENGTH) {
      return undefined;
    }
  } catch {
    return undefined;
  }
  return {
    jsonrpc: '2.0',
    method: value.method,
    params: isRecord(value.params) ? value.params : undefined,
  };
};

const clampHeight = (value: unknown): number | undefined => {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return undefined;
  }
  return Math.min(MAX_ARTIFACT_HEIGHT, Math.max(MIN_ARTIFACT_HEIGHT, Math.ceil(value)));
};

export class ArtifactController {
  private readonly active = new Map<string, ActiveArtifact>();
  private readonly pending = new Set<PendingArtifactRun>();
  private readonly pendingByMount = new Map<HTMLElement, PendingArtifactRun>();
  private readonly mountObserver: MutationObserver;
  private disposed = false;

  public constructor(private readonly options: ArtifactControllerOptions) {
    window.addEventListener('message', this.onMessage);
    this.mountObserver = new MutationObserver(this.cleanupDisconnected);
    this.mountObserver.observe(document.documentElement, { childList: true, subtree: true });
  }

  public async run(html: string, mount: HTMLElement): Promise<string> {
    if (this.disposed) {
      throw new Error('Artifact controller has already been disposed.');
    }

    const previousRun = this.pendingByMount.get(mount);
    if (previousRun) {
      previousRun.cancelled = true;
    }
    const existingIds = [...this.active.entries()]
      .filter(([, artifact]) => artifact.mount === mount)
      .map(([artifactId]) => artifactId);
    // stopInternal removes the active entry and iframe synchronously before its first await. Do not
    // await destruction here: the pending token must be registered before run() yields, otherwise a
    // same-tick forceCleanup could miss this new create entirely.
    for (const artifactId of existingIds) {
      void this.stopInternal(artifactId, false);
    }

    if (!mount.isConnected) {
      throw new ArtifactRunCancelledError();
    }

    mount.replaceChildren();
    mount.dataset.state = 'loading';
    const loading = document.createElement('div');
    loading.className = 'artifact-view__loading';
    loading.textContent = '正在准备隔离的可视化环境…';
    mount.append(loading);

    let settle!: () => void;
    const pending: PendingArtifactRun = {
      cancelled: false,
      mount,
      settle: () => settle(),
      settled: new Promise<void>((resolve) => {
        settle = resolve;
      }),
    };
    this.pending.add(pending);
    this.pendingByMount.set(mount, pending);

    let destroyAttempted = false;
    let mounted = false;
    const destroyCreatedRecord = async (): Promise<void> => {
      if (!pending.artifactId || destroyAttempted) {
        return;
      }
      destroyAttempted = true;
      await this.options.destroy(pending.artifactId);
    };

    try {
      const record = await this.options.create(html);
      if (!ARTIFACT_ID_PATTERN.test(record.artifactId)) {
        throw new Error('主进程返回了无效的 Artifact 标识。');
      }
      pending.artifactId = record.artifactId;
      if (record.url !== `claudedock-artifact://${record.artifactId}/index.html`) {
        throw new Error('主进程返回了无效的 Artifact 隔离地址。');
      }
      if (
        pending.cancelled ||
        this.disposed ||
        !mount.isConnected ||
        this.pendingByMount.get(mount) !== pending
      ) {
        await destroyCreatedRecord();
        throw new ArtifactRunCancelledError();
      }

      const frame = document.createElement('iframe');
      frame.className = 'artifact-view__frame';
      frame.dataset.artifactId = record.artifactId;
      frame.referrerPolicy = 'no-referrer';
      frame.sandbox.add('allow-scripts');
      frame.src = record.url;
      frame.title = '模型生成的交互式可视化';

      const stopButton = document.createElement('button');
      stopButton.className = 'artifact-view__stop';
      stopButton.type = 'button';
      stopButton.textContent = '停止运行';
      const toolbar = document.createElement('div');
      toolbar.className = 'artifact-view__toolbar';
      const status = document.createElement('span');
      status.textContent = '隔离运行中';
      toolbar.append(status, stopButton);

      const stop = (): void => {
        void this.stop(record.artifactId);
      };
      stopButton.addEventListener('click', stop);
      mount.replaceChildren(toolbar, frame);
      mount.dataset.state = 'running';
      this.active.set(record.artifactId, { frame, mount, stop });
      mounted = true;
      this.options.onActiveChange(this.activeIds());
      frame.addEventListener(
        'load',
        () => {
          this.postTheme(record.artifactId);
        },
        { once: true },
      );
      return record.artifactId;
    } catch (error) {
      if (!mounted) {
        await destroyCreatedRecord();
      }
      if (error instanceof ArtifactRunCancelledError) {
        throw error;
      }
      const message = error instanceof Error ? error.message : '无法运行此可视化。';
      if (mount.isConnected && this.pendingByMount.get(mount) === pending) {
        mount.dataset.state = 'error';
        const failure = document.createElement('p');
        failure.className = 'artifact-view__error';
        failure.textContent = message;
        mount.replaceChildren(failure);
      }
      this.options.onError(message);
      throw error;
    } finally {
      this.pending.delete(pending);
      if (this.pendingByMount.get(mount) === pending) {
        this.pendingByMount.delete(mount);
      }
      pending.settle();
    }
  }

  public async stop(artifactId: string): Promise<void> {
    await this.stopInternal(artifactId, true);
  }

  public stopAll(): void {
    void this.forceCleanup();
  }

  /**
   * Cancels in-flight creates as well as mounted frames and waits until every create that was
   * already sent to the main process has either failed or destroyed its returned record.
   */
  public async forceCleanup(): Promise<void> {
    const pending = [...this.pending];
    for (const run of pending) {
      run.cancelled = true;
    }
    const stops = [...this.active.keys()].map((artifactId) => this.stopInternal(artifactId, false));
    await Promise.all([...stops, ...pending.map((run) => run.settled)]);
  }

  public async dispose(): Promise<void> {
    this.disposed = true;
    this.mountObserver.disconnect();
    window.removeEventListener('message', this.onMessage);
    await this.forceCleanup();
  }

  public updateTheme(): void {
    for (const artifactId of this.active.keys()) {
      this.postTheme(artifactId);
    }
  }

  public activeIds(): string[] {
    return [...this.active.keys()];
  }

  private async stopInternal(artifactId: string, renderStopped: boolean): Promise<void> {
    const active = this.active.get(artifactId);
    if (!active) {
      return;
    }
    this.active.delete(artifactId);
    this.options.onActiveChange(this.activeIds());
    active.frame.src = 'about:blank';
    active.frame.remove();
    if (renderStopped && active.mount.isConnected) {
      active.mount.dataset.state = 'stopped';
      const stopped = document.createElement('div');
      stopped.className = 'artifact-view__stopped';
      stopped.textContent = '可视化已停止。再次点击“运行此可视化”可重新创建隔离环境。';
      active.mount.replaceChildren(stopped);
    }
    try {
      await this.options.destroy(artifactId);
    } catch {
      this.options.onError('可视化已在界面停止，但主进程清理状态失败。');
    }
  }

  private readonly cleanupDisconnected = (): void => {
    for (const pending of this.pending) {
      if (!pending.mount.isConnected) {
        pending.cancelled = true;
      }
    }
    for (const [artifactId, artifact] of this.active) {
      if (!artifact.mount.isConnected) {
        void this.stopInternal(artifactId, false);
      }
    }
  };

  private readonly onMessage = (event: MessageEvent<unknown>): void => {
    const matched = [...this.active.entries()].find(
      ([, artifact]) => event.source === artifact.frame.contentWindow,
    );
    if (!matched) {
      return;
    }
    const [artifactId, artifact] = matched;
    const notification = parseNotification(event.data);
    if (!notification) {
      return;
    }
    if (notification.method === 'artifact/ready') {
      this.postTheme(artifactId);
      const height = clampHeight(notification.params?.height);
      if (height) {
        artifact.frame.style.height = `${height}px`;
      }
      return;
    }
    if (notification.method === 'artifact/resize') {
      const height = clampHeight(notification.params?.height);
      if (height) {
        artifact.frame.style.height = `${height}px`;
      }
    }
  };

  private postTheme(artifactId: string): void {
    const artifact = this.active.get(artifactId);
    if (!artifact?.frame.contentWindow) {
      return;
    }
    const theme = this.options.getTheme();
    artifact.frame.contentWindow.postMessage(
      {
        jsonrpc: '2.0',
        method: 'claudedock/theme',
        params: {
          appearance: theme.appearance,
          variables: theme.variables,
        },
      } satisfies JsonRpcNotification,
      '*',
    );
  }
}
