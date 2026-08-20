import { randomUUID } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import type { ChatAttachmentView, ChatContentBlock, ChatMessage } from '../../shared/contracts';
import { inspectSafeImage } from '../infra/image-safety';

interface StoredChatAttachmentMetadata extends ChatAttachmentView {
  version: 1;
}

interface PreparedAttachmentSource {
  /** Set for clipboard/in-memory imports; mutually exclusive with realPath. */
  bytes?: Buffer;
  fileName: string;
  mediaType: string;
  /** Set for filesystem imports; mutually exclusive with bytes. */
  realPath?: string;
  sizeBytes: number;
  type: 'document' | 'image';
}

export interface ChatAttachmentBytesSource {
  bytes: ArrayBuffer | ArrayBufferView;
  fileName: string;
}

export interface ResolvedChatAttachment extends ChatAttachmentView {
  filePath: string;
}

export interface ImportedChatAttachmentDraft {
  attachments: ChatAttachmentView[];
  draftId: string;
}

const ATTACHMENT_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DRAFT_ID_PATTERN = ATTACHMENT_ID_PATTERN;
const TEMPORARY_IMPORT_PATTERN =
  /^\.import-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const MAX_CHAT_ATTACHMENT_COUNT = 10;
export const MAX_CHAT_ATTACHMENT_BYTES = 32 * 1024 * 1024;
export const MAX_CHAT_ATTACHMENT_TOTAL_BYTES = 32 * 1024 * 1024;
const MAX_FILE_NAME_LENGTH = 255;
const PAYLOAD_FILE_NAME = 'payload';
const METADATA_FILE_NAME = 'metadata.json';

const MEDIA_BY_EXTENSION: Readonly<
  Record<string, { mediaType: string; type: 'document' | 'image' }>
> = {
  '.csv': { mediaType: 'text/plain', type: 'document' },
  '.gif': { mediaType: 'image/gif', type: 'image' },
  '.jpeg': { mediaType: 'image/jpeg', type: 'image' },
  '.jpg': { mediaType: 'image/jpeg', type: 'image' },
  '.json': { mediaType: 'text/plain', type: 'document' },
  '.md': { mediaType: 'text/plain', type: 'document' },
  '.pdf': { mediaType: 'application/pdf', type: 'document' },
  '.png': { mediaType: 'image/png', type: 'image' },
  '.text': { mediaType: 'text/plain', type: 'document' },
  '.txt': { mediaType: 'text/plain', type: 'document' },
  '.tsv': { mediaType: 'text/plain', type: 'document' },
  '.webp': { mediaType: 'image/webp', type: 'image' },
};

export const isChatAttachmentId = (value: unknown): value is string =>
  typeof value === 'string' && ATTACHMENT_ID_PATTERN.test(value);

export const isChatAttachmentDraftId = (value: unknown): value is string =>
  typeof value === 'string' && DRAFT_ID_PATTERN.test(value);

const hasControlCharacter = (value: string): boolean =>
  [...value].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 0x1f || code === 0x7f;
  });

const attachmentIdsInBlock = (block: ChatContentBlock): string[] =>
  block.type !== 'text' && block.source.type === 'local' ? [block.source.attachmentId] : [];

export const chatAttachmentIds = (messages: ChatMessage[]): Set<string> => {
  const ids = new Set<string>();
  for (const message of messages) {
    if (typeof message.content === 'string') {
      continue;
    }
    for (const block of message.content) {
      for (const attachmentId of attachmentIdsInBlock(block)) {
        ids.add(attachmentId);
      }
    }
  }
  return ids;
};

const cleanFileName = (filePath: string): string => {
  const fileName = path.basename(filePath).normalize('NFC');
  if (
    !fileName ||
    fileName === '.' ||
    fileName === '..' ||
    fileName.length > MAX_FILE_NAME_LENGTH ||
    hasControlCharacter(fileName)
  ) {
    throw new Error('附件文件名无效或过长。');
  }
  return fileName;
};

const mediaFor = (fileName: string): { mediaType: string; type: 'document' | 'image' } => {
  const media = MEDIA_BY_EXTENSION[path.extname(fileName).toLowerCase()];
  if (!media) {
    throw new Error('仅支持 PDF、CSV、纯文本以及 PNG/JPEG/GIF/WebP 图片。');
  }
  return media;
};

