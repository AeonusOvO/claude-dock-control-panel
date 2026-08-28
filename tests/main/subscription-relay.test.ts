import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SubscriptionCredential } from '../../src/main/subscriptions/catalog';
import { SubscriptionError } from '../../src/main/subscriptions/http';
import { refreshSubscription } from '../../src/main/subscriptions/oauth';
import { SubscriptionRelay, type SubscriptionNetwork } from '../../src/main/subscriptions/relay';
import { SubscriptionVault } from '../../src/main/subscriptions/vault';

const roots: string[] = [];
const relays: SubscriptionRelay[] = [];
const encryption = {
  isEncryptionAvailable: () => true,
  encryptString: vi.fn((value: string) => Buffer.from(value).reverse()),
  decryptString: (value: Buffer) => Buffer.from(value).reverse().toString('utf8'),
};
const temporary = () => {
  const root = mkdtempSync(path.join(tmpdir(), 'claudedock-subscription-'));
  roots.push(root);
  return root;
};
const network = (fetch: typeof globalThis.fetch): SubscriptionNetwork => ({
  fetch,
  network: async (_url, operation, signal) => {
    signal.throwIfAborted();
    return operation();
  },
});
const credential = (
  accessToken = 'private-access',
  expiresAt = Date.now() + 900000,
): SubscriptionCredential => ({
  provider: 'kimi-subscription',
  accessToken,
  refreshToken: 'private-refresh',
  expiresAt,
});
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const create = async (
  upstream = vi.fn<typeof fetch>(async () =>
    Response.json({ content: [{ type: 'text', text: 'ok' }] }),
  ),
  refresh: typeof refreshSubscription = refreshSubscription,
  root = temporary(),
) => {
  const vault = new SubscriptionVault(root, encryption);
  const inference = network(upstream);
  const access = vi.spyOn(inference, 'network');
  const relay = new SubscriptionRelay(vault, network(vi.fn()), inference, refresh);
  relays.push(relay);
  await relay.ensureRunning();
  return { relay, upstream, vault, root, access };
};
const request = (base: string, key: string, init: RequestInit = {}, route = '/v1/messages') =>
  fetch(`${base}${route}`, {
    method: 'POST',
    body: JSON.stringify({
      model: 'kimi-for-coding',
      max_tokens: 1,
      messages: [{ role: 'user', content: '.' }],
    }),
    ...init,
    headers: {
      authorization: `Bearer ${key}`,
      'content-type': 'application/json',
      connection: 'close',
      ...Object.fromEntries(new Headers(init.headers)),
    },
  });

