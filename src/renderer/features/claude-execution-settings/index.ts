import type {
  ClaudeExecutionEffectiveViewDto,
  ClaudeExecutionRequestedValues,
  ClaudeExecutionSettingsDto,
  ClaudeExecutionSettingsRequest,
  ClaudeToolSearchRequest,
} from '../../../shared/contracts';

export interface ClaudeExecutionSettingsFeatureDependencies {
  root: HTMLElement;
  setDialogMutationBusy: (busy: boolean) => void;
  showToast: (message: string, tone?: 'error' | 'success') => void;
  updateUnsavedIndicator: () => number;
}

export interface ClaudeExecutionSettingsFeature {
  activate: () => Promise<void>;
  dispose: () => void;
  endDialogSession: (restore: boolean) => void;
  isDirty: () => boolean;
  savePending: () => Promise<boolean>;
}

interface FeatureState {
  active: boolean;
  authoritative?: ClaudeExecutionSettingsDto;
  busy: boolean;
  customDraft?: ClaudeExecutionRequestedValues;
  disposed: boolean;
  draft?: ClaudeExecutionSettingsRequest;
  generation: number;
  loadError: boolean;
  loading: boolean;
}

type ExecutionSettingKey = keyof ClaudeExecutionEffectiveViewDto;

const requiredChild = <ElementType extends HTMLElement>(
  selector: string,
  root: ParentNode,
): ElementType => {
  const element = root.querySelector<ElementType>(selector);
  if (!element) throw new Error(`Missing Claude execution control: ${selector}`);
  return element;
};

const settingDefinitions: readonly {
  key: ExecutionSettingKey;
  label: string;
}[] = [
  { key: 'concurrentSubagents', label: '并发子代理' },
  { key: 'spawnDepth', label: '子代理生成深度' },
  { key: 'toolUseConcurrency', label: '工具调用并发' },
  { key: 'toolSearch', label: '工具搜索' },
];

const numericBounds = {
  concurrentSubagents: { maximum: 128, minimum: 1 },
  spawnDepth: { maximum: 16, minimum: 1 },
  toolUseConcurrency: { maximum: 128, minimum: 1 },
} as const;

const statusLabels = {
  fixed: '固定值',
  supported: '已支持',
  unavailable: '不可用',
  unverified: '未验证',
  'update-required': '需要更新',
} as const;

const sourceLabels = {
  'claude-default': 'Claude 默认行为',
  'requested-inherit': '继承请求',
  undocumented: '暂无公开支持依据',
  'verified-evidence': '已验证能力证据',
  'version-matrix': '版本能力矩阵',
} as const;

const cloneValues = (values: ClaudeExecutionRequestedValues): ClaudeExecutionRequestedValues => ({
  ...values,
});

const cloneRequest = (request: ClaudeExecutionSettingsRequest): ClaudeExecutionSettingsRequest =>
  request.mode === 'custom'
    ? { mode: 'custom', values: cloneValues(request.values) }
    : request.mode === 'profile'
      ? { mode: 'profile', profileId: request.profileId }
      : { mode: 'claude-default' };

const requestsEqual = (
  left: ClaudeExecutionSettingsRequest | undefined,
  right: ClaudeExecutionSettingsRequest | undefined,
): boolean => {
  if (!left || !right || left.mode !== right.mode) return false;
  if (left.mode === 'claude-default') return true;
  if (left.mode === 'profile' && right.mode === 'profile') {
    return left.profileId === right.profileId;
  }
  if (left.mode !== 'custom' || right.mode !== 'custom') return false;
  return (
    left.values.concurrentSubagents === right.values.concurrentSubagents &&
    left.values.spawnDepth === right.values.spawnDepth &&
    left.values.toolSearch === right.values.toolSearch &&
    left.values.toolUseConcurrency === right.values.toolUseConcurrency
  );
};

const escapeHtml = (value: string): string =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');

const formatToolSearch = (value: ClaudeToolSearchRequest): string => {
  if (value === true) return '开启';
  if (value === false) return '关闭';
  if (value === 'inherit') return '继承';
  if (value === 'auto') return '自动';
  return `自动阈值 ${value.slice('auto:'.length)}`;
};

const formatValue = (value: unknown): string => {
  if (value === undefined) return '—';
  if (typeof value === 'boolean' || typeof value === 'string') {
    return formatToolSearch(value as ClaudeToolSearchRequest);
  }
  return String(value);
};

