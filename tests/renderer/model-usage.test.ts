import { describe, expect, it, vi } from 'vitest';
import type { ModelUsageSnapshot } from '../../src/shared/contracts';
import { modelUsagePresentation } from '../../src/renderer/platform/model-usage-view';
import { settle, withRenderer } from '../helpers/renderer-interaction-fixture';

const state: ModelUsageSnapshot = {
  revision: 1,
  mode: 'api',
  status: 'available',
  preset: 'deepseek',
  model: 'deepseek-chat',
  tokens: { input: 1000, output: 500, cacheRead: 100, cacheCreation: 200 },
  detail: '本次接入后',
  floating: false,
  themeId: 'claude',
};
describe('model usage card', () => {
  it('uses token totals without fabricating a quota percentage', () => {
    const view = modelUsagePresentation(state);
    expect(view.value).toBe('1800');
    expect(view.percent).toBeUndefined();
    expect(view.title).toContain('已记录 1,800 Token');
    expect(view.title).toContain('缓存读取 100');
  });
  it('shows the most restrictive window and an explicit unavailable fallback', () => {
    const subscription = {
      ...state,
      mode: 'subscription' as const,
      windows: [
        { label: '5 小时', remainingPercent: 70 },
        { label: '7 天', remainingPercent: 25 },
      ],
    };
    expect(modelUsagePresentation(subscription)).toMatchObject({
      value: '25%',
      unit: '7 天窗口剩余',
      percent: 25,
    });
    expect(modelUsagePresentation({ ...subscription, status: 'unavailable' })).toMatchObject({
      value: '暂无法获取',
      percent: undefined,
    });
  });
  it('subscribes once, updates in place, and toggles the shared floating window', async () => {
    const toggle = vi.fn(async () => ({ ...state, floating: true }));
    await withRenderer(
      { getModelUsage: async () => state, setModelUsageFloating: toggle },
      async (harness) => {
        await settle(harness);
        const value = harness.query('[data-usage-value]');
        expect(value.textContent).toBe('1800');
        harness.emit('onModelUsage', {
          ...state,
          revision: 2,
          floating: true,
          tokens: { ...state.tokens!, input: 2000 },
        });
        expect(harness.query('[data-usage-value]')).toBe(value);
        expect(value.textContent).toBe('2800');
        expect(harness.query('#model-usage-floating').getAttribute('aria-pressed')).toBe('true');
        harness.click('#model-usage-floating');
        await settle(harness);
        expect(toggle).toHaveBeenCalledWith(false);
        expect(harness.method('getModelUsage')).toHaveBeenCalledOnce();
      },
    );
  });

  it('keeps the quota failure reason visible and marks retained percentages as old data', () => {
    const unavailable: ModelUsageSnapshot = {
      ...state,
      mode: 'subscription',
      status: 'unavailable',
      preset: 'chatgpt-subscription',
      tokens: undefined,
      detail: 'ChatGPT 额度查询授权已失效，等待网关刷新。',
    };
    expect(modelUsagePresentation(unavailable)).toMatchObject({
      value: '暂无法获取',
      detail: unavailable.detail,
      percent: undefined,
    });
    expect(
      modelUsagePresentation({
        ...unavailable,
        status: 'stale',
        windows: [{ label: '7 天', remainingPercent: 92 }],
        detail: 'ChatGPT 额度查询超时；显示上次结果',
      }),
    ).toMatchObject({ value: '92%', detail: 'ChatGPT 额度查询超时；显示上次结果（旧数据）' });
  });
  it('ignores a stale initial read after a newer push and shows errors without breaking navigation', async () => {
    let resolve!: (value: ModelUsageSnapshot) => void;
    await withRenderer(
      {
        getModelUsage: () =>
          new Promise((settle) => {
            resolve = settle;
          }),
        setModelUsageFloating: async () => {
          throw new Error('failed');
        },
      },
      async (harness) => {
        harness.emit('onModelUsage', { ...state, revision: 3 });
        resolve({ ...state, revision: 1, mode: 'none' });
        await settle(harness);
        expect(harness.query('[data-usage-value]').textContent).toBe('1800');
        harness.click('#model-usage-floating');
        await settle(harness);
        expect(harness.query<HTMLButtonElement>('#model-usage-floating').disabled).toBe(false);
        harness.click('[data-rail-tab="connection"]');
        expect(harness.query('[data-rail-tab="connection"]').getAttribute('aria-pressed')).toBe(
          'true',
        );
      },
    );
  });
});