afterEach(async () => {
  await Promise.all(relays.splice(0).map((relay) => relay.shutdownForQuit()));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('embedded subscription relay and vault', () => {
  it('authenticates loopback callers and rejects browsers, unknown slots and arbitrary routes before forwarding', async () => {
    const { relay, upstream } = await create();
    const slot = relay.addCandidate(credential());
    const base = relay.baseUrl(slot.id);
    const bad = await request(base, 'bad');
    expect(bad.status).toBe(401);
    await bad.text();
    const browser = await request(base, slot.clientKey, {
      headers: { Authorization: `Bearer ${slot.clientKey}`, Origin: 'https://evil.example' },
    });
    expect(browser.status).toBe(401);
    await browser.text();
    const unknown = await request(relay.baseUrl('a'.repeat(32)), slot.clientKey);
    expect(unknown.status).toBe(401);
    await unknown.text();
    expect(upstream).not.toHaveBeenCalled();
    const valid = await request(base, slot.clientKey, {
      headers: {
        Authorization: `Bearer ${slot.clientKey}`,
        Cookie: 'must-not-forward',
        'X-Api-Key': 'must-not-forward',
      },
    });
    expect(valid.status).toBe(200);
    await valid.text();
    expect(upstream.mock.calls[0]?.[0]).toBe('https://api.kimi.com/coding/v1/messages');
    const headers = new Headers(upstream.mock.calls[0]?.[1]?.headers);
    expect(headers.get('Authorization')).toBe('Bearer private-access');
    expect(headers.has('cookie')).toBe(false);
    expect(headers.has('x-api-key')).toBe(false);
    expect(JSON.stringify(upstream.mock.calls)).not.toContain(slot.clientKey);
  });

  it('coalesces simultaneous rotating-token refreshes and persists the replacement before forwarding', async () => {
    const gate = deferred<SubscriptionCredential>();
    const refresh = vi.fn<typeof refreshSubscription>(() => gate.promise);
    const { relay, vault, upstream } = await create(undefined, refresh);
    const slot = relay.addCandidate(credential('old', Date.now() - 100));
    relay.persist(slot.id);
    const requests = Array.from({ length: 12 }, () =>
      request(relay.baseUrl(slot.id), slot.clientKey),
    );
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledOnce());
    gate.resolve(credential('new'));
    const responses = await Promise.all(requests);
    expect(responses.every((response) => response.status === 200)).toBe(true);
    await Promise.all(responses.map((response) => response.text()));
    expect(refresh).toHaveBeenCalledOnce();
    expect(vault.load().slots[0]?.credential.accessToken).toBe('new');
    expect(
      upstream.mock.calls.every(
        ([, init]) => new Headers(init?.headers).get('Authorization') === 'Bearer new',
      ),
    ).toBe(true);
  });

  it('keeps a shared refresh alive when one caller disconnects', async () => {
    const gate = deferred<SubscriptionCredential>();
    const refresh = vi.fn<typeof refreshSubscription>(() => gate.promise);
    const { relay, upstream, access } = await create(undefined, refresh);
    const slot = relay.addCandidate(credential('old', Date.now() - 100));
    const controller = new AbortController();
    const cancelled = request(relay.baseUrl(slot.id), slot.clientKey, {
      signal: controller.signal,
    }).catch(() => undefined);
    const survivor = request(relay.baseUrl(slot.id), slot.clientKey);
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledOnce());
    controller.abort();
    await cancelled;
    await vi.waitFor(() =>
      expect(access.mock.calls.some(([, , signal]) => signal.aborted)).toBe(true),
    );
    expect(refresh.mock.calls[0]?.[1].signal.aborted).toBe(false);
    gate.resolve(credential('new'));
    const response = await survivor;
    expect(response.status).toBe(200);
    await response.text();
    expect(refresh).toHaveBeenCalledOnce();
    expect(upstream).toHaveBeenCalledOnce();
  });

  it('shares forced refresh after concurrent upstream rejections of an unexpired token', async () => {
    const gate = deferred<SubscriptionCredential>();
    const refresh = vi.fn<typeof refreshSubscription>(() => gate.promise);
    const upstream = vi.fn<typeof fetch>(async (_url, init) =>
      new Headers(init?.headers).get('authorization') === 'Bearer old'
        ? new Response('', { status: 401 })
        : Response.json({ content: [{ type: 'text', text: 'ok' }] }),
    );
    const { relay } = await create(upstream, refresh);
    const slot = relay.addCandidate(credential('old'));
    const pending = Array.from({ length: 6 }, () =>
      request(relay.baseUrl(slot.id), slot.clientKey),
    );
    await vi.waitFor(() => expect(upstream).toHaveBeenCalledTimes(6));
    expect(refresh).toHaveBeenCalledOnce();
    gate.resolve(credential('new'));
    const responses = await Promise.all(pending);
    expect(responses.every((response) => response.status === 200)).toBe(true);
    await Promise.all(responses.map((response) => response.text()));
    expect(refresh).toHaveBeenCalledOnce();
  });

  it('accepts Claude SDK beta messages, token counting and model discovery but rejects arbitrary queries', async () => {
    const upstream = vi.fn<typeof fetch>(async (url) =>
      String(url).endsWith('/models')
        ? Response.json({ data: [{ id: 'kimi-for-coding' }] })
        : Response.json({ input_tokens: 1 }),
    );
    const { relay } = await create(upstream);
    const slot = relay.addCandidate(credential());
    const base = relay.baseUrl(slot.id);
    for (const route of ['/v1/messages?beta=true', '/v1/messages/count_tokens?beta=true']) {
      const response = await request(
        base,
        slot.clientKey,
        { headers: { 'anthropic-beta': 'tools-2024-04-04' } },
        route,
      );
      expect(response.status).toBe(200);
      await response.text();
      const sent = upstream.mock.calls.at(-1)!;
      expect(String(sent[0])).toBe('https://api.kimi.com/coding' + route);
      expect(new Headers(sent[1]?.headers).get('anthropic-beta')).toBe('tools-2024-04-04');
    }
    const models = await request(
      base,
      slot.clientKey,
      { method: 'GET', body: undefined },
      '/v1/models',
    );
    expect(await models.json()).toMatchObject({
      data: [{ id: 'kimi-for-coding' }],
      has_more: false,
    });
    const invalid = await request(base, slot.clientKey, {}, '/v1/messages?target=elsewhere');
    expect(invalid.status).toBe(401);
    await invalid.text();
    expect(upstream).toHaveBeenCalledTimes(3);
  });

  it('retains old account bindings when a new account connects, including after a restart', async () => {
    const { relay, vault, root } = await create();
    const first = relay.addCandidate(credential('account-A'));
    relay.persist(first.id);
    const second = relay.addCandidate(credential('account-B'));
    relay.persist(second.id);
    const oldBase = relay.baseUrl(first.id);
    await relay.shutdownForQuit();
    const restarted = await create(undefined, undefined, root);
    expect(restarted.relay.baseUrl(first.id)).toBe(oldBase);
    for (const slot of [first, second]) {
      const response = await request(restarted.relay.baseUrl(slot.id), slot.clientKey);
      expect(response.status).toBe(200);
      await response.text();
    }
    expect(
      restarted.upstream.mock.calls.map(([, init]) =>
        new Headers(init?.headers).get('Authorization'),
      ),
    ).toEqual(['Bearer account-A', 'Bearer account-B']);
    expect(vault.load().slots).toHaveLength(2);
    const file = readFileSync(path.join(root, 'managed-subscriptions/credentials.enc'), 'utf8');
    expect(file).not.toMatch(/account-A|account-B|private-refresh/);
  });

  it('never changes a persisted port or sends credentials to another process that owns it', async () => {
    const root = temporary();
    const foreign = createServer((_req, res) => res.end('unrelated'));
    await new Promise<void>((resolve) => foreign.listen(18540, '127.0.0.1', resolve));
    try {
      const vault = new SubscriptionVault(root, encryption);
      vault.setPort(18540);
      const relay = new SubscriptionRelay(vault, network(vi.fn()), network(vi.fn()));
      relays.push(relay);
      await expect(relay.ensureRunning()).rejects.toThrow('端口不可用');
      expect(vault.load().port).toBe(18540);
    } finally {
      await new Promise<void>((resolve) => foreign.close(() => resolve()));
    }
  });

  it('streams native Anthropic responses unchanged', async () => {
    const sse =
      'event: message_start\ndata: {"type":"message_start"}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n';
    const { relay } = await create(
      vi.fn(async () => new Response(sse, { headers: { 'Content-Type': 'text/event-stream' } })),
    );
    const slot = relay.addCandidate(credential());
    const response = await request(relay.baseUrl(slot.id), slot.clientKey);
    expect(response.headers.get('Content-Type')).toBe('text/event-stream');
    expect(await response.text()).toBe(sse);
  });

  it('returns quota errors without falling back or revealing an upstream error body', async () => {
    const { relay, upstream } = await create(
      vi.fn(async () =>
        Response.json(
          { error: { message: 'private-access and account-details' } },
          { status: 429 },
        ),
      ),
    );
    const slot = relay.addCandidate(credential());
    const response = await request(relay.baseUrl(slot.id), slot.clientKey);
    expect(response.status).toBe(429);
    expect(await response.text()).not.toMatch(/private-access|account-details/);
    expect(upstream).toHaveBeenCalledOnce();
  });

  it('quarantines a rejected refresh token rather than retrying it for every message', async () => {
    const refresh = vi.fn<typeof refreshSubscription>(async () => {
      throw new SubscriptionError('请重新登录。', 401);
    });
    const { relay, upstream } = await create(undefined, refresh);
    const slot = relay.addCandidate(credential('old', Date.now() - 100));
    for (let i = 0; i < 2; i += 1) {
      const response = await request(relay.baseUrl(slot.id), slot.clientKey);
      expect(response.status).toBe(401);
      await response.text();
    }
    expect(refresh).toHaveBeenCalledOnce();
    expect(upstream).not.toHaveBeenCalled();
  });

  it('stops refreshing when the resource server also rejects the replacement token', async () => {
    const refresh = vi.fn<typeof refreshSubscription>(async () => credential('new'));
    const upstream = vi.fn<typeof fetch>(async () => new Response('', { status: 401 }));
    const { relay } = await create(upstream, refresh);
    const slot = relay.addCandidate(credential('old'));
    for (let i = 0; i < 2; i += 1) {
      const response = await request(relay.baseUrl(slot.id), slot.clientKey);
      expect(response.status).toBe(401);
      await response.text();
    }
    expect(refresh).toHaveBeenCalledOnce();
    expect(upstream).toHaveBeenCalledTimes(2);
  });

  it('discards failed candidates and refuses late refresh writes during shutdown', async () => {
    const gate = deferred<SubscriptionCredential>();
    const refresh = vi.fn<typeof refreshSubscription>(() => gate.promise);
    const { relay, vault } = await create(undefined, refresh);
    const slot = relay.addCandidate(credential('old', Date.now() - 100));
    relay.persist(slot.id);
    const pending = request(relay.baseUrl(slot.id), slot.clientKey).catch(() => undefined);
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledOnce());
    relay.shutdown();
    gate.resolve(credential('late'));
    await relay.shutdownForQuit();
    await pending;
    expect(vault.load().slots[0]?.credential.accessToken).toBe('old');
  });

  it('uses a provider catalog only when model discovery is unsupported, never on bad credentials', async () => {
    const upstream = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('', { status: 404 }))
      .mockResolvedValueOnce(new Response('', { status: 401 }));
    const { relay } = await create(upstream);
    const slot = relay.addCandidate(credential());
    expect(await relay.discoverModels(slot.id, new AbortController().signal)).toEqual([
      'kimi-for-coding',
    ]);
    await expect(relay.discoverModels(slot.id, new AbortController().signal)).rejects.toThrow(
      '检查套餐',
    );
    relay.discard(slot.id);
    const response = await request(relay.baseUrl(slot.id), slot.clientKey);
    expect(response.status).toBe(401);
    await response.text();
  });

  it('refuses unencrypted storage and leaves a corrupt vault untouched', () => {
    const root = temporary();
    expect(() =>
      new SubscriptionVault(root, { ...encryption, isEncryptionAvailable: () => false }).load(),
    ).toThrow('加密不可用');
    const vault = new SubscriptionVault(root, encryption);
    vault.setPort(18520);
    const file = path.join(root, 'managed-subscriptions/credentials.enc');
    writeFileSync(file, 'corrupt');
    expect(() => new SubscriptionVault(root, encryption).load()).toThrow('无法读取');
    expect(readFileSync(file, 'utf8')).toBe('corrupt');
  });
});
