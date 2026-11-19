import {
  appendFileSync,
  closeSync,
  existsSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  unlinkSync,
} from 'node:fs';
import type { Dirent } from 'node:fs';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { normalizeProjectPath } from '../infra/directory';
import type { ClaudeSessionMetadata } from '../../shared/contracts';

const DEFAULT_CLAUDE_PROJECTS_DIRECTORY = path.join(homedir(), '.claude', 'projects');
const MAX_JSONL_SIZE = 50 * 1024 * 1024;
const CLAUDE_SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const optionalFiniteNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

const optionalNonEmptyString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined;

const timestampMilliseconds = (value: unknown): number | undefined => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 10_000_000_000 ? value : value * 1000;
  }
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
};

export const isValidClaudeSessionId = (value: string): boolean => CLAUDE_SESSION_ID.test(value);

export const claudeProjectDirectoryName = (cwd: string): string =>
  path.resolve(cwd).replace(/[:\\/]/g, '-');

export const normalizeClaudeSessionTitle = (value: string): string => {
  const normalized = value.trim();
  const hasControlCharacter = [...normalized].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 31 || codePoint === 127;
  });
  if (!normalized || normalized.length > 60 || hasControlCharacter) {
    throw new Error('对话名称需为 1-60 个字符，且不能包含控制字符。');
  }
  return normalized;
};

// Some older Claude transcripts only identify their project in the per-session index.
const indexOwners = (raw: string): Map<string, string> => {
  const owners = new Map<string, string>();
  const index = JSON.parse(raw) as { entries?: unknown };
  if (Array.isArray(index?.entries)) {
    for (const item of index.entries) {
      if (
        typeof item?.sessionId === 'string' &&
        typeof item.projectPath === 'string' &&
        path.isAbsolute(item.projectPath)
      )
        owners.set(item.sessionId.toLowerCase(), item.projectPath);
    }
  }
  return owners;
};

const readIndexOwners = (directory: string): Map<string, string> => {
  try {
    return indexOwners(readFileSync(path.join(directory, 'sessions-index.json'), 'utf8'));
  } catch {
    return new Map();
  }
};

const readIndexOwnersAsync = async (directory: string): Promise<Map<string, string>> => {
  try {
    return indexOwners(await readFile(path.join(directory, 'sessions-index.json'), 'utf8'));
  } catch {
    return new Map();
  }
};