const formatSourceDates = (
  source: ClaudeExecutionEffectiveViewDto[ExecutionSettingKey]['source'],
): string => {
  const facts: string[] = [];
  if (source.verifiedAt !== undefined) {
    facts.push(`验证于 ${new Date(source.verifiedAt).toLocaleString('zh-CN')}`);
  }
  if (source.expiresAt !== undefined) {
    facts.push(`有效至 ${new Date(source.expiresAt).toLocaleString('zh-CN')}`);
  }
  return facts.join(' · ');
};

const installationText = (installation: ClaudeExecutionSettingsDto['installation']): string => {
  if (!installation.installed) return '未检测到 Claude Code';
  if (!installation.version) return '已检测到 Claude Code，版本尚未确认';
  return `Claude Code 版本 ${installation.version}`;
};

const profileSummary = (values: ClaudeExecutionRequestedValues): string =>
  `子代理 ${values.concurrentSubagents} · 深度 ${values.spawnDepth} · 工具并发 ${values.toolUseConcurrency} · 工具搜索 ${formatToolSearch(values.toolSearch)}`;

const requestedValues = (
  dto: ClaudeExecutionSettingsDto,
  request: ClaudeExecutionSettingsRequest,
): ClaudeExecutionRequestedValues | undefined => {
  if (request.mode === 'custom') return request.values;
  if (request.mode === 'profile') {
    return dto.profiles.find(({ id }) => id === request.profileId)?.values;
  }
  return undefined;
};

const requestedValue = (
  dto: ClaudeExecutionSettingsDto,
  request: ClaudeExecutionSettingsRequest,
  key: ExecutionSettingKey,
): string => {
  const values = requestedValues(dto, request);
  if (!values) return 'Claude 默认';
  return formatValue(values[key]);
};

const parseToolSearch = (
  value: string,
): { valid: true; value: ClaudeToolSearchRequest } | { valid: false } => {
  const normalized = value.trim();
  if (normalized === 'true') return { valid: true, value: true };
  if (normalized === 'false') return { valid: true, value: false };
  if (normalized === 'inherit' || normalized === 'auto') {
    return { valid: true, value: normalized };
  }
  if (/^auto:(?:0|[1-9]\d?|100)$/u.test(normalized)) {
    return { valid: true, value: normalized as ClaudeToolSearchRequest };
  }
  return { valid: false };
};

const defaultCustomValues = (dto: ClaudeExecutionSettingsDto): ClaudeExecutionRequestedValues => {
  if (dto.requested.mode === 'custom') return cloneValues(dto.requested.values);
  if (dto.requested.mode === 'profile') {
    const { profileId } = dto.requested;
    const activeProfile = dto.profiles.find(({ id }) => id === profileId);
    if (activeProfile) return cloneValues(activeProfile.values);
  }
  const balanced = dto.profiles.find(({ id }) => id === 'balanced');
  return cloneValues(balanced?.values ?? dto.profiles[0]!.values);
};

const renderLoading = (root: HTMLElement, failed: boolean): void => {
  root.innerHTML = failed
    ? `<div class="claude-execution-empty" data-execution-load-error>
        <strong>Claude 执行设置读取失败。</strong>
        <span>当前值尚未改变。</span>
        <button type="button" data-execution-action="retry">重试</button>
      </div>`
    : `<div class="claude-execution-empty" data-execution-loading>
        <strong>正在读取 Claude 执行设置…</strong>
        <span>读取完成后可编辑未来启动使用的请求。</span>
      </div>`;
};

const renderProfiles = (
  dto: ClaudeExecutionSettingsDto,
  draft: ClaudeExecutionSettingsRequest,
): string => {
  const profileCards = dto.profiles
    .map(
      (profile) => `<label class="claude-execution-choice">
        <input
          type="radio"
          name="claude-execution-mode"
          value="profile:${profile.id}"
          ${draft.mode === 'profile' && draft.profileId === profile.id ? 'checked' : ''}
        />
        <span>
          <strong>${escapeHtml(profile.label)}</strong>
          <small>${escapeHtml(profileSummary(profile.values))}</small>
        </span>
      </label>`,
    )
    .join('');
  return `<div class="claude-execution-choices" data-execution-profiles>
    ${profileCards}
    <label class="claude-execution-choice">
      <input
        type="radio"
        name="claude-execution-mode"
        value="claude-default"
        ${draft.mode === 'claude-default' ? 'checked' : ''}
      />
      <span>
        <strong>Claude 默认</strong>
        <small>完成时保存为不请求 ClaudeDock 执行覆盖。</small>
      </span>
    </label>
    <label class="claude-execution-choice">
      <input
        type="radio"
        name="claude-execution-mode"
        value="custom"
        ${draft.mode === 'custom' ? 'checked' : ''}
      />
      <span>
        <strong>自定义</strong>
        <small>在安全范围内逐项填写请求值。</small>
      </span>
    </label>
  </div>`;
};

