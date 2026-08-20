import { describe, expect, it, vi } from 'vitest';
import {
  RuntimeActivityRegistry,
  type ClaudeRuntimeActivityEvent,
} from '../../src/main/runtime/activity-registry';

const event = (
  name: string,
  overrides: Partial<ClaudeRuntimeActivityEvent> = {},
): ClaudeRuntimeActivityEvent => ({
  event: name,
  eventId: `${name}-${Math.random()}`,
  launchGeneration: 4,
  ptyGeneration: 7,
  sessionId: 'session-1',
  signaledAt: Date.now(),
  ...overrides,
});

describe('runtime activity registry', () => {
  it('keeps the conversation waiting while a background task can wake its parent', () => {
    const onChange = vi.fn();
    const registry = new RuntimeActivityRegistry(onChange);
    registry.consume(event('SessionStart'));
    registry.consume(
      event('SubagentStart', {
        agentId: 'agent-1',
        agentType: 'researcher',
        description: '检查长时流故障',
      }),
    );

    const waiting = registry.consume(
      event('Stop', {
        backgroundTasks: [{ description: '检查长时流故障', id: 'agent-1', kind: 'subagent' }],
      }),
    );
    expect(waiting).toMatchObject({
      phase: 'waiting-background',
      subagentCount: 1,
      willResumeConversation: true,
    });
    expect(waiting.tasks[0]).toMatchObject({
      id: 'agent-1',
      status: 'waiting',
      tokenUse: 'likely',
      willWakeParent: true,
    });

    const resuming = registry.consume(event('SubagentStop', { agentId: 'agent-1' }));
    expect(resuming.phase).toBe('resuming');
    expect(resuming.willResumeConversation).toBe(true);
    expect(resuming.subagentCount).toBe(0);
    expect(onChange).toHaveBeenCalled();
  });

  it('generation-fences stale events and fails without claiming an automatic replay', () => {
    const registry = new RuntimeActivityRegistry();
    registry.consume(event('UserPromptSubmit'));
    const replacement = registry.consume(
      event('SessionStart', { launchGeneration: 5, ptyGeneration: 8 }),
    );
    expect(replacement).toMatchObject({ launchGeneration: 5, phase: 'cli-idle', ptyGeneration: 8 });
    expect(registry.consume(event('StopFailure'))).toMatchObject({
      launchGeneration: 5,
      phase: 'cli-idle',
      ptyGeneration: 8,
    });

    const failed = registry.consume(
      event('StopFailure', {
        failureKind: 'stream-disconnected',
        launchGeneration: 5,
        ptyGeneration: 8,
      }),
    );
    expect(failed).toMatchObject({ phase: 'failed', willResumeConversation: false });
  });

  it('does not report resuming until the top-level Stop has declared background work', () => {
    const registry = new RuntimeActivityRegistry();
    registry.consume(event('UserPromptSubmit'));
    registry.consume(event('SubagentStart', { agentId: 'agent-early' }));

    const foreground = registry.consume(event('SubagentStop', { agentId: 'agent-early' }));
    expect(foreground).toMatchObject({
      phase: 'foreground-running',
      willResumeConversation: false,
    });

    registry.consume(
      event('Stop', {
        backgroundTasks: [{ id: 'agent-late', kind: 'subagent' }],
      }),
    );
    const stillWaiting = registry.consume(
      event('TaskCreated', { agentType: 'web-server', taskId: 'server-1' }),
    );
    expect(stillWaiting).toMatchObject({
      phase: 'waiting-background',
      willResumeConversation: true,
    });
    expect(stillWaiting.tasks.find((task) => task.id === 'server-1')).toMatchObject({
      kind: 'web',
      tokenUse: 'none',
    });
  });

  it('drops completed task history after the ten-minute retention window', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-08-05T00:00:00Z'));
      const registry = new RuntimeActivityRegistry();
      registry.consume(event('TaskCreated', { taskId: 'finished-task' }));
      registry.consume(event('TaskCompleted', { taskId: 'finished-task' }));
      expect(registry.get('session-1').tasks).toHaveLength(1);

      vi.advanceTimersByTime(10 * 60_000 + 1);
      expect(registry.get('session-1').tasks).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('treats an explicit empty Stop snapshot as authoritative without inventing completion', () => {
    const registry = new RuntimeActivityRegistry();
    registry.consume(event('TaskCreated', { taskId: 'lost-completion' }));
    const reconciled = registry.consume(
      event('Stop', { backgroundTasks: [], backgroundTasksPresent: true }),
    );

    expect(reconciled.phase).toBe('cli-idle');
    expect(reconciled.tasks).toContainEqual(
      expect.objectContaining({ id: 'lost-completion', status: 'orphaned' }),
    );
  });

  it('marks unfinished tasks stale instead of claiming they completed', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-08-05T00:00:00Z'));
      const registry = new RuntimeActivityRegistry();
      registry.consume(event('TaskCreated', { taskId: 'stale-task' }));
      vi.advanceTimersByTime(30 * 60_000 + 1);
      expect(registry.get('session-1').tasks).toContainEqual(
        expect.objectContaining({ id: 'stale-task', status: 'orphaned' }),
      );
    } finally {
      vi.useRealTimers();
    }
  });
});
