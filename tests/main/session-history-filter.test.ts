import { describe, expect, it, vi } from 'vitest';
import { CHANNELS } from '../../src/shared/ipc/channels';
import { ConversationOwnerRegistry } from '../../src/main/conversation/owner-registry';

const handlers = new Map<string, (...args: unknown[]) => unknown>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(channel, handler);
    }),
  },
}));

const { registerSessionIpc } = await import('../../src/main/ipc/session');

describe('stored conversation history ownership filter', () => {
  it('hides a transcript already owned by a terminal as well as one owned natively', async () => {
    handlers.clear();
    const conversationId = '9f1c2b3d-4e5f-4a6b-8c9d-0e1f2a3b4c5d';
    const projectPath = String.raw`D:\Project`;
    const registry = new ConversationOwnerRegistry();
    registry.claim({
      conversationId,
      generation: 1,
      ownerId: 'terminal:session-1',
      ownerKind: 'terminal',
      phase: 'active',
      projectPath,
      runtime: 'claude',
    });

    registerSessionIpc({
      conversationOwnerRegistry: registry,
      deleteClaudeConversation: vi.fn(),
      describeWorkspace: vi.fn(),
      guards: { requireClaudeRuntime: vi.fn(), validateSender: vi.fn() },
      services: {
        resolve: vi.fn(() => ({ activeConversationIds: () => new Set<string>() })),
      } as never,
      sessionManager: {
        getSessionsForProjectAsync: vi.fn(async () => [
          {
            conversationId,
            lastActiveAt: 1,
            messageCount: 3,
            sessionId: conversationId,
          },
        ]),
      } as never,
      workspace: {} as never,
      workspaceStore: {} as never,
    });

    const handler = handlers.get(CHANNELS.CLAUDE_GET_SESSIONS_FOR_PATH);
    expect(handler).toBeTypeOf('function');
    await expect(handler?.({}, projectPath)).resolves.toEqual([]);
  });
});
