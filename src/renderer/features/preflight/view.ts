import type {
  NetworkEnvironmentCheck,
  NetworkPreflightResult,
  NetworkProbeResult,
  NetworkProviderId,
  NetworkPublicAddressObservation,
  NetworkRiskSignal,
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
  if (!result) return 'unknown';
  const status = result.providerConnectivity.status;
  if (status === 'testing') return 'pending';
  if (status === 'blocked') return 'error';
  if (status === 'allowed' || status === 'allowed_with_notice') return 'success';
  return 'warning';
};

const networkStatusLabel = (result: NetworkPreflightResult): string => {
  switch (result.providerConnectivity.status) {
    case 'allowed':
    case 'allowed_with_notice':
      return '连接正常';
    case 'blocked':
      return '提供商连接未通过';
    case 'degraded':
      return '连接证据不完整';
    case 'partially_available':
      return '部分连接能力不可用';
    case 'testing':
      return '正在进行网络预检…';
    case 'unknown':
      return '连接状态未知';
    case 'warning':
      return '连接可用 · 有端点说明';
  }
};

const providerDisplayLabel = (provider: NetworkProviderId): string =>
  provider === 'openai-codex'
    ? 'OpenAI Codex'
    : provider === 'openai-api'
      ? 'OpenAI API'
      : provider === 'xai-grok'
        ? 'xAI Grok'
        : provider === 'ai-services'
          ? 'AI 服务综合预检'
          : 'Anthropic Claude Code';

const preflightActionLabel = (action: NetworkPreflightResult['action']): string => {
  switch (action) {
    case 'background':
      return '后台无额度预检';
    case 'cli-launch':
      return 'CLI 启动预检';
    case 'cloud-task':
      return '云端任务预检';
    case 'first-request':
      return '首次请求预检';
    case 'login':
      return '登录预检';
    case 'provider-switch':
      return '提供商切换预检';
  }
};

const setBusyButton = (
  button: HTMLButtonElement,
  busy: boolean,
  disabled: boolean,
  idleLabel: string,
): void => {
  button.disabled = disabled;
  button.setAttribute('aria-busy', String(busy));
  button.textContent = busy ? '正在进行网络预检…' : idleLabel;
};

const renderPreflightControls = ({ elements, state }: PreflightViewContext): void => {
  const operation = state.networkPreflightOperation;
  const busy = Boolean(operation);
  const locked = operation?.manual ?? false;
  elements.networkPreflightCard.setAttribute('aria-busy', String(busy));
  elements.networkPreflightDialog.setAttribute('aria-busy', String(busy));
  elements.settingsNetworkStatus.setAttribute('aria-busy', String(busy));
  elements.networkPreflightTrigger.disabled = locked;
  elements.networkPreflightTrigger.setAttribute('aria-busy', String(busy));
  elements.networkPreflightTriggerLabel.textContent = busy ? '正在进行网络预检…' : '网络预检';
  setBusyButton(elements.networkPreflightRecheck, busy, locked, '重新检测');
  setBusyButton(elements.networkPreflightDialogRecheck, busy, locked, '立即重新检测');
  setBusyButton(elements.settingsNetworkRecheck, busy, locked, '重新检测');
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
  switch (check.status) {
    case 'passed':
      return '通过';
    case 'risk':
      return '风险';
    case 'unavailable':
      return '不可用';
    case 'unknown':
      return '未完成';
  }
};

const environmentEvidenceStatusText = (
  environment: NonNullable<NetworkPreflightResult['advisoryEvidence']['environment']>,
): string => {
  const base =
    environment.evidenceStatus === 'complete'
      ? '关键辅助证据本次已完成'
      : environment.evidenceStatus === 'unavailable'
        ? '关键辅助证据本次不可用'
        : '关键辅助证据本次部分完成';
  const optionalUnavailable =
    environment.checks?.filter(
      (check) => check.id === 'stun-public-address' && check.status === 'unavailable',
    ).length ?? 0;
  return optionalUnavailable > 0 ? `${base} · ${optionalUnavailable} 项可选证据不可用` : base;
};

