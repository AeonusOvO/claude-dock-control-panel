import { existsSync } from 'node:fs';
import path from 'node:path';
import { resolveWindowsCommand } from '../infra/windows-command';

export interface SdkQuery extends AsyncIterable<unknown> {
  applyFlagSettings(settings: Record<string, unknown>): Promise<void>;
  close(): void;
  initializationResult(): Promise<unknown>;
  /** Reconnect the SDK control stream after a recoverable transport gap. */
  reinitialize?: () => Promise<unknown>;
  interrupt(): Promise<unknown>;
  setModel(model?: string): Promise<void>;
  setPermissionMode(mode: string): Promise<void>;
  stopTask(taskId: string): Promise<void>;
  supportedCommands(): Promise<unknown[]>;
}

export type SdkQueryFactory = (input: {
  options: Record<string, unknown>;
  prompt: AsyncIterable<unknown>;
}) => SdkQuery;

type ClaudeAgentEnvironmentOverrides = Record<string, null | string | undefined>;

export const buildClaudeAgentProcessEnvironment = (
  inherited: NodeJS.ProcessEnv,
  overrides: ClaudeAgentEnvironmentOverrides,
): NodeJS.ProcessEnv => {
  const environment: NodeJS.ProcessEnv = { ...inherited };
  for (const [name, value] of Object.entries(overrides)) {
    const normalizedName = name.toLowerCase();
    for (const existingName of Object.keys(environment)) {
      if (existingName.toLowerCase() === normalizedName) delete environment[existingName];
    }
    if (value !== null && value !== undefined) environment[name] = value;
  }
  return environment;
};

export class AsyncInputQueue implements AsyncIterable<unknown> {
  private closed = false;
  private readonly pending: Array<(result: IteratorResult<unknown>) => void> = [];
  private readonly values: unknown[] = [];

  public push(value: unknown): void {
    if (this.closed) throw new Error('原生会话输入通道已关闭。');
    const resolve = this.pending.shift();
    if (resolve) resolve({ done: false, value });
    else this.values.push(value);
  }

  public close(): void {
    this.closed = true;
    for (const resolve of this.pending.splice(0)) resolve({ done: true, value: undefined });
  }

  public [Symbol.asyncIterator](): AsyncIterator<unknown> {
    return {
      next: async () => {
        const value = this.values.shift();
        if (value !== undefined) return { done: false, value };
        if (this.closed) return { done: true, value: undefined };
        return new Promise<IteratorResult<unknown>>((resolve) => this.pending.push(resolve));
      },
    };
  }
}

export const defaultQueryFactory = async (): Promise<SdkQueryFactory> => {
  const sdk = await import('@anthropic-ai/claude-agent-sdk');
  return sdk.query as unknown as SdkQueryFactory;
};

export const claudeAgentExecutableFromCommand = (
  resolvedCommand: string,
  fileExists: (candidate: string) => boolean = existsSync,
): string => {
  const basename = path.basename(resolvedCommand).toLowerCase();
  if (basename === 'claude.exe') return resolvedCommand;
  if (!['claude', 'claude.cmd', 'claude.ps1'].includes(basename)) {
    throw new Error('本机 Claude Code 命令不是受支持的 Windows 启动器。');
  }
  const npmExecutable = path.join(
    path.dirname(resolvedCommand),
    'node_modules',
    '@anthropic-ai',
    'claude-code',
    'bin',
    'claude.exe',
  );
  if (!fileExists(npmExecutable)) {
    throw new Error(
      '已找到 NPM 的 Claude Code 启动器，但没有找到它安装的 claude.exe。请在“任务与下载”中重新安装 Claude Code。',
    );
  }
  return npmExecutable;
};

export const defaultResolveExecutable = async (
  cwd: string,
  environment: NodeJS.ProcessEnv,
): Promise<string> => {
  if (process.platform !== 'win32') {
    throw new Error('ClaudeDock 目前只在 Windows 上提供原生 Claude 会话。');
  }
  // NPM exposes `claude.ps1`/`claude.cmd` on PATH while the native executable lives inside the
  // installed package. Resolve that user-owned executable explicitly so the Agent SDK uses the
  // same Claude Code installation without bundling or silently falling back to a second copy.
  return claudeAgentExecutableFromCommand(await resolveWindowsCommand('claude', environment, cwd));
};