const renderCustomEditor = (
  values: ClaudeExecutionRequestedValues,
  visible: boolean,
): string => `<fieldset class="claude-execution-custom" data-execution-custom ${visible ? '' : 'hidden'}>
  <legend>自定义请求</legend>
  <label>
    <span>并发子代理</span>
    <input
      data-execution-custom-field="concurrentSubagents"
      type="number"
      min="${numericBounds.concurrentSubagents.minimum}"
      max="${numericBounds.concurrentSubagents.maximum}"
      step="1"
      value="${values.concurrentSubagents}"
    />
    <small>${numericBounds.concurrentSubagents.minimum}–${numericBounds.concurrentSubagents.maximum}</small>
  </label>
  <label>
    <span>子代理生成深度</span>
    <input
      data-execution-custom-field="spawnDepth"
      type="number"
      min="${numericBounds.spawnDepth.minimum}"
      max="${numericBounds.spawnDepth.maximum}"
      step="1"
      value="${values.spawnDepth}"
    />
    <small>${numericBounds.spawnDepth.minimum}–${numericBounds.spawnDepth.maximum}</small>
  </label>
  <label>
    <span>工具调用并发</span>
    <input
      data-execution-custom-field="toolUseConcurrency"
      type="number"
      min="${numericBounds.toolUseConcurrency.minimum}"
      max="${numericBounds.toolUseConcurrency.maximum}"
      step="1"
      value="${values.toolUseConcurrency}"
    />
    <small>${numericBounds.toolUseConcurrency.minimum}–${numericBounds.toolUseConcurrency.maximum}</small>
  </label>
  <label class="claude-execution-custom__tool-search">
    <span>工具搜索</span>
    <input
      data-execution-custom-field="toolSearch"
      type="text"
      value="${escapeHtml(String(values.toolSearch))}"
      spellcheck="false"
      aria-describedby="claude-execution-tool-search-help"
    />
    <small id="claude-execution-tool-search-help">true、false、inherit、auto 或 auto:0–auto:100</small>
  </label>
</fieldset>`;

const renderEffectiveTable = (
  dto: ClaudeExecutionSettingsDto,
  draft: ClaudeExecutionSettingsRequest,
): string => {
  const rows = settingDefinitions
    .map(({ key, label }) => {
      const setting = dto.effective[key];
      const dates = formatSourceDates(setting.source);
      return `<tr data-execution-setting="${key}">
        <th scope="row">${label}</th>
        <td data-execution-requested="${key}">${escapeHtml(requestedValue(dto, draft, key))}</td>
        <td>${escapeHtml(formatValue(setting.defaultValue))}</td>
        <td>${escapeHtml(formatValue(setting.effectiveValue))}</td>
        <td>
          <span class="claude-execution-status" data-status="${setting.status}">${statusLabels[setting.status]}</span>
        </td>
        <td>
          <span>${sourceLabels[setting.source.kind]}</span>
          ${dates ? `<small>${escapeHtml(dates)}</small>` : ''}
        </td>
        <td>
          <details>
            <summary>查看详情</summary>
            <p>${escapeHtml(setting.reason)}</p>
          </details>
        </td>
      </tr>`;
    })
    .join('');
  return `<div class="claude-execution-table-wrap">
    <table class="claude-execution-table">
      <thead>
        <tr>
          <th scope="col">设置</th>
          <th scope="col">请求草稿</th>
          <th scope="col">Claude 默认</th>
          <th scope="col">当前有效值</th>
          <th scope="col">状态</th>
          <th scope="col">来源</th>
          <th scope="col">详情</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  </div>`;
};

