import { TextDecoder } from 'node:util';
import { registryError, McpRegistryError } from './registry-errors';
import type { McpRegistryClientLimits, McpRegistryPageSet } from './registry-types';

export const MCP_REGISTRY_ORIGIN = 'https://registry.modelcontextprotocol.io';
export const MCP_REGISTRY_SERVERS_PATH = '/v0.1/servers';
export const MCP_REGISTRY_USER_AGENT = 'ClaudeDock-MCP-Registry/1';

export const DEFAULT_MCP_REGISTRY_LIMITS: Readonly<McpRegistryClientLimits> = {
  maxAggregateBytes: 64 * 1024 * 1024,
  maxCursorBytes: 8 * 1024,
  maxPageBytes: 4 * 1024 * 1024,
  maxPages: 200,
  maxRecords: 10_000,
  pageLimit: 50,
  timeoutMs: 10_000,
};

export type McpRegistryFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface McpRegistryClientOptions {
  fetch: McpRegistryFetch;
  limits?: Partial<McpRegistryClientLimits>;
  timeoutSignal?: (timeoutMs: number) => AbortSignal;
}

interface ParsedPage {
  nextCursor?: string;
  servers: unknown[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const positiveSafeInteger = (value: number, name: string): number => {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive safe integer.`);
  }
  return value;
};

const resolveLimits = (
  overrides: Partial<McpRegistryClientLimits> | undefined,
): McpRegistryClientLimits => {
  const limits = { ...DEFAULT_MCP_REGISTRY_LIMITS, ...overrides };
  return {
    maxAggregateBytes: positiveSafeInteger(limits.maxAggregateBytes, 'maxAggregateBytes'),
    maxCursorBytes: positiveSafeInteger(limits.maxCursorBytes, 'maxCursorBytes'),
    maxPageBytes: positiveSafeInteger(limits.maxPageBytes, 'maxPageBytes'),
    maxPages: positiveSafeInteger(limits.maxPages, 'maxPages'),
    maxRecords: positiveSafeInteger(limits.maxRecords, 'maxRecords'),
    pageLimit: positiveSafeInteger(limits.pageLimit, 'pageLimit'),
    timeoutMs: positiveSafeInteger(limits.timeoutMs, 'timeoutMs'),
  };
};

const rejectOversizedContentLength = (
  response: Response,
  limits: McpRegistryClientLimits,
  aggregateBytes: number,
): void => {
  const raw = response.headers.get('content-length');
  if (!raw || !/^\d+$/.test(raw)) return;
  const length = Number(raw);
  if (!Number.isSafeInteger(length)) {
    throw registryError('bounds', 'page-too-large', 'Registry page length is not safely bounded.');
  }
  if (length > limits.maxPageBytes) {
    throw registryError('bounds', 'page-too-large', 'Registry page exceeds the byte limit.');
  }
  if (aggregateBytes + length > limits.maxAggregateBytes) {
    throw registryError(
      'bounds',
      'aggregate-too-large',
      'Registry synchronization exceeds the aggregate byte limit.',
    );
  }
};

const cancelReader = async (reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> => {
  try {
    await reader.cancel();
  } catch {
    // The bounded read is already failing; cancellation errors carry no durable state.
  }
};

const readBoundedBody = async (
  response: Response,
  limits: McpRegistryClientLimits,
  aggregateBytes: number,
): Promise<Buffer> => {
  rejectOversizedContentLength(response, limits, aggregateBytes);
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let pageBytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      pageBytes += chunk.value.byteLength;
      if (pageBytes > limits.maxPageBytes) {
        await cancelReader(reader);
        throw registryError('bounds', 'page-too-large', 'Registry page exceeds the byte limit.');
      }
      if (aggregateBytes + pageBytes > limits.maxAggregateBytes) {
        await cancelReader(reader);
        throw registryError(
          'bounds',
          'aggregate-too-large',
          'Registry synchronization exceeds the aggregate byte limit.',
        );
      }
      chunks.push(Buffer.from(chunk.value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, pageBytes);
};

const parsePage = (bytes: Buffer, maxCursorBytes: number): ParsedPage => {
  let value: unknown;
  try {
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    value = JSON.parse(decoded) as unknown;
  } catch (error) {
    throw registryError('parse', 'malformed-page', 'Registry page is not valid UTF-8 JSON.', error);
  }
  if (!isRecord(value) || !Array.isArray(value.servers)) {
    throw registryError('parse', 'malformed-page', 'Registry page has an invalid shape.');
  }
  const metadata = value.metadata;
  if (metadata !== undefined && metadata !== null && !isRecord(metadata)) {
    throw registryError('parse', 'malformed-page', 'Registry page metadata is invalid.');
  }
  const nextCursor = isRecord(metadata) ? metadata.nextCursor : undefined;
  if (nextCursor !== undefined && nextCursor !== null && typeof nextCursor !== 'string') {
    throw registryError('parse', 'malformed-page', 'Registry next cursor is invalid.');
  }
  if (
    typeof nextCursor === 'string' &&
    (nextCursor.length > maxCursorBytes || Buffer.byteLength(nextCursor, 'utf8') > maxCursorBytes)
  ) {
    throw registryError(
      'bounds',
      'cursor-too-large',
      'Registry next cursor exceeds its byte limit.',
    );
  }
  return {
    nextCursor: typeof nextCursor === 'string' && nextCursor.length > 0 ? nextCursor : undefined,
    servers: value.servers,
  };
};

const assertOfficialResponse = (response: Response, requestUrl: URL): void => {
  if (response.redirected || (response.status >= 300 && response.status < 400)) {
    throw registryError('fetch', 'redirect-rejected', 'Registry redirects are rejected.');
  }
  if (response.url) {
    let responseUrl: URL;
    try {
      responseUrl = new URL(response.url);
    } catch (error) {
      throw registryError('fetch', 'redirect-rejected', 'Registry response URL is invalid.', error);
    }
    if (responseUrl.href !== requestUrl.href) {
      throw registryError('fetch', 'redirect-rejected', 'Registry response changed its URL.');
    }
  }
  if (!response.ok) {
    throw registryError('fetch', 'http-error', `Registry returned HTTP ${response.status}.`);
  }
};

export class McpRegistryClient {
  private readonly fetchImplementation: McpRegistryFetch;
  private readonly limits: McpRegistryClientLimits;
  private readonly timeoutSignal: (timeoutMs: number) => AbortSignal;

  public constructor(options: McpRegistryClientOptions) {
    this.fetchImplementation = options.fetch;
    this.limits = resolveLimits(options.limits);
    this.timeoutSignal = options.timeoutSignal ?? ((timeoutMs) => AbortSignal.timeout(timeoutMs));
  }

  public async fetchAll(updatedSince?: string): Promise<McpRegistryPageSet> {
    const pages: unknown[][] = [];
    const seenCursors = new Set<string>();
    let aggregateBytes = 0;
    let cursor: string | undefined;
    let recordCount = 0;

    for (let pageNumber = 1; pageNumber <= this.limits.maxPages; pageNumber += 1) {
      const requestUrl = this.createPageUrl(cursor, updatedSince);
      let response: Response;
      try {
        response = await this.fetchImplementation(requestUrl, {
          credentials: 'omit',
          headers: {
            accept: 'application/json',
            'user-agent': MCP_REGISTRY_USER_AGENT,
          },
          redirect: 'error',
          signal: this.timeoutSignal(this.limits.timeoutMs),
        });
      } catch (error) {
        if (error instanceof McpRegistryError) throw error;
        throw registryError('fetch', 'request-failed', 'Registry request failed.', error);
      }
      assertOfficialResponse(response, requestUrl);
      let bytes: Buffer;
      try {
        bytes = await readBoundedBody(response, this.limits, aggregateBytes);
      } catch (error) {
        if (error instanceof McpRegistryError) throw error;
        throw registryError('fetch', 'request-failed', 'Registry response body failed.', error);
      }
      aggregateBytes += bytes.length;
      const page = parsePage(bytes, this.limits.maxCursorBytes);
      recordCount += page.servers.length;
      if (recordCount > this.limits.maxRecords) {
        throw registryError('bounds', 'record-limit', 'Registry record limit was exceeded.');
      }
      pages.push(page.servers);
      if (!page.nextCursor) {
        return { pages, recordCount, totalBytes: aggregateBytes };
      }
      if (seenCursors.has(page.nextCursor)) {
        throw registryError('bounds', 'repeated-cursor', 'Registry repeated an opaque cursor.');
      }
      seenCursors.add(page.nextCursor);
      cursor = page.nextCursor;
    }

    throw registryError('bounds', 'page-limit', 'Registry page limit was exceeded.');
  }

  private createPageUrl(cursor: string | undefined, updatedSince: string | undefined): URL {
    const url = new URL(MCP_REGISTRY_SERVERS_PATH, MCP_REGISTRY_ORIGIN);
    if (url.protocol !== 'https:' || url.origin !== MCP_REGISTRY_ORIGIN) {
      throw registryError('fetch', 'request-failed', 'Registry origin invariant failed.');
    }
    url.searchParams.set('limit', String(this.limits.pageLimit));
    url.searchParams.set('include_deleted', 'true');
    if (updatedSince !== undefined) url.searchParams.set('updated_since', updatedSince);
    if (cursor !== undefined) url.searchParams.set('cursor', cursor);
    return url;
  }
}
