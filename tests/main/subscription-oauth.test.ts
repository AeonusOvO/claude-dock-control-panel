import { createHash } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { authorizeSubscription, refreshSubscription } from '../../src/main/subscriptions/oauth';
import {
  authJson,
  openAuthorization,
  waitForPoll,
  type AuthContext,
} from '../../src/main/subscriptions/http';
import type { SubscriptionProvider } from '../../src/shared/claude/subscriptions';

vi.mock('../../src/main/subscriptions/http', async (original) => ({
  ...(await original<typeof import('../../src/main/subscriptions/http')>()),
  waitForPoll: vi.fn(async (_interval: number, _deadline: number, signal: AbortSignal) =>
    signal.throwIfAborted(),
  ),
}));

const context = (fetch: typeof globalThis.fetch): AuthContext => ({
  fetch,
  signal: new AbortController().signal,
  open: vi.fn(async () => undefined),
  userCode: vi.fn(),
});
const kimiCode = () => ({
  device_code: 'private-device-code',
  user_code: 'USER-CODE',
  verification_uri: 'https://www.kimi.com/code',
  expires_in: 600,
  interval: 5,
});
const token = () => ({
  access_token: 'private-access-token',
  refresh_token: 'private-refresh-token',
  expires_in: 900,
});
afterEach(() => vi.clearAllMocks());

