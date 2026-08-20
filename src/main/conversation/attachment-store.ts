import { randomUUID } from 'node:crypto';
import { type Dirent, lstatSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { lstat, mkdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type {
  ConversationAttachmentInput,
  NativeAttachmentBytesInput,
  NativeAttachmentView,
} from '../../shared/conversation/native';
import { inspectSafeImage } from '../infra/image-safety';

interface StoredNativeAttachment extends Omit<NativeAttachmentView, 'previewDataUrl'> {
  version: 1;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PAYLOAD = 'payload';
const METADATA = 'metadata.json';
export const MAX_NATIVE_ATTACHMENT_COUNT = 10;
export const MAX_NATIVE_ATTACHMENT_BYTES = 32 * 1024 * 1024;
export const MAX_NATIVE_ATTACHMENT_TOTAL_BYTES = 32 * 1024 * 1024;

const assertUuid = (value: string, label: string): string => {
  if (!UUID_PATTERN.test(value)) throw new Error(`${label}无效。`);
  return value.toLowerCase();
};

const cleanName = (value: string): string => {
  const name = path.basename(value).normalize('NFC');
  if (
    !name ||
    name === '.' ||
    name === '..' ||
    name.length > 255 ||
    [...name].some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code <= 0x1f || code === 0x7f;
    })
  ) {
    throw new Error('图片文件名无效或过长。');
  }
  return name;
};

const bufferFrom = (input: NativeAttachmentBytesInput): Buffer => {
  if (!(input?.bytes instanceof ArrayBuffer)) throw new Error('剪贴板图片数据无效。');
  const bytes = Buffer.from(input.bytes);
  if (bytes.length <= 0 || bytes.length > MAX_NATIVE_ATTACHMENT_BYTES) {
    throw new Error('单张图片必须大于 0 字节且不超过 32 MiB。');
  }
  return bytes;
};

export class NativeAttachmentStore {
  private readonly root: string;
  private mutationQueue: Promise<void> = Promise.resolve();

  public constructor(userDataPath: string) {
    this.root = path.join(userDataPath, 'claude', 'native-attachments');
  }

  public importFiles(conversationId: string, filePaths: string[]): Promise<NativeAttachmentView[]> {
    return this.enqueue(async () => {
      if (!Array.isArray(filePaths) || filePaths.length === 0) {
        throw new Error('没有选择图片。');
      }
      const prepared = await Promise.all(
        filePaths.map(async (filePath) => {
          if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) {
            throw new Error('图片路径必须是本机绝对路径。');
          }
          const source = await lstat(filePath);
          if (!source.isFile() || source.isSymbolicLink()) {
            throw new Error('图片必须是普通文件，不能是目录或符号链接。');
          }
          const resolved = await realpath(filePath);
          const resolvedInfo = await stat(resolved);
          if (
            !resolvedInfo.isFile() ||
            resolvedInfo.size <= 0 ||
            resolvedInfo.size > MAX_NATIVE_ATTACHMENT_BYTES
          ) {
            throw new Error('单张图片必须大于 0 字节且不超过 32 MiB。');
          }
          const fileName = cleanName(resolved);
          const bytes = await readFile(resolved);
          if (bytes.length !== resolvedInfo.size) throw new Error('图片在导入过程中发生变化。');
          return { bytes, fileName };
        }),
      );
      return this.importPrepared(conversationId, prepared);
    });
  }

  public importBytes(
    conversationId: string,
    inputs: NativeAttachmentBytesInput[],
  ): Promise<NativeAttachmentView[]> {
    return this.enqueue(async () => {
      if (!Array.isArray(inputs) || inputs.length === 0) throw new Error('剪贴板中没有图片。');
      const prepared = inputs.map((input) => ({
        bytes: bufferFrom(input),
        fileName: cleanName(input.fileName),
      }));
      return this.importPrepared(conversationId, prepared);
    });
  }

  public list(conversationId: string): NativeAttachmentView[] {
    const directory = this.conversationDirectory(conversationId);
    let entries: Dirent[];
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      // The conversation simply has no attachment directory yet.
      return [];
    }
    const views: NativeAttachmentView[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !UUID_PATTERN.test(entry.name)) continue;
      try {
        views.push(this.get(conversationId, entry.name));
      } catch {
        /*
         * `get` throws for a corrupted or replaced attachment. Isolating it per entry keeps every
         * healthy attachment visible; failing the whole listing would hide them all and restart the
         * count and total-size quotas from zero.
         */
      }
    }
    return views;
  }

  public get(conversationId: string, attachmentId: string): NativeAttachmentView {
    const directory = this.attachmentDirectory(conversationId, attachmentId);
    const metadata = JSON.parse(
      readFileSync(path.join(directory, METADATA), 'utf8'),
    ) as Partial<StoredNativeAttachment>;
    if (
      metadata.version !== 1 ||
      metadata.attachmentId !== attachmentId.toLowerCase() ||
      typeof metadata.fileName !== 'string' ||
      typeof metadata.mediaType !== 'string' ||
      !Number.isSafeInteger(metadata.sizeBytes) ||
      !Number.isSafeInteger(metadata.width) ||
      !Number.isSafeInteger(metadata.height)
    ) {
      throw new Error('图片附件元数据损坏。');
    }
    const payload = path.join(directory, PAYLOAD);
    const info = lstatSync(payload);
    if (!info.isFile() || info.isSymbolicLink() || info.size !== metadata.sizeBytes) {
      throw new Error('图片附件已损坏或被替换。');
    }
    return metadata as NativeAttachmentView;
  }

  public resolve(conversationId: string, attachmentId: string): ConversationAttachmentInput {
    const view = this.get(conversationId, attachmentId);
    return {
      id: view.attachmentId,
      mediaType: view.mediaType,
      name: view.fileName,
      path: path.join(this.attachmentDirectory(conversationId, attachmentId), PAYLOAD),
      size: view.sizeBytes,
    };
  }

  public remove(conversationId: string, attachmentId: string): Promise<boolean> {
    return this.enqueue(async () => {
      const directory = this.attachmentDirectory(conversationId, attachmentId);
      try {
        await lstat(directory);
      } catch {
        return false;
      }
      await rm(directory, { force: true, recursive: true });
      return true;
    });
  }

  public releaseConversation(conversationId: string): Promise<void> {
    return this.enqueue(async () => {
      await rm(this.conversationDirectory(conversationId), { force: true, recursive: true });
    });
  }

  public collectOrphans(
    activeConversationIds: ReadonlySet<string>,
    ttlMs = 24 * 60 * 60 * 1000,
  ): void {
    if (!Number.isFinite(ttlMs) || ttlMs < 0) throw new Error('附件清理宽限期无效。');
    let entries;
    try {
      entries = readdirSync(this.root, { withFileTypes: true });
    } catch {
      return;
    }
    const cutoff = Date.now() - ttlMs;
    for (const entry of entries) {
      if (
        !entry.isDirectory() ||
        !UUID_PATTERN.test(entry.name) ||
        activeConversationIds.has(entry.name)
      ) {
        continue;
      }
      const directory = path.join(this.root, entry.name);
      try {
        if (statSync(directory).mtimeMs <= cutoff)
          rmSync(directory, { force: true, recursive: true });
      } catch {
        // Concurrent cleanup already won.
      }
    }
  }

  private async importPrepared(
    conversationId: string,
    prepared: Array<{ bytes: Buffer; fileName: string }>,
  ): Promise<NativeAttachmentView[]> {
    const canonicalConversationId = assertUuid(conversationId, '对话标识');
    const current = this.list(canonicalConversationId);
    if (current.length + prepared.length > MAX_NATIVE_ATTACHMENT_COUNT) {
      throw new Error(`每条消息最多添加 ${MAX_NATIVE_ATTACHMENT_COUNT} 张图片。`);
    }
    const currentBytes = current.reduce((sum, item) => sum + item.sizeBytes, 0);
    const newBytes = prepared.reduce((sum, item) => sum + item.bytes.length, 0);
    if (currentBytes + newBytes > MAX_NATIVE_ATTACHMENT_TOTAL_BYTES) {
      throw new Error('当前会话待发送图片总大小不能超过 32 MiB。');
    }
    const conversationDirectory = this.conversationDirectory(canonicalConversationId);
    await mkdir(conversationDirectory, { mode: 0o700, recursive: true });
    const imported: NativeAttachmentView[] = [];
    try {
      for (const item of prepared) {
        const safety = inspectSafeImage(item.bytes, item.fileName);
        const attachmentId = randomUUID();
        const temporary = path.join(conversationDirectory, `.import-${attachmentId}`);
        const final = this.attachmentDirectory(canonicalConversationId, attachmentId);
        await mkdir(temporary, { mode: 0o700 });
        try {
          await writeFile(path.join(temporary, PAYLOAD), item.bytes, { mode: 0o600 });
          const metadata: StoredNativeAttachment = {
            attachmentId,
            fileName: item.fileName,
            height: safety.height,
            mediaType: safety.mediaType,
            sizeBytes: item.bytes.length,
            version: 1,
            width: safety.width,
          };
          await writeFile(path.join(temporary, METADATA), `${JSON.stringify(metadata)}\n`, {
            encoding: 'utf8',
            mode: 0o600,
          });
          await rename(temporary, final);
          imported.push(metadata);
        } catch (error) {
          await rm(temporary, { force: true, recursive: true });
          throw error;
        }
      }
      return imported;
    } catch (error) {
      await Promise.all(
        imported.map((item) =>
          rm(this.attachmentDirectory(canonicalConversationId, item.attachmentId), {
            force: true,
            recursive: true,
          }),
        ),
      );
      throw error;
    }
  }

  private conversationDirectory(conversationId: string): string {
    return path.join(this.root, assertUuid(conversationId, '对话标识'));
  }

  private attachmentDirectory(conversationId: string, attachmentId: string): string {
    return path.join(
      this.conversationDirectory(conversationId),
      assertUuid(attachmentId, '附件标识'),
    );
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationQueue.then(operation, operation);
    this.mutationQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
