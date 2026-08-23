import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { CLAUDE_EXECUTION_PROFILES } from '../../src/shared/claude/execution-profiles';
import type {
  ClaudeExecutionCapabilityStatus,
  ClaudeExecutionEffectiveSettingDto,
  ClaudeExecutionEffectiveViewDto,
  ClaudeExecutionSettingsDto,
  ClaudeExecutionSettingsRequest,
  ClaudeExecutionSourceKind,
  ClaudeToolSearchRequest,
  ControlPanelApi,
} from '../../src/shared/contracts';
import {
  createClaudeExecutionSettingsFeature,
  type ClaudeExecutionSettingsFeature,
} from '../../src/renderer/features/claude-execution-settings';
import {
  createClaudeExecutionSettingsLoader,
  type ClaudeExecutionSettingsFeatureModule,
} from '../../src/renderer/features/claude-execution-settings/loader';
import { settle, withRenderer } from '../helpers/renderer-interaction-fixture';

const createDeferred = <Value>() => {
  let resolve!: (value: Value | PromiseLike<Value>) => void;
  const promise = new Promise<Value>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
};

const source = (kind: ClaudeExecutionSourceKind) => ({
  ...(kind === 'verified-evidence'
    ? { expiresAt: 2_000_000_000_000, verifiedAt: 1_900_000_000_000 }
    : {}),
  kind,
});

const numericSetting = (
  status: ClaudeExecutionCapabilityStatus,
  kind: ClaudeExecutionSourceKind,
  overrides: Partial<ClaudeExecutionEffectiveSettingDto<number>> = {},
): ClaudeExecutionEffectiveSettingDto<number> => ({
  defaultValue: 4,
  effectiveValue: 8,
  reason: `numeric-reason-${status}-${kind}`,
  requestedValue: 8,
  source: source(kind),
  status,
  ...overrides,
});

const toolSearchSetting = (
  status: ClaudeExecutionCapabilityStatus,
  kind: ClaudeExecutionSourceKind,
): ClaudeExecutionEffectiveSettingDto<ClaudeToolSearchRequest> => ({
  defaultValue: 'inherit',
  effectiveValue: 'auto:20',
  reason: `tool-search-reason-${status}-${kind}`,
  requestedValue: 'auto:20',
  source: source(kind),
  status,
});

const makeEffective = (): ClaudeExecutionEffectiveViewDto => ({
  concurrentSubagents: numericSetting('supported', 'version-matrix', {
    effectiveValue: 91,
  }),
  spawnDepth: numericSetting('fixed', 'claude-default', {
    defaultValue: 3,
    effectiveValue: 3,
    requestedValue: 3,
  }),
  toolSearch: toolSearchSetting('unavailable', 'undocumented'),
  toolUseConcurrency: numericSetting('update-required', 'verified-evidence'),
});

interface DtoOverrides {
  effective?: ClaudeExecutionEffectiveViewDto;
  installation?: ClaudeExecutionSettingsDto['installation'];
  requested?: ClaudeExecutionSettingsRequest;
}

const makeDto = (overrides: DtoOverrides = {}): ClaudeExecutionSettingsDto => ({
  catalogVersion: 1,
  effective: overrides.effective ?? makeEffective(),
  installation: overrides.installation ?? { installed: true, version: '5.2.1' },
  profiles: CLAUDE_EXECUTION_PROFILES.map(({ id, label, values }) => ({
    id,
    label,
    values: { ...values },
  })),
  requested: overrides.requested ?? { mode: 'profile', profileId: 'balanced' },
  version: 1,
});

const statusAndSourceCases = [
  ['fixed', '固定值', 'claude-default', 'Claude 默认行为'],
  ['supported', '已支持', 'version-matrix', '版本能力矩阵'],
  ['unavailable', '不可用', 'undocumented', '暂无公开支持依据'],
  ['unverified', '未验证', 'requested-inherit', '继承请求'],
  ['update-required', '需要更新', 'verified-evidence', '已验证能力证据'],
] as const satisfies readonly (readonly [
  ClaudeExecutionCapabilityStatus,
  string,
  ClaudeExecutionSourceKind,
  string,
])[];

