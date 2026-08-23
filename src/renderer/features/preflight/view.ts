import type {
  NetworkEnvironmentCheck,
  NetworkPreflightResult,
  NetworkProviderId,
} from '../../../shared/contracts';
import type { PreflightElements } from './elements';
import type { PreflightState } from './state';

export type PreflightTone = 'error' | 'pending' | 'success' | 'unknown' | 'warning';

export interface CodexFooterConnectionView {
  busy: boolean;
  disabled: boolean;
  label: string;
  tone: Exclude<PreflightTone, 'unknown'>;
}

export interface PreflightViewDependencies {
  getActiveNetworkProvider: () => NetworkProviderId | undefined;
  isCodexActive: () => boolean;
  setCodexFooterConnection: (view: CodexFooterConnectionView) => void;
}

export interface PreflightView {
  renderActiveNetworkPreflight: () => void;
  renderNetworkPreflightDetails: (result?: NetworkPreflightResult) => void;
}

interface PreflightViewContext {
  dependencies: PreflightViewDependencies;
  elements: PreflightElements;
  state: PreflightState;
}

const networkPreflightTone = (result: NetworkPreflightResult | undefined): PreflightTone => {
  if (!result) {
    return 'unknown';
  }
  if (result.status === 'testing') {
    return 'pending';
  }
  if (result.status === 'blocked') {
    return 'error';
  }
  if (result.status === 'allowed') {
    return 'success';
  }
  return 'warning';
};

const networkStatusLabel = (result: NetworkPreflightResult): string => {
  switch (result.status) {
    case 'allowed':
      return '官方网络正常';
    case 'allowed_with_notice':
      return '网络可用 · 有路径提示';
    case 'blocked':
      return '官方网络已阻止';
    case 'degraded':
      return '网络结果不完整';
    case 'partially_available':
      return '当前动作的 WebSocket 未确认';
    case 'testing':
      return '正在执行无额度预检';
    case 'unknown':
      return '网络状态未知';
    case 'warning':
      return '网络可用 · 需要确认';
  }
};

const replaceList = (target: HTMLUListElement, values: string[], empty: string): void => {
  const items = values.length > 0 ? values : [empty];
  target.replaceChildren(
    ...items.map((value) => {
      const item = document.createElement('li');
      item.textContent = value;
      return item;
    }),
  );
};

const environmentCheckStatusLabel = (check: NetworkEnvironmentCheck): string => {
  if (check.id === 'language') return '参考';
  return check.status === 'passed' ? '通过' : check.status === 'risk' ? '风险' : '未完成';
};

