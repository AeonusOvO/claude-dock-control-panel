import type { NetworkPreflightResult, NetworkProviderId } from '../../../shared/contracts';
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
      return '基础可用 · 云任务受限';
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

const renderNetworkPreflightDetails = (
  { elements }: PreflightViewContext,
  result?: NetworkPreflightResult,
): void => {
  const tone = networkPreflightTone(result);
  elements.networkPreflightDialogTone.dataset.tone = tone;
  if (!result) {
    elements.networkPreflightDialogSummary.textContent = '尚无探测结果';
    elements.networkPreflightDialogMeta.textContent =
      '探测不调用模型、不读取登录令牌，也不修改系统代理。';
    replaceList(elements.networkPreflightReasons, [], '打开工作台后会自动执行首次检查。');
    replaceList(elements.networkPreflightPaths, [], '尚未解析进程网络路径。');
    elements.networkPreflightProbes.replaceChildren();
    return;
  }
  elements.networkPreflightDialogSummary.textContent = result.summary;
  const checkedAt = result.checkedAt
    ? new Intl.DateTimeFormat('zh-CN', {
        dateStyle: 'short',
        timeStyle: 'medium',
      }).format(result.checkedAt)
    : '正在检测';
  elements.networkPreflightDialogMeta.textContent = `${checkedAt} · 风险 ${result.riskScore}/100 · 仅检查本机路径与服务商官方端点`;
  replaceList(elements.networkPreflightReasons, result.reasons, '没有需要用户处理的风险信号。');
  replaceList(
    elements.networkPreflightPaths,
    result.paths.map(
      (pathView) =>
        `${pathView.detail} ${
          pathView.proxyConfigured ? `可见代理第一跳：${pathView.proxyKind}` : '未发现本机显式代理'
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
};

const renderActiveNetworkPreflight = (context: PreflightViewContext): void => {
  const { dependencies, elements, state } = context;
  const provider = dependencies.getActiveNetworkProvider();
  if (!provider) {
    elements.networkPreflightCard.dataset.tone = 'success';
    elements.networkPreflightProvider.textContent = '自定义网关';
    elements.networkPreflightSummary.textContent = '不使用官方服务守卫，按当前网关健康状态运行';
    elements.networkPreflightRecheck.disabled = false;
    return;
  }
  const result = state.networkPreflightResults.get(provider);
  const tone = networkPreflightTone(result);
  elements.networkPreflightCard.dataset.tone = tone;
  elements.networkPreflightProvider.textContent =
    result?.providerLabel ??
    (provider === 'openai-codex' ? 'OpenAI Codex' : 'Anthropic Claude Code');
  elements.networkPreflightSummary.textContent = result?.summary ?? '等待首次无额度探测';
  elements.networkPreflightRecheck.disabled =
    state.networkPreflightInProgress || result?.status === 'testing';
  if (dependencies.isCodexActive()) {
    dependencies.setCodexFooterConnection({
      busy: result?.status === 'testing',
      disabled: result?.status === 'testing',
      label: result ? networkStatusLabel(result) : '官方网络待检测',
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
