import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ResourceUsageView } from '../../src/shared/contracts';
import type { ModelUsageConnection } from '../../src/main/usage/identity';
import type { TranscriptUsageReply } from '../../src/main/usage/transcript-client';
import { ModelUsageService } from '../../src/main/usage/service';

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
  readChatGptQuota: () => Promise<ResourceUsageView | undefined> = async () => undefined,
  existingRoot?: string,
) => {
  const root = existingRoot ?? (await mkdtemp(path.join(tmpdir(), 'claudedock-usage-service-')));
  if (!existingRoot) roots.push(root);
  const changed = vi.fn();
  const service = new ModelUsageService({
    userDataPath: root,
    projectsRoot: path.join(root, 'projects'),
    onChanged: changed,
    readChatGptQuota,
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
});