const renderEnvironmentAssessment = (
  elements: PreflightElements,
  result?: NetworkPreflightResult,
  manualInProgress = false,
): void => {
  const environment = result?.environment;
  const tone = !result
    ? 'unknown'
    : result.status === 'testing'
      ? 'pending'
      : environment?.riskLevel === 'high'
        ? 'error'
        : environment?.riskLevel === 'medium' || environment?.riskLevel === 'unknown'
          ? 'warning'
          : networkPreflightTone(result);
  elements.settingsNetworkStatus.dataset.tone = tone;
  elements.networkPreflightTrigger.dataset.tone = tone;
  elements.settingsNetworkRecheck.disabled =
    manualInProgress || elements.networkPreflightRecheck.disabled;
  if (!environment) {
    elements.settingsNetworkSummary.textContent = result?.summary ?? '尚无检测结果';
    elements.settingsNetworkMeta.textContent =
      result?.status === 'testing' ? '正在读取出口与环境信号…' : '点击“重新检测”执行完整评估。';
    elements.settingsNetworkFacts.replaceChildren();
    elements.settingsNetworkIssues.replaceChildren();
    return;
  }
  elements.settingsNetworkSummary.textContent = environment.summary;
  elements.settingsNetworkMeta.textContent = new Intl.DateTimeFormat('zh-CN', {
    dateStyle: 'short',
    timeStyle: 'medium',
  }).format(environment.checkedAt);
  const facts = [
    `证据：${environment.evidenceStatus === 'complete' ? '关键检查已完成' : environment.evidenceStatus === 'unavailable' ? '关键检查不可用，不能判断为低风险' : '部分关键检查未完成，不能判断为低风险'}`,
    `出口：${environment.exitAddressPrefix ?? '未知'} · ${environment.exitCountryName ?? environment.exitCountryCode ?? '地区未知'}${environment.exitProvider ? ` · ${environment.exitProvider}` : ''}`,
    `时区：本机 ${environment.localTimezone}${environment.exitTimezone ? ` · 出口 ${environment.exitTimezone}` : ''}${environment.cliTimezone ? ` · CLI 已覆盖为 ${environment.cliTimezone}` : ''}`,
    `Windows 首选语言（首项）：${environment.localLanguage} · 仅供参考`,
    ...(environment.cliLanguages
      ? [`CLI 语言环境覆盖：${environment.cliLanguages.join('、')} · 不参与系统语言对照`]
      : []),
    `DNS：${environment.dnsDetail}`,
    ...(environment.checks?.map(
      (check) => `${environmentCheckStatusLabel(check)} · ${check.label}：${check.detail}`,
    ) ?? []),
  ];
  elements.settingsNetworkFacts.replaceChildren(
    ...facts.map((value) => {
      const item = document.createElement('div');
      item.textContent = value;
      return item;
    }),
  );
  elements.settingsNetworkIssues.replaceChildren(
    ...(environment.issues.length > 0
      ? environment.issues.map((issue) => {
          const row = document.createElement('article');
          row.dataset.severity = issue.severity;
          const copy = document.createElement('span');
          const title = document.createElement('strong');
          title.textContent = issue.title;
          const detail = document.createElement('small');
          detail.textContent = issue.detail;
          copy.append(title, detail);
          row.append(copy);
          if (issue.kind === 'timezone-mismatch' && issue.suggestedTimezone) {
            const button = document.createElement('button');
            button.type = 'button';
            button.dataset.networkRepair = 'timezone';
            button.dataset.value = issue.suggestedTimezone;
            button.textContent = '修改（仅新 CLI）';
            row.append(button);
          }
          return row;
        })
      : [
          (() => {
            const empty = document.createElement('p');
            empty.className = 'settings-help';
            empty.textContent =
              environment.evidenceStatus === 'complete'
                ? '本次检查未发现已知风险；这不是账号安全保证。'
                : '关键证据没有全部完成，不能判断为低风险。';
            return empty;
          })(),
        ]),
  );
};

const renderNetworkPreflightDetails = (
  { elements, state }: PreflightViewContext,
  result?: NetworkPreflightResult,
): void => {
  const tone = networkPreflightTone(result);
  renderEnvironmentAssessment(elements, result, state.networkPreflightManualInProgress);
  elements.networkPreflightDialogTone.dataset.tone = tone;
  if (!result) {
    elements.networkPreflightDialogSummary.textContent = '尚无探测结果';
    elements.networkPreflightDialogMeta.textContent =
      '探测不调用模型、不读取登录令牌，也不修改系统代理。';
    replaceList(elements.networkPreflightReasons, [], '打开工作台后会自动执行首次检查。');
    replaceList(elements.networkPreflightPaths, [], '尚未解析进程网络路径。');
    elements.networkPreflightProbes.replaceChildren();
    elements.networkPreflightEnvironment.textContent = '尚未读取出口环境。';
    return;
  }
  elements.networkPreflightDialogSummary.textContent = result.summary;
  const checkedAt = result.checkedAt
    ? new Intl.DateTimeFormat('zh-CN', {
        dateStyle: 'short',
        timeStyle: 'medium',
      }).format(result.checkedAt)
    : '正在检测';
  elements.networkPreflightDialogMeta.textContent = `${checkedAt} · 综合风险 ${result.riskScore}/100 · 检查服务端点、脱敏出口、权威 DNS 与 CLI 环境`;
  replaceList(
    elements.networkPreflightReasons,
    [
      ...result.reasons,
      ...(result.environment?.issues.map((issue) => `${issue.title}：${issue.detail}`) ?? []),
    ],
    '没有需要用户处理的风险信号。',
  );
  replaceList(
    elements.networkPreflightPaths,
    result.paths.map(
      (pathView) =>
        `${pathView.detail} ${
          pathView.proxyKind === 'unknown'
            ? '显式代理解析未完成'
            : pathView.proxyConfigured
              ? `可见代理第一跳：${pathView.proxyKind}`
              : '未发现本机显式代理'
        }${
          pathView.virtualInterfaces.length > 0
            ? `；虚拟接口：${pathView.virtualInterfaces.join('、')}`
            : ''
        }`,
    ),
    '尚未解析进程网络路径。',
  );
  elements.networkPreflightProbes.replaceChildren(
    ...result.probes.map((probe) => {
      const row = document.createElement('div');
      const status = document.createElement('span');
      status.dataset.status = probe.status;
      status.textContent =
        probe.status === 'passed'
          ? '通过'
          : probe.status === 'failed'
            ? '失败'
            : probe.status === 'warning'
              ? '警告'
              : probe.status === 'skipped'
                ? '已跳过'
                : '未知';
      const label = document.createElement('strong');
      label.textContent = probe.label;
      const detail = document.createElement('span');
      detail.textContent = probe.detail;
      row.append(status, label, detail);
      return row;
    }),
  );
  const environment = result.environment;
  elements.networkPreflightEnvironment.replaceChildren();
  if (!environment) {
    elements.networkPreflightEnvironment.textContent = '本次结果没有包含出口环境评估。';
    return;
  }
  const facts = document.createElement('p');
  facts.textContent = `出口 ${environment.exitAddressPrefix ?? '未知'} · ${environment.exitCountryName ?? environment.exitCountryCode ?? '地区未知'}；本机时区 ${environment.localTimezone}${environment.exitTimezone ? `，出口时区 ${environment.exitTimezone}` : ''}；${environment.dnsDetail}`;
  elements.networkPreflightEnvironment.append(facts);
  for (const check of environment.checks ?? []) {
    const evidence = document.createElement('p');
    evidence.dataset.status = check.status;
    evidence.textContent = `${environmentCheckStatusLabel(check)} · ${check.label}：${check.detail}`;
    elements.networkPreflightEnvironment.append(evidence);
  }
  for (const issue of environment.issues) {
    if (issue.kind !== 'timezone-mismatch' || !issue.suggestedTimezone) continue;
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.networkRepair = 'timezone';
    button.dataset.value = issue.suggestedTimezone;
    button.textContent = `${issue.title}：修改（仅新 CLI）`;
    elements.networkPreflightEnvironment.append(button);
  }
};

