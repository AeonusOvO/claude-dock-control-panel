import { randomUUID } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type {
  ClaudeMetrics,
  ModelTokenUsage,
  ModelUsageSnapshot,
  ResourceUsageView,
} from '../../shared/contracts';
import { DEFAULT_TERMINAL_THEME, type TerminalThemeId } from '../../shared/ui/terminal-themes';
import { claudeProjectDirectoryName, isValidClaudeSessionId } from '../claude/session-manager';
import type { ModelUsageConnection } from './identity';
import { TranscriptUsageClient, type TranscriptUsageReply } from './transcript-client';
import { emptyTokens } from './transcript-reader';

interface UsageJournal {
  version: 1;
  connectionId?: string;
  epoch: string;
  connectedAt: number;
  sources: Record<string, ModelTokenUsage>;
}

export interface ModelUsageServiceOptions {
  userDataPath: string;
  projectsRoot: string;
  onChanged: (snapshot: ModelUsageSnapshot) => void;
  readChatGptQuota: () => Promise<ResourceUsageView | undefined>;
  themeId?: TerminalThemeId;
}

const validTokens = (value: unknown): value is ModelTokenUsage =>
  !!value &&
  typeof value === 'object' &&
  ['input', 'output', 'cacheRead', 'cacheCreation'].every((key) => {
    const number = (value as Record<string, unknown>)[key];
    return typeof number === 'number' && Number.isSafeInteger(number) && number >= 0;
  });

export class ModelUsageService {
  private connection?: ModelUsageConnection;
  private journal: UsageJournal = {
    version: 1,
    epoch: randomUUID(),
    connectedAt: Date.now(),
    sources: {},
  };
  private readonly journalPath: string;
  private readonly transcripts: TranscriptUsageClient;
  private revision = 0;
  private floating = false;
  private themeId: TerminalThemeId;
  private status: ModelUsageSnapshot['status'] = 'unavailable';
  private detail = '尚未接入模型';
  private windows?: ModelUsageSnapshot['windows'];
  private updatedAt?: number;
  private partial = false;
  private persistTimer?: NodeJS.Timeout;
  private quotaTimer: NodeJS.Timeout;
  private quotaInFlight = false;
  private writes = Promise.resolve();
  private closed = false;

  public constructor(private readonly options: ModelUsageServiceOptions) {
    this.journalPath = path.join(options.userDataPath, 'model-usage.json');
    this.themeId = options.themeId ?? DEFAULT_TERMINAL_THEME;
    // One bounded startup read, never performed from the polling or terminal-output paths.
    try {
      if (statSync(this.journalPath).size <= 1024 * 1024) {
        const saved = JSON.parse(readFileSync(this.journalPath, 'utf8')) as UsageJournal;
        if (
          saved.version === 1 &&
          typeof saved.epoch === 'string' &&
          typeof saved.connectionId === 'string' &&
          Number.isFinite(saved.connectedAt) &&
          saved.connectedAt <= Date.now() &&
          saved.sources &&
          Object.entries(saved.sources).every(
            ([key, value]) => /^[a-f0-9]{64}$/.test(key) && validTokens(value),
          )
        )
          this.journal = saved;
      }
    } catch {
      /* First launch, or a damaged journal: start a clearly new observation period. */
    }
    this.transcripts = new TranscriptUsageClient(options.projectsRoot, (reply) =>
      this.consumeTranscriptReply(reply),
    );
    this.quotaTimer = setInterval(() => {
      void this.refreshQuota();
    }, 60_000);
    this.quotaTimer.unref();
  }

  public select(connection: ModelUsageConnection | undefined, reset = false): void {
    if (this.closed) return;
    const changed = connection?.id !== this.connection?.id;
    this.connection = connection;
    if (reset || connection?.id !== this.journal.connectionId) {
      this.transcripts.reset();
      this.journal = {
        version: 1,
        connectionId: connection?.id,
        epoch: randomUUID(),
        connectedAt: Date.now(),
        sources: {},
      };
      this.persist();
    }
    if (changed || reset) {
      this.windows = undefined;
      this.updatedAt = undefined;
      this.partial = false;
      this.status = connection?.mode === 'api' ? 'available' : 'unavailable';
      this.detail = !connection
        ? '尚未接入模型'
        : connection.mode === 'api'
          ? Object.keys(this.journal.sources).length
            ? '本次接入后 · 含输入、输出与缓存 Token'
            : '本次接入后 · 等待用量上报'
          : '当前平台尚未提供可读取的额度';
    }
    this.publish();
    if (changed || reset) void this.refreshQuota();
  }

  public getSnapshot(): ModelUsageSnapshot {
    const tokens = emptyTokens();
    for (const source of Object.values(this.journal.sources)) {
      for (const field of Object.keys(tokens) as (keyof ModelTokenUsage)[])
        tokens[field] += source[field];
    }
    return {
      revision: this.revision,
      mode: this.connection?.mode ?? 'none',
      status: this.status,
      preset: this.connection?.preset,
      model: this.connection?.model,
      connectedAt: this.connection ? this.journal.connectedAt : undefined,
      updatedAt: this.updatedAt,
      tokens: this.connection?.mode === 'api' ? tokens : undefined,
      windows: this.windows?.map((window) => ({ ...window })),
      detail: this.detail,
      floating: this.floating,
      themeId: this.themeId,
    };
  }