const parseMetadata = (value: unknown, expectedId: string): ChatAttachmentView => {
  if (!value || typeof value !== 'object') {
    throw new Error('附件元数据损坏。');
  }
  const record = value as Record<string, unknown>;
  if (
    record.version !== 1 ||
    record.attachmentId !== expectedId ||
    typeof record.fileName !== 'string' ||
    !record.fileName ||
    record.fileName.length > MAX_FILE_NAME_LENGTH ||
    hasControlCharacter(record.fileName) ||
    typeof record.mediaType !== 'string' ||
    !record.mediaType ||
    !Number.isSafeInteger(record.sizeBytes) ||
    Number(record.sizeBytes) <= 0 ||
    Number(record.sizeBytes) > MAX_CHAT_ATTACHMENT_BYTES ||
    (record.type !== 'document' && record.type !== 'image')
  ) {
    throw new Error('附件元数据损坏。');
  }
  return {
    attachmentId: expectedId,
    fileName: record.fileName,
    mediaType: record.mediaType,
    sizeBytes: Number(record.sizeBytes),
    type: record.type,
  };
};

const sameIds = (first: ReadonlySet<string>, second: ReadonlySet<string>): boolean =>
  first.size === second.size && [...first].every((attachmentId) => second.has(attachmentId));

const prepareByteSources = (sources: ChatAttachmentBytesSource[]): PreparedAttachmentSource[] => {
  if (
    !Array.isArray(sources) ||
    sources.length === 0 ||
    sources.length > MAX_CHAT_ATTACHMENT_COUNT
  ) {
    throw new Error(`每次最多可导入 ${MAX_CHAT_ATTACHMENT_COUNT} 个附件。`);
  }
  return sources.map((source) => {
    const bytes = ArrayBuffer.isView(source?.bytes)
      ? Buffer.from(source.bytes.buffer, source.bytes.byteOffset, source.bytes.byteLength)
      : source?.bytes instanceof ArrayBuffer
        ? Buffer.from(source.bytes)
        : undefined;
    if (!bytes) {
      throw new Error('粘贴内容不是有效的文件数据。');
    }
    if (bytes.byteLength <= 0 || bytes.byteLength > MAX_CHAT_ATTACHMENT_BYTES) {
      throw new Error('单个附件必须大于 0 字节且不超过 32 MiB。');
    }
    // Names come from the renderer, so basename them the same way a filesystem import does.
    const fileName = cleanFileName(typeof source.fileName === 'string' ? source.fileName : '');
    const media = mediaFor(fileName);
    if (media.type === 'image') inspectSafeImage(bytes, fileName);
    return { bytes, fileName, sizeBytes: bytes.byteLength, ...media };
  });
};

export class ChatAttachmentStore {
  private readonly drafts = new Map<string, Set<string>>();
  private mutationQueue: Promise<void> = Promise.resolve();
  private readonly storageDirectory: string;

  public constructor(userDataPath: string) {
    this.storageDirectory = path.join(userDataPath, 'claude', 'chat-attachments');
  }

  /**
   * Utility import for migrations/tests. Renderer-facing code must use importDraftFiles so limits
   * remain authoritative across multiple IPC calls.
   */
  public importFiles(filePaths: string[]): Promise<ChatAttachmentView[]> {
    return this.enqueueMutation(async () => {
      const sources = await this.prepareSources(filePaths);
      this.assertAggregateLimits(0, 0, sources);
      return this.importPreparedSources(sources);
    });
  }