const networkProbeStatusLabel = (status: NetworkProbeResult['status']): string =>
  status === 'passed'
    ? '通过'
    : status === 'failed'
      ? '失败'
      : status === 'warning'
        ? '警告'
        : status === 'skipped'
          ? '已跳过'
          : '未知';

const PROCESS_LABELS: Readonly<Record<string, string>> = {
  application: 'Electron 应用',
  'claude-cli': 'Claude CLI',
  'codex-cli': 'Codex CLI',
  'network-diagnostics': '网络诊断进程',
  'oauth-browser': 'OAuth 浏览器',
  renderer: 'Renderer',
  terminal: '终端进程',
};

const PROBE_KIND_LABELS: Readonly<Record<NetworkProbeResult['kind'], string>> = {
  api: 'API',
  dns: 'DNS',
  https: 'HTTPS',
  oauth: 'OAuth',
  path: '路径',
  tls: 'TLS',
  version: '版本',
  websocket: 'WebSocket',
};

const CONFIDENCE_LABELS = {
  high: '高',
  low: '低',
  medium: '中',
  unknown: '未知',
} as const;

const formatCheckedAt = (checkedAt: number): string =>
  new Intl.DateTimeFormat('zh-CN', {
    dateStyle: 'short',
    timeStyle: 'medium',
  }).format(checkedAt);

const processLabel = (process: NetworkProbeResult['process']): string =>
  PROCESS_LABELS[process] ?? process;

const probeEvidenceText = (probe: NetworkProbeResult, prefix?: string): string =>
  `${prefix ? `${prefix} · ` : ''}${networkProbeStatusLabel(probe.status)} · ${probe.label} · 方法：${PROBE_KIND_LABELS[probe.kind]} · 进程：${processLabel(probe.process)} · ${probe.required ? '必需提供商证据' : '可选证据'}${probe.target ? ` · 目标：${probe.target}` : ''} · 采集时间：${formatCheckedAt(probe.checkedAt)} · ${probe.detail}`;

const signalEvidenceText = (lane: '提供商信号' | '辅助信号', signal: NetworkRiskSignal): string =>
  `${lane} · ${signal.label} · 严重度：${signal.severity} · 来源：${signal.source} · 采集时间：${formatCheckedAt(signal.observedAt)} · 置信度：${CONFIDENCE_LABELS[signal.confidence]} · ${signal.detail}`;

const appendClientCompatibilityEvidence = (
  target: HTMLElement,
  result: NetworkPreflightResult,
): void => {
  for (const probe of result.providerConnectivity.probes.filter(
    (candidate) => candidate.kind === 'version',
  )) {
    const evidence = document.createElement('p');
    evidence.dataset.status = probe.status;
    evidence.textContent = probeEvidenceText(probe, '客户端兼容性');
    target.append(evidence);
  }
};

const observationDuplicatesCheck = (
  observations: readonly NetworkPublicAddressObservation[],
  check: NetworkEnvironmentCheck,
): boolean =>
  check.id === 'public-address-ipquery'
    ? observations.some((observation) => observation.observationProvider === 'IPQuery')
    : check.id === 'public-address-ipip'
      ? observations.some((observation) => observation.observationProvider === 'IPIP')
      : check.id === 'ipv6-public-address'
        ? observations.some(
            (observation) =>
              observation.observationProvider === 'ipify' && observation.endpoint === check.target,
          )
        : false;

const ENVIRONMENT_CHECK_ORDER: Readonly<Record<NetworkEnvironmentCheck['id'], number>> = {
  'dns-authoritative': 0,
  'ipv6-public-address': 1,
  'stun-public-address': 2,
  timezone: 3,
  language: 4,
  'ip-reputation': 5,
  'public-address-ipip': 6,
  'public-address-ipquery': 6,
};

