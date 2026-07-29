import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ChatAttachmentStore } from '../src/main/chat-attachment-store';

const fixtureRoots: string[] = [];

const fixture = () => {
  const root = mkdtempSync(path.join(tmpdir(), 'claudedock-chat-attachment-'));
  fixtureRoots.push(root);
  const sourceDirectory = path.join(root, 'sources');
  mkdirSync(sourceDirectory);
  return {
    attachmentDirectory: path.join(root, 'user-data', 'claude', 'chat-attachments'),
    sourceDirectory,
    store: new ChatAttachmentStore(path.join(root, 'user-data')),
  };
};

afterEach(() => {
  for (const root of fixtureRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

describe('chat attachment store', () => {
  it('copies supported files into application-owned UUID storage and encodes only on demand', async () => {
    const { attachmentDirectory, sourceDirectory, store } = fixture();
    const source = path.join(sourceDirectory, 'pixel.png');
    writeFileSync(source, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    const [attachment] = await store.importFiles([source]);

    expect(attachment).toMatchObject({
      fileName: 'pixel.png',
      mediaType: 'image/png',
      sizeBytes: 4,
      type: 'image',
    });
    expect(attachment?.attachmentId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(store.readBase64(attachment!.attachmentId)).toBe('iVBORw==');
    const metadata = JSON.parse(
      readFileSync(
        path.join(attachmentDirectory, attachment!.attachmentId, 'metadata.json'),
        'utf8',
      ),
    ) as Record<string, unknown>;
    expect(metadata).not.toHaveProperty('sourcePath');
    expect(JSON.stringify(metadata)).not.toContain(sourceDirectory);
  });

  it('keeps batch import atomic when any source is unsupported', async () => {
    const { attachmentDirectory, sourceDirectory, store } = fixture();
    const supported = path.join(sourceDirectory, 'notes.txt');
    const unsupported = path.join(sourceDirectory, 'program.exe');
    writeFileSync(supported, 'notes', 'utf8');
    writeFileSync(unsupported, 'not really an executable', 'utf8');

    await expect(store.importFiles([supported, unsupported])).rejects.toThrow(/仅支持/);
    expect(existsSync(attachmentDirectory)).toBe(false);
  });

  it('accepts TSV table files advertised by the attachment picker', async () => {
    const { sourceDirectory, store } = fixture();
    const source = path.join(sourceDirectory, 'metrics.tsv');
    writeFileSync(source, 'name\tvalue\nalpha\t42\n', 'utf8');

    const [attachment] = await store.importFiles([source]);

    expect(attachment).toMatchObject({
      fileName: 'metrics.tsv',
      mediaType: 'text/plain',
      type: 'document',
    });
  });

  it('deletes only candidate attachments that are not retained', async () => {
    const { sourceDirectory, store } = fixture();
    const firstPath = path.join(sourceDirectory, 'first.txt');
    const secondPath = path.join(sourceDirectory, 'second.txt');
    writeFileSync(firstPath, 'first', 'utf8');
    writeFileSync(secondPath, 'second', 'utf8');
    const [first, second] = await store.importFiles([firstPath, secondPath]);

    store.deleteUnreferenced(
      [first!.attachmentId, second!.attachmentId],
      new Set([second!.attachmentId]),
    );

    expect(() => store.get(first!.attachmentId)).toThrow();
    expect(store.get(second!.attachmentId)).toMatchObject({ fileName: 'second.txt' });
  });

  it('serializes concurrent draft imports and enforces the ten-file aggregate limit', async () => {
    const { sourceDirectory, store } = fixture();
    const paths = Array.from({ length: 11 }, (_, index) => {
      const filePath = path.join(sourceDirectory, `file-${index}.txt`);
      writeFileSync(filePath, String(index), 'utf8');
      return filePath;
    });
    const initial = await store.importDraftFiles([paths[0]!]);
    const results = await Promise.allSettled([
      store.importDraftFiles(paths.slice(1, 6), initial.draftId),
      store.importDraftFiles(paths.slice(6, 11), initial.draftId),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    expect(String(rejected?.reason)).toContain('最多添加 10 个');
  });

  it('enforces 32 MiB across separate imports in one draft', async () => {
    const { sourceDirectory, store } = fixture();
    const firstPath = path.join(sourceDirectory, 'first.pdf');
    const secondPath = path.join(sourceDirectory, 'second.pdf');
    writeFileSync(firstPath, Buffer.alloc(17 * 1024 * 1024, 1));
    writeFileSync(secondPath, Buffer.alloc(16 * 1024 * 1024, 2));

    const initial = await store.importDraftFiles([firstPath]);
    await expect(store.importDraftFiles([secondPath], initial.draftId)).rejects.toThrow(
      /总大小不能超过 32 MiB/,
    );
  });

  it('deletes a removed draft attachment immediately when history does not retain it', async () => {
    const { sourceDirectory, store } = fixture();
    const source = path.join(sourceDirectory, 'draft.txt');
    writeFileSync(source, 'draft', 'utf8');
    const imported = await store.importDraftFiles([source]);
    const attachment = imported.attachments[0]!;

    expect(
      await store.removeDraftAttachment(imported.draftId, attachment.attachmentId, new Set()),
    ).toBe(true);
    expect(() => store.get(attachment.attachmentId)).toThrow();
  });
});