describe('Claude execution settings lazy loader', () => {
  let dom: JSDOM;
  let root: HTMLElement;

  beforeEach(() => {
    dom = new JSDOM('<div id="root"></div>', {
      pretendToBeVisual: true,
      url: 'http://localhost/',
    });
    root = dom.window.document.getElementById('root')!;
  });

  afterEach(() => {
    dom.window.close();
  });

  const createFakeFeature = (): ClaudeExecutionSettingsFeature => ({
    activate: vi.fn(async () => undefined),
    dispose: vi.fn(),
    endDialogSession: vi.fn(),
    isDirty: vi.fn(() => true),
    savePending: vi.fn(async () => false),
  });

  const featureDependencies = () => ({
    root,
    setDialogMutationBusy: vi.fn(),
    showToast: vi.fn(),
    updateUnsavedIndicator: vi.fn(() => 0),
  });

  it('does not import before activation and constructs the feature only once', async () => {
    const feature = createFakeFeature();
    const factory = vi.fn(() => feature);
    const importFeature = vi.fn(async () => ({
      createClaudeExecutionSettingsFeature: factory,
    }));
    const showToast = vi.fn();
    const loader = createClaudeExecutionSettingsLoader({
      featureDependencies: featureDependencies(),
      importFeature,
      showToast,
    });

    expect(importFeature).not.toHaveBeenCalled();
    expect(loader.isDirty()).toBe(false);
    await expect(loader.savePending()).resolves.toBe(true);

    await loader.activate();
    await loader.activate();

    expect(importFeature).toHaveBeenCalledTimes(1);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(feature.activate).toHaveBeenCalledTimes(2);
    expect(loader.isDirty()).toBe(true);
    await expect(loader.savePending()).resolves.toBe(false);

    loader.endDialogSession(true);
    expect(feature.endDialogSession).toHaveBeenCalledWith(true);
    loader.dispose();
    expect(feature.dispose).toHaveBeenCalledTimes(1);
    expect(showToast).not.toHaveBeenCalled();
  });

  it('clears a failed import so a later activation can retry', async () => {
    const feature = createFakeFeature();
    let attempt = 0;
    const importFeature = vi.fn(() => {
      attempt += 1;
      return attempt === 1
        ? Promise.reject(new Error('chunk failed'))
        : Promise.resolve({ createClaudeExecutionSettingsFeature: () => feature });
    });
    const showToast = vi.fn();
    const loader = createClaudeExecutionSettingsLoader({
      featureDependencies: featureDependencies(),
      importFeature,
      showToast,
    });

    await loader.activate();
    expect(showToast).toHaveBeenCalledWith('无法加载 Claude 执行设置。', 'error');

    await loader.activate();
    expect(importFeature).toHaveBeenCalledTimes(2);
    expect(feature.activate).toHaveBeenCalledTimes(1);
  });

  it('disposes exactly once when disposal happens while the import is pending', async () => {
    const feature = createFakeFeature();
    const module = createDeferred<ClaudeExecutionSettingsFeatureModule>();
    const loader = createClaudeExecutionSettingsLoader({
      featureDependencies: featureDependencies(),
      importFeature: () => module.promise,
      showToast: vi.fn(),
    });

    const activation = loader.activate();
    loader.dispose();
    module.resolve({ createClaudeExecutionSettingsFeature: () => feature });
    await activation;

    expect(feature.activate).not.toHaveBeenCalled();
    expect(feature.dispose).toHaveBeenCalledTimes(1);
  });

  it('fences a pending activation after the dialog session ends', async () => {
    const feature = createFakeFeature();
    const module = createDeferred<ClaudeExecutionSettingsFeatureModule>();
    const loader = createClaudeExecutionSettingsLoader({
      featureDependencies: featureDependencies(),
      importFeature: () => module.promise,
      showToast: vi.fn(),
    });

    const firstActivation = loader.activate();
    loader.endDialogSession(true);
    module.resolve({ createClaudeExecutionSettingsFeature: () => feature });
    await firstActivation;
    expect(feature.activate).not.toHaveBeenCalled();

    await loader.activate();
    expect(feature.activate).toHaveBeenCalledTimes(1);
  });
});