const orderedEnvironmentChecks = (
  checks: readonly NetworkEnvironmentCheck[] | undefined,
  observations: readonly NetworkPublicAddressObservation[],
): NetworkEnvironmentCheck[] => {
  const attributedChecks = (checks ?? []).filter(
    (check: NetworkEnvironmentCheck) => !observationDuplicatesCheck(observations, check),
  );
  return [...attributedChecks].sort(
    (left: NetworkEnvironmentCheck, right: NetworkEnvironmentCheck) =>
      ENVIRONMENT_CHECK_ORDER[left.id] - ENVIRONMENT_CHECK_ORDER[right.id],
  );
};

const EVIDENCE_FRESHNESS_LABELS = {
  cached: '缓存',
  live: '实时',
  unknown: '未知',
} as const;

const ENVIRONMENT_TRANSPORT_LABELS = {
  'curl-cli': 'curl CLI',
  derived: '多源派生',
  'local-system': '本机系统状态',
  'not-collected': '未收集',
  'system-dns': '系统 DNS 解析器',
} as const;

const environmentCheckText = (check: NetworkEnvironmentCheck): string =>
  `${environmentCheckStatusLabel(check)} · ${check.label} · 权威性：仅辅助证据 · 进程：${processLabel(check.process)} · 范围：${check.networkScope === 'conversation' ? '会话网络会话' : '应用网络会话'} · 传输：${ENVIRONMENT_TRANSPORT_LABELS[check.transport]} · 目标：${check.target} · 采集时间：${formatCheckedAt(check.checkedAt)} · 新鲜度：${EVIDENCE_FRESHNESS_LABELS[check.freshness]} · 置信度：${CONFIDENCE_LABELS[check.confidence]} · 来源：${check.source} · ${check.detail}`;

const publicAddressObservationText = (observation: NetworkPublicAddressObservation): string => {
  const transportLabels = { 'curl-cli': 'curl CLI' } as const;
  const agreementLabels = {
    corroborated: '多源印证',
    mixed: '来源不一致',
    'not-comparable': '不可比较',
    'single-source': '单一来源',
  } as const;
  const family = observation.addressFamily
    ? `${observation.addressFamily === 'ipv4' ? 'IPv4' : 'IPv6'} · `
    : '';
  return `${family}${observation.observationProvider} · ${observation.addressPrefix ?? '地址未知'} · 进程：${processLabel(observation.process)} · 范围：${observation.networkScope === 'conversation' ? '会话网络会话' : '应用网络会话'} · 传输：${transportLabels[observation.transport]} · 端点：${observation.endpoint} · 采集时间：${formatCheckedAt(observation.checkedAt)} · 新鲜度：${EVIDENCE_FRESHNESS_LABELS[observation.freshness]} · 置信度：${CONFIDENCE_LABELS[observation.confidence]} · 来源一致性：${agreementLabels[observation.sourceAgreement]} · ${observation.detail} ${observation.statement}`;
};