function* transcriptMetadata(
  contents: string,
  conversationId: string,
  cwd: string,
  mtimeMs: number,
  indexedOwner?: string,
): Generator<void, ClaudeSessionMetadata | null> {
  let origin: string | undefined;
  let sessionId: string | undefined;
  let aiTitle: string | undefined;
  let customTitle: string | undefined;
  let sessionName: string | undefined;
  let slug: string | undefined;
  let modelId: string | undefined;
  let inputTokens = 0;
  let outputTokens = 0;
  let estimatedCostUsd: number | undefined;
  let messageCount = 0;
  let lastActiveAt = 0;

  for (const [index, line] of contents.split('\n').entries()) {
    if (index > 0 && index % 256 === 0) yield;
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      if (
        !origin &&
        typeof parsed.cwd === 'string' &&
        path.isAbsolute(parsed.cwd) &&
        parsed.isSidechain !== true
      ) {
        origin = parsed.cwd;
      }
      sessionId ??=
        optionalNonEmptyString(parsed.sessionId) ?? optionalNonEmptyString(parsed.session_id);
      slug ??= optionalNonEmptyString(parsed.slug);
      sessionName ??= optionalNonEmptyString(parsed.sessionName);
      if (parsed.type === 'ai-title') {
        aiTitle = optionalNonEmptyString(parsed.aiTitle) ?? aiTitle;
      }
      if (parsed.type === 'custom-title') {
        customTitle = optionalNonEmptyString(parsed.customTitle) ?? customTitle;
      }

      const message =
        parsed.message && typeof parsed.message === 'object'
          ? (parsed.message as Record<string, unknown>)
          : undefined;
      const recordRole = optionalNonEmptyString(parsed.type) ?? optionalNonEmptyString(parsed.role);
      const messageRole = optionalNonEmptyString(message?.role);
      if (
        recordRole === 'user' ||
        recordRole === 'assistant' ||
        messageRole === 'user' ||
        messageRole === 'assistant'
      ) {
        messageCount += 1;
      }

      modelId ??= optionalNonEmptyString(message?.model) ?? optionalNonEmptyString(parsed.model);

      const usageCandidate = message?.usage ?? parsed.usage;
      if (usageCandidate && typeof usageCandidate === 'object') {
        const usage = usageCandidate as Record<string, unknown>;
        inputTokens += optionalFiniteNumber(usage.input_tokens) ?? 0;
        outputTokens += optionalFiniteNumber(usage.output_tokens) ?? 0;
      }

      estimatedCostUsd ??=
        optionalFiniteNumber(parsed.estimatedCostUsd) ??
        optionalFiniteNumber(parsed.total_cost_usd) ??
        optionalFiniteNumber(parsed.cost);

      const timestamp = timestampMilliseconds(parsed.timestamp);
      if (timestamp !== undefined && timestamp > lastActiveAt) {
        lastActiveAt = timestamp;
      }
    } catch {
      // Claude Code can append while this file is being read; ignore incomplete lines.
    }
  }
  const owner = origin ?? indexedOwner;
  if (!owner || normalizeProjectPath(owner) !== normalizeProjectPath(cwd)) return null;
  const normalizedSessionId =
    sessionId && isValidClaudeSessionId(sessionId) ? sessionId : conversationId;
  return {
    conversationId,
    estimatedCostUsd,
    inputTokens: inputTokens > 0 ? inputTokens : undefined,
    lastActiveAt: Math.floor(lastActiveAt || mtimeMs),
    messageCount,
    modelId,
    outputTokens: outputTokens > 0 ? outputTokens : undefined,
    sessionId: normalizedSessionId,
    sessionName: customTitle ?? aiTitle ?? sessionName ?? slug,
  };
}

export class ClaudeSessionManager {
  public constructor(private readonly projectsDirectory = DEFAULT_CLAUDE_PROJECTS_DIRECTORY) {}

  public getSessionsForProject(cwd: string): ClaudeSessionMetadata[] {
    const projectDirectory = this.projectDirectory(cwd);
    if (!existsSync(projectDirectory)) {
      return [];
    }

    const owners = readIndexOwners(projectDirectory);
    const sessions: ClaudeSessionMetadata[] = [];
    try {
      for (const entry of readdirSync(projectDirectory, { withFileTypes: true })) {
        if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== '.jsonl') {
          continue;
        }

        const conversationId = path.basename(entry.name, path.extname(entry.name));
        if (!isValidClaudeSessionId(conversationId)) {
          continue;
        }

        try {
          const metadata = this.extractSessionMetadata(
            path.join(projectDirectory, entry.name),
            conversationId,
            cwd,
            owners,
          );
          if (metadata) {
            sessions.push(metadata);
          }
        } catch {
          // A malformed or concurrently-written transcript must not break the history list.
        }
      }
    } catch {
      return [];
    }