  /**
   * Adds one batch to an application-owned draft. All draft mutations are serialized so two
   * concurrent renderer invokes cannot both pass a stale count/byte check.
   */
  public importDraftFiles(
    filePaths: string[],
    requestedDraftId?: string,
  ): Promise<ImportedChatAttachmentDraft> {
    return this.enqueueMutation(async () => {
      const draftId = requestedDraftId ?? randomUUID();
      if (requestedDraftId && !isChatAttachmentDraftId(requestedDraftId)) {
        throw new Error('附件草稿标识无效。');
      }
      if (requestedDraftId && !this.drafts.has(requestedDraftId)) {
        throw new Error('附件草稿已经失效，请重新选择文件。');
      }
      const currentIds = this.drafts.get(draftId) ?? new Set<string>();
      const current = [...currentIds].map((attachmentId) => this.get(attachmentId));
      const sources = await this.prepareSources(filePaths);
      this.assertAggregateLimits(
        current.length,
        current.reduce((total, attachment) => total + attachment.sizeBytes, 0),
        sources,
      );
      const attachments = await this.importPreparedSources(sources);
      const nextIds = new Set(currentIds);
      for (const attachment of attachments) {
        nextIds.add(attachment.attachmentId);
      }
      this.drafts.set(draftId, nextIds);
      return { attachments, draftId };
    });
  }

  /**
   * Adds clipboard/in-memory payloads to a draft. Pasting an image produces bytes with no path on
   * disk, so the filesystem path in prepareSources cannot validate it; the same count, size and
   * media-type limits still apply.
   */
  public importDraftBytes(
    sources: ChatAttachmentBytesSource[],
    requestedDraftId?: string,
  ): Promise<ImportedChatAttachmentDraft> {
    return this.enqueueMutation(async () => {
      const draftId = requestedDraftId ?? randomUUID();
      if (requestedDraftId && !isChatAttachmentDraftId(requestedDraftId)) {
        throw new Error('附件草稿标识无效。');
      }
      if (requestedDraftId && !this.drafts.has(requestedDraftId)) {
        throw new Error('附件草稿已经失效，请重新选择文件。');
      }
      const currentIds = this.drafts.get(draftId) ?? new Set<string>();
      const current = [...currentIds].map((attachmentId) => this.get(attachmentId));
      const prepared = prepareByteSources(sources);
      this.assertAggregateLimits(
        current.length,
        current.reduce((total, attachment) => total + attachment.sizeBytes, 0),
        prepared,
      );
      const attachments = await this.importPreparedSources(prepared);
      const nextIds = new Set(currentIds);
      for (const attachment of attachments) {
        nextIds.add(attachment.attachmentId);
      }
      this.drafts.set(draftId, nextIds);
      return { attachments, draftId };
    });
  }

  public assertDraftMatches(
    draftId: string | undefined,
    expectedAttachmentIds: ReadonlySet<string>,
  ): void {
    if (!draftId) {
      if (expectedAttachmentIds.size > 0) {
        throw new Error('当前消息包含未登记到草稿的本地附件，请重新选择文件。');
      }
      return;
    }
    if (!isChatAttachmentDraftId(draftId)) {
      throw new Error('附件草稿标识无效。');
    }
    const actual = this.drafts.get(draftId);
    if (!actual || !sameIds(actual, expectedAttachmentIds)) {
      throw new Error('附件草稿与当前消息不一致，请重新选择文件。');
    }
  }

  public commitDraft(
    draftId: string | undefined,
    expectedAttachmentIds: ReadonlySet<string>,
  ): void {
    this.assertDraftMatches(draftId, expectedAttachmentIds);
    if (draftId) {
      this.drafts.delete(draftId);
    }
  }

  public removeDraftAttachment(
    draftId: string,
    attachmentId: string,
    retainedIds: ReadonlySet<string>,
  ): Promise<boolean> {
    return this.enqueueMutation(async () => {
      if (!isChatAttachmentDraftId(draftId) || !isChatAttachmentId(attachmentId)) {
        throw new Error('附件草稿或附件标识无效。');
      }
      const draft = this.drafts.get(draftId);
      if (!draft?.has(attachmentId)) {
        return false;
      }
      if (!retainedIds.has(attachmentId)) {
        await rm(this.directoryFor(attachmentId), { force: true, recursive: true });
      }
      draft.delete(attachmentId);
      return true;
    });
  }

