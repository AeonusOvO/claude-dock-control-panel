import { existsSync, readdirSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import type { ClaudeSessionMetadata } from '../shared/contracts';

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

export class ClaudeSessionManager {
  public constructor(private readonly projectsDirectory = DEFAULT_CLAUDE_PROJECTS_DIRECTORY) {}

  public getSessionsForProject(cwd: string): ClaudeSessionMetadata[] {
    const projectDirectory = this.projectDirectory(cwd);
    if (!existsSync(projectDirectory)) {
      return [];
    }

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

  public deleteSession(cwd: string, conversationId: string): boolean {
    if (!isValidClaudeSessionId(conversationId)) {
      return false;
    }

    const sessionFile = path.join(this.projectDirectory(cwd), `${conversationId}.jsonl`);
    try {
      if (!existsSync(sessionFile) || !statSync(sessionFile).isFile()) {
        return false;
      }
      unlinkSync(sessionFile);
      return true;
    } catch {
      return false;
    }
  }

  private projectDirectory(cwd: string): string {
    return path.join(this.projectsDirectory, claudeProjectDirectoryName(cwd));
  }

  private extractSessionMetadata(
    sessionFile: string,
    conversationId: string,
  ): ClaudeSessionMetadata | null {
    const stat = statSync(sessionFile);
    if (!stat.isFile() || stat.size === 0 || stat.size > MAX_JSONL_SIZE) {
      return null;
    }

    let sessionId: string | undefined;
    let sessionName: string | undefined;
    let modelId: string | undefined;
    let inputTokens = 0;
    let outputTokens = 0;
    let estimatedCostUsd: number | undefined;
    let messageCount = 0;
    let lastActiveAt = 0;

    for (const line of readFileSync(sessionFile, 'utf8').split('\n')) {
      if (!line.trim()) {
        continue;
      }

      try {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        sessionId ??=
          optionalNonEmptyString(parsed.sessionId) ?? optionalNonEmptyString(parsed.session_id);
        sessionName ??=
          optionalNonEmptyString(parsed.slug) ??
          optionalNonEmptyString(parsed.aiTitle) ??
          optionalNonEmptyString(parsed.sessionName);

        const message =
          parsed.message && typeof parsed.message === 'object'
            ? (parsed.message as Record<string, unknown>)
            : undefined;
        const recordRole =
          optionalNonEmptyString(parsed.type) ?? optionalNonEmptyString(parsed.role);
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

    const normalizedSessionId =
      sessionId && isValidClaudeSessionId(sessionId) ? sessionId : conversationId;
    return {
      conversationId,
      estimatedCostUsd,
      inputTokens: inputTokens > 0 ? inputTokens : undefined,
      lastActiveAt: Math.floor(lastActiveAt || stat.mtimeMs),
      messageCount,
      modelId,
      outputTokens: outputTokens > 0 ? outputTokens : undefined,
      sessionId: normalizedSessionId,
      sessionName,
    };
  }
}