    return sessions.sort((left, right) => right.lastActiveAt - left.lastActiveAt);
  }

  /**
   * Interactive history reads stay off the Electron main-process hot path. File I/O is async and
   * parsing yields between bounded batches, so a large JSONL archive cannot freeze window events,
   * terminal IPC, or other session launches while its sidebar index is being rebuilt.
   */
  public async getSessionsForProjectAsync(cwd: string): Promise<ClaudeSessionMetadata[]> {
    const projectDirectory = this.projectDirectory(cwd);
    let entries: Dirent<string>[];
    try {
      entries = await readdir(projectDirectory, { withFileTypes: true });
    } catch {
      return [];
    }

    const sessions: ClaudeSessionMetadata[] = [];
    const owners = await readIndexOwnersAsync(projectDirectory);
    for (const entry of entries) {
      if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== '.jsonl') continue;
      const conversationId = path.basename(entry.name, path.extname(entry.name));
      if (!isValidClaudeSessionId(conversationId)) continue;
      try {
        const metadata = await this.extractSessionMetadataAsync(
          path.join(projectDirectory, entry.name),
          conversationId,
          cwd,
          owners,
        );
        if (metadata) sessions.push(metadata);
      } catch {
        // A malformed, deleted, or concurrently-written transcript is isolated to its own row.
      }
    }
    return sessions.sort((left, right) => right.lastActiveAt - left.lastActiveAt);
  }

  public deleteSession(cwd: string, conversationId: string): boolean {
    if (!isValidClaudeSessionId(conversationId)) {
      return false;
    }

    const sessionFile = path.join(this.projectDirectory(cwd), `${conversationId}.jsonl`);
    try {
      if (!this.ownsTranscript(sessionFile, conversationId, cwd)) {
        return false;
      }
      unlinkSync(sessionFile);
      return true;
    } catch {
      return false;
    }
  }

  public renameSession(cwd: string, conversationId: string, title: string): boolean {
    if (!isValidClaudeSessionId(conversationId)) {
      return false;
    }
    const normalizedTitle = normalizeClaudeSessionTitle(title);
    const sessionFile = path.join(this.projectDirectory(cwd), `${conversationId}.jsonl`);
    try {
      if (!this.ownsTranscript(sessionFile, conversationId, cwd)) {
        return false;
      }

      const stat = lstatSync(sessionFile);
      const descriptor = openSync(sessionFile, 'r');
      const finalByte = Buffer.alloc(1);
      try {
        readSync(descriptor, finalByte, 0, 1, stat.size - 1);
      } finally {
        closeSync(descriptor);
      }
      const prefix = finalByte[0] === 0x0a ? '' : '\n';
      const titleRecord = JSON.stringify({
        customTitle: normalizedTitle,
        sessionId: conversationId,
        timestamp: new Date().toISOString(),
        type: 'custom-title',
      });
      appendFileSync(sessionFile, `${prefix}${titleRecord}\n`, 'utf8');
      return true;
    } catch {
      return false;
    }
  }

  private projectDirectory(cwd: string): string {
    return path.join(this.projectsDirectory, claudeProjectDirectoryName(cwd));
  }

  private ownsTranscript(file: string, id: string, cwd: string): boolean {
    return this.extractSessionMetadata(file, id, cwd, readIndexOwners(path.dirname(file))) !== null;
  }

  private extractSessionMetadata(
    file: string,
    id: string,
    cwd: string,
    owners: ReadonlyMap<string, string>,
  ): ClaudeSessionMetadata | null {
    const stat = lstatSync(file);
    if (!stat.isFile() || !stat.size || stat.size > MAX_JSONL_SIZE) return null;
    const parse = transcriptMetadata(
      readFileSync(file, 'utf8'),
      id,
      cwd,
      stat.mtimeMs,
      owners.get(id.toLowerCase()),
    );
    let result = parse.next();
    while (!result.done) result = parse.next();
    return result.value;
  }

  private async extractSessionMetadataAsync(
    file: string,
    id: string,
    cwd: string,
    owners: ReadonlyMap<string, string>,
  ): Promise<ClaudeSessionMetadata | null> {
    const stat = await lstat(file);
    if (!stat.isFile() || !stat.size || stat.size > MAX_JSONL_SIZE) return null;
    const parse = transcriptMetadata(
      await readFile(file, 'utf8'),
      id,
      cwd,
      stat.mtimeMs,
      owners.get(id.toLowerCase()),
    );
    let result = parse.next();
    while (!result.done) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      result = parse.next();
    }
    return result.value;
  }
}
