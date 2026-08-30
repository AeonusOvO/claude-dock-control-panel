import { describe, expect, it, vi } from 'vitest';
import { createChatAttachmentImportActions } from '../../src/renderer/features/chat/chat-attachment-import';
import type { ChatActionsDependencies } from '../../src/renderer/features/chat/dependencies';
import { createChatElements } from '../../src/renderer/features/chat/elements';
import { createChatState } from '../../src/renderer/features/chat/state';
import { withRenderer } from '../helpers/renderer-interaction-fixture';

const attachmentImportDependencies = (
  showToast: ChatActionsDependencies['showToast'],
): ChatActionsDependencies => ({ showToast }) as ChatActionsDependencies;

describe('Chat attachment import queue', () => {
  it('rejects a new import while a chat request is active', async () => {
    await withRenderer({}, async (harness) => {
      const elements = createChatElements();
      const state = createChatState();
      state.activeChatRequestId = 'active-request';
      const setChatBusy = vi.fn();
      const applyChatAttachmentImportResult = vi.fn();
      const actions = createChatAttachmentImportActions(
        elements,
        state,
        attachmentImportDependencies(vi.fn()),
        setChatBusy,
        applyChatAttachmentImportResult,
      );

      const file = new harness.dom.window.File(['fixture'], 'attachment.txt', {
        type: 'text/plain',
      });

      expect(actions.queueChatAttachmentImport([file])).toBe(false);
      expect(state.queuedChatAttachmentImports).toBe(0);
      expect(setChatBusy).not.toHaveBeenCalled();
      expect(harness.method('importChatAttachments')).not.toHaveBeenCalled();
      expect(applyChatAttachmentImportResult).not.toHaveBeenCalled();
    });
  });

  it('reports an asynchronously rejected queued import to completion observers', async () => {
    const onComplete = vi.fn();
    await withRenderer(
      {
        importChatAttachmentBytes: vi.fn(async () => {
          throw new Error('attachment import failed');
        }),
      },
      async (harness) => {
        const actions = createChatAttachmentImportActions(
          createChatElements(),
          createChatState(),
          attachmentImportDependencies(vi.fn()),
          vi.fn(),
          vi.fn(),
        );
        const file = new harness.dom.window.File(['fixture'], 'attachment.txt', {
          type: 'text/plain',
        });

        expect(actions.queueChatAttachmentImport([file], onComplete)).toBe(true);
        await vi.waitFor(() => expect(onComplete).toHaveBeenCalledWith(false));
      },
    );
  });

  it('reports a successfully imported queued attachment to completion observers', async () => {
    const onComplete = vi.fn();
    await withRenderer(
      {
        importChatAttachmentBytes: vi.fn(async () => ({
          attachments: [],
          errors: [],
          ok: true,
        })),
      },
      async (harness) => {
        const actions = createChatAttachmentImportActions(
          createChatElements(),
          createChatState(),
          attachmentImportDependencies(vi.fn()),
          vi.fn(),
          vi.fn(),
        );
        const file = new harness.dom.window.File(['fixture'], 'attachment.txt', {
          type: 'text/plain',
        });

        expect(actions.queueChatAttachmentImport([file], onComplete)).toBe(true);
        await vi.waitFor(() => expect(onComplete).toHaveBeenCalledWith(true));
      },
    );
  });
});
