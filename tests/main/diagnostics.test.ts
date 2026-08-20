import { describe, expect, it, vi } from 'vitest';
import { MainDiagnostics } from '../../src/main/infra/diagnostics';
import { Logger } from '../../src/main/infra/logger';
import type { RuntimeActivitySnapshot } from '../../src/shared/contracts';

const activity: RuntimeActivitySnapshot = {
  launchGeneration: 2,
  observedAt: 4_000,
  phase: 'foreground-running',
  ptyGeneration: 3,
  sessionId: 'session-1',
  subagentCount: 0,
  tasks: [],
  webProcesses: [],
  willResumeConversation: false,
};

describe('main diagnostics query surface', () => {
  it('combines logs, stream failures, network history, and runtime activity', () => {
    const logger = new Logger({ now: () => 5_000 });
    const logged = logger.error('terminal', '无法启动终端。', 'spawn ENOENT', 'environment');
    const runtimeList = vi.fn(() => [activity]);
    const diagnostics = new MainDiagnostics({
      claudeStream: {
        list: () => [
          {
            backgroundTaskCount: 1,
            kind: 'unexpected-eof',
            occurredAt: 3_000,
            sessionRuntimeMs: 2_000,
          },
        ],
      },
      logger,
      network: { getView: () => ({ entries: [], retentionDays: 7 }) },
      runtimeActivity: { list: runtimeList },
    });

    expect(diagnostics.query({ code: logged.code, sessionId: 'session-1' })).toEqual({
      claudeStreamFailures: [
        {
          backgroundTaskCount: 1,
          kind: 'unexpected-eof',
          occurredAt: 3_000,
          sessionRuntimeMs: 2_000,
        },
      ],
      logs: [logged],
      networkHistory: { entries: [], retentionDays: 7 },
      runtimeActivities: [activity],
    });
    expect(runtimeList).toHaveBeenCalledWith('session-1');
  });
});
