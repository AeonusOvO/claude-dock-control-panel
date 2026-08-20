import { describe, expect, it } from 'vitest';
import { createMainHarness } from '../helpers/main-harness';

describe('main bootstrap contributions', () => {
  it('runs network, runtime, diagnostics, IPC, and window startup in dependency order', async () => {
    const harness = await createMainHarness();
    try {
      const expectedOrder = [
        'app.setAppUserModelId',
        'artifact.install',
        'construct:McpManager',
        'construct:DownloadEngine',
        'download.install',
        'proxy.applyApplication',
        'proxy.applyConversation',
        'construct:RuntimeProcessRegistry',
        'construct:ClaudeRuntime',
        'construct:NativeConversationService',
        'construct:NetworkPreflightService',
        'runtime-process.start',
        'window.create',
      ];

      expect(harness.calls.filter((call) => expectedOrder.includes(call))).toEqual(expectedOrder);
    } finally {
      harness.restore();
    }
  });
});