  public releaseDraft(draftId: string, retainedIds: ReadonlySet<string>): Promise<number> {
    return this.enqueueMutation(async () => {
      if (!isChatAttachmentDraftId(draftId)) {
        throw new Error('附件草稿标识无效。');
      }
      const draft = this.drafts.get(draftId);
      if (!draft) {
        return 0;
      }
      let deleted = 0;
      for (const attachmentId of draft) {
        if (!retainedIds.has(attachmentId)) {
          await rm(this.directoryFor(attachmentId), { force: true, recursive: true });
          deleted += 1;
        }
      }
      this.drafts.delete(draftId);
      return deleted;
    });
  }

  public get(attachmentId: string): ChatAttachmentView {
    const attachment = this.resolve(attachmentId);
    return {
      attachmentId: attachment.attachmentId,
      fileName: attachment.fileName,
      mediaType: attachment.mediaType,
      sizeBytes: attachment.sizeBytes,
      type: attachment.type,
    };
  }

  public isAvailable(attachmentId: string): boolean {
    try {
      this.resolve(attachmentId);
      return true;
    } catch {
      return false;
    }
  }

  public resolve(attachmentId: string): ResolvedChatAttachment {
    const directory = this.directoryFor(attachmentId);
    const metadata = parseMetadata(
      JSON.parse(readFileSync(path.join(directory, METADATA_FILE_NAME), 'utf8')) as unknown,
      attachmentId,
    );
    const filePath = path.join(directory, PAYLOAD_FILE_NAME);
    const info = lstatSync(filePath);
    if (info.isSymbolicLink() || !info.isFile() || info.size !== metadata.sizeBytes) {
      throw new Error('附件文件已损坏或被替换。');
    }
    return { ...metadata, filePath };
  }

  public readBase64(attachmentId: string): string {
    const attachment = this.resolve(attachmentId);
    return readFileSync(attachment.filePath).toString('base64');
  }

  public async readBase64Async(attachmentId: string): Promise<string> {
    const attachment = this.resolve(attachmentId);
    return (await readFile(attachment.filePath)).toString('base64');
  }

  public delete(attachmentId: string): boolean {
    const directory = this.directoryFor(attachmentId);
    try {
      lstatSync(directory);
    } catch {
      return false;
    }
    rmSync(directory, { force: true, recursive: true });
    return true;
  }

  public deleteMany(attachmentIds: Iterable<string>): void {
    for (const attachmentId of attachmentIds) {
      if (isChatAttachmentId(attachmentId)) {
        this.delete(attachmentId);
      }
    }
  }

  public deleteUnreferenced(
    candidateIds: Iterable<string>,
    retainedIds: ReadonlySet<string>,
  ): void {
    for (const attachmentId of candidateIds) {
      if (!retainedIds.has(attachmentId)) {
        this.delete(attachmentId);
      }
    }
  }

  /**
   * Startup crash recovery. Callers must only invoke this after history was read successfully;
   * otherwise a damaged history index could make valid attachment directories appear orphaned.
   */
  public collectOrphans(
    retainedIds: ReadonlySet<string>,
    minimumAgeMs = 24 * 60 * 60 * 1000,
  ): void {
    if (!Number.isFinite(minimumAgeMs) || minimumAgeMs < 0) {
      throw new Error('附件清理宽限期无效。');
    }
    let entries;
    try {
      entries = readdirSync(this.storageDirectory, { withFileTypes: true });
    } catch {
      return;
    }
    const cutoff = Date.now() - minimumAgeMs;
    for (const entry of entries) {
      const storedAttachment =
        entry.isDirectory() && isChatAttachmentId(entry.name) && !retainedIds.has(entry.name);
      const interruptedImport = entry.isDirectory() && TEMPORARY_IMPORT_PATTERN.test(entry.name);
      if (!storedAttachment && !interruptedImport) {
        continue;
      }
      const directory = path.join(this.storageDirectory, entry.name);
      try {
        if (statSync(directory).mtimeMs <= cutoff) {
          rmSync(directory, { force: true, recursive: true });
        }
      } catch {
        // A concurrent delete already completed the cleanup.
      }
    }
  }

  private assertAggregateLimits(
    currentCount: number,
    currentBytes: number,
    sources: PreparedAttachmentSource[],
  ): void {
    if (currentCount + sources.length > MAX_CHAT_ATTACHMENT_COUNT) {
      throw new Error(`每条消息最多添加 ${MAX_CHAT_ATTACHMENT_COUNT} 个附件。`);
    }
    const totalBytes =
      currentBytes + sources.reduce((total, attachment) => total + attachment.sizeBytes, 0);
    if (totalBytes > MAX_CHAT_ATTACHMENT_TOTAL_BYTES) {
      throw new Error('单条消息的附件总大小不能超过 32 MiB。');
    }
  }