const renderActiveNetworkPreflight = (context: PreflightViewContext): void => {
  const { dependencies, elements, state } = context;
  const activeProvider = dependencies.getActiveNetworkProvider();
  const provider = activeProvider ?? state.networkPreflightDisplayProvider;
  if (!provider) {
    elements.networkPreflightCard.dataset.tone = 'success';
    elements.networkPreflightProvider.textContent = '自定义网关';
    elements.networkPreflightSummary.textContent = '不使用官方服务守卫，按当前网关健康状态运行';
    elements.networkPreflightRecheck.disabled = false;
    renderEnvironmentAssessment(elements, undefined, state.networkPreflightManualInProgress);
    return;
  }
  const result = state.networkPreflightResults.get(provider);
  const inProgress = state.networkPreflightInProgress || result?.status === 'testing';
  const tone = inProgress ? 'pending' : networkPreflightTone(result);
  elements.networkPreflightCard.dataset.tone = tone;
  elements.networkPreflightProvider.textContent = activeProvider
    ? (result?.providerLabel ??
      (provider === 'openai-codex'
        ? 'OpenAI Codex'
        : provider === 'xai-grok'
          ? 'xAI Grok'
          : provider === 'ai-services'
            ? 'AI 服务综合预检'
            : 'Anthropic Claude Code'))
    : '独立网络预检';
  elements.networkPreflightSummary.textContent =
    result?.status === 'testing'
      ? result.summary
      : state.networkPreflightInProgress
        ? '正在执行网络预检…'
        : (result?.summary ?? '等待首次无额度探测');
  elements.networkPreflightRecheck.disabled = state.networkPreflightManualInProgress;
  renderEnvironmentAssessment(elements, result, state.networkPreflightManualInProgress);
  if (inProgress) {
    elements.settingsNetworkStatus.dataset.tone = 'pending';
    elements.networkPreflightTrigger.dataset.tone = 'pending';
    elements.settingsNetworkSummary.textContent = '正在执行网络预检…';
    elements.settingsNetworkMeta.textContent = '正在检查网络路径、出口、DNS 与本地环境。';
  }
  if (dependencies.isCodexActive()) {
    dependencies.setCodexFooterConnection({
      busy: inProgress,
      disabled: inProgress,
      label: inProgress
        ? '正在执行无额度预检'
        : result
          ? networkStatusLabel(result)
          : '官方网络待检测',
      tone: tone === 'unknown' ? 'warning' : tone,
    });
  }
};

export const createPreflightView = (
  elements: PreflightElements,
  state: PreflightState,
  dependencies: PreflightViewDependencies,
): PreflightView => {
  const context = { dependencies, elements, state };
  return {
    renderActiveNetworkPreflight: () => renderActiveNetworkPreflight(context),
    renderNetworkPreflightDetails: (result) => renderNetworkPreflightDetails(context, result),
  };
};