const renderSettings = (root: HTMLElement, state: FeatureState): void => {
  const dto = state.authoritative;
  const draft = state.draft;
  if (!dto || !draft) {
    renderLoading(root, state.loadError);
    return;
  }
  state.customDraft ??= defaultCustomValues(dto);
  root.innerHTML = `<div class="claude-execution-settings" aria-busy="${String(state.busy)}">
    <section class="claude-execution-overview" aria-labelledby="claude-execution-settings-title">
      <div class="settings-section-heading">
        <strong id="claude-execution-settings-title">Claude 执行</strong>
        <span data-execution-installation>${escapeHtml(installationText(dto.installation))}</span>
      </div>
      <p class="claude-execution-scope">
        设置只应用于未来准备的 Claude Code 启动；正在运行和已经准备完成的会话不变。
        并发只影响吞吐与同时执行数量，不提高模型智能、推理能力或回答质量。
      </p>
      <div class="claude-execution-actions">
        <button type="button" data-execution-action="recommended">使用推荐</button>
        <button type="button" data-execution-action="restore">恢复 Claude 默认</button>
        <span data-execution-progress>${state.busy ? '正在应用…' : '当前值已读取。'}</span>
      </div>
    </section>
    <section class="claude-execution-section" aria-labelledby="claude-execution-profile-title">
      <div class="settings-section-heading">
        <strong id="claude-execution-profile-title">请求配置</strong>
        <span>配置选择和自定义编辑在点击“完成”前只保留为草稿。</span>
      </div>
      ${renderProfiles(dto, draft)}
      ${renderCustomEditor(state.customDraft, draft.mode === 'custom')}
    </section>
    <section class="claude-execution-section" aria-labelledby="claude-execution-effective-title">
      <div class="settings-section-heading">
        <strong id="claude-execution-effective-title">支持与有效值</strong>
        <span>请求草稿、Claude 默认值和当前有效值分别显示。</span>
      </div>
      ${renderEffectiveTable(dto, draft)}
    </section>
  </div>`;

  for (const control of root.querySelectorAll<HTMLButtonElement | HTMLInputElement>(
    'input, button',
  )) {
    control.disabled = state.busy;
  }
};

const setProgress = (root: HTMLElement, message: string): void => {
  const progress = root.querySelector<HTMLElement>('[data-execution-progress]');
  if (progress) progress.textContent = message;
};

const renderRequestedDraft = (
  root: HTMLElement,
  dto: ClaudeExecutionSettingsDto,
  draft: ClaudeExecutionSettingsRequest,
): void => {
  for (const { key } of settingDefinitions) {
    const cell = root.querySelector<HTMLElement>(`[data-execution-requested="${key}"]`);
    if (cell) cell.textContent = requestedValue(dto, draft, key);
  }
};

const readCustomDraft = (root: HTMLElement): ClaudeExecutionRequestedValues | undefined => {
  const readNumber = (key: keyof typeof numericBounds): number | undefined => {
    const input = requiredChild<HTMLInputElement>(`[data-execution-custom-field="${key}"]`, root);
    const value = input.valueAsNumber;
    const { maximum, minimum } = numericBounds[key];
    const valid = Number.isSafeInteger(value) && value >= minimum && value <= maximum;
    input.setAttribute('aria-invalid', String(!valid));
    input.setCustomValidity(valid ? '' : `请输入 ${minimum}–${maximum} 之间的整数。`);
    return valid ? value : undefined;
  };
  const toolSearchInput = requiredChild<HTMLInputElement>(
    '[data-execution-custom-field="toolSearch"]',
    root,
  );
  const toolSearch = parseToolSearch(toolSearchInput.value);
  toolSearchInput.setAttribute('aria-invalid', String(!toolSearch.valid));
  toolSearchInput.setCustomValidity(
    toolSearch.valid ? '' : '请输入 true、false、inherit、auto 或 auto:0–auto:100。',
  );

  const concurrentSubagents = readNumber('concurrentSubagents');
  const spawnDepth = readNumber('spawnDepth');
  const toolUseConcurrency = readNumber('toolUseConcurrency');
  if (
    concurrentSubagents === undefined ||
    spawnDepth === undefined ||
    toolUseConcurrency === undefined ||
    !toolSearch.valid
  ) {
    return undefined;
  }
  return {
    concurrentSubagents,
    spawnDepth,
    toolSearch: toolSearch.value,
    toolUseConcurrency,
  };
};

class ClaudeExecutionSettingsController implements ClaudeExecutionSettingsFeature {
  private activeLoad: Promise<void> | undefined;
  private readonly state: FeatureState = {
    active: false,
    busy: false,
    disposed: false,
    generation: 0,
    loadError: false,
    loading: false,
  };

  public constructor(private readonly dependencies: ClaudeExecutionSettingsFeatureDependencies) {
    const { root } = dependencies;
    root.addEventListener('click', this.handleClick);
    root.addEventListener('change', this.handleChange);
    root.addEventListener('input', this.handleInput);
  }

