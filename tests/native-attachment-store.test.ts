import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { NativeAttachmentStore } from '../src/main/native-attachment-store';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);
const CONVERSATION_ID = '11111111-1111-4111-8111-111111111111';
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

const fixture = (): { root: string; store: NativeAttachmentStore } => {
  const root = mkdtempSync(path.join(tmpdir(), 'claudedock-native-attachment-'));
  roots.push(root);
  return { root, store: new NativeAttachmentStore(root) };
};

describe('native attachment store', () => {
  it('copies validated bytes into session-owned storage and never exposes a source path', async () => {
    const { root, store } = fixture();
    const source = path.join(root, 'source.png');
    writeFileSync(source, PNG);
    const [view] = await store.importFiles(CONVERSATION_ID, [source]);

    expect(view).toMatchObject({ height: 1, mediaType: 'image/png', width: 1 });
    const resolved = store.resolve(CONVERSATION_ID, view!.attachmentId);
    expect(resolved.path).not.toBe(source);
    expect(resolved.path).toContain(path.join('claude', 'native-attachments', CONVERSATION_ID));
    expect(existsSync(source)).toBe(true);

    await store.releaseConversation(CONVERSATION_ID);
    expect(existsSync(source)).toBe(true);
    expect(store.list(CONVERSATION_ID)).toEqual([]);
  });

  it('rejects extension spoofing and removes only the application copy', async () => {
    const { store } = fixture();
    const bytes = Uint8Array.from(PNG).buffer;
    await expect(
      store.importBytes(CONVERSATION_ID, [{ bytes, fileName: 'spoof.jpg' }]),
    ).rejects.toThrow(/扩展名与实际内容不一致/);

    const [view] = await store.importBytes(CONVERSATION_ID, [
      { bytes: Uint8Array.from(PNG).buffer, fileName: 'clipboard.png' },
    ]);
    expect(await store.remove(CONVERSATION_ID, view!.attachmentId)).toBe(true);
    expect(store.list(CONVERSATION_ID)).toEqual([]);
  });
});