describe('Claude execution settings renderer behavior', () => {
  let authoritative: ClaudeExecutionSettingsDto;
  let dom: JSDOM;
  let getSettings: Mock<ControlPanelApi['getClaudeExecutionSettings']>;
  let globalDescriptors: Map<PropertyKey, PropertyDescriptor | undefined>;
  let recommendedSettings: Mock<ControlPanelApi['useRecommendedClaudeExecutionSettings']>;
  let restoreSettings: Mock<ControlPanelApi['restoreClaudeExecutionSettingsDefault']>;
  let root: HTMLElement;
  let setDialogMutationBusy: Mock<(busy: boolean) => void>;
  let showToast: Mock<(message: string, tone?: 'error' | 'success') => void>;
  let updateSettings: Mock<ControlPanelApi['updateClaudeExecutionSettings']>;
  let updateUnsavedIndicator: Mock<() => number>;

  const exposeGlobal = (key: PropertyKey, value: unknown): void => {
    globalDescriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, {
      configurable: true,
      value,
      writable: true,
    });
  };

  beforeEach(() => {
    authoritative = makeDto();
    dom = new JSDOM('<div id="root"></div>', {
      pretendToBeVisual: true,
      url: 'http://localhost/',
    });
    root = dom.window.document.getElementById('root')!;
    globalDescriptors = new Map();

    getSettings = vi.fn(async () => authoritative);
    updateSettings = vi.fn(async (requested) => {
      authoritative = makeDto({ requested });
      return authoritative;
    });
    recommendedSettings = vi.fn(async () => authoritative);
    restoreSettings = vi.fn(async () => authoritative);
    setDialogMutationBusy = vi.fn();
    showToast = vi.fn();
    updateUnsavedIndicator = vi.fn(() => 0);

    const api = {
      getClaudeExecutionSettings: getSettings,
      restoreClaudeExecutionSettingsDefault: restoreSettings,
      updateClaudeExecutionSettings: updateSettings,
      useRecommendedClaudeExecutionSettings: recommendedSettings,
    } as unknown as ControlPanelApi;
    Object.defineProperty(dom.window, 'controlPanel', {
      configurable: true,
      value: api,
    });

    for (const [key, value] of Object.entries({
      Element: dom.window.Element,
      Event: dom.window.Event,
      HTMLElement: dom.window.HTMLElement,
      HTMLInputElement: dom.window.HTMLInputElement,
      document: dom.window.document,
      window: dom.window,
    })) {
      exposeGlobal(key, value);
    }
  });

  afterEach(() => {
    dom.window.close();
    for (const [key, descriptor] of globalDescriptors) {
      if (descriptor) {
        Object.defineProperty(globalThis, key, descriptor);
      } else {
        Reflect.deleteProperty(globalThis, key);
      }
    }
  });

  const createFeature = (): ClaudeExecutionSettingsFeature =>
    createClaudeExecutionSettingsFeature({
      root,
      setDialogMutationBusy,
      showToast,
      updateUnsavedIndicator,
    });

  const modeInput = (value: string): HTMLInputElement => {
    const input = root.querySelector<HTMLInputElement>(
      `input[name="claude-execution-mode"][value="${value}"]`,
    );
    if (!input) throw new Error(`Missing mode input: ${value}`);
    return input;
  };

  const customInput = (key: string): HTMLInputElement => {
    const input = root.querySelector<HTMLInputElement>(`[data-execution-custom-field="${key}"]`);
    if (!input) throw new Error(`Missing custom input: ${key}`);
    return input;
  };

  const setCustomInput = (key: string, value: string): void => {
    const input = customInput(key);
    input.value = value;
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  };

  const flush = async (): Promise<void> => {
    await Promise.resolve();
    await Promise.resolve();
  };

  it('renders five ordered profiles and keeps requested, default, and effective facts separate', async () => {
    const safe = makeDto({ requested: { mode: 'profile', profileId: 'token-saver' } });
    const unsafe = {
      ...safe,
      credentials: 'credential-secret',
      environment: 'environment-secret',
      machine: 'machine-secret',
      route: 'route-secret',
      effective: {
        ...safe.effective,
        concurrentSubagents: {
          ...safe.effective.concurrentSubagents,
          envKey: 'env-key-secret',
          operation: { kind: 'set', value: 'operation-secret' },
          source: {
            ...safe.effective.concurrentSubagents.source,
            reference: 'reference-secret',
          },
        },
      },
    } as unknown as ClaudeExecutionSettingsDto;
    getSettings.mockResolvedValueOnce(unsafe);
    const feature = createFeature();

    await feature.activate();

    expect(
      Array.from(
        root.querySelectorAll<HTMLInputElement>(
          '[data-execution-profiles] input[value^="profile:"]',
        ),
        ({ value }) => value,
      ),
    ).toEqual([
      'profile:token-saver',
      'profile:restrained',
      'profile:balanced',
      'profile:high-throughput',
      'profile:best-performance',
    ]);
    expect(modeInput('profile:token-saver').checked).toBe(true);

    const concurrentRow = root.querySelector<HTMLElement>(
      '[data-execution-setting="concurrentSubagents"]',
    )!;
    const valueCells = concurrentRow.querySelectorAll('td');
    expect(valueCells[0]?.textContent).toBe('2');
    expect(valueCells[1]?.textContent).toBe('4');
    expect(valueCells[2]?.textContent).toBe('91');
    expect(root.textContent).toContain('Claude Code 版本 5.2.1');
    expect(root.textContent).toContain('正在运行和已经准备完成的会话不变');
    expect(root.textContent).toContain('不提高模型智能、推理能力或回答质量');

    for (const reason of Array.from(
      root.querySelectorAll<HTMLParagraphElement>('details p'),
      ({ textContent }) => textContent,
    )) {
      expect(reason).toContain('reason-');
    }
    expect(root.querySelectorAll('details summary')).toHaveLength(4);
    for (const summary of root.querySelectorAll('details summary')) {
      expect(summary.textContent).toBe('查看详情');
    }

    for (const secret of [
      'credential-secret',
      'environment-secret',
      'machine-secret',
      'route-secret',
      'env-key-secret',
      'operation-secret',
      'reference-secret',
    ]) {
      expect(root.textContent).not.toContain(secret);
      expect(root.innerHTML).not.toContain(secret);
    }
  });

  it.each(statusAndSourceCases)(
    'presents %s status and %s source using renderer-safe labels',
    async (status, statusLabel, kind, sourceLabel) => {
      const base = makeDto();
      getSettings.mockResolvedValueOnce(
        makeDto({
          effective: {
            ...base.effective,
            concurrentSubagents: numericSetting(status, kind),
          },
        }),
      );
      const feature = createFeature();

      await feature.activate();

      const row = root.querySelector<HTMLElement>(
        '[data-execution-setting="concurrentSubagents"]',
      )!;
      expect(row.textContent).toContain(statusLabel);
      expect(row.textContent).toContain(sourceLabel);
      if (kind === 'verified-evidence') {
        expect(row.textContent).toContain('验证于');
        expect(row.textContent).toContain('有效至');
      }
    },
  );

  it.each([
    [{ installed: false }, '未检测到 Claude Code'],
    [{ installed: true }, '已检测到 Claude Code，版本尚未确认'],
    [{ installed: true, version: '9.8.7' }, 'Claude Code 版本 9.8.7'],
  ] as const)('presents installation state %j', async (installation, label) => {
    getSettings.mockResolvedValueOnce(makeDto({ installation }));
    const feature = createFeature();

    await feature.activate();

    expect(root.querySelector('[data-execution-installation]')?.textContent).toBe(label);
  });

  it('keeps profile, custom, and Claude-default requests as drafts until Done', async () => {
    const feature = createFeature();
    await feature.activate();

    modeInput('profile:restrained').click();
    expect(feature.isDirty()).toBe(true);
    expect(updateSettings).not.toHaveBeenCalled();
    await expect(feature.savePending()).resolves.toBe(true);
    expect(updateSettings).toHaveBeenLastCalledWith({
      mode: 'profile',
      profileId: 'restrained',
    });
    expect(feature.isDirty()).toBe(false);

    modeInput('custom').click();
    setCustomInput('concurrentSubagents', '12');
    setCustomInput('spawnDepth', '4');
    setCustomInput('toolUseConcurrency', '14');
    setCustomInput('toolSearch', 'auto:25');
    expect(updateSettings).toHaveBeenCalledTimes(1);

    modeInput('profile:token-saver').click();
    modeInput('custom').click();
    expect(customInput('concurrentSubagents').value).toBe('12');
    expect(customInput('spawnDepth').value).toBe('4');
    expect(customInput('toolUseConcurrency').value).toBe('14');
    expect(customInput('toolSearch').value).toBe('auto:25');

    await expect(feature.savePending()).resolves.toBe(true);
    expect(updateSettings).toHaveBeenLastCalledWith({
      mode: 'custom',
      values: {
        concurrentSubagents: 12,
        spawnDepth: 4,
        toolSearch: 'auto:25',
        toolUseConcurrency: 14,
      },
    });
    expect(feature.isDirty()).toBe(false);

    modeInput('claude-default').click();
    expect(updateSettings).toHaveBeenCalledTimes(2);
    await expect(feature.savePending()).resolves.toBe(true);
    expect(updateSettings).toHaveBeenLastCalledWith({ mode: 'claude-default' });
    expect(updateSettings).toHaveBeenCalledTimes(3);
  });

  it('treats invalid custom text as dirty and blocks Done on the first invalid field', async () => {
    authoritative = makeDto({
      requested: {
        mode: 'custom',
        values: {
          concurrentSubagents: 8,
          spawnDepth: 3,
          toolSearch: 'inherit',
          toolUseConcurrency: 10,
        },
      },
    });
    const feature = createFeature();
    await feature.activate();

    setCustomInput('concurrentSubagents', '129');

    expect(feature.isDirty()).toBe(true);
    await expect(feature.savePending()).resolves.toBe(false);
    expect(updateSettings).not.toHaveBeenCalled();
    expect(customInput('concurrentSubagents').getAttribute('aria-invalid')).toBe('true');
    expect(dom.window.document.activeElement).toBe(customInput('concurrentSubagents'));
    expect(showToast).toHaveBeenCalledWith('请检查 Claude 执行自定义请求。', 'error');
  });

  it('discards ordinary drafts on Cancel and reloads the authoritative request', async () => {
    const feature = createFeature();
    await feature.activate();
    modeInput('profile:best-performance').click();
    expect(feature.isDirty()).toBe(true);

    feature.endDialogSession(true);
    expect(root.childElementCount).toBe(0);
    expect(feature.isDirty()).toBe(false);
    expect(updateSettings).not.toHaveBeenCalled();

    await feature.activate();
    expect(getSettings).toHaveBeenCalledTimes(2);
    expect(modeInput('profile:balanced').checked).toBe(true);
  });

  it('applies recommended and restore-default immediately as new Cancel baselines', async () => {
    recommendedSettings.mockImplementation(async () => {
      authoritative = makeDto({
        requested: { mode: 'profile', profileId: 'high-throughput' },
      });
      return authoritative;
    });
    restoreSettings.mockImplementation(async () => {
      authoritative = makeDto({ requested: { mode: 'claude-default' } });
      return authoritative;
    });
    const feature = createFeature();
    await feature.activate();

    modeInput('custom').click();
    setCustomInput('concurrentSubagents', '12');
    root.querySelector<HTMLButtonElement>('[data-execution-action="recommended"]')!.click();

    expect(setDialogMutationBusy).toHaveBeenLastCalledWith(true);
    expect(
      root.querySelector<HTMLButtonElement>('[data-execution-action="recommended"]')?.disabled,
    ).toBe(true);
    await vi.waitFor(() => {
      expect(modeInput('profile:high-throughput').checked).toBe(true);
    });
    expect(feature.isDirty()).toBe(false);
    expect(updateSettings).not.toHaveBeenCalled();
    expect(setDialogMutationBusy).toHaveBeenLastCalledWith(false);

    modeInput('custom').click();
    expect(customInput('concurrentSubagents').value).toBe('12');
    modeInput('profile:token-saver').click();
    feature.endDialogSession(true);
    await feature.activate();
    expect(modeInput('profile:high-throughput').checked).toBe(true);

    root.querySelector<HTMLButtonElement>('[data-execution-action="restore"]')!.click();
    await vi.waitFor(() => {
      expect(modeInput('claude-default').checked).toBe(true);
    });
    expect(feature.isDirty()).toBe(false);

    modeInput('profile:balanced').click();
    feature.endDialogSession(true);
    await feature.activate();
    expect(modeInput('claude-default').checked).toBe(true);
  });

  it('prevents a stale initial load from overwriting a reopened dialog session', async () => {
    const firstLoad = createDeferred<ClaudeExecutionSettingsDto>();
    const reopened = makeDto({
      requested: { mode: 'profile', profileId: 'best-performance' },
    });
    getSettings.mockReturnValueOnce(firstLoad.promise).mockResolvedValueOnce(reopened);
    const feature = createFeature();

    const pendingFirst = feature.activate();
    feature.endDialogSession(true);
    await feature.activate();
    expect(modeInput('profile:best-performance').checked).toBe(true);

    firstLoad.resolve(makeDto({ requested: { mode: 'profile', profileId: 'token-saver' } }));
    await pendingFirst;
    expect(modeInput('profile:best-performance').checked).toBe(true);
    expect(getSettings).toHaveBeenCalledTimes(2);
  });

  it('does not let a stale mutation overwrite or unlock a newer session mutation', async () => {
    const staleRecommended = createDeferred<ClaudeExecutionSettingsDto>();
    const currentRestore = createDeferred<ClaudeExecutionSettingsDto>();
    recommendedSettings.mockReturnValueOnce(staleRecommended.promise);
    restoreSettings.mockReturnValueOnce(currentRestore.promise);
    const feature = createFeature();
    await feature.activate();

    root.querySelector<HTMLButtonElement>('[data-execution-action="recommended"]')!.click();
    feature.endDialogSession(true);
    await feature.activate();
    root.querySelector<HTMLButtonElement>('[data-execution-action="restore"]')!.click();
    expect(setDialogMutationBusy).toHaveBeenLastCalledWith(true);

    staleRecommended.resolve(
      makeDto({ requested: { mode: 'profile', profileId: 'best-performance' } }),
    );
    await flush();
    expect(setDialogMutationBusy).toHaveBeenLastCalledWith(true);
    expect(root.querySelector('[data-execution-progress]')?.textContent).toBe(
      '正在恢复 Claude 默认…',
    );

    currentRestore.resolve(makeDto({ requested: { mode: 'claude-default' } }));
    await vi.waitFor(() => {
      expect(modeInput('claude-default').checked).toBe(true);
    });
    expect(modeInput('profile:best-performance').checked).toBe(false);
    expect(setDialogMutationBusy).toHaveBeenLastCalledWith(false);
  });

  it('fences a late save result after Cancel and reopen', async () => {
    const save = createDeferred<ClaudeExecutionSettingsDto>();
    updateSettings.mockReturnValueOnce(save.promise);
    const feature = createFeature();
    await feature.activate();
    modeInput('profile:restrained').click();

    const pendingSave = feature.savePending();
    expect(setDialogMutationBusy).toHaveBeenLastCalledWith(true);
    feature.endDialogSession(true);
    await feature.activate();
    expect(modeInput('profile:balanced').checked).toBe(true);

    save.resolve(makeDto({ requested: { mode: 'profile', profileId: 'restrained' } }));
    await expect(pendingSave).resolves.toBe(false);
    expect(modeInput('profile:balanced').checked).toBe(true);
    expect(setDialogMutationBusy).toHaveBeenLastCalledWith(false);
  });

  it('shows load failure facts and retries without changing settings', async () => {
    getSettings
      .mockRejectedValueOnce(new Error('read failed'))
      .mockResolvedValueOnce(authoritative);
    const feature = createFeature();

    await feature.activate();
    expect(root.querySelector('[data-execution-load-error]')).not.toBeNull();
    expect(root.textContent).toContain('当前值尚未改变');
    expect(showToast).toHaveBeenCalledWith('无法读取 Claude 执行设置。', 'error');

    root.querySelector<HTMLButtonElement>('[data-execution-action="retry"]')!.click();
    await vi.waitFor(() => {
      expect(root.querySelectorAll('[data-execution-profiles] input')).toHaveLength(7);
    });
    expect(getSettings).toHaveBeenCalledTimes(2);
    expect(updateSettings).not.toHaveBeenCalled();
  });

  it('removes content and listeners on disposal', async () => {
    const feature = createFeature();
    await feature.activate();
    feature.dispose();

    expect(root.childElementCount).toBe(0);
    expect(feature.isDirty()).toBe(false);
    root.innerHTML = '<button data-execution-action="recommended">推荐</button>';
    root.querySelector<HTMLButtonElement>('button')!.click();
    await flush();
    expect(recommendedSettings).not.toHaveBeenCalled();

    await feature.activate();
    expect(getSettings).toHaveBeenCalledTimes(1);
  });
});

