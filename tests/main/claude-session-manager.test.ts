import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  ClaudeSessionManager,
  claudeProjectDirectoryName,
  isValidClaudeSessionId,
  normalizeClaudeSessionTitle,
} from '../../src/main/claude/session-manager';

const fixtureRoot = mkdtempSync(path.join(tmpdir(), 'claudedock-sessions-'));
const projectsRoot = path.join(fixtureRoot, 'projects');

afterAll(() => {
  rmSync(fixtureRoot, { force: true, recursive: true });
});

const writeSession = (
  cwd: string,
  sessionId: string,
  timestamp: string,
  model = 'claude-test',
): string => {
  const projectDirectory = path.join(projectsRoot, claudeProjectDirectoryName(cwd));
  mkdirSync(projectDirectory, { recursive: true });
  const sessionFile = path.join(projectDirectory, `${sessionId}.jsonl`);
  writeFileSync(
    sessionFile,
    [
      JSON.stringify({
        sessionId,
        slug: 'useful-session',
        timestamp,
        type: 'user',
      }),
      JSON.stringify({
        message: {
          model,
          role: 'assistant',
          usage: { input_tokens: 17, output_tokens: 5 },
        },
        sessionId,
        timestamp,
        type: 'assistant',
      }),
      '{incomplete',
    ].join('\n'),
    'utf8',
  );
  return sessionFile;
};

describe('ClaudeSessionManager', () => {
  it('reads only direct JSONL sessions for the requested project without blocking the main loop', async () => {
    const currentProject = 'D:\\Projects\\Current';
    const otherProject = 'D:\\Projects\\Other';
    const olderId = '11111111-1111-4111-8111-111111111111';
    const newerId = '22222222-2222-4222-8222-222222222222';
    const otherId = '33333333-3333-4333-8333-333333333333';
    writeSession(currentProject, olderId, '2026-07-20T10:00:00.000Z');
    writeSession(currentProject, newerId, '2026-07-21T10:00:00.000Z');
    writeSession(otherProject, otherId, '2026-07-22T10:00:00.000Z');

    const sessions = new ClaudeSessionManager(projectsRoot).getSessionsForProject(currentProject);
    const backgroundSessions = await new ClaudeSessionManager(
      projectsRoot,
    ).getSessionsForProjectAsync(currentProject);

    expect(sessions.map((session) => session.conversationId)).toEqual([newerId, olderId]);
    expect(backgroundSessions).toEqual(sessions);
    expect(sessions[0]).toMatchObject({
      inputTokens: 17,
      messageCount: 2,
      modelId: 'claude-test',
      outputTokens: 5,
      sessionId: newerId,
      sessionName: 'useful-session',
    });
  });

  it('deletes only the validated session in the requested project', () => {
    const currentProject = 'D:\\Projects\\DeleteCurrent';
    const otherProject = 'D:\\Projects\\DeleteOther';
    const sessionId = '44444444-4444-4444-8444-444444444444';
    const currentFile = writeSession(currentProject, sessionId, '2026-07-23T10:00:00.000Z');
    const otherFile = writeSession(otherProject, sessionId, '2026-07-23T10:00:00.000Z');
    const manager = new ClaudeSessionManager(projectsRoot);

    expect(manager.deleteSession(currentProject, sessionId)).toBe(true);
    expect(() => readFileSync(currentFile, 'utf8')).toThrow();
    expect(readFileSync(otherFile, 'utf8')).toContain(sessionId);
    expect(manager.deleteSession(otherProject, '..\\secrets')).toBe(false);
  });

  it('prefers AI titles and persists a user rename as Claude custom-title metadata', () => {
    const currentProject = 'D:\\Projects\\RenameCurrent';
    const sessionId = '66666666-6666-4666-8666-666666666666';
    const sessionFile = writeSession(currentProject, sessionId, '2026-07-24T10:00:00.000Z');
    appendFileSync(
      sessionFile,
      `\n${JSON.stringify({
        aiTitle: '修复终端输入',
        sessionId,
        timestamp: '2026-07-24T10:05:00.000Z',
        type: 'ai-title',
      })}`,
      'utf8',
    );
    const manager = new ClaudeSessionManager(projectsRoot);

    expect(manager.getSessionsForProject(currentProject)[0]?.sessionName).toBe('修复终端输入');
    expect(manager.renameSession(currentProject, sessionId, '  中文自定义标题  ')).toBe(true);

    const lines = readFileSync(sessionFile, 'utf8').trim().split('\n');
    expect(JSON.parse(lines.at(-1) ?? '{}')).toMatchObject({
      customTitle: '中文自定义标题',
      sessionId,
      type: 'custom-title',
    });
    expect(manager.getSessionsForProject(currentProject)[0]?.sessionName).toBe('中文自定义标题');
  });

  it('accepts only UUID-shaped Claude session identifiers', () => {
    expect(isValidClaudeSessionId('55555555-5555-4555-8555-555555555555')).toBe(true);
    expect(isValidClaudeSessionId('not-a-session')).toBe(false);
    expect(isValidClaudeSessionId('..\\session')).toBe(false);
  });

  it('rejects empty, oversized, or control-character session titles', () => {
    expect(normalizeClaudeSessionTitle('  正常标题  ')).toBe('正常标题');
    expect(() => normalizeClaudeSessionTitle('')).toThrow(/1-60/);
    expect(() => normalizeClaudeSessionTitle('a'.repeat(61))).toThrow(/1-60/);
    expect(() => normalizeClaudeSessionTitle('标题\u001b')).toThrow(/控制字符/);
  });
});
