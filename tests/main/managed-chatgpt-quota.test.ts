import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ManagedChatGptQuotaReader,
  parseManagedChatGptQuota,
} from '../../src/main/claude/managed-chatgpt-quota';
import { ManagedChatGptGateway } from '../../src/main/claude/managed-chatgpt-gateway';
import { BusyRegistry } from '../../src/main/coordination/busy-registry';
import { createManagedQuotaFixture, quotaPayload } from '../helpers/managed-quota-fixture';

const roots: string[] = [];
const readers: ManagedChatGptQuotaReader[] = [];
afterEach(async () => {
  for (const reader of readers.splice(0)) reader.invalidate();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const fixture = async (fetchImplementation: typeof fetch, canRead = () => true) => {
  const result = await createManagedQuotaFixture();
  roots.push(result.root);
  const reader = new ManagedChatGptQuotaReader(result.authDirectory, fetchImplementation, canRead);
  readers.push(reader);
  return { ...result, reader };
};
const awaitFetch = async (fetcher: ReturnType<typeof vi.fn>) => {
  for (let index = 0; index < 10000 && !fetcher.mock.calls.length; index++) await setImmediate();
  expect(fetcher).toHaveBeenCalledOnce();
};

describe('ChatGPT quota compatibility adapter', () => {
  it('projects actual windows and reset times, including zero and full usage', () => {
    const payload = quotaPayload();
    expect(parseManagedChatGptQuota(payload, 'gpt-5.3-codex')).toEqual([
      { label: '5 小时', usedPercent: 37, resetsAt: 2000000000, windowDurationMins: 300 },
      { label: '7 天', usedPercent: 62.5, resetsAt: 2000600000, windowDurationMins: 10080 },
    ]);
    payload.rate_limit.primary_window.used_percent = 0;
    payload.rate_limit.secondary_window.used_percent = 100;
    expect(parseManagedChatGptQuota(payload, '')?.map((window) => window.usedPercent)).toEqual([
      0, 100,
    ]);
  });

  it('uses reported durations and relative resets without inventing a five-hour allowance', () => {
    expect(
      parseManagedChatGptQuota(
        {
          rate_limit: {
            primary_window: {
              used_percent: 12,
              limit_window_seconds: 900,
              reset_after_seconds: 100,
            },
          },
        },
        '',
        2000000000000,
      ),
    ).toEqual([
      { label: '15 分钟', usedPercent: 12, resetsAt: 2000000100, windowDurationMins: 15 },
    ]);
  });

  it('selects an explicit model bucket and never substitutes the general quota for Spark', () => {
    const payload = quotaPayload();
    expect(parseManagedChatGptQuota(payload, 'gpt-5.3-codex-spark')).toEqual([]);
    expect(
      parseManagedChatGptQuota(
        {
          ...payload,
          additional_rate_limits: [
            {
              limit_name: 'GPT-5.3-Codex-Spark',
              rate_limit: { primary_window: { used_percent: 90, limit_window_seconds: 3600 } },
            },
          ],
        },
        'gpt-5.3-codex-spark',
      ),
    ).toEqual([{ label: '1 小时', usedPercent: 90, resetsAt: undefined, windowDurationMins: 60 }]);
  });

  it.each([
    null,
    {},
    { plan_type: 'pro', credits: { balance: 99, unlimited: true } },
    { rate_limit: { primary_window: { used_percent: '20' } } },
    { rate_limit: { primary_window: { used_percent: Number.NaN } } },
    { rate_limit: { primary_window: { used_percent: Number.POSITIVE_INFINITY } } },
  ])('does not estimate quota from missing or malformed data: %j', (payload) => {
    expect(parseManagedChatGptQuota(payload, '')).toEqual([]);
  });
});

describe('current managed ChatGPT account quota', () => {
  it('uses only the owned token and workspace, with cookies and redirects disabled', async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      Response.json({
        ...quotaPayload(),
        debug: 'managed-access-secret managed-refresh-secret managed@example.com',
      }),
    );
    const { reader, root, file, write } = await fixture(fetcher);
    const otherHome = path.join(root, 'independent-codex');
    await mkdir(otherHome);
    await writeFile(path.join(otherHome, 'auth.json'), '{"access_token":"unrelated-secret"}');
    vi.stubEnv('CODEX_HOME', otherHome);
    await write({ base_url: 'https://untrusted.invalid/steal' });
    const before = await readFile(file);
    const quota = await reader.read('gpt-5.3-codex');
    expect(quota.availability).toBe('available');
    expect(quota.windows?.[0]?.usedPercent).toBe(37);
    expect(fetcher).toHaveBeenCalledWith(
      'https://chatgpt.com/backend-api/wham/usage',
      expect.objectContaining({
        method: 'GET',
        credentials: 'omit',
        redirect: 'error',
        cache: 'no-store',
        headers: {
          Authorization: 'Bearer managed-access-secret',
          'Chatgpt-Account-Id': 'account-managed',
          Accept: 'application/json',
        },
      }),
    );
    expect(JSON.stringify(quota)).not.toMatch(/secret|managed@example|account-managed|auth\.json/);
    expect(await readFile(file)).toEqual(before);
    expect(await readFile(path.join(otherHome, 'auth.json'), 'utf8')).toBe(
      '{"access_token":"unrelated-secret"}',
    );
  });

  it('works through the real gateway facade without starting processes, probing models, or modifying auth', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json(quotaPayload()));
    const { userData, file } = await fixture(fetcher);
    const forbidden = vi.fn(() => {
      throw new Error('Quota must not install, spawn, or decrypt gateway keys');
    });
    const gateway = new ManagedChatGptGateway(
      userData,
      {} as never,
      new BusyRegistry(),
      {
        encryptString: forbidden,
        decryptString: forbidden,
        isEncryptionAvailable: forbidden,
      },
      fetcher,
      forbidden,
      forbidden,
      forbidden,
    );
    const before = await readFile(file);
    expect((await gateway.readAccountResourceUsage('gpt-5.3-codex')).availability).toBe(
      'available',
    );
    expect(forbidden).not.toHaveBeenCalled();
    expect(await readFile(file)).toEqual(before);
  });

  it.each([
    [401, '授权已失效'],
    [403, '被拒绝'],
    [429, '过于频繁'],
    [404, '暂未返回'],
    [500, '服务暂不可用'],
  ])('distinguishes HTTP %s without echoing upstream secrets', async (status, message) => {
    const { reader } = await fixture(
      vi.fn<typeof fetch>(
        async () => new Response('managed-access-secret', { status: status as number }),
      ),
    );
    const quota = await reader.read('gpt-5.3-codex');
    expect(quota).toMatchObject({ availability: 'unavailable', clearPrevious: false });
    expect(quota.detail).toContain(message);
    expect(JSON.stringify(quota)).not.toContain('managed-access-secret');
  });

  it('distinguishes signed-out, switching, network, and unsupported states', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => {
      throw new Error('raw secret network error');
    });
    const { reader, file } = await fixture(fetcher);
    expect((await reader.read('')).detail).toContain('网络异常');
    fetcher.mockResolvedValueOnce(Response.json({ plan_type: 'pro' }));
    expect((await reader.read('')).detail).toContain('暂未返回');
    await rm(file);
    expect(await reader.read('')).toMatchObject({ clearPrevious: true });
    expect(fetcher).toHaveBeenCalledTimes(2);
    const busy = await fixture(fetcher, () => false);
    expect((await busy.reader.read('')).detail).toContain('正在切换');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it.each(['html', 'declared-oversize', 'stream-oversize', 'redirect'])(
    'bounds and rejects %s responses',
    async (kind) => {
      const canceled = vi.fn();
      const fetcher = vi.fn<typeof fetch>(async () => {
        if (kind === 'html') return new Response('<html>managed-access-secret</html>');
        const response = new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(kind === 'stream-oversize' ? 65537 : 1));
            },
            cancel: canceled,
          }),
          { headers: kind === 'declared-oversize' ? { 'content-length': '999999' } : {} },
        );
        if (kind === 'redirect') Object.defineProperty(response, 'redirected', { value: true });
        return response;
      });
      const { reader } = await fixture(fetcher);
      expect((await reader.read('')).detail).toContain('格式暂不兼容');
      if (kind !== 'html') expect(canceled).toHaveBeenCalled();
    },
  );

  it('discards a late response after another workspace replaces the owned account', async () => {
    let replace!: () => Promise<void>;
    const fetcher = vi.fn<typeof fetch>(async () => {
      await replace();
      return Response.json(quotaPayload());
    });
    const { reader, write } = await fixture(fetcher);
    replace = () => write({ account_id: 'another-workspace' });
    const oldAccount = await reader.read('');
    expect(oldAccount).toMatchObject({
      availability: 'unavailable',
      clearPrevious: true,
    });
    expect(oldAccount.windows).toBeUndefined();
    replace = () => write({ account_id: 'another-workspace', access_token: 'rotated-access' });
    expect((await reader.read('')).availability).toBe('available');
  });

  it('cancels in-flight reads across a lifecycle change even if the transport ignores abort', async () => {
    let settle!: (response: Response) => void;
    const fetcher = vi.fn<typeof fetch>(
      () =>
        new Promise((resolve) => {
          settle = resolve;
        }),
    );
    const { reader } = await fixture(fetcher);
    const pending = reader.read('');
    await awaitFetch(fetcher);
    reader.invalidate();
    expect(await pending).toMatchObject({ availability: 'unavailable', clearPrevious: true });
    expect(fetcher.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    const cancel = vi.fn();
    settle(new Response(new ReadableStream({ cancel })));
    await setImmediate();
    expect(cancel).toHaveBeenCalled();
  });

  it.each(['http', 'network'])(
    'does not retain another workspace after a failed %s query',
    async (failure) => {
      const { reader, write } = await fixture(
        vi.fn<typeof fetch>(async () => {
          await replace();
          if (failure === 'network') throw new Error('private transport diagnostic');
          return new Response('', { status: 401 });
        }),
      );
      const replace = () => write({ account_id: 'another-workspace' });
      const result = await reader.read('gpt-5.3-codex');
      expect(result).toMatchObject({ availability: 'unavailable', clearPrevious: true });
      expect(result.detail).toContain('正在切换');
      expect(result.accountKey).toBeUndefined();
    },
  );

  it.each(['headers', 'body'])(
    'times out stalled %s and releases the request in the background',
    async (part) => {
      const cancel = vi.fn();
      let settle: ((response: Response) => void) | undefined;
      const fetcher = vi.fn<typeof fetch>(() =>
        part === 'headers'
          ? new Promise((resolve) => {
              settle = resolve;
            })
          : Promise.resolve(new Response(new ReadableStream({ cancel }))),
      );
      const { reader } = await fixture(fetcher);
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const pending = reader.read('');
      await awaitFetch(fetcher);
      await vi.advanceTimersByTimeAsync(8000);
      expect((await pending).detail).toContain('查询超时');
      expect(fetcher.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
      if (settle) settle(new Response(new ReadableStream({ cancel })));
      await setImmediate();
      expect(cancel).toHaveBeenCalled();
    },
  );
});