const renderEnvironmentAssessment = (
  elements: PreflightElements,
  result?: NetworkPreflightResult,
  manualInProgress = false,
  inProgress = false,
): void => {
  const environment = result?.advisoryEvidence.environment;
  const tone = networkPreflightTone(result);
  elements.settingsNetworkStatus.dataset.tone = tone;
  elements.networkPreflightTrigger.dataset.tone = tone;
  elements.settingsNetworkRecheck.disabled =
    manualInProgress || elements.networkPreflightRecheck.disabled;
  if (inProgress) {
    elements.settingsNetworkSummary.textContent = '正在进行网络预检…';
    elements.settingsNetworkMeta.textContent = '正在收集本次提供商端点与目标限定的辅助证据…';
    const pending = document.createElement('div');
    pending.textContent = '正在检查精确端点、代理决策、公网地址与环境证据；旧结果已暂时隐藏。';
    elements.settingsNetworkFacts.replaceChildren(pending);
    elements.settingsNetworkIssues.replaceChildren();
    return;
  }
  if (!environment) {
    elements.settingsNetworkSummary.textContent =
      result?.providerConnectivity.summary ?? '尚无检测结果';
    elements.settingsNetworkMeta.textContent =
      result?.providerConnectivity.status === 'testing'
        ? '正在收集提供商端点与目标限定的辅助证据…'
        : '点击“重新检测”执行完整评估。';
    elements.settingsNetworkFacts.replaceChildren(
      ...(result?.providerConnectivity.probes
        .filter((probe) => probe.kind === 'version')
        .map((probe) => {
          const item = document.createElement('div');
          item.textContent = probeEvidenceText(probe, '客户端兼容性');
          return item;
        }) ?? []),
    );
    elements.settingsNetworkIssues.replaceChildren();
    return;
  }
  elements.settingsNetworkSummary.textContent =
    result?.providerConnectivity.summary ?? '尚无检测结果';
  elements.settingsNetworkMeta.textContent = formatCheckedAt(environment.checkedAt);
  const checks = orderedEnvironmentChecks(
    environment.checks,
    environment.publicAddressObservations,
  );
  const reputationChecks = checks.filter((check) => check.id === 'ip-reputation');
  const earlierChecks = checks.filter((check) => check.id !== 'ip-reputation');
  const hasDnsCheck = earlierChecks.some((check) => check.id === 'dns-authoritative');
  const facts = [
    `辅助证据摘要：${environment.summary}`,
    `证据完整性：${environmentEvidenceStatusText(environment)} · 不影响提供商连接结论`,
    ...environment.publicAddressObservations.map(publicAddressObservationText),
    ...(!hasDnsCheck ? [`DNS：${environment.dnsDetail}`] : []),
    ...earlierChecks.map(environmentCheckText),
    `时区：本机 ${environment.localTimezone}${environment.cliTimezone ? ` · CLI 已覆盖为 ${environment.cliTimezone}` : ''}`,
    `Windows 首选语言（首项）：${environment.localLanguage} · 仅供参考`,
    ...(environment.cliLanguages
      ? [`CLI 语言环境覆盖：${environment.cliLanguages.join('、')} · 不参与系统语言对照`]
      : []),
    ...reputationChecks.map(environmentCheckText),
    ...(result?.providerConnectivity.probes
      .filter((probe) => probe.kind === 'version')
      .map((probe) => probeEvidenceText(probe, '客户端兼容性')) ?? []),
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
  context: PreflightViewContext,
  result?: NetworkPreflightResult,
): void => {
  const { elements, state } = context;
  renderPreflightControls(context);
  const operation = state.networkPreflightOperation;
  const dialogProvider = state.networkPreflightDialogProvider ?? result?.provider;
  if (operation && (!dialogProvider || operation.provider === dialogProvider)) {
    elements.networkPreflightDialogTone.dataset.tone = 'pending';
    elements.networkPreflightDialogSummary.textContent = '正在进行网络预检…';
    elements.networkPreflightDialogMeta.textContent = `${providerDisplayLabel(operation.provider)} · ${preflightActionLabel(operation.action)} · 正在检查提供商端点与目标限定的辅助证据`;
    replaceList(elements.networkPreflightReasons, [], '等待本次检查完成。');
    replaceList(elements.networkPreflightPaths, [], '正在解析当前目标的应用与 CLI 可见代理决策。');
    const probe = document.createElement('p');
    probe.dataset.status = 'pending';
    probe.textContent = '正在检查当前提供商的 DNS、TLS、HTTP 与必要传输能力。';
    elements.networkPreflightProbes.replaceChildren(probe);
    elements.networkPreflightEnvironment.textContent = '正在收集目标限定的公网地址与辅助环境证据。';
    return;
  }
  const tone = networkPreflightTone(result);
  elements.networkPreflightDialogTone.dataset.tone = tone;
  if (!result) {
    elements.networkPreflightDialogSummary.textContent = '尚无探测结果';
    elements.networkPreflightDialogMeta.textContent =
      '探测不调用模型、不读取登录令牌，也不修改系统代理。';
    replaceList(elements.networkPreflightReasons, [], '打开工作台后会自动执行首次检查。');
    replaceList(elements.networkPreflightPaths, [], '尚未解析进程网络路径。');
    elements.networkPreflightProbes.replaceChildren();
    elements.networkPreflightEnvironment.textContent = '尚未读取辅助环境证据。';
    return;
  }
  elements.networkPreflightDialogSummary.textContent = result.providerConnectivity.summary;
  const checkedAt = result.checkedAt
    ? new Intl.DateTimeFormat('zh-CN', {
        dateStyle: 'short',
        timeStyle: 'medium',
      }).format(result.checkedAt)
    : '正在检测';
  elements.networkPreflightDialogMeta.textContent = `${checkedAt} · 提供商连接与辅助证据分开判定 · 公网地址观察只适用于各自目标`;
  replaceList(
    elements.networkPreflightReasons,
    [
      ...new Set([
        ...result.providerConnectivity.reasons,
        ...result.providerConnectivity.featureAccess.flatMap((access) =>
          !access.allowed && access.reason ? [`操作阻止 · ${access.reason}`] : [],
        ),
        ...result.providerConnectivity.signals.map((signal) =>
          signalEvidenceText('提供商信号', signal),
        ),
        ...result.advisoryEvidence.reasons,
        ...result.advisoryEvidence.signals.map((signal) => signalEvidenceText('辅助信号', signal)),
        ...(result.advisoryEvidence.environment?.issues.map(
          (issue) => `辅助建议 · ${issue.title}：${issue.detail}`,
        ) ?? []),
      ]),
    ],
    '没有需要用户处理的风险信号。',
  );
  replaceList(
    elements.networkPreflightPaths,
    result.advisoryEvidence.paths.map(
      (pathView) =>
        `${pathView.detail} 目标：${pathView.target}；范围：${pathView.networkScope === 'conversation' ? '会话网络会话' : '应用网络会话'}；${
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
    ...result.providerConnectivity.probes
      .filter((probe) => probe.kind !== 'version')
      .map((probe) => {
        const row = document.createElement('div');
        const status = document.createElement('span');
        status.dataset.status = probe.status;
        status.textContent = networkProbeStatusLabel(probe.status);
        const label = document.createElement('strong');
        label.textContent = probe.label;
        const detail = document.createElement('span');
        detail.textContent = `方法：${PROBE_KIND_LABELS[probe.kind]} · 进程：${processLabel(probe.process)} · ${probe.required ? '必需提供商证据' : '可选证据'}${probe.target ? ` · 目标：${probe.target}` : ''} · 采集时间：${formatCheckedAt(probe.checkedAt)} · ${probe.detail}`;
        row.append(status, label, detail);
        return row;
      }),
  );
  const environment = result.advisoryEvidence.environment;
  elements.networkPreflightEnvironment.replaceChildren();
  if (!environment) {
    elements.networkPreflightEnvironment.textContent = '本次结果没有包含辅助环境证据。';
    appendClientCompatibilityEvidence(elements.networkPreflightEnvironment, result);
    return;
  }
  for (const observation of environment.publicAddressObservations) {
    const address = document.createElement('p');
    address.dataset.status = observation.state === 'complete' ? 'passed' : 'unknown';
    address.textContent = publicAddressObservationText(observation);
    elements.networkPreflightEnvironment.append(address);
  }
  const scope = document.createElement('p');
  scope.textContent = '辅助证据不参与提供商访问判定；以下每行保留自己的目标与来源。';
  elements.networkPreflightEnvironment.append(scope);
  const checks = orderedEnvironmentChecks(
    environment.checks,
    environment.publicAddressObservations,
  );
  const reputationChecks = checks.filter((check) => check.id === 'ip-reputation');
  const earlierChecks = checks.filter((check) => check.id !== 'ip-reputation');
  if (!earlierChecks.some((check) => check.id === 'dns-authoritative')) {
    const dns = document.createElement('p');
    dns.textContent = `DNS：${environment.dnsDetail}`;
    elements.networkPreflightEnvironment.append(dns);
  }
  for (const check of earlierChecks) {
    const evidence = document.createElement('p');
    evidence.dataset.status = check.status;
    evidence.textContent = environmentCheckText(check);
    elements.networkPreflightEnvironment.append(evidence);
  }
  const localEnvironment = document.createElement('p');
  localEnvironment.textContent = `本机环境 · 时区：${environment.localTimezone}${environment.cliTimezone ? ` · CLI 时区：${environment.cliTimezone}` : ''} · Windows 首选语言：${environment.localLanguage}${environment.cliLanguages ? ` · CLI 语言：${environment.cliLanguages.join('、')}` : ''}`;
  elements.networkPreflightEnvironment.append(localEnvironment);
  for (const check of reputationChecks) {
    const evidence = document.createElement('p');
    evidence.dataset.status = check.status;
    evidence.textContent = environmentCheckText(check);
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
  appendClientCompatibilityEvidence(elements.networkPreflightEnvironment, result);
};

const renderActiveNetworkPreflight = (context: PreflightViewContext): void => {
  const { dependencies, elements, state } = context;
  renderPreflightControls(context);
  const operation = state.networkPreflightOperation;
  const manualInProgress = operation?.manual ?? false;
  const activeProvider = dependencies.getActiveNetworkProvider();
  const provider = activeProvider ?? state.networkPreflightDisplayProvider;
  if (!provider) {
    elements.networkPreflightCard.dataset.tone = 'success';
    elements.networkPreflightProvider.textContent = '自定义网关';
    elements.networkPreflightSummary.textContent = '不使用官方服务守卫，按当前网关健康状态运行';
    renderEnvironmentAssessment(elements, undefined, manualInProgress, Boolean(operation));
    return;
  }
  const result = state.networkPreflightResults.get(provider);
  const inProgress = Boolean(operation) || result?.providerConnectivity.status === 'testing';
  const tone = inProgress ? 'pending' : networkPreflightTone(result);
  elements.networkPreflightCard.dataset.tone = tone;
  elements.networkPreflightProvider.textContent = activeProvider
    ? (result?.providerLabel ?? providerDisplayLabel(provider))
    : '独立网络预检';
  elements.networkPreflightSummary.textContent = operation
    ? '正在进行网络预检…'
    : result?.providerConnectivity.status === 'testing'
      ? result.providerConnectivity.summary
      : (result?.providerConnectivity.summary ?? '等待首次无额度探测');
  renderEnvironmentAssessment(elements, result, manualInProgress, inProgress);
  if (inProgress) {
    elements.settingsNetworkStatus.dataset.tone = 'pending';
    elements.networkPreflightTrigger.dataset.tone = 'pending';
    elements.settingsNetworkSummary.textContent = '正在进行网络预检…';
    elements.settingsNetworkMeta.textContent = operation
      ? `${providerDisplayLabel(operation.provider)} · ${preflightActionLabel(operation.action)} · 正在检查提供商端点与目标限定的辅助证据。`
      : '正在检查提供商端点，并分别收集显式代理与目标限定的环境辅助证据。';
  }
  if (dependencies.isCodexActive()) {
    dependencies.setCodexFooterConnection({
      busy: inProgress,
      disabled: inProgress,
      label: inProgress
        ? '正在进行网络预检…'
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