  public async activate(): Promise<void> {
    const { state } = this;
    if (state.disposed) return;
    if (state.active && state.authoritative) return;
    if (state.active && this.activeLoad) return this.activeLoad;
    state.active = true;
    return this.startLoad();
  }

  public dispose(): void {
    const { root, setDialogMutationBusy } = this.dependencies;
    if (this.state.disposed) return;
    this.state.disposed = true;
    this.state.active = false;
    this.state.generation += 1;
    setDialogMutationBusy(false);
    root.removeEventListener('click', this.handleClick);
    root.removeEventListener('change', this.handleChange);
    root.removeEventListener('input', this.handleInput);
    root.replaceChildren();
  }

  public endDialogSession(_restore: boolean): void {
    const { root, setDialogMutationBusy, updateUnsavedIndicator } = this.dependencies;
    if (!this.state.active) return;
    this.state.active = false;
    this.state.busy = false;
    this.state.generation += 1;
    this.state.authoritative = undefined;
    this.state.customDraft = undefined;
    this.state.draft = undefined;
    this.state.loadError = false;
    this.state.loading = false;
    setDialogMutationBusy(false);
    root.replaceChildren();
    updateUnsavedIndicator();
  }

  public isDirty(): boolean {
    const { root } = this.dependencies;
    const invalidCustomDraft =
      this.state.draft?.mode === 'custom' &&
      root.querySelector('[data-execution-custom-field][aria-invalid="true"]') !== null;
    return (
      this.state.active &&
      this.state.authoritative !== undefined &&
      (invalidCustomDraft || !requestsEqual(this.state.draft, this.state.authoritative.requested))
    );
  }

  public async savePending(): Promise<boolean> {
    const { root, setDialogMutationBusy, showToast, updateUnsavedIndicator } = this.dependencies;
    const { state } = this;
    if (!state.active || !state.authoritative || !state.draft) return true;
    if (state.busy) return false;
    if (state.draft.mode === 'custom') {
      const customDraft = readCustomDraft(root);
      if (!customDraft) {
        setProgress(root, '自定义请求包含无效值。');
        root.querySelector<HTMLInputElement>('[aria-invalid="true"]')?.focus();
        showToast('请检查 Claude 执行自定义请求。', 'error');
        return false;
      }
      state.customDraft = customDraft;
      state.draft = { mode: 'custom', values: cloneValues(customDraft) };
    }
    if (!this.isDirty()) return true;

    const generation = ++state.generation;
    const request = cloneRequest(state.draft);
    state.busy = true;
    setDialogMutationBusy(true);
    renderSettings(root, state);
    setProgress(root, '正在保存请求配置…');
    try {
      const dto = await window.controlPanel.updateClaudeExecutionSettings(request);
      if (!this.isCurrent(generation)) return false;
      this.applyMutationResult(dto);
      state.busy = false;
      renderSettings(root, state);
      updateUnsavedIndicator();
      return true;
    } catch {
      if (this.isCurrent(generation)) {
        state.busy = false;
        renderSettings(root, state);
        setProgress(root, '保存未完成，当前已保存值保持不变。');
        showToast('Claude 执行设置未能保存。', 'error');
      }
      return false;
    } finally {
      if (generation === state.generation) setDialogMutationBusy(false);
    }
  }

  private readonly handleChange = (event: Event): void => {
    const target = event.target;
    const authoritative = this.state.authoritative;
    if (
      !(target instanceof HTMLInputElement) ||
      target.name !== 'claude-execution-mode' ||
      !authoritative ||
      this.state.busy
    ) {
      return;
    }
    if (target.value === 'claude-default') {
      this.state.draft = { mode: 'claude-default' };
    } else if (target.value === 'custom') {
      this.state.customDraft ??= defaultCustomValues(authoritative);
      this.state.draft = {
        mode: 'custom',
        values: cloneValues(this.state.customDraft),
      };
    } else if (target.value.startsWith('profile:')) {
      const profileId = target.value.slice('profile:'.length);
      const profile = authoritative.profiles.find(({ id }) => id === profileId);
      if (!profile) return;
      this.state.draft = { mode: 'profile', profileId: profile.id };
    }
    renderSettings(this.dependencies.root, this.state);
    this.dependencies.updateUnsavedIndicator();
  };