const applicationProxyState = {
  config: {
    enabled: false,
    host: '127.0.0.1',
    passwordConfigured: false,
    port: 8080,
    protocol: 'http' as const,
    scope: { application: true, cli: true, conversation: true },
    username: '',
  },
};

describe('Claude execution settings dialog integration', () => {
  it('stays unloaded until its tab is selected and follows global Cancel and Done', async () => {
    let current = makeDto();
    const getSettings = vi.fn(async () => current);
    const updateSettings = vi.fn(async (requested: ClaudeExecutionSettingsRequest) => {
      current = makeDto({ requested });
      return current;
    });

    await withRenderer(
      {
        getApplicationProxyState: async () => applicationProxyState,
        getClaudeExecutionSettings: getSettings,
        updateClaudeExecutionSettings: updateSettings,
      },
      async (harness) => {
        expect(getSettings).not.toHaveBeenCalled();
        expect(harness.query('#claude-execution-settings-root').childElementCount).toBe(0);

        harness.click('#open-connection-advanced');
        await settle(harness);
        expect(getSettings).not.toHaveBeenCalled();

        harness.click('[data-settings-tab="claude-execution"]');
        await vi.waitFor(() => {
          expect(getSettings).toHaveBeenCalledTimes(1);
        });
        expect(
          harness.query<HTMLInputElement>(
            'input[name="claude-execution-mode"][value="profile:balanced"]',
          ).checked,
        ).toBe(true);

        harness.click('input[name="claude-execution-mode"][value="profile:best-performance"]');
        expect(harness.query('#settings-unsaved-indicator').textContent).toBe('*1 项未保存');
        harness.click('#cancel-connection-advanced');
        expect(updateSettings).not.toHaveBeenCalled();
        expect(harness.query<HTMLDialogElement>('#connection-advanced-dialog').open).toBe(false);

        harness.click('#open-connection-advanced');
        await settle(harness);
        harness.click('[data-settings-tab="claude-execution"]');
        await vi.waitFor(() => {
          expect(getSettings).toHaveBeenCalledTimes(2);
        });
        expect(
          harness.query<HTMLInputElement>(
            'input[name="claude-execution-mode"][value="profile:balanced"]',
          ).checked,
        ).toBe(true);

        harness.click('input[name="claude-execution-mode"][value="profile:best-performance"]');
        harness.click('#complete-connection-advanced');
        await vi.waitFor(() => {
          expect(updateSettings).toHaveBeenCalledWith({
            mode: 'profile',
            profileId: 'best-performance',
          });
          expect(harness.query<HTMLDialogElement>('#connection-advanced-dialog').open).toBe(false);
        });
      },
    );
  });

  it('keeps the dialog open when an invalid custom edit blocks global Done', async () => {
    const current = makeDto({
      requested: {
        mode: 'custom',
        values: {
          concurrentSubagents: 8,
          spawnDepth: 3,
          toolSearch: 'inherit',
          toolUseConcurrency: 10,
        },
      },
    });
    const updateSettings = vi.fn(async () => current);

    await withRenderer(
      {
        getApplicationProxyState: async () => applicationProxyState,
        getClaudeExecutionSettings: async () => current,
        updateClaudeExecutionSettings: updateSettings,
      },
      async (harness) => {
        harness.click('#open-connection-advanced');
        await settle(harness);
        harness.click('[data-settings-tab="claude-execution"]');
        await vi.waitFor(() => {
          expect(
            harness.document.querySelector('[data-execution-custom-field="concurrentSubagents"]'),
          ).not.toBeNull();
        });

        const input = harness.query<HTMLInputElement>(
          '[data-execution-custom-field="concurrentSubagents"]',
        );
        input.value = '129';
        input.dispatchEvent(new harness.dom.window.Event('input', { bubbles: true }));
        expect(harness.query('#settings-unsaved-indicator').textContent).toBe('*1 项未保存');

        harness.click('#complete-connection-advanced');
        await settle(harness);

        expect(updateSettings).not.toHaveBeenCalled();
        expect(harness.query<HTMLDialogElement>('#connection-advanced-dialog').open).toBe(true);
        expect(harness.query<HTMLButtonElement>('#complete-connection-advanced').disabled).toBe(
          false,
        );
        expect(harness.query<HTMLButtonElement>('#cancel-connection-advanced').disabled).toBe(
          false,
        );
      },
    );
  });
});