  public setFloating(visible: boolean): void {
    this.floating = visible;
    this.publish();
  }
  public setTheme(themeId: TerminalThemeId): void {
    this.themeId = themeId;
    this.publish();
  }
  public capture(connection: ModelUsageConnection): ModelUsageConnection {
    return {
      ...connection,
      epoch: connection.id === this.connection?.id ? this.journal.epoch : undefined,
    };
  }

  /** Signals from already-owned launches, not from the selected tab or uncommitted form input. */
  public observe(
    connection: ModelUsageConnection | undefined,
    cwd: string,
    sessionId: string | undefined,
    metrics?: ClaudeMetrics,
  ): void {
    if (!connection || connection.id !== this.connection?.id || this.closed) return;
    if (connection.mode === 'api') {
      if (!sessionId || !isValidClaudeSessionId(sessionId)) return;
      this.transcripts.schedule({
        epoch: this.journal.epoch,
        since: this.journal.connectedAt,
        file: path.join(
          this.options.projectsRoot,
          claudeProjectDirectoryName(cwd),
          `${sessionId.toLowerCase()}.jsonl`,
        ),
      });
    } else if (
      connection.preset === 'anthropic' &&
      connection.epoch === this.journal.epoch &&
      metrics &&
      metrics.capturedAt >= this.journal.connectedAt
    ) {
      const windows = [
        {
          label: '5 小时',
          usedPercent: metrics.rateLimitFiveHour,
          resetsAt: metrics.rateLimitFiveHourResetsAt,
        },
        {
          label: '7 天',
          usedPercent: metrics.rateLimitSevenDay,
          resetsAt: metrics.rateLimitSevenDayResetsAt,
        },
      ];
      this.applyQuota({
        availability: 'available',
        capabilities: { balance: false, context: false, windows: true },
        checkedAt: metrics.capturedAt,
        source: 'claude-statusline',
        windows,
      });
    }
  }

  private consumeTranscriptReply(reply: TranscriptUsageReply): void {
    if (this.closed || this.connection?.mode !== 'api' || reply.epoch !== this.journal.epoch)
      return;
    if (reply.unavailable) {
      this.status = Object.keys(this.journal.sources).length ? 'stale' : 'unavailable';
      this.detail = '暂时无法读取用量记录；已记录的 Token 会保留';
    } else {
      for (const result of reply.results ?? []) {
        if (result.epoch !== this.journal.epoch || !result.available || !validTokens(result.tokens))
          continue;
        const previous = this.journal.sources[result.source] ?? emptyTokens();
        for (const field of Object.keys(previous) as (keyof ModelTokenUsage)[])
          previous[field] = Math.max(previous[field], result.tokens[field]);
        this.journal.sources[result.source] = previous;
        this.partial ||= result.partial;
      }
      this.updatedAt = Date.now();
      this.status = 'available';
      this.detail = this.partial
        ? '已记录 Token · 部分记录无法解析'
        : '本次接入后 · 含输入、输出与缓存 Token';
      this.persist();
    }
    this.publish();
  }

  private applyQuota(resource: ResourceUsageView | undefined): void {
    const windows = resource?.windows?.filter(
      (window) => typeof window.usedPercent === 'number' && Number.isFinite(window.usedPercent),
    );
    if (!windows?.length) {
      this.status = this.windows?.length ? 'stale' : 'unavailable';
      this.detail = this.windows?.length
        ? '额度暂未更新，显示上次结果'
        : '当前平台尚未提供可读取的额度';
    } else {
      this.windows = windows.slice(0, 2).map((window) => ({
        label: window.label,
        remainingPercent: Math.max(0, Math.min(100, 100 - window.usedPercent!)),
        resetsAt: window.resetsAt,
      }));
      this.updatedAt = resource!.checkedAt;
      this.status = resource!.availability === 'stale' ? 'stale' : 'available';
      this.detail = '平台上报的剩余额度 · 非上下文占用';
    }
    this.publish();
  }

  private async refreshQuota(): Promise<void> {
    if (this.closed || this.quotaInFlight || this.connection?.preset !== 'chatgpt-subscription') {
      if (
        this.windows &&
        this.updatedAt &&
        Date.now() - this.updatedAt > 5 * 60_000 &&
        this.status !== 'stale'
      ) {
        this.status = 'stale';
        this.detail = '额度暂未更新，显示上次结果';
        this.publish();
      }
      return;
    }
    const epoch = this.journal.epoch;
    this.quotaInFlight = true;
    try {
      const resource = await this.options.readChatGptQuota();
      if (!this.closed && epoch === this.journal.epoch) this.applyQuota(resource);
    } catch {
      if (!this.closed && epoch === this.journal.epoch) this.applyQuota(undefined);
    } finally {
      this.quotaInFlight = false;
    }
  }

  private publish(): void {
    if (!this.closed) {
      this.revision += 1;
      this.options.onChanged(this.getSnapshot());
    }
  }
  private persist(): void {
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = undefined;
      this.flush();
    }, 5_000);
    this.persistTimer.unref();
  }
  private flush(): void {
    const serialized = JSON.stringify(this.journal);
    this.writes = this.writes
      .then(async () => {
        await mkdir(path.dirname(this.journalPath), { recursive: true });
        await writeFile(`${this.journalPath}.tmp`, serialized, 'utf8');
        await rename(`${this.journalPath}.tmp`, this.journalPath);
      })
      .catch(() => {
        /* Usage storage must never interrupt a conversation. */
      });
  }
  public dispose(): void {
    this.closed = true;
    clearInterval(this.quotaTimer);
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.flush();
    this.transcripts.dispose();
  }
}
