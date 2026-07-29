import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { WindowsCommandInvocation } from './windows-command';
import { resolveWindowsCommandInvocation } from './windows-command';

type JsonRecord = Record<string, unknown>;

interface PendingRequest {
  reject: (error: Error) => void;
  resolve: (value: unknown) => void;
  timer: NodeJS.Timeout;
}

export interface CodexAppServerNotification {
  method: string;
  params?: JsonRecord;
}

export type CodexAppServerNotificationListener = (notification: CodexAppServerNotification) => void;

type InvocationResolver = () => Promise<WindowsCommandInvocation>;

const MAX_LINE_BYTES = 8 * 1024 * 1024;
const MAX_ERROR_TEXT = 1_000;
const REQUEST_TIMEOUT_MS = 20_000;

const isRecord = (value: unknown): value is JsonRecord =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const safeErrorMessage = (value: unknown): string => {
  if (!isRecord(value)) {
    return 'Codex App Server 返回了未知错误。';
  }
  const message = typeof value.message === 'string' ? value.message : 'Codex App Server 请求失败。';
  return message.slice(0, MAX_ERROR_TEXT);
};

/**
 * Minimal, version-tolerant JSONL client for Codex App Server. It deliberately exposes only
 * request/notification primitives: higher layers own the allow-list of methods and sanitize every
 * account value before it reaches the renderer.
 */
export class CodexAppServerClient {
  private child: ChildProcessWithoutNullStreams | undefined;
  private nextRequestId = 1;
  private readonly listeners = new Set<CodexAppServerNotificationListener>();
  private readonly pending = new Map<number, PendingRequest>();
  private startPromise: Promise<void> | undefined;
  private stdoutBuffer = '';
  private stderrBuffer = '';
  private stopping = false;

  public constructor(
    private readonly resolveInvocation: InvocationResolver = () =>
      resolveWindowsCommandInvocation('codex'),
  ) {}

  public onNotification(listener: CodexAppServerNotificationListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  public async request<T>(method: string, params: JsonRecord = {}): Promise<T> {
    await this.ensureStarted();
    return this.requestOnActiveConnection<T>(method, params);
  }

  public stop(): void {
    this.stopping = true;
    const child = this.child;
    this.child = undefined;
    this.startPromise = undefined;
    this.stdoutBuffer = '';
    if (child && !child.killed) {
      child.kill();
    }
    this.rejectPending(new Error('Codex App Server 已停止。'));
    this.stopping = false;
  }

  private ensureStarted(): Promise<void> {
    if (this.startPromise) {
      return this.startPromise;
    }
    if (this.child && !this.child.killed) {
      return Promise.resolve();
    }
    this.startPromise = this.start();
    return this.startPromise;
  }

  private async start(): Promise<void> {
    const invocation = await this.resolveInvocation();
    const environment: NodeJS.ProcessEnv = { ...process.env };
    delete environment.ELECTRON_RUN_AS_NODE;
    const child = spawn(
      invocation.executable,
      [...invocation.argumentsPrefix, 'app-server', '--listen', 'stdio://'],
      {
        env: environment,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      },
    );
    this.child = child;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      this.consumeStdout(chunk);
    });
    child.stderr.on('data', (chunk: string) => {
      this.stderrBuffer = `${this.stderrBuffer}${chunk}`.slice(-4_000);
    });
    child.once('error', (error) => {
      this.handleExit(error);
    });
    child.once('close', (code, signal) => {
      if (!this.stopping && this.child === child) {
        const detail = this.stderrBuffer.trim().slice(-MAX_ERROR_TEXT);
        this.handleExit(
          new Error(detail || `Codex App Server 已退出（${code ?? signal ?? '未知状态'}）。`),
        );
      }
    });

    try {
      await this.requestOnActiveConnection('initialize', {
        clientInfo: {
          name: 'claudedock',
          title: 'ClaudeDock',
          version: '2.1',
        },
      });
      this.send({ method: 'initialized', params: {} });
    } catch (error) {
      this.stop();
      throw error;
    }
  }

  private requestOnActiveConnection<T>(method: string, params: JsonRecord): Promise<T> {
    const id = this.nextRequestId;
    this.nextRequestId = this.nextRequestId >= Number.MAX_SAFE_INTEGER ? 1 : this.nextRequestId + 1;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex App Server 请求 ${method} 超时。`));
      }, REQUEST_TIMEOUT_MS);
      timer.unref();
      this.pending.set(id, {
        reject,
        resolve: (value) => resolve(value as T),
        timer,
      });
      try {
        this.send({ id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  private send(message: JsonRecord): void {
    if (!this.child?.stdin.writable) {
      throw new Error('Codex App Server 尚未连接。');
    }
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private consumeStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    if (Buffer.byteLength(this.stdoutBuffer, 'utf8') > MAX_LINE_BYTES) {
      this.failConnection(new Error('Codex App Server 单条响应超过安全上限。'));
      return;
    }
    let newline = this.stdoutBuffer.indexOf('\n');
    while (newline >= 0) {
      const line = this.stdoutBuffer.slice(0, newline).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (line) {
        this.handleLine(line);
      }
      newline = this.stdoutBuffer.indexOf('\n');
    }
  }

  private handleLine(line: string): void {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      this.failConnection(new Error('Codex App Server 返回了无法解析的消息。'));
      return;
    }
    if (!isRecord(message)) {
      return;
    }
    if (typeof message.id === 'number') {
      const pending = this.pending.get(message.id);
      if (pending && ('result' in message || 'error' in message)) {
        clearTimeout(pending.timer);
        this.pending.delete(message.id);
        if ('error' in message && message.error !== undefined) {
          pending.reject(new Error(safeErrorMessage(message.error)));
        } else {
          pending.resolve(message.result);
        }
        return;
      }
      if (typeof message.method === 'string') {
        this.send({
          error: { code: -32601, message: 'ClaudeDock does not support this server request.' },
          id: message.id,
        });
      }
      return;
    }
    if (typeof message.method === 'string') {
      const notification: CodexAppServerNotification = {
        method: message.method,
        params: isRecord(message.params) ? message.params : undefined,
      };
      for (const listener of this.listeners) {
        try {
          listener(notification);
        } catch {
          // A renderer-state listener must not take down the account transport.
        }
      }
    }
  }

  private failConnection(error: Error): void {
    const child = this.child;
    this.handleExit(error);
    if (child && !child.killed) {
      child.kill();
    }
  }

  private handleExit(error: Error): void {
    this.child = undefined;
    this.startPromise = undefined;
    this.rejectPending(error);
  }

  private rejectPending(error: Error): void {
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
  }
}
