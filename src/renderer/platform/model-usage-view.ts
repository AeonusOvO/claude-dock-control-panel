import type { ModelUsageApi, ModelUsageSnapshot } from '../../shared/contracts';

const compact = new Intl.NumberFormat('zh-CN', { notation: 'compact', maximumFractionDigits: 1 });
const exact = new Intl.NumberFormat('zh-CN');

export const modelUsagePresentation = (state: ModelUsageSnapshot) => {
  const tokens = state.tokens;
  const total = tokens ? tokens.input + tokens.output + tokens.cacheRead + tokens.cacheCreation : 0;
  const window = state.windows?.length
    ? state.windows.reduce((lowest, candidate) =>
        candidate.remainingPercent < lowest.remainingPercent ? candidate : lowest,
      )
    : undefined;
  const available = state.status !== 'unavailable';
  const title = [
    state.model,
    state.detail,
    state.mode === 'api' && tokens
      ? `已记录 ${exact.format(total)} Token；输入 ${exact.format(tokens.input)}，输出 ${exact.format(tokens.output)}，缓存读取 ${exact.format(tokens.cacheRead)}，缓存写入 ${exact.format(tokens.cacheCreation)}`
      : undefined,
    ...(state.windows?.map(
      (window) =>
        `${window.label}剩余 ${window.remainingPercent.toFixed(1)}%${window.resetsAt ? `，重置时间 ${new Date(window.resetsAt * 1000).toLocaleString('zh-CN')}` : ''}`,
    ) ?? []),
    state.connectedAt
      ? `统计起点：${new Date(state.connectedAt).toLocaleString('zh-CN')}`
      : undefined,
    state.updatedAt ? `最近更新：${new Date(state.updatedAt).toLocaleString('zh-CN')}` : undefined,
    state.mode === 'api'
      ? '仅统计 ClaudeDock 终端与原生对话上报的请求用量，非平台账单；不含外部客户端、独立对话和接入测试。'
      : undefined,
  ]
    .filter(Boolean)
    .join('\n');
  return {
    label: state.mode === 'api' ? '本次 API 用量' : '剩余额度',
    value:
      state.mode === 'none'
        ? '尚未接入'
        : !available
          ? '暂无法获取'
          : state.mode === 'api'
            ? compact.format(total)
            : window
              ? `${window.remainingPercent.toFixed(1).replace(/\.0$/, '')}%`
              : '暂无法获取',
    unit:
      state.mode === 'api' && available
        ? 'Token 已记录'
        : window && available
          ? `${window.label}窗口剩余`
          : '后台自动获取',
    detail: state.status === 'stale' ? `${state.detail}（旧数据）` : state.detail,
    center:
      state.mode === 'api'
        ? 'Σ'
        : window && available
          ? `${Math.round(window.remainingPercent)}`
          : '—',
    percent: state.mode === 'subscription' && available ? window?.remainingPercent : undefined,
    title,
  };
};

export const renderModelUsage = (root: HTMLElement, state: ModelUsageSnapshot): void => {
  const view = modelUsagePresentation(state);
  for (const field of ['label', 'value', 'unit', 'detail', 'center'] as const) {
    const element = root.querySelector<HTMLElement>(`[data-usage-${field}]`);
    if (element && element.textContent !== view[field]) element.textContent = view[field];
  }
  root.dataset.status = state.status;
  root.dataset.mode = state.mode;
  root.title = view.title;
  const meter = root.querySelector<SVGCircleElement>('[data-usage-meter]');
  if (meter) {
    meter.style.strokeDashoffset = String(100 - (view.percent ?? 0));
    meter.style.opacity = view.percent === undefined ? '0' : '1';
  }
};

/** Subscribe first and fence the initial async read: a late response cannot overwrite a push. */
export const subscribeModelUsage = (
  api: ModelUsageApi,
  render: (state: ModelUsageSnapshot) => void,
  onError: () => void,
): (() => void) => {
  let revision = -1;
  let closed = false;
  const apply = (snapshot: ModelUsageSnapshot): void => {
    if (closed) return;
    if (!snapshot || !Number.isFinite(snapshot.revision)) {
      if (revision < 0) onError();
      return;
    }
    if (snapshot.revision < revision) return;
    revision = snapshot.revision;
    render(snapshot);
  };
  const unsubscribe = api.onModelUsage(apply);
  void api.getModelUsage().then(apply, () => {
    if (!closed && revision < 0) onError();
  });
  return () => {
    closed = true;
    unsubscribe();
  };
};