describe('domestic subscription OAuth', () => {
  it('opens Kimi consent, polls with device identity and honors slow_down without exposing device tokens', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(Response.json(kimiCode()))
      .mockResolvedValueOnce(Response.json({ error: 'slow_down' }))
      .mockResolvedValueOnce(Response.json({ error: 'authorization_pending' }, { status: 400 }))
      .mockResolvedValueOnce(Response.json(token()));
    const ctx = context(fetch);
    const result = await authorizeSubscription('kimi-subscription', ctx);
    expect(ctx.open).toHaveBeenCalledWith('https://www.kimi.com/code');
    expect(ctx.userCode).toHaveBeenCalledWith('USER-CODE');
    expect(JSON.stringify(vi.mocked(ctx.userCode).mock.calls)).not.toContain('private');
    expect(vi.mocked(waitForPoll).mock.calls.map(([interval]) => interval)).toEqual([
      5000, 10000, 10000,
    ]);
    const requestHeaders = fetch.mock.calls.map(([, init]) => new Headers(init?.headers));
    expect(new Set(requestHeaders.map((headers) => headers.get('X-Msh-Device-Id'))).size).toBe(1);
    expect(requestHeaders[0]?.get('X-Msh-Platform')).toBe('ClaudeDock');
    expect(new URLSearchParams(String(fetch.mock.calls[1]?.[1]?.body)).get('grant_type')).toContain(
      'device_code',
    );
    expect(result.accessToken).toBe('private-access-token');
    expect(result.deviceId).toBe(requestHeaders[0]?.get('X-Msh-Device-Id'));
  });

  it.each(['minimax-subscription-cn', 'minimax-subscription-global'] as const)(
    'uses same-region MiniMax OAuth with PKCE and verified state: %s',
    async (provider) => {
      const host = provider.endsWith('-cn') ? 'minimaxi.com' : 'minimax.io';
      let challenge = '';
      const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
        const form = new URLSearchParams(String(init?.body));
        if (String(url).endsWith('/device/code')) {
          challenge = form.get('code_challenge')!;
          expect(form.get('code_challenge_method')).toBe('S256');
          return Response.json({
            user_code: 'USER-CODE',
            state: form.get('state'),
            verification_uri: `https://platform.${host}/oauth/authorize`,
            expired_in: Date.now() + 600000,
            interval: 2000,
          });
        }
        expect(createHash('sha256').update(form.get('code_verifier')!).digest('base64url')).toBe(
          challenge,
        );
        return Response.json({
          ...token(),
          status: 'success',
          expired_in: 900,
          resource_url: `https://api.${host}`,
        });
      });
      const ctx = context(fetch);
      const result = await authorizeSubscription(provider, ctx);
      expect(ctx.open).toHaveBeenCalledWith(`https://platform.${host}/oauth/authorize`);
      expect(fetch.mock.calls.map(([url]) => new URL(String(url)).origin)).toEqual([
        `https://account.${host}`,
        `https://account.${host}`,
      ]);
      expect(result.provider).toBe(provider);
      expect(result.expiresAt).toBeGreaterThan(Date.now() + 800000);
    },
  );

  it('rejects MiniMax state substitution before opening any browser', async () => {
    const ctx = context(vi.fn(async () => Response.json({ state: 'wrong' })));
    await expect(authorizeSubscription('minimax-subscription-cn', ctx)).rejects.toThrow('校验失败');
    expect(ctx.open).not.toHaveBeenCalled();
  });

  it.each([
    'https://www.kimi.com.evil.test/code',
    'https://www.kimi.com@evil.test/code',
    'http://www.kimi.com/code',
  ])('rejects untrusted authorization URL: %s', async (url) => {
    const ctx = context(vi.fn());
    await expect(openAuthorization(ctx, url, ['https://www.kimi.com'])).rejects.toThrow('非官方');
    expect(ctx.open).not.toHaveBeenCalled();
  });

  it('does not open a browser for a late response after cancellation', async () => {
    const controller = new AbortController();
    const ctx = context(
      vi.fn(async () => {
        controller.abort();
        return Response.json(kimiCode());
      }),
    );
    ctx.signal = controller.signal;
    await expect(authorizeSubscription('kimi-subscription', ctx)).rejects.toThrow();
    expect(ctx.open).not.toHaveBeenCalled();
  });

  it('never includes token service error descriptions in failures', async () => {
    const ctx = context(
      vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValueOnce(Response.json(kimiCode()))
        .mockResolvedValueOnce(
          Response.json({ error: 'invalid_grant', error_description: 'private-access-token' }),
        ),
    );
    await expect(authorizeSubscription('kimi-subscription', ctx)).rejects.toThrow('授权未成功');
  });

  it.each([900, Math.floor(Date.now() / 1000) + 900, Date.now() + 900000])(
    'refreshes MiniMax and normalizes expiry %s',
    async (expiry) => {
      const fetch = vi.fn<typeof globalThis.fetch>(async () =>
        Response.json({ status: 'success', access_token: 'new-access', expired_in: expiry }),
      );
      const credential = {
        provider: 'minimax-subscription-cn' as const,
        accessToken: 'old-access',
        refreshToken: 'old-refresh',
        expiresAt: Date.now() - 100,
      };
      const fresh = await refreshSubscription(credential, context(fetch));
      expect(fresh.refreshToken).toBe('old-refresh');
      expect(fresh.expiresAt).toBeGreaterThan(Date.now() + 800000);
      expect(fetch.mock.calls[0]?.[0]).toBe('https://account.minimaxi.com/oauth2/token');
      expect(new URLSearchParams(String(fetch.mock.calls[0]?.[1]?.body)).get('grant_type')).toBe(
        'refresh_token',
      );
      expect(credential.accessToken).toBe('old-access');
    },
  );

  it('refuses a token resource in another MiniMax region', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json({
        ...token(),
        status: 'success',
        expired_in: 900,
        resource_url: 'https://api.minimax.io',
      }),
    );
    await expect(
      refreshSubscription(
        {
          provider: 'minimax-subscription-cn',
          accessToken: 'old',
          refreshToken: 'refresh',
          expiresAt: 1,
        },
        context(fetch),
      ),
    ).rejects.toThrow('区域不匹配');
  });

  it('bounds authorization response bodies and cancels the reader', async () => {
    const cancel = vi.fn();
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(1024 * 1024 + 1));
        },
        cancel,
      }),
    );
    await expect(
      authJson(context(vi.fn(async () => response)), 'https://auth.kimi.com'),
    ).rejects.toThrow('响应过大');
    expect(cancel).toHaveBeenCalled();
  });
});

