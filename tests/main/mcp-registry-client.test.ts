import { describe, expect, it, vi } from 'vitest';
import {
  MCP_REGISTRY_ORIGIN,
  MCP_REGISTRY_SERVERS_PATH,
  MCP_REGISTRY_USER_AGENT,
  McpRegistryClient,
  type McpRegistryFetch,
} from '../../src/main/mcp/registry-client';
import { McpRegistryError } from '../../src/main/mcp/registry-errors';

const jsonResponse = (value: unknown, init: ResponseInit = {}): Response =>
  new Response(JSON.stringify(value), {
    headers: { 'content-type': 'application/json', ...init.headers },
    status: init.status ?? 200,
  });

const expectRegistryError = async (
  promise: Promise<unknown>,
  code: McpRegistryError['code'],
): Promise<void> => {
  await expect(promise).rejects.toMatchObject({ code });
};

describe('McpRegistryClient', () => {
  it('traverses every cursor page and passes opaque cursors through URLSearchParams', async () => {
    const opaqueCursor = 'next +/?:&=% 空';
    const timeoutSignal = new AbortController().signal;
    const timeoutFactory = vi.fn(() => timeoutSignal);
    const fetchMock = vi
      .fn<McpRegistryFetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          metadata: { nextCursor: opaqueCursor },
          servers: [{ server: { name: 'io.example/one' } }],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          metadata: { nextCursor: null },
          servers: [{ server: { name: 'io.example/two' } }],
        }),
      );
    const client = new McpRegistryClient({ fetch: fetchMock, timeoutSignal: timeoutFactory });

    const result = await client.fetchAll('2026-08-20T01:02:03.004Z');

    expect(result.pages).toHaveLength(2);
    expect(result.recordCount).toBe(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firstUrl = new URL(String(fetchMock.mock.calls[0]?.[0]));
    const secondUrl = new URL(String(fetchMock.mock.calls[1]?.[0]));
    expect(firstUrl.origin).toBe(MCP_REGISTRY_ORIGIN);
    expect(firstUrl.pathname).toBe(MCP_REGISTRY_SERVERS_PATH);
    expect(firstUrl.searchParams.get('limit')).toBe('50');
    expect(firstUrl.searchParams.get('include_deleted')).toBe('true');
    expect(firstUrl.searchParams.get('updated_since')).toBe('2026-08-20T01:02:03.004Z');
    expect(firstUrl.searchParams.has('cursor')).toBe(false);
    expect(secondUrl.searchParams.get('cursor')).toBe(opaqueCursor);
    const request = fetchMock.mock.calls[0]?.[1];
    expect(request).toMatchObject({
      credentials: 'omit',
      redirect: 'error',
      signal: timeoutSignal,
    });
    expect(new Headers(request?.headers).get('user-agent')).toBe(MCP_REGISTRY_USER_AGENT);
    expect(timeoutFactory).toHaveBeenCalledWith(10_000);
  });

  it('rejects repeated cursors and excess page counts', async () => {
    const repeatedFetch = vi
      .fn<McpRegistryFetch>()
      .mockImplementation(async () =>
        jsonResponse({ metadata: { nextCursor: 'same' }, servers: [] }),
      );
    await expectRegistryError(
      new McpRegistryClient({ fetch: repeatedFetch }).fetchAll(),
      'repeated-cursor',
    );
    expect(repeatedFetch).toHaveBeenCalledTimes(2);

    const boundedFetch = vi
      .fn<McpRegistryFetch>()
      .mockResolvedValue(jsonResponse({ metadata: { nextCursor: 'more' }, servers: [] }));
    await expectRegistryError(
      new McpRegistryClient({
        fetch: boundedFetch,
        limits: { maxPages: 1 },
      }).fetchAll(),
      'page-limit',
    );
    expect(boundedFetch).toHaveBeenCalledTimes(1);
  });

  it('rejects opaque cursors that exceed character or UTF-8 byte bounds', async () => {
    for (const cursor of ['a'.repeat(9), '空'.repeat(3)]) {
      const fetchMock = vi
        .fn<McpRegistryFetch>()
        .mockResolvedValue(jsonResponse({ metadata: { nextCursor: cursor }, servers: [] }));
      await expectRegistryError(
        new McpRegistryClient({
          fetch: fetchMock,
          limits: { maxCursorBytes: 8 },
        }).fetchAll(),
        'cursor-too-large',
      );
      expect(fetchMock).toHaveBeenCalledTimes(1);
    }
  });

  it('rejects redirects, malformed pages, and record-count excess', async () => {
    await expectRegistryError(
      new McpRegistryClient({
        fetch: vi
          .fn<McpRegistryFetch>()
          .mockResolvedValue(
            new Response(null, { headers: { location: 'https://example.invalid' }, status: 302 }),
          ),
      }).fetchAll(),
      'redirect-rejected',
    );
    await expectRegistryError(
      new McpRegistryClient({
        fetch: vi.fn<McpRegistryFetch>().mockResolvedValue(new Response('{broken')),
      }).fetchAll(),
      'malformed-page',
    );
    await expectRegistryError(
      new McpRegistryClient({
        fetch: vi.fn<McpRegistryFetch>().mockResolvedValue(
          new Response(
            new ReadableStream({
              start(controller) {
                controller.error(new Error('stream failed'));
              },
            }),
          ),
        ),
      }).fetchAll(),
      'request-failed',
    );
    await expectRegistryError(
      new McpRegistryClient({
        fetch: vi.fn<McpRegistryFetch>().mockResolvedValue(jsonResponse({ servers: [{}, {}] })),
        limits: { maxRecords: 1 },
      }).fetchAll(),
      'record-limit',
    );
  });

  it('rejects malformed UTF-8 instead of accepting replacement characters', async () => {
    const invalidUtf8 = Buffer.concat([
      Buffer.from('{"servers":["', 'utf8'),
      Buffer.from([0xc3, 0x28]),
      Buffer.from('"]}', 'utf8'),
    ]);
    const fetchMock = vi
      .fn<McpRegistryFetch>()
      .mockResolvedValue(new Response(invalidUtf8, { status: 200 }));

    await expectRegistryError(
      new McpRegistryClient({ fetch: fetchMock }).fetchAll(),
      'malformed-page',
    );
  });

  it('enforces page and aggregate byte limits while streaming response bodies', async () => {
    const page = JSON.stringify({ servers: [] });
    await expectRegistryError(
      new McpRegistryClient({
        fetch: vi.fn<McpRegistryFetch>().mockResolvedValue(new Response(page)),
        limits: { maxPageBytes: Buffer.byteLength(page) - 1 },
      }).fetchAll(),
      'page-too-large',
    );

    const first = JSON.stringify({ metadata: { nextCursor: 'two' }, servers: [] });
    const second = JSON.stringify({ servers: [] });
    const aggregateFetch = vi
      .fn<McpRegistryFetch>()
      .mockResolvedValueOnce(new Response(first))
      .mockResolvedValueOnce(new Response(second));
    await expectRegistryError(
      new McpRegistryClient({
        fetch: aggregateFetch,
        limits: {
          maxAggregateBytes: Buffer.byteLength(first) + Buffer.byteLength(second) - 1,
          maxPageBytes: 1_024,
        },
      }).fetchAll(),
      'aggregate-too-large',
    );
  });

  it('never constructs requests for package or remote alternative URLs', async () => {
    const alternativeUrls = [
      'https://package-registry.invalid/artifact',
      'https://remote-alternative.invalid/mcp',
    ];
    const fetchMock = vi.fn<McpRegistryFetch>().mockResolvedValue(
      jsonResponse({
        servers: [
          {
            server: {
              description: 'Inert catalog text',
              name: 'io.example/inert',
              packages: [
                {
                  identifier: alternativeUrls[0],
                  registryType: 'mcpb',
                  transport: { type: 'stdio' },
                },
              ],
              remotes: [{ type: 'streamable-http', url: alternativeUrls[1] }],
              version: '1.0.0',
            },
          },
        ],
      }),
    );

    await new McpRegistryClient({ fetch: fetchMock }).fetchAll();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const calledUrls = fetchMock.mock.calls.map(([input]) => String(input));
    expect(calledUrls.every((url) => url.startsWith(MCP_REGISTRY_ORIGIN))).toBe(true);
    expect(calledUrls).not.toEqual(expect.arrayContaining(alternativeUrls));
  });
});