  private async prepareSources(filePaths: string[]): Promise<PreparedAttachmentSource[]> {
    if (
      !Array.isArray(filePaths) ||
      filePaths.length === 0 ||
      filePaths.length > MAX_CHAT_ATTACHMENT_COUNT
    ) {
      throw new Error(`每次最多可导入 ${MAX_CHAT_ATTACHMENT_COUNT} 个附件。`);
    }
    return Promise.all(
      filePaths.map(async (filePath) => {
        if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) {
          throw new Error('附件路径必须是本机绝对路径。');
        }
        const sourceInfo = await lstat(filePath);
        if (sourceInfo.isSymbolicLink() || !sourceInfo.isFile()) {
          throw new Error('附件必须是普通文件，不能是目录或符号链接。');
        }
        const resolvedPath = await realpath(filePath);
        const sizeBytes = (await stat(resolvedPath)).size;
        if (
          !Number.isSafeInteger(sizeBytes) ||
          sizeBytes <= 0 ||
          sizeBytes > MAX_CHAT_ATTACHMENT_BYTES
        ) {
          throw new Error('单个附件必须大于 0 字节且不超过 32 MiB。');
        }
        const fileName = cleanFileName(resolvedPath);
        const media = mediaFor(fileName);
        if (media.type === 'image') inspectSafeImage(await readFile(resolvedPath), fileName);
        return { fileName, realPath: resolvedPath, sizeBytes, ...media };
      }),
    );
  }

  private async importPreparedSources(
    sources: PreparedAttachmentSource[],
  ): Promise<ChatAttachmentView[]> {
    const importedIds: string[] = [];
    await mkdir(this.storageDirectory, { recursive: true });
    try {
      const attachments: ChatAttachmentView[] = [];
      for (const source of sources) {
        const attachmentId = randomUUID();
        const finalDirectory = this.directoryFor(attachmentId);
        const temporaryDirectory = path.join(this.storageDirectory, `.import-${attachmentId}`);
        await mkdir(temporaryDirectory, { recursive: false, mode: 0o700 });
        try {
          const payloadPath = path.join(temporaryDirectory, PAYLOAD_FILE_NAME);
          if (source.bytes) {
            await writeFile(payloadPath, source.bytes, { mode: 0o600 });
          } else if (source.realPath) {
            await copyFile(source.realPath, payloadPath);
          } else {
            throw new Error('附件来源无效。');
          }
          const copiedSize = (await stat(payloadPath)).size;
          if (copiedSize !== source.sizeBytes) {
            throw new Error('附件复制过程中发生变化，请重试。');
          }
          const metadata: StoredChatAttachmentMetadata = {
            attachmentId,
            fileName: source.fileName,
            mediaType: source.mediaType,
            sizeBytes: source.sizeBytes,
            type: source.type,
            version: 1,
          };
          await writeFile(
            path.join(temporaryDirectory, METADATA_FILE_NAME),
            `${JSON.stringify(metadata, null, 2)}\n`,
            { encoding: 'utf8', mode: 0o600 },
          );
          await rename(temporaryDirectory, finalDirectory);
          importedIds.push(attachmentId);
          attachments.push(this.get(attachmentId));
        } catch (error) {
          await rm(temporaryDirectory, { force: true, recursive: true });
          throw error;
        }
      }
      return attachments;
    } catch (error) {
      await Promise.all(
        importedIds.map((attachmentId) =>
          rm(this.directoryFor(attachmentId), { force: true, recursive: true }),
        ),
      );
      throw error;
    }
  }

  private enqueueMutation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationQueue.then(operation, operation);
    this.mutationQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private directoryFor(attachmentId: string): string {
    if (!isChatAttachmentId(attachmentId)) {
      throw new Error('附件标识无效。');
    }
    return path.join(this.storageDirectory, attachmentId);
  }
}