describe('GLM ZCode subscription authorization', () => {
  const businessResponse = (url: string, init?: RequestInit): Response => {
    if (url.endsWith('/api/monitor/usage/quota/limit')) {
      expect(new Headers(init?.headers).get('authorization')).toBe('key.secret');
      return Response.json({
        code: 200,
        success: true,
        data: { limits: [{ type: 'TOKENS_LIMIT', percentage: 12 }] },
      });
    }
    if (url.endsWith('/getCustomerInfo'))
      return Response.json({
        code: 0,
        data: {
          organizations: [
            {
              organizationId: 'org',
              organizationName: '默认机构',
              projects: [{ projectId: 'project', projectName: '默认项目' }],
            },
          ],
        },
      });
    if (url.endsWith('/copy/key')) return Response.json({ code: 0, data: { secretKey: 'secret' } });
    if (url.endsWith('/api_keys') && init?.method !== 'POST')
      return Response.json({ code: 0, data: [{ name: 'claudedock-subscription', apiKey: 'key' }] });
    if (url.endsWith('/api/auth/z/login'))
      return Response.json({ code: 0, data: { access_token: 'business-token' } });
    throw new Error(`Unexpected fixture path ${new URL(url).pathname}`);
  };

  it('uses browser consent and the official business key flow for global GLM', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
      const path = String(url);
      if (path.endsWith('/cli/init'))
        return Response.json({
          code: 0,
          data: { flow_id: 'flow', authorize_url: 'https://chat.z.ai/auth', poll_token: 'poll' },
        });
      if (path.endsWith('/poll/flow'))
        return Response.json({
          code: 0,
          data: { status: 'ready', zai: { access_token: 'account-token' } },
        });
      return businessResponse(path, init);
    });
    const ctx = context(fetch);
    const result = await authorizeSubscription('glm-subscription-global', ctx);
    expect(result.accessToken).toBe('key.secret');
    expect(ctx.open).toHaveBeenCalledWith('https://chat.z.ai/auth');
    expect(JSON.stringify(result)).not.toMatch(/account-token|business-token|poll/);
    expect(fetch.mock.calls.some(([url]) => String(url).includes('zcode-plan'))).toBe(false);
  });

  it('binds a fresh loopback socket and ignores wrong-state callbacks before accepting the valid one', async () => {
    let expectedState = '';
    const fetchMock = vi.fn<typeof globalThis.fetch>(async (url, init) => {
      if (String(url).endsWith('/oauth/token')) {
        expect(JSON.parse(String(init?.body))).toMatchObject({
          code: 'approved',
          state: expectedState,
          provider: 'bigmodel',
        });
        return Response.json({ code: 0, data: { bigmodel: { access_token: 'account-token' } } });
      }
      return businessResponse(String(url), init);
    });
    const ctx = context(fetchMock);
    let callbackUrl = '';
    ctx.open = async (url) => {
      const auth = new URL(url);
      expectedState = auth.searchParams.get('state')!;
      callbackUrl = auth.searchParams.get('redirect')!;
      const malformedStatus = await new Promise<number | undefined>((resolve, reject) => {
        const req = httpRequest(
          { hostname: '127.0.0.1', port: new URL(callbackUrl).port, path: 'http://[invalid' },
          (response) => {
            response.resume();
            response.on('end', () => resolve(response.statusCode));
          },
        );
        req.on('error', reject);
        req.end();
      });
      expect(malformedStatus).toBe(400);
      const wrong = await globalThis.fetch(`${callbackUrl}?state=wrong&authCode=bad`);
      expect(wrong.status).toBe(400);
      await wrong.text();
      const correct = await globalThis.fetch(
        `${callbackUrl}?state=${expectedState}&authCode=approved`,
      );
      expect(correct.status).toBe(200);
      await correct.text();
    };
    const result = await authorizeSubscription('glm-subscription-cn', ctx);
    expect(result.accessToken).toBe('key.secret');
    await expect(globalThis.fetch(callbackUrl)).rejects.toThrow();
  });

  it('closes the GLM callback when the user cancels and never exchanges a code', async () => {
    const controller = new AbortController();
    const ctx = context(vi.fn());
    ctx.signal = controller.signal;
    let redirect = '';
    ctx.open = async (url) => {
      redirect = new URL(url).searchParams.get('redirect')!;
      controller.abort();
    };
    await expect(authorizeSubscription('glm-subscription-cn', ctx)).rejects.toThrow();
    expect(ctx.fetch).not.toHaveBeenCalled();
    await expect(globalThis.fetch(redirect)).rejects.toThrow();
  });

  it('settles cancellation while the GLM callback socket is still binding', async () => {
    const controller = new AbortController();
    const ctx = context(vi.fn());
    ctx.signal = controller.signal;
    const pending = authorizeSubscription('glm-subscription-cn', ctx);
    controller.abort();
    await expect(pending).rejects.toThrow();
    expect(ctx.open).not.toHaveBeenCalled();
    expect(ctx.fetch).not.toHaveBeenCalled();
  });

  it('creates at most one application-owned GLM key and never changes unrelated keys', async () => {
    let listed = false;
    const fetchMock = vi.fn<typeof globalThis.fetch>(async (url, init) => {
      const value = String(url);
      if (value.endsWith('/cli/init'))
        return Response.json({
          code: 0,
          data: { flow_id: 'flow', authorize_url: 'https://chat.z.ai/auth' },
        });
      if (value.endsWith('/poll/flow'))
        return Response.json({
          code: 0,
          data: { status: 'ready', zai: { access_token: 'account-token' } },
        });
      if (value.endsWith('/api_keys') && init?.method === 'POST') {
        expect(JSON.parse(String(init.body))).toEqual({ name: 'claudedock-subscription' });
        return Response.json({ code: 0, data: {} });
      }
      if (value.endsWith('/api_keys') && !listed) {
        listed = true;
        return Response.json({ code: 0, data: [{ name: 'zcode-api-key', apiKey: 'unrelated' }] });
      }
      return businessResponse(value, init);
    });
    await authorizeSubscription(
      'glm-subscription-global' as SubscriptionProvider,
      context(fetchMock),
    );
    expect(
      fetchMock.mock.calls.filter(
        ([url, init]) => String(url).endsWith('/api_keys') && init?.method === 'POST',
      ),
    ).toHaveLength(1);
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/copy/unrelated'))).toBe(
      false,
    );
  });

  it.each([
    { limits: [], message: '未检测到有效' },
    { limits: [{ type: 'TOKENS_LIMIT', percentage: 100 }], message: '额度已用尽' },
    { limits: [{ type: 'TOKENS_LIMIT', percentage: 'unknown' }], message: '未检测到有效' },
  ])(
    'refuses GLM inference when Coding Plan cannot be confirmed: $message',
    async ({ limits, message }) => {
      const fetchMock = vi.fn<typeof globalThis.fetch>(async (url, init) => {
        const value = String(url);
        if (value.endsWith('/cli/init'))
          return Response.json({
            code: 0,
            data: { flow_id: 'flow', authorize_url: 'https://chat.z.ai/auth' },
          });
        if (value.endsWith('/poll/flow'))
          return Response.json({
            code: 0,
            data: { status: 'ready', zai: { access_token: 'account-token' } },
          });
        if (value.endsWith('/quota/limit'))
          return Response.json({ code: 200, success: true, data: { limits } });
        return businessResponse(value, init);
      });
      await expect(
        authorizeSubscription('glm-subscription-global', context(fetchMock)),
      ).rejects.toThrow(message);
      expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/messages'))).toBe(false);
    },
  );
});
