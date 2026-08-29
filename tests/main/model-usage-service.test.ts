/* eslint-disable max-lines -- This specification keeps the quota lifecycle race matrix together. */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ModelUsageSnapshot, ResourceUsageView } from '../../src/shared/contracts';
import type { ModelUsageConnection } from '../../src/main/usage/identity';
import type { TranscriptUsageReply } from '../../src/main/usage/transcript-client';
import { ModelUsageService } from '../../src/main/usage/service';
import type { ModelQuotaResult } from '../../src/main/usage/quota';

const clients = vi.hoisted(
  () =>
    [] as {
      receive: (reply: TranscriptUsageReply) => void;
      schedule: ReturnType<typeof vi.fn>;
      reset: ReturnType<typeof vi.fn>;
      dispose: ReturnType<typeof vi.fn>;
    }[],
);
vi.mock('../../src/main/usage/transcript-client', () => ({
  TranscriptUsageClient: class {
    public schedule = vi.fn();
    public reset = vi.fn();
    public dispose = vi.fn();
    public constructor(_root: string, receive: (reply: TranscriptUsageReply) => void) {
      clients.push({ receive, schedule: this.schedule, reset: this.reset, dispose: this.dispose });
    }
  },
}));

const roots: string[] = [];
const services: ModelUsageService[] = [];
afterEach(async () => {
  for (const service of services.splice(0)) {
    service.dispose();
    await Reflect.get(service, 'writes');
  }
  vi.useRealTimers();
  clients.length = 0;
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const api: ModelUsageConnection = {
  id: 'api-account',
  preset: 'deepseek',
  model: 'deepseek-chat',
  mode: 'api',
};
const session = '00000000-1111-2222-3333-444444444444';
const fixture = async (
  readChatGptQuota: (
    signal: AbortSignal,
    model: string,
  ) => Promise<ModelQuotaResult | undefined> = async () => undefined,
  existingRoot?: string,
  subscribeChatGptQuotaReadable?: (listener: () => void) => () => void,
  subscribeChatGptQuotaInvalidated?: (listener: (accountChanging: boolean) => void) => () => void,
  onChanged?: (snapshot: ModelUsageSnapshot) => void,
) => {
  const root = existingRoot ?? (await mkdtemp(path.join(tmpdir(), 'claudedock-usage-service-')));
  if (!existingRoot) roots.push(root);
  const changed = vi.fn();
  const service = new ModelUsageService({
    userDataPath: root,
    projectsRoot: path.join(root, 'projects'),
    onChanged: onChanged ?? changed,
    readChatGptQuota,
    subscribeChatGptQuotaInvalidated,
    subscribeChatGptQuotaReadable,
  });
  services.push(service);
  return { service, changed, client: clients.at(-1)!, root };
};
const report = (
  service: ModelUsageService,
  client: (typeof clients)[number],
  input: number,
  source = 'a'.repeat(64),
) => {
  const epoch = service.capture(api).epoch!;
  client.receive({
    epoch,
    results: [
      {
        epoch,
        source,
        available: true,
        partial: false,
        tokens: { input, output: 10, cacheRead: 20, cacheCreation: 30 },
      },
    ],
  });
};

describe('model usage snapshots', () => {
  it('aggregates sessions, deduplicates absolute counters and fences late data after reconnect', async () => {
    const { service, client } = await fixture();
    service.select(api, true);
    const first = service.capture(api);
    report(service, client, 100);
    report(service, client, 100);
    report(service, client, 200, 'b'.repeat(64));
    expect(service.getSnapshot().tokens?.input).toBe(300);
    service.select({ ...api, model: 'another-model' }, true);
    client.receive({
      epoch: first.epoch!,
      results: [
        {
          epoch: first.epoch!,
          source: 'c'.repeat(64),
          tokens: { input: 999, output: 0, cacheRead: 0, cacheCreation: 0 },
          available: true,
          partial: false,
        },
      ],
    });
    expect(service.getSnapshot().tokens?.input).toBe(0);
    service.observe({ ...api, id: 'another-account' }, 'D:\\Project', session);
    expect(client.schedule).not.toHaveBeenCalled();
    service.observe(first, 'D:\\Project', session);
    expect(client.schedule).toHaveBeenCalledWith(
      expect.objectContaining({ epoch: service.capture(api).epoch }),
    );
  });

  it('persists only opaque source IDs and counters, retaining the epoch after app restart', async () => {
    const { service, client, root } = await fixture();
    service.select(api, true);
    report(service, client, 500);
    const original = service.getSnapshot();
    service.dispose();
    await Reflect.get(service, 'writes');
    const journal = await readFile(path.join(root, 'model-usage.json'), 'utf8');
    expect(journal).not.toMatch(/credential|prompt|content|D:\\Project/);
    const { service: restarted, client: reader } = await fixture(undefined, root);
    restarted.select(api);
    expect(restarted.getSnapshot()).toMatchObject({
      connectedAt: original.connectedAt,
      tokens: original.tokens,
    });
    report(restarted, reader, 500);
    expect(restarted.getSnapshot().tokens?.input).toBe(500);
  });

  it('never treats context capacity as subscription quota and rejects earlier account epochs', async () => {
    const { service } = await fixture();
    const subscription: ModelUsageConnection = {
      ...api,
      preset: 'anthropic',
      mode: 'subscription',
    };
    service.select(subscription, true);
    const first = service.capture(subscription);
    service.observe(first, 'D:\\Project', session, {
      capturedAt: Date.now(),
      contextWindowSize: 200000,
      contextWindowUsed: 100000,
    });
    expect(service.getSnapshot().status).toBe('unavailable');
    service.observe(first, 'D:\\Project', session, {
      capturedAt: Date.now(),
      rateLimitFiveHour: 15,
      rateLimitSevenDay: 44,
    });
    expect(service.getSnapshot().windows?.map((window) => window.remainingPercent)).toEqual([
      85, 56,
    ]);
    service.select(subscription, true);
    service.observe(first, 'D:\\Project', session, {
      capturedAt: Date.now() + 1,
      rateLimitFiveHour: 99,
    });
    expect(service.getSnapshot().windows).toBeUndefined();
  });

  it('singleflights slow quota reads, fences switched accounts, and has no two-second poll', async () => {
    vi.useFakeTimers();
    let resolve!: (resource: ResourceUsageView) => void;
    const quota = vi.fn(
      () =>
        new Promise<ResourceUsageView>((settle) => {
          resolve = settle;
        }),
    );
    const { service } = await fixture(quota);
    service.select({ ...api, preset: 'chatgpt-subscription', mode: 'subscription' }, true);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(quota).toHaveBeenCalledOnce();
    service.select(api, true);
    resolve({
      availability: 'available',
      checkedAt: Date.now(),
      source: 'codex-app-server',
      capabilities: { balance: false, context: false, windows: true },
      windows: [{ label: '5 小时', usedPercent: 20 }],
    });
    await Promise.resolve();
    expect(service.getSnapshot().windows).toBeUndefined();
    service.setFloating(true);
    service.setTheme('midnight');
    expect(service.getSnapshot()).toMatchObject({
      floating: true,
      themeId: 'midnight',
      mode: 'api',
    });
  });

  it('keeps recorded totals when a source is temporarily unavailable', async () => {
    const { service, client } = await fixture();
    service.select(api, true);
    report(service, client, 100);
    client.receive({ epoch: service.capture(api).epoch!, unavailable: true });
    expect(service.getSnapshot()).toMatchObject({ status: 'stale', tokens: { input: 100 } });
    service.select(undefined, true);
    expect(service.getSnapshot()).toMatchObject({ mode: 'none', tokens: undefined });
  });

  it('preserves explicit failure reasons and only keeps old quota for the same account', async () => {
    vi.useFakeTimers();
    const quota = vi.fn<() => Promise<ModelQuotaResult>>().mockResolvedValue({
      accountKey: 'account-a',
      availability: 'available',
      capabilities: { balance: false, context: false, windows: true },
      checkedAt: Date.now(),
      source: 'managed-chatgpt-gateway',
      windows: [{ label: '5 小时', usedPercent: 37 }],
    });
    const { service } = await fixture(quota);
    service.select({ ...api, preset: 'chatgpt-subscription', mode: 'subscription' });
    await vi.advanceTimersByTimeAsync(0);
    const first = service.getSnapshot();
    expect(first.windows?.[0]?.remainingPercent).toBe(63);
    const failure: ModelQuotaResult = {
      accountKey: 'account-a',
      availability: 'unavailable',
      capabilities: { balance: false, context: false, windows: true },
      checkedAt: Date.now(),
      source: 'managed-chatgpt-gateway',
      detail: 'ChatGPT 额度查询超时，稍后后台重试。',
    };
    quota.mockResolvedValue(failure);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(service.getSnapshot()).toMatchObject({
      status: 'stale',
      windows: first.windows,
      updatedAt: first.updatedAt,
    });
    expect(service.getSnapshot().detail).toContain('查询超时');
    quota.mockResolvedValue({ ...failure, accountKey: 'account-b' });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(service.getSnapshot().status).toBe('unavailable');
    expect(service.getSnapshot().windows).toBeUndefined();
    expect(service.getSnapshot().updatedAt).toBeUndefined();
    expect(JSON.stringify(service.getSnapshot())).not.toMatch(/accountKey|account-a|account-b/);
  });

  it('clears previous data when the current account cannot be established', async () => {
    vi.useFakeTimers();
    const quota = vi.fn<() => Promise<ModelQuotaResult>>().mockResolvedValue({
      accountKey: 'account-a',
      availability: 'available',
      capabilities: { balance: false, context: false, windows: true },
      checkedAt: Date.now(),
      source: 'managed-chatgpt-gateway',
      windows: [{ label: '5 小时', usedPercent: 0 }],
    });
    const { service } = await fixture(quota);
    service.select({ ...api, preset: 'chatgpt-subscription', mode: 'subscription' });
    await vi.advanceTimersByTimeAsync(0);
    quota.mockResolvedValue({
      clearPrevious: true,
      availability: 'unavailable',
      capabilities: { balance: false, context: false, windows: true },
      checkedAt: Date.now(),
      source: 'managed-chatgpt-gateway',
      detail: '当前账户尚未授权。',
      retryWhenGatewayStable: true,
    });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(service.getSnapshot()).toMatchObject({
      status: 'unavailable',
      detail: '当前账户尚未授权。',
    });
    expect(service.getSnapshot().windows).toBeUndefined();
  });

  it('starts the new account read immediately and ignores the old request after reconnect', async () => {
    let finishOld!: (value: ModelQuotaResult) => void;
    let oldSignal: AbortSignal | undefined;
    const quota = vi
      .fn<(signal: AbortSignal, model: string) => Promise<ModelQuotaResult>>()
      .mockImplementationOnce((signal) => {
        oldSignal = signal;
        return new Promise((resolve) => {
          finishOld = resolve;
        });
      })
      .mockResolvedValue({
        accountKey: 'new-account',
        availability: 'available',
        capabilities: { balance: false, context: false, windows: true },
        checkedAt: Date.now(),
        source: 'managed-chatgpt-gateway',
        windows: [{ label: '5 小时', usedPercent: 25 }],
      });
    const { service } = await fixture(quota);
    const connection: ModelUsageConnection = {
      ...api,
      preset: 'chatgpt-subscription',
      mode: 'subscription',
    };
    service.select(connection);
    service.select({ ...connection, id: 'new-connection', model: 'gpt-5.3-codex' }, true);
    expect(oldSignal?.aborted).toBe(true);
    await vi.waitFor(() => expect(service.getSnapshot().windows?.[0]?.remainingPercent).toBe(75));
    expect(quota.mock.calls[1]?.[1]).toBe('gpt-5.3-codex');
    finishOld({
      accountKey: 'old-account',
      availability: 'available',
      capabilities: { balance: false, context: false, windows: true },
      checkedAt: Date.now(),
      source: 'managed-chatgpt-gateway',
      windows: [{ label: '5 小时', usedPercent: 99 }],
    });
    await Promise.resolve();
    expect(service.getSnapshot().windows?.[0]?.remainingPercent).toBe(75);
  });

  it('replaces a lifecycle-cancelled read after the stable signal, even when the signal arrives first', async () => {
    let invalidated!: (accountChanging: boolean) => void;
    let readable!: () => void;
    let finishFirst!: (resource: ModelQuotaResult) => void;
    const retry = {
      clearPrevious: true,
      availability: 'unavailable' as const,
      capabilities: { balance: false, context: false, windows: true },
      checkedAt: Date.now(),
      detail: 'ChatGPT 账户正在切换或授权尚未完成，稍后后台重试。',
      retryWhenGatewayStable: true,
      source: 'managed-chatgpt-gateway' as const,
    };
    const quota = vi
      .fn<(signal: AbortSignal, model: string) => Promise<ModelQuotaResult>>()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishFirst = resolve;
          }),
      )
      .mockResolvedValue({
        accountKey: 'account-a',
        availability: 'available',
        capabilities: { balance: false, context: false, windows: true },
        checkedAt: Date.now(),
        source: 'managed-chatgpt-gateway',
        windows: [{ label: '5 小时', usedPercent: 24 }],
      });
    const { service } = await fixture(
      quota,
      undefined,
      (listener) => {
        readable = listener;
        return () => undefined;
      },
      (listener) => {
        invalidated = listener;
        return () => undefined;
      },
    );
    service.select({ ...api, preset: 'chatgpt-subscription', mode: 'subscription' });
    await vi.waitFor(() => expect(quota).toHaveBeenCalledOnce());

    invalidated(false);
    readable();
    readable();
    finishFirst(retry);
    await vi.waitFor(() => expect(quota).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(service.getSnapshot().windows?.[0]?.remainingPercent).toBe(76));
  });

  it('coalesces a stable-signal replacement and does not burst again after success', async () => {
    vi.useFakeTimers();
    let invalidated!: (accountChanging: boolean) => void;
    let readable!: () => void;
    const retry: ModelQuotaResult = {
      clearPrevious: true,
      availability: 'unavailable',
      capabilities: { balance: false, context: false, windows: true },
      checkedAt: Date.now(),
      detail: 'ChatGPT 账户正在切换或授权尚未完成，稍后后台重试。',
      retryWhenGatewayStable: true,
      source: 'managed-chatgpt-gateway',
    };
    const quota = vi
      .fn<() => Promise<ModelQuotaResult>>()
      .mockResolvedValueOnce(retry)
      .mockResolvedValue({
        accountKey: 'account-a',
        availability: 'available',
        capabilities: { balance: false, context: false, windows: true },
        checkedAt: Date.now(),
        source: 'managed-chatgpt-gateway',
        windows: [{ label: '5 小时', usedPercent: 24 }],
      });
    const { service } = await fixture(
      quota,
      undefined,
      (listener) => {
        readable = listener;
        return () => undefined;
      },
      (listener) => {
        invalidated = listener;
        return () => undefined;
      },
    );
    service.select({ ...api, preset: 'chatgpt-subscription', mode: 'subscription' });
    await vi.advanceTimersByTimeAsync(0);
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
    expect(quota).toHaveBeenCalledOnce();
    expect(service.getSnapshot().detail).toContain('账户正在切换');

    invalidated(true);
    readable();
    readable();
    readable();
    await vi.advanceTimersByTimeAsync(0);
    expect(quota).toHaveBeenCalledTimes(2);
    expect(service.getSnapshot().windows?.[0]?.remainingPercent).toBe(76);
    readable();
    await vi.advanceTimersByTimeAsync(0);
    expect(quota).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(59_999);
    expect(quota).toHaveBeenCalledTimes(2);
  });

  it('does not poll while a quota read waits for gateway stability', async () => {
    vi.useFakeTimers();
    let invalidated!: (accountChanging: boolean) => void;
    const retry: ModelQuotaResult = {
      clearPrevious: true,
      availability: 'unavailable',
      capabilities: { balance: false, context: false, windows: true },
      checkedAt: Date.now(),
      detail: 'ChatGPT 账户正在切换或授权尚未完成，稍后后台重试。',
      retryWhenGatewayStable: true,
      source: 'managed-chatgpt-gateway',
    };
    const quota = vi.fn<() => Promise<ModelQuotaResult>>().mockResolvedValue(retry);
    const { service } = await fixture(quota, undefined, undefined, (listener) => {
      invalidated = listener;
      return () => undefined;
    });
    service.select({ ...api, preset: 'chatgpt-subscription', mode: 'subscription' });
    await vi.advanceTimersByTimeAsync(0);
    await vi.waitFor(() => expect(quota).toHaveBeenCalledOnce());
    invalidated(true);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(quota).toHaveBeenCalledOnce();
  });

  it('waits for gateway readability when ChatGPT is selected during a lifecycle', async () => {
    vi.useFakeTimers();
    let invalidated!: (accountChanging: boolean) => void;
    let readable!: () => void;
    const quota = vi.fn<() => Promise<ModelQuotaResult>>().mockResolvedValue({
      accountKey: 'account-a',
      availability: 'available',
      capabilities: { balance: false, context: false, windows: true },
      checkedAt: Date.now(),
      source: 'managed-chatgpt-gateway',
      windows: [{ label: '5 小时', usedPercent: 24 }],
    });
    const { service } = await fixture(
      quota,
      undefined,
      (listener) => {
        readable = listener;
        return () => undefined;
      },
      (listener) => {
        invalidated = listener;
        return () => undefined;
      },
    );

    invalidated(false);
    service.select({ ...api, preset: 'chatgpt-subscription', mode: 'subscription' });
    await vi.advanceTimersByTimeAsync(0);
    expect(quota).not.toHaveBeenCalled();

    readable();
    await vi.waitFor(() => expect(quota).toHaveBeenCalledOnce());
    expect(service.getSnapshot().windows?.[0]?.remainingPercent).toBe(76);
  });

  it('keeps an unauthorized result on normal polling when no lifecycle is active', async () => {
    vi.useFakeTimers();
    const unauthorized: ModelQuotaResult = {
      accountKey: 'account-a',
      availability: 'unavailable',
      capabilities: { balance: false, context: false, windows: true },
      checkedAt: Date.now(),
      detail: 'ChatGPT 额度查询授权已失效，等待网关刷新；如持续出现，请重新授权。',
      retryWhenGatewayStable: true,
      source: 'managed-chatgpt-gateway',
    };
    const quota = vi
      .fn<() => Promise<ModelQuotaResult>>()
      .mockResolvedValueOnce(unauthorized)
      .mockResolvedValue({
        accountKey: 'account-a',
        availability: 'available',
        capabilities: { balance: false, context: false, windows: true },
        checkedAt: Date.now(),
        source: 'managed-chatgpt-gateway',
        windows: [{ label: '5 小时', usedPercent: 30 }],
      });
    const { service } = await fixture(quota);
    service.select({ ...api, preset: 'chatgpt-subscription', mode: 'subscription' });
    await vi.advanceTimersByTimeAsync(0);
    await vi.waitFor(() => expect(quota).toHaveBeenCalledOnce());

    await vi.advanceTimersByTimeAsync(60_000);
    await vi.waitFor(() => expect(quota).toHaveBeenCalledTimes(2));
    expect(service.getSnapshot().windows?.[0]?.remainingPercent).toBe(70);
  });

  it('does not block polling after a standalone account-changing read result', async () => {
    vi.useFakeTimers();
    const accountChanging: ModelQuotaResult = {
      clearPrevious: true,
      availability: 'unavailable',
      capabilities: { balance: false, context: false, windows: true },
      checkedAt: Date.now(),
      detail: 'ChatGPT 账户正在切换或授权尚未完成，稍后后台重试。',
      retryWhenGatewayStable: true,
      source: 'managed-chatgpt-gateway',
    };
    const quota = vi
      .fn<() => Promise<ModelQuotaResult>>()
      .mockResolvedValueOnce(accountChanging)
      .mockResolvedValue({
        accountKey: 'account-a',
        availability: 'available',
        capabilities: { balance: false, context: false, windows: true },
        checkedAt: Date.now(),
        source: 'managed-chatgpt-gateway',
        windows: [{ label: '5 小时', usedPercent: 30 }],
      });
    const { service } = await fixture(quota);
    service.select({ ...api, preset: 'chatgpt-subscription', mode: 'subscription' });
    await vi.advanceTimersByTimeAsync(0);
    await vi.waitFor(() => expect(quota).toHaveBeenCalledOnce());

    await vi.advanceTimersByTimeAsync(60_000);
    await vi.waitFor(() => expect(quota).toHaveBeenCalledTimes(2));
    expect(service.getSnapshot().windows?.[0]?.remainingPercent).toBe(70);
  });

  it('does not use a stable signal to accelerate ordinary quota failures', async () => {
    vi.useFakeTimers();
    let readable!: () => void;
    const quota = vi
      .fn<() => Promise<ModelQuotaResult>>()
      .mockResolvedValueOnce({
        availability: 'unavailable',
        capabilities: { balance: false, context: false, windows: true },
        checkedAt: Date.now(),
        detail: 'ChatGPT 额度查询超时，稍后后台重试。',
        source: 'managed-chatgpt-gateway',
      })
      .mockResolvedValue({
        availability: 'available',
        capabilities: { balance: false, context: false, windows: true },
        checkedAt: Date.now(),
        source: 'managed-chatgpt-gateway',
        windows: [{ label: '5 小时', usedPercent: 24 }],
      });
    const { service } = await fixture(quota, undefined, (listener) => {
      readable = listener;
      return () => undefined;
    });
    service.select({ ...api, preset: 'chatgpt-subscription', mode: 'subscription' });
    await vi.advanceTimersByTimeAsync(0);
    readable();
    await vi.advanceTimersByTimeAsync(0);
    expect(quota).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(59_999);
    expect(quota).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(quota).toHaveBeenCalledTimes(2);
  });

  it('fences a pending replacement when the usage service is disposed', async () => {
    let readable!: () => void;
    const unsubscribe = vi.fn();
    const retry: ModelQuotaResult = {
      clearPrevious: true,
      availability: 'unavailable',
      capabilities: { balance: false, context: false, windows: true },
      checkedAt: Date.now(),
      detail: 'ChatGPT 账户正在切换或授权尚未完成，稍后后台重试。',
      retryWhenGatewayStable: true,
      source: 'managed-chatgpt-gateway',
    };
    const quota = vi.fn(async () => retry);
    const { service } = await fixture(quota, undefined, (listener) => {
      readable = listener;
      return unsubscribe;
    });
    service.select({ ...api, preset: 'chatgpt-subscription', mode: 'subscription' });
    await vi.waitFor(() => expect(quota).toHaveBeenCalledOnce());
    service.dispose();
    readable();
    await Promise.resolve();
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(quota).toHaveBeenCalledOnce();
  });

  it('discards a success resolved just before lifecycle invalidation and reads again after stability', async () => {
    let invalidated!: (accountChanging: boolean) => void;
    let readable!: () => void;
    let finishFirst!: (resource: ModelQuotaResult) => void;
    const quota = vi
      .fn<() => Promise<ModelQuotaResult>>()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishFirst = resolve;
          }),
      )
      .mockResolvedValue({
        accountKey: 'account-b',
        availability: 'available',
        capabilities: { balance: false, context: false, windows: true },
        checkedAt: Date.now(),
        source: 'managed-chatgpt-gateway',
        windows: [{ label: '5 小时', usedPercent: 25 }],
      });
    const { service } = await fixture(
      quota,
      undefined,
      (listener) => {
        readable = listener;
        return () => undefined;
      },
      (listener) => {
        invalidated = listener;
        return () => undefined;
      },
    );
    service.select({ ...api, preset: 'chatgpt-subscription', mode: 'subscription' });
    await vi.waitFor(() => expect(quota).toHaveBeenCalledOnce());

    finishFirst({
      accountKey: 'account-a',
      availability: 'available',
      capabilities: { balance: false, context: false, windows: true },
      checkedAt: Date.now(),
      source: 'managed-chatgpt-gateway',
      windows: [{ label: '5 小时', usedPercent: 99 }],
    });
    invalidated(false);
    readable();
    await vi.waitFor(() => expect(quota).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(service.getSnapshot().windows?.[0]?.remainingPercent).toBe(75));
  });

  it('does not apply a successful read after account invalidation', async () => {
    vi.useFakeTimers();
    let invalidated!: (accountChanging: boolean) => void;
    let readable!: () => void;
    let finishSecond!: (resource: ModelQuotaResult) => void;
    let finishThird!: (resource: ModelQuotaResult) => void;
    const quota = vi
      .fn<() => Promise<ModelQuotaResult>>()
      .mockResolvedValueOnce({
        accountKey: 'account-a',
        availability: 'available',
        capabilities: { balance: false, context: false, windows: true },
        checkedAt: Date.now(),
        source: 'managed-chatgpt-gateway',
        windows: [{ label: '5 小时', usedPercent: 37 }],
      })
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishSecond = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishThird = resolve;
          }),
      );
    const { service } = await fixture(
      quota,
      undefined,
      (listener) => {
        readable = listener;
        return () => undefined;
      },
      (listener) => {
        invalidated = listener;
        return () => undefined;
      },
    );
    service.select({ ...api, preset: 'chatgpt-subscription', mode: 'subscription' });
    await vi.advanceTimersByTimeAsync(0);
    await vi.waitFor(() => expect(service.getSnapshot().status).toBe('available'));
    const previous = service.getSnapshot();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(quota).toHaveBeenCalledTimes(2);

    invalidated(true);
    finishSecond({
      accountKey: 'account-a',
      availability: 'available',
      capabilities: { balance: false, context: false, windows: true },
      checkedAt: Date.now(),
      source: 'managed-chatgpt-gateway',
      windows: [{ label: '5 小时', usedPercent: 99 }],
    });
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
    expect(service.getSnapshot()).toMatchObject({ status: 'stale', windows: previous.windows });

    readable();
    await vi.waitFor(() => expect(quota).toHaveBeenCalledTimes(3));
    finishThird({
      accountKey: 'account-b',
      availability: 'available',
      capabilities: { balance: false, context: false, windows: true },
      checkedAt: Date.now(),
      source: 'managed-chatgpt-gateway',
      windows: [{ label: '5 小时', usedPercent: 25 }],
    });
    await vi.waitFor(() => expect(service.getSnapshot().windows?.[0]?.remainingPercent).toBe(75));
  });

  it('clears cached quota when account invalidation settles before the cancelled result', async () => {
    vi.useFakeTimers();
    let invalidated!: (accountChanging: boolean) => void;
    let readable!: () => void;
    let finishSecond!: (resource: ModelQuotaResult) => void;
    let finishThird!: (resource: ModelQuotaResult) => void;
    const retry: ModelQuotaResult = {
      clearPrevious: true,
      availability: 'unavailable',
      capabilities: { balance: false, context: false, windows: true },
      checkedAt: Date.now(),
      detail: 'ChatGPT 账户正在切换或授权尚未完成，稍后后台重试。',
      retryWhenGatewayStable: true,
      source: 'managed-chatgpt-gateway',
    };
    const quota = vi
      .fn<() => Promise<ModelQuotaResult>>()
      .mockResolvedValueOnce({
        accountKey: 'account-a',
        availability: 'available',
        capabilities: { balance: false, context: false, windows: true },
        checkedAt: Date.now(),
        source: 'managed-chatgpt-gateway',
        windows: [{ label: '5 小时', usedPercent: 37 }],
      })
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishSecond = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishThird = resolve;
          }),
      );
    const { service } = await fixture(
      quota,
      undefined,
      (listener) => {
        readable = listener;
        return () => undefined;
      },
      (listener) => {
        invalidated = listener;
        return () => undefined;
      },
    );
    service.select({ ...api, preset: 'chatgpt-subscription', mode: 'subscription' });
    await vi.advanceTimersByTimeAsync(0);
    await vi.waitFor(() => expect(service.getSnapshot().status).toBe('available'));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(quota).toHaveBeenCalledTimes(2);

    invalidated(true);
    expect(service.getSnapshot().status).toBe('stale');
    readable();
    finishSecond(retry);
    await vi.waitFor(() => expect(quota).toHaveBeenCalledTimes(3));
    expect(service.getSnapshot().windows).toBeUndefined();
    expect(service.getSnapshot().status).toBe('unavailable');

    finishThird({
      accountKey: 'account-b',
      availability: 'available',
      capabilities: { balance: false, context: false, windows: true },
      checkedAt: Date.now(),
      source: 'managed-chatgpt-gateway',
      windows: [{ label: '5 小时', usedPercent: 25 }],
    });
    await vi.waitFor(() => expect(service.getSnapshot().windows?.[0]?.remainingPercent).toBe(75));
  });

  it('preserves cached quota when an ordinary lifecycle read is cancelled', async () => {
    vi.useFakeTimers();
    let invalidated!: (accountChanging: boolean) => void;
    let readable!: () => void;
    let finishSecond!: (resource: ModelQuotaResult) => void;
    const retry: ModelQuotaResult = {
      clearPrevious: true,
      availability: 'unavailable',
      capabilities: { balance: false, context: false, windows: true },
      checkedAt: Date.now(),
      detail: 'ChatGPT 账户正在切换或授权尚未完成，稍后后台重试。',
      retryWhenGatewayStable: true,
      source: 'managed-chatgpt-gateway',
    };
    const quota = vi
      .fn<() => Promise<ModelQuotaResult>>()
      .mockResolvedValueOnce({
        accountKey: 'account-a',
        availability: 'available',
        capabilities: { balance: false, context: false, windows: true },
        checkedAt: Date.now(),
        source: 'managed-chatgpt-gateway',
        windows: [{ label: '5 小时', usedPercent: 37 }],
      })
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishSecond = resolve;
          }),
      )
      .mockResolvedValueOnce({
        accountKey: 'account-a',
        availability: 'available',
        capabilities: { balance: false, context: false, windows: true },
        checkedAt: Date.now(),
        source: 'managed-chatgpt-gateway',
        windows: [{ label: '5 小时', usedPercent: 30 }],
      });
    const { service } = await fixture(
      quota,
      undefined,
      (listener) => {
        readable = listener;
        return () => undefined;
      },
      (listener) => {
        invalidated = listener;
        return () => undefined;
      },
    );
    service.select({ ...api, preset: 'chatgpt-subscription', mode: 'subscription' });
    await vi.advanceTimersByTimeAsync(0);
    await vi.waitFor(() => expect(service.getSnapshot().status).toBe('available'));
    const previous = service.getSnapshot();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(quota).toHaveBeenCalledTimes(2);

    invalidated(false);
    expect(service.getSnapshot()).toMatchObject({ status: 'stale', windows: previous.windows });
    finishSecond(retry);
    await Promise.resolve();
    expect(service.getSnapshot()).toMatchObject({ status: 'stale', windows: previous.windows });

    readable();
    await vi.waitFor(() => expect(quota).toHaveBeenCalledTimes(3));
    await vi.waitFor(() => expect(service.getSnapshot().windows?.[0]?.remainingPercent).toBe(70));
  });

  it('skips timer quota reads while an ordinary lifecycle is active', async () => {
    vi.useFakeTimers();
    let invalidated!: (accountChanging: boolean) => void;
    let readable!: () => void;
    const quota = vi.fn<() => Promise<ModelQuotaResult>>().mockResolvedValueOnce({
      accountKey: 'account-a',
      availability: 'available',
      capabilities: { balance: false, context: false, windows: true },
      checkedAt: Date.now(),
      source: 'managed-chatgpt-gateway',
      windows: [{ label: '5 小时', usedPercent: 37 }],
    });
    const { service } = await fixture(
      quota,
      undefined,
      (listener) => {
        readable = listener;
        return () => undefined;
      },
      (listener) => {
        invalidated = listener;
        return () => undefined;
      },
    );
    service.select({ ...api, preset: 'chatgpt-subscription', mode: 'subscription' });
    await vi.advanceTimersByTimeAsync(0);
    await vi.waitFor(() => expect(service.getSnapshot().status).toBe('available'));
    const previous = service.getSnapshot();

    invalidated(false);
    expect(service.getSnapshot()).toMatchObject({
      status: 'stale',
      windows: previous.windows,
      detail: 'ChatGPT 网关正在更新；显示上次结果',
    });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(quota).toHaveBeenCalledOnce();

    readable();
    await vi.advanceTimersByTimeAsync(0);
    expect(quota).toHaveBeenCalledOnce();
    expect(service.getSnapshot()).toMatchObject({ status: 'stale', windows: previous.windows });
  });

  it('does not treat coalesced lifecycle invalidations as a permanently busy gateway', async () => {
    vi.useFakeTimers();
    let invalidated!: (accountChanging: boolean) => void;
    let readable!: () => void;
    const quota = vi
      .fn<() => Promise<ModelQuotaResult>>()
      .mockResolvedValueOnce({
        accountKey: 'account-a',
        availability: 'available',
        capabilities: { balance: false, context: false, windows: true },
        checkedAt: Date.now(),
        source: 'managed-chatgpt-gateway',
        windows: [{ label: '5 小时', usedPercent: 37 }],
      })
      .mockResolvedValueOnce({
        accountKey: 'account-a',
        availability: 'unavailable',
        capabilities: { balance: false, context: false, windows: true },
        checkedAt: Date.now(),
        detail: 'ChatGPT 额度查询授权已失效，等待网关刷新；如持续出现，请重新授权。',
        retryWhenGatewayStable: true,
        source: 'managed-chatgpt-gateway',
      });
    const { service } = await fixture(
      quota,
      undefined,
      (listener) => {
        readable = listener;
        return () => undefined;
      },
      (listener) => {
        invalidated = listener;
        return () => undefined;
      },
    );
    service.select({ ...api, preset: 'chatgpt-subscription', mode: 'subscription' });
    await vi.advanceTimersByTimeAsync(0);
    await vi.waitFor(() => expect(service.getSnapshot().status).toBe('available'));

    invalidated(false);
    invalidated(false);
    readable();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(quota).toHaveBeenCalledTimes(2);
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
    expect(service.getSnapshot().detail).toContain('授权已失效');
    expect(service.getSnapshot().windows?.[0]?.remainingPercent).toBe(63);
  });

  it('refreshes after an explicit account invalidation even when no read is active', async () => {
    let invalidated!: (accountChanging: boolean) => void;
    let readable!: () => void;
    const quota = vi
      .fn<() => Promise<ModelQuotaResult>>()
      .mockResolvedValueOnce({
        accountKey: 'account-a',
        availability: 'available',
        capabilities: { balance: false, context: false, windows: true },
        checkedAt: Date.now(),
        source: 'managed-chatgpt-gateway',
        windows: [{ label: '5 小时', usedPercent: 37 }],
      })
      .mockResolvedValue({
        accountKey: 'account-a',
        availability: 'unavailable',
        capabilities: { balance: false, context: false, windows: true },
        checkedAt: Date.now(),
        detail: 'ChatGPT 额度查询超时，稍后后台重试。',
        source: 'managed-chatgpt-gateway',
      });
    const { service } = await fixture(
      quota,
      undefined,
      (listener) => {
        readable = listener;
        return () => undefined;
      },
      (listener) => {
        invalidated = listener;
        return () => undefined;
      },
    );
    service.select({ ...api, preset: 'chatgpt-subscription', mode: 'subscription' });
    await vi.waitFor(() => expect(service.getSnapshot().status).toBe('available'));
    const previous = service.getSnapshot();

    invalidated(true);
    expect(service.getSnapshot()).toMatchObject({ status: 'stale', windows: previous.windows });
    readable();
    await vi.waitFor(() => expect(quota).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(service.getSnapshot().detail).toContain('查询超时'));
    expect(service.getSnapshot()).toMatchObject({
      status: 'stale',
      windows: previous.windows,
      updatedAt: previous.updatedAt,
    });
  });

  it('retains an account retry when a snapshot observer throws', async () => {
    let invalidated!: (accountChanging: boolean) => void;
    let readable!: () => void;
    let throwOnChange = false;
    const quota = vi.fn<() => Promise<ModelQuotaResult>>().mockResolvedValue({
      accountKey: 'account-a',
      availability: 'available',
      capabilities: { balance: false, context: false, windows: true },
      checkedAt: Date.now(),
      source: 'managed-chatgpt-gateway',
      windows: [{ label: '5 小时', usedPercent: 24 }],
    });
    const { service } = await fixture(
      quota,
      undefined,
      (listener) => {
        readable = listener;
        return () => undefined;
      },
      (listener) => {
        invalidated = listener;
        return () => undefined;
      },
      () => {
        if (throwOnChange) throw new Error('renderer frame closed');
      },
    );
    service.select({ ...api, preset: 'chatgpt-subscription', mode: 'subscription' });
    await vi.waitFor(() => expect(quota).toHaveBeenCalledOnce());
    throwOnChange = true;

    expect(() => invalidated(true)).not.toThrow();
    readable();
    await vi.waitFor(() => expect(quota).toHaveBeenCalledTimes(2));
    expect(service.getSnapshot().windows?.[0]?.remainingPercent).toBe(76);
  });

  it('survives observer failure while applying a deferred account result', async () => {
    let invalidated!: (accountChanging: boolean) => void;
    let readable!: () => void;
    let finishFirst!: (resource: ModelQuotaResult) => void;
    let throwOnChange = false;
    const retry: ModelQuotaResult = {
      clearPrevious: true,
      availability: 'unavailable',
      capabilities: { balance: false, context: false, windows: true },
      checkedAt: Date.now(),
      detail: 'ChatGPT 账户正在切换或授权尚未完成，稍后后台重试。',
      retryWhenGatewayStable: true,
      source: 'managed-chatgpt-gateway',
    };
    const quota = vi
      .fn<() => Promise<ModelQuotaResult>>()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishFirst = resolve;
          }),
      )
      .mockResolvedValue({
        accountKey: 'account-a',
        availability: 'available',
        capabilities: { balance: false, context: false, windows: true },
        checkedAt: Date.now(),
        source: 'managed-chatgpt-gateway',
        windows: [{ label: '5 小时', usedPercent: 24 }],
      });
    const { service } = await fixture(
      quota,
      undefined,
      (listener) => {
        readable = listener;
        return () => undefined;
      },
      (listener) => {
        invalidated = listener;
        return () => undefined;
      },
      () => {
        if (throwOnChange) throw new Error('renderer frame closed');
      },
    );
    service.select({ ...api, preset: 'chatgpt-subscription', mode: 'subscription' });
    await vi.waitFor(() => expect(quota).toHaveBeenCalledOnce());
    invalidated(true);
    readable();
    throwOnChange = true;
    finishFirst(retry);

    await vi.waitFor(() => expect(quota).toHaveBeenCalledTimes(2));
    expect(service.getSnapshot().windows?.[0]?.remainingPercent).toBe(76);
  });

  it('marks cached quota stale during a lifecycle and preserves it on same-account failure', async () => {
    vi.useFakeTimers();
    let invalidated!: (accountChanging: boolean) => void;
    let readable!: () => void;
    let finishSecond!: (resource: ModelQuotaResult) => void;
    const quota = vi
      .fn<() => Promise<ModelQuotaResult>>()
      .mockResolvedValueOnce({
        accountKey: 'account-a',
        availability: 'available',
        capabilities: { balance: false, context: false, windows: true },
        checkedAt: Date.now(),
        source: 'managed-chatgpt-gateway',
        windows: [{ label: '5 小时', usedPercent: 37 }],
      })
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishSecond = resolve;
          }),
      )
      .mockResolvedValue({
        accountKey: 'account-a',
        availability: 'unavailable',
        capabilities: { balance: false, context: false, windows: true },
        checkedAt: Date.now(),
        detail: 'ChatGPT 额度查询超时，稍后后台重试。',
        source: 'managed-chatgpt-gateway',
      });
    const { service } = await fixture(
      quota,
      undefined,
      (listener) => {
        readable = listener;
        return () => undefined;
      },
      (listener) => {
        invalidated = listener;
        return () => undefined;
      },
    );
    service.select({ ...api, preset: 'chatgpt-subscription', mode: 'subscription' });
    await vi.advanceTimersByTimeAsync(0);
    await vi.waitFor(() => expect(service.getSnapshot().status).toBe('available'));
    const previous = service.getSnapshot();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(quota).toHaveBeenCalledTimes(2);

    invalidated(false);
    expect(service.getSnapshot()).toMatchObject({ status: 'stale', windows: previous.windows });
    readable();
    finishSecond({
      accountKey: 'account-a',
      availability: 'unavailable',
      capabilities: { balance: false, context: false, windows: true },
      checkedAt: Date.now(),
      detail: 'ChatGPT 额度查询超时，稍后后台重试。',
      source: 'managed-chatgpt-gateway',
    });
    await vi.waitFor(() => expect(quota).toHaveBeenCalledTimes(3));
    await vi.waitFor(() => expect(service.getSnapshot().detail).toContain('查询超时'));
    expect(service.getSnapshot()).toMatchObject({
      status: 'stale',
      windows: previous.windows,
      updatedAt: previous.updatedAt,
    });
  });

  it('keeps a forced replacement queued when an overlapping read rejects', async () => {
    vi.useFakeTimers();
    let invalidated!: (accountChanging: boolean) => void;
    let readable!: () => void;
    let rejectSecond!: (error: Error) => void;
    const quota = vi
      .fn<() => Promise<ModelQuotaResult>>()
      .mockResolvedValueOnce({
        accountKey: 'account-a',
        availability: 'available',
        capabilities: { balance: false, context: false, windows: true },
        checkedAt: Date.now(),
        source: 'managed-chatgpt-gateway',
        windows: [{ label: '5 小时', usedPercent: 25 }],
      })
      .mockImplementationOnce(
        () =>
          new Promise((_, reject) => {
            rejectSecond = reject;
          }),
      )
      .mockResolvedValue({
        accountKey: 'account-a',
        availability: 'available',
        capabilities: { balance: false, context: false, windows: true },
        checkedAt: Date.now(),
        source: 'managed-chatgpt-gateway',
        windows: [{ label: '5 小时', usedPercent: 30 }],
      });
    const { service } = await fixture(
      quota,
      undefined,
      (listener) => {
        readable = listener;
        return () => undefined;
      },
      (listener) => {
        invalidated = listener;
        return () => undefined;
      },
    );
    service.select({ ...api, preset: 'chatgpt-subscription', mode: 'subscription' });
    await vi.advanceTimersByTimeAsync(0);
    expect(quota).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(service.getSnapshot().status).toBe('available'));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(quota).toHaveBeenCalledTimes(2);
    invalidated(false);
    readable();
    rejectSecond(new Error('transport failed'));
    await vi.waitFor(() => expect(quota).toHaveBeenCalledTimes(3));
    await vi.waitFor(() => expect(service.getSnapshot().windows?.[0]?.remainingPercent).toBe(70));
  });

  it('fences a late quota result when only the model changes on the same connection', async () => {
    let finishOld!: (resource: ModelQuotaResult) => void;
    const quota = vi
      .fn<(signal: AbortSignal, model: string) => Promise<ModelQuotaResult>>()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishOld = resolve;
          }),
      )
      .mockResolvedValue({
        accountKey: 'account-a',
        availability: 'available',
        capabilities: { balance: false, context: false, windows: true },
        checkedAt: Date.now(),
        source: 'managed-chatgpt-gateway',
        windows: [{ label: 'Spark', usedPercent: 25 }],
      });
    const { service } = await fixture(quota);
    const connection: ModelUsageConnection = {
      ...api,
      preset: 'chatgpt-subscription',
      mode: 'subscription',
      model: 'gpt-5.3-codex',
    };
    service.select(connection);
    await vi.waitFor(() => expect(quota).toHaveBeenCalledOnce());
    service.select({ ...connection, model: 'gpt-5.3-codex-spark' });
    await vi.waitFor(() => expect(service.getSnapshot().windows?.[0]?.remainingPercent).toBe(75));

    finishOld({
      accountKey: 'account-a',
      availability: 'available',
      capabilities: { balance: false, context: false, windows: true },
      checkedAt: Date.now(),
      source: 'managed-chatgpt-gateway',
      windows: [{ label: 'General', usedPercent: 99 }],
    });
    await Promise.resolve();
    expect(service.getSnapshot().windows?.[0]).toMatchObject({
      label: 'Spark',
      remainingPercent: 75,
    });
  });

  it('marks cached quota stale while a later singleflight read remains pending', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-28T00:00:00Z'));
    const quota = vi
      .fn<() => Promise<ModelQuotaResult>>()
      .mockResolvedValueOnce({
        accountKey: 'account-a',
        availability: 'available',
        capabilities: { balance: false, context: false, windows: true },
        checkedAt: Date.now(),
        source: 'managed-chatgpt-gateway',
        windows: [{ label: '5 小时', usedPercent: 37 }],
      })
      .mockImplementation(() => new Promise(() => undefined));
    const { service } = await fixture(quota);
    service.select({ ...api, preset: 'chatgpt-subscription', mode: 'subscription' });
    await vi.advanceTimersByTimeAsync(0);
    expect(service.getSnapshot().status).toBe('available');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(quota).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(5 * 60_000 + 1);
    expect(service.getSnapshot().status).toBe('stale');
  });

  it('does not burst at a timer boundary or poll when the floating window and theme change', async () => {
    vi.useFakeTimers();
    const quota = vi.fn(async () => undefined);
    const { service } = await fixture(quota);
    await vi.advanceTimersByTimeAsync(59_000);
    service.select({ ...api, preset: 'chatgpt-subscription', mode: 'subscription' });
    await vi.advanceTimersByTimeAsync(1_000);
    service.setFloating(true);
    service.setTheme('midnight');
    await vi.advanceTimersByTimeAsync(2_000);
    expect(quota).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(58_000);
    expect(quota).toHaveBeenCalledTimes(2);
  });

  it('refreshes the model-specific bucket without requiring a different account identifier', async () => {
    const quota = vi.fn(async () => undefined);
    const { service } = await fixture(quota);
    const connection: ModelUsageConnection = {
      ...api,
      preset: 'chatgpt-subscription',
      mode: 'subscription',
      model: 'gpt-5.3-codex',
    };
    service.select(connection);
    await Promise.resolve();
    const connectedAt = service.getSnapshot().connectedAt;
    service.select({ ...connection, model: 'gpt-5.3-codex-spark' });
    await Promise.resolve();
    expect(quota).toHaveBeenCalledTimes(2);
    expect(service.getSnapshot().connectedAt).toBe(connectedAt);
  });
});