  private readonly handleClick = (event: Event): void => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const action = target.closest<HTMLElement>('[data-execution-action]')?.dataset.executionAction;
    if (action === 'retry') {
      if (this.state.active && !this.state.loading) this.startLoad();
      return;
    }
    if (action === 'recommended') {
      void this.runImmediate(
        () => window.controlPanel.useRecommendedClaudeExecutionSettings(),
        '正在应用推荐配置…',
        '推荐配置已应用。',
      );
      return;
    }
    if (action === 'restore') {
      void this.runImmediate(
        () => window.controlPanel.restoreClaudeExecutionSettingsDefault(),
        '正在恢复 Claude 默认…',
        'Claude 默认已恢复。',
      );
    }
  };

  private readonly handleInput = (event: Event): void => {
    const target = event.target;
    const authoritative = this.state.authoritative;
    if (
      !(target instanceof HTMLInputElement) ||
      !target.dataset.executionCustomField ||
      this.state.draft?.mode !== 'custom' ||
      !authoritative ||
      this.state.busy
    ) {
      return;
    }
    const customDraft = readCustomDraft(this.dependencies.root);
    if (!customDraft) {
      setProgress(this.dependencies.root, '自定义请求包含无效值。');
      this.dependencies.updateUnsavedIndicator();
      return;
    }
    this.state.customDraft = customDraft;
    this.state.draft = { mode: 'custom', values: cloneValues(customDraft) };
    setProgress(this.dependencies.root, '自定义请求尚未保存。');
    renderRequestedDraft(this.dependencies.root, authoritative, this.state.draft);
    this.dependencies.updateUnsavedIndicator();
  };

  private applyMutationResult(dto: ClaudeExecutionSettingsDto): void {
    this.state.authoritative = dto;
    this.state.draft = cloneRequest(dto.requested);
    if (dto.requested.mode === 'custom') {
      this.state.customDraft = cloneValues(dto.requested.values);
    }
  }

  private isCurrent(generation: number): boolean {
    return !this.state.disposed && this.state.active && generation === this.state.generation;
  }

  private async load(): Promise<void> {
    const { root, showToast, updateUnsavedIndicator } = this.dependencies;
    const generation = ++this.state.generation;
    this.state.loading = true;
    this.state.loadError = false;
    renderLoading(root, false);
    try {
      const dto = await window.controlPanel.getClaudeExecutionSettings();
      if (!this.isCurrent(generation)) return;
      this.state.authoritative = dto;
      this.state.draft = cloneRequest(dto.requested);
      this.state.customDraft = defaultCustomValues(dto);
      this.state.loading = false;
      renderSettings(root, this.state);
      updateUnsavedIndicator();
    } catch {
      if (!this.isCurrent(generation)) return;
      this.state.loading = false;
      this.state.loadError = true;
      renderLoading(root, true);
      showToast('无法读取 Claude 执行设置。', 'error');
    }
  }

  private async runImmediate(
    operation: () => Promise<ClaudeExecutionSettingsDto>,
    progress: string,
    success: string,
  ): Promise<void> {
    const { root, setDialogMutationBusy, showToast, updateUnsavedIndicator } = this.dependencies;
    if (this.state.disposed || !this.state.active || this.state.busy || !this.state.authoritative) {
      return;
    }
    const generation = ++this.state.generation;
    this.state.busy = true;
    setDialogMutationBusy(true);
    renderSettings(root, this.state);
    setProgress(root, progress);
    try {
      const dto = await operation();
      if (!this.isCurrent(generation)) return;
      this.applyMutationResult(dto);
      this.state.busy = false;
      renderSettings(root, this.state);
      setProgress(root, success);
      updateUnsavedIndicator();
      showToast(success, 'success');
    } catch {
      if (this.isCurrent(generation)) {
        this.state.busy = false;
        renderSettings(root, this.state);
        setProgress(root, '操作未完成，当前已保存值保持不变。');
        showToast('Claude 执行设置操作未完成。', 'error');
      }
    } finally {
      if (generation === this.state.generation) setDialogMutationBusy(false);
    }
  }

  private startLoad(): Promise<void> {
    const pending = this.load().finally(() => {
      if (this.activeLoad === pending) this.activeLoad = undefined;
    });
    this.activeLoad = pending;
    return pending;
  }
}

export const createClaudeExecutionSettingsFeature = (
  dependencies: ClaudeExecutionSettingsFeatureDependencies,
): ClaudeExecutionSettingsFeature => new ClaudeExecutionSettingsController(dependencies);
