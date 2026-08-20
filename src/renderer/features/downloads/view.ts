import type { BusyLease, DownloadTaskView } from '../../../shared/contracts';
import type { DownloadsElements } from './elements';
import { ACTIVE_DOWNLOAD_STATES, type DownloadsState } from './state';

const DOWNLOAD_STATE_LABELS: Record<DownloadTaskView['state'], string> = {
  cancelled: '已取消',
  completed: '已完成',
  failed: '失败',
  paused: '已暂停',
  progressing: '下载中',
  queued: '排队中',
  verifying: '正在校验',
};

const formatDownloadBytes = (bytes: number): string => {
  if (bytes <= 0) {
    return '0 B';
  }
  const units = ['B', 'KB', 'MB', 'GB'];
  const unitIndex = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** unitIndex;
  return `${value.toLocaleString('zh-CN', {
    maximumFractionDigits: unitIndex === 0 ? 0 : 1,
  })} ${units[unitIndex]}`;
};

const formatDownloadDuration = (milliseconds: number): string => {
  if (milliseconds < 0) {
    return '计算中…';
  }
  const totalSeconds = Math.max(0, Math.round(milliseconds / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes} 分 ${seconds} 秒` : `${seconds} 秒`;
};

export interface DownloadsViewDependencies {
  formatDuration: (milliseconds: number | undefined) => string;
  onDeleteHistory: (task: DownloadTaskView, button: HTMLButtonElement) => void;
  onTaskAction: (taskId: string, action: 'cancel' | 'pause' | 'resume') => Promise<void>;
}

export interface DownloadsView {
  render: () => void;
}

interface DownloadsViewContext {
  dependencies: DownloadsViewDependencies;
  elements: DownloadsElements;
  state: DownloadsState;
}

const appendDownloadAction = (
  { dependencies }: DownloadsViewContext,
  container: HTMLElement,
  task: DownloadTaskView,
  action: 'cancel' | 'pause' | 'resume',
  label: string,
): void => {
  const button = document.createElement('button');
  button.className = `download-task__action download-task__action--${action}`;
  button.textContent = label;
  button.type = 'button';
  button.addEventListener('click', () => {
    button.disabled = true;
    void dependencies.onTaskAction(task.id, action);
  });
  container.append(button);
};

const createDownloadTaskCard = (
  context: DownloadsViewContext,
  task: DownloadTaskView,
  historical: boolean,
): HTMLElement => {
  const { dependencies, elements } = context;
  const card = document.createElement('article');
  card.className = 'download-task';
  card.dataset.state = task.state;
  const heading = document.createElement('header');
  const identity = document.createElement('div');
  const title = document.createElement('strong');
  title.textContent = task.label;
  const taskState = document.createElement('span');
  taskState.className = 'download-task__state';
  taskState.textContent = DOWNLOAD_STATE_LABELS[task.state];
  identity.append(title, taskState);

  const progress = elements.progressTemplate.content.firstElementChild?.cloneNode(true) as
    HTMLElement | undefined;
  if (!progress) return card;
  const settled =
    task.state === 'cancelled' || task.state === 'completed' || task.state === 'failed';
  const percent = Math.max(0, task.percent);
  const indeterminate = !settled && task.percent < 0;
  progress.dataset.indeterminate = String(indeterminate);
  progress.setAttribute('role', 'progressbar');
  progress.setAttribute('aria-label', `${task.label}下载进度`);
  progress.setAttribute('aria-busy', String(indeterminate));
  if (!indeterminate) progress.setAttribute('aria-valuenow', String(Math.round(percent)));
  progress.setAttribute('aria-valuemin', '0');
  progress.setAttribute('aria-valuemax', '100');
  progress.style.setProperty('--download-progress', `${percent}%`);
  const ringValue = progress.querySelector<HTMLElement>('.download-progress__value');
  const linearValue = progress.querySelector<HTMLElement>('.download-progress__linear > span');
  if (ringValue) ringValue.textContent = indeterminate ? '…' : `${Math.round(percent)}%`;
  if (linearValue) linearValue.style.width = indeterminate ? '42%' : `${percent}%`;
  heading.append(identity, progress);

  const metrics = document.createElement('dl');
  metrics.className = 'download-task__metrics';
  const appendMetric = (label: string, value: string): void => {
    const wrapper = document.createElement('div');
    const term = document.createElement('dt');
    const detail = document.createElement('dd');
    term.textContent = label;
    detail.textContent = value;
    wrapper.append(term, detail);
    metrics.append(wrapper);
  };
  appendMetric(
    '进度',
    task.totalBytes > 0
      ? `${formatDownloadBytes(task.receivedBytes)} / ${formatDownloadBytes(task.totalBytes)}`
      : `${formatDownloadBytes(task.receivedBytes)} / 计算中…`,
  );
  appendMetric(
    '速度',
    task.bytesPerSecond > 0 ? `${formatDownloadBytes(task.bytesPerSecond)}/s` : '计算中…',
  );
  appendMetric('已用', formatDownloadDuration(task.elapsedMs));
  appendMetric('剩余', formatDownloadDuration(task.remainingMs));

  if (task.errorMessage) {
    const error = document.createElement('p');
    error.className = 'download-task__error';
    error.textContent = task.errorMessage;
    card.append(heading, metrics, error);
  } else {
    card.append(heading, metrics);
  }
  const actions = document.createElement('footer');
  if (!historical && task.canPause) appendDownloadAction(context, actions, task, 'pause', '暂停');
  if (!historical && task.canResume) appendDownloadAction(context, actions, task, 'resume', '继续');
  if (!historical && !settled) appendDownloadAction(context, actions, task, 'cancel', '取消');
  if (historical) {
    const finishedAt = document.createElement('span');
    finishedAt.className = 'download-task__history-time';
    finishedAt.textContent = task.finishedAt
      ? new Date(task.finishedAt).toLocaleString('zh-CN')
      : '本次运行';
    const remove = document.createElement('button');
    remove.className = 'download-task__delete';
    remove.type = 'button';
    remove.textContent = '删除记录';
    remove.addEventListener('click', () => dependencies.onDeleteHistory(task, remove));
    actions.append(finishedAt, remove);
  }
  if (actions.childElementCount > 0) card.append(actions);
  return card;
};

const createBusyOperationCard = (
  { dependencies, elements }: DownloadsViewContext,
  lease: BusyLease,
): HTMLElement => {
  const card = document.createElement('article');
  card.className = 'download-task';
  card.dataset.state = 'installing';
  const heading = document.createElement('header');
  const identity = document.createElement('div');
  const title = document.createElement('strong');
  title.textContent = lease.label;
  const taskState = document.createElement('span');
  taskState.className = 'download-task__state';
  const actionLabel = (
    {
      configure: '配置',
      disable: '禁用',
      enable: '启用',
      install: '安装',
      refresh: '刷新',
      remove: '移除',
      uninstall: '卸载',
      update: '更新',
    } as const
  )[lease.action ?? (lease.kind === 'uninstall' ? 'uninstall' : 'install')];
  const queueCopy =
    lease.queuePosition && lease.queueTotal
      ? ` · 队列 ${lease.queuePosition}/${lease.queueTotal}`
      : '';
  taskState.textContent = `${lease.stage ?? `${actionLabel}中`}${queueCopy}`;
  identity.append(title, taskState);
  const progress = elements.progressTemplate.content.firstElementChild?.cloneNode(true) as
    HTMLElement | undefined;
  if (progress) {
    progress.dataset.indeterminate = 'true';
    progress.setAttribute('role', 'progressbar');
    progress.setAttribute('aria-label', `${lease.label}进度`);
    progress.setAttribute('aria-busy', 'true');
    progress.querySelector<HTMLElement>('.download-progress__value')!.textContent = '…';
    progress.querySelector<HTMLElement>('.download-progress__linear > span')!.style.width = '34%';
    heading.append(identity, progress);
  } else {
    heading.append(identity);
  }
  card.append(heading);

  const details = document.createElement('dl');
  details.className = 'download-task__metrics download-task__metrics--operation';
  const appendMetric = (label: string, value: string): void => {
    const item = document.createElement('div');
    const term = document.createElement('dt');
    const description = document.createElement('dd');
    term.textContent = label;
    description.textContent = value;
    item.append(term, description);
    details.append(item);
  };
  appendMetric('对象', lease.target ?? lease.label);
  appendMetric(
    '已用时间',
    dependencies.formatDuration(Math.max(0, Date.now() - (lease.startedAt ?? Date.now()))),
  );
  if (lease.domain) appendMetric('类型', lease.domain);
  card.append(details);

  if (lease.logTail?.length) {
    const log = document.createElement('pre');
    log.className = 'download-task__log';
    log.textContent = lease.logTail.slice(-4).join('\n');
    card.append(log);
  }
  return card;
};

const applicationDownloadView = (state: DownloadsState): DownloadTaskView | undefined => {
  const updater = state.applicationUpdater;
  if (!updater || updater.phase !== 'downloading') return undefined;
  const totalBytes = updater.totalBytes ?? 0;
  const receivedBytes = updater.downloadedBytes ?? 0;
  return {
    bytesPerSecond: updater.bytesPerSecond ?? 0,
    canPause: false,
    canResume: false,
    elapsedMs: 0,
    id: 'application-update-download',
    label: `ClaudeDock ${updater.latestVersion ?? ''} 应用更新`,
    percent: updater.percent ?? -1,
    receivedBytes,
    remainingMs:
      updater.bytesPerSecond && totalBytes > receivedBytes
        ? ((totalBytes - receivedBytes) / updater.bytesPerSecond) * 1_000
        : -1,
    state: 'progressing',
    totalBytes,
  };
};

const renderDownloadCenter = (context: DownloadsViewContext): void => {
  const { elements, state } = context;
  const activeDownloads = state.tasks.filter(({ state: taskState }) =>
    ACTIVE_DOWNLOAD_STATES.has(taskState),
  );
  const history = state.tasks
    .filter(({ state: taskState }) => !ACTIVE_DOWNLOAD_STATES.has(taskState))
    .sort((left, right) => (right.finishedAt ?? 0) - (left.finishedAt ?? 0));
  const applicationDownload = applicationDownloadView(state);
  const operations = state.busyLeases.filter(
    ({ kind }) => kind === 'install' || kind === 'uninstall',
  );
  const visibleActive = applicationDownload
    ? [applicationDownload, ...activeDownloads]
    : activeDownloads;

  elements.taskList.replaceChildren(
    ...visibleActive.map((task) => createDownloadTaskCard(context, task, false)),
  );
  elements.operationList.replaceChildren(
    ...operations.map((lease) => createBusyOperationCard(context, lease)),
  );
  elements.historyList.replaceChildren(
    ...history.map((task) => createDownloadTaskCard(context, task, true)),
  );
  elements.activeSection.hidden = visibleActive.length === 0 && operations.length === 0;
  elements.historySection.hidden = history.length === 0;
  elements.centerEmpty.hidden =
    visibleActive.length > 0 || operations.length > 0 || history.length > 0;
  elements.activeSummary.textContent = `${visibleActive.length + operations.length} 项进行中`;
  elements.historySummary.textContent = `${history.length} 条记录`;
  elements.clearHistoryButton.disabled = history.length === 0;

  const activeCount = visibleActive.length + operations.length;
  const aggregatePercent =
    operations.length === 0 &&
    visibleActive.length > 0 &&
    visibleActive.every(({ totalBytes }) => totalBytes > 0)
      ? (visibleActive.reduce((sum, task) => sum + task.receivedBytes, 0) /
          visibleActive.reduce((sum, task) => sum + task.totalBytes, 0)) *
        100
      : -1;
  document.body.dataset.downloading = String(activeCount > 0);
  elements.openCenterButton.dataset.active = String(activeCount > 0);
  elements.openCenterButton.dataset.paused = String(
    activeCount > 0 &&
      operations.length === 0 &&
      visibleActive.every(({ state: taskState }) => taskState === 'paused'),
  );
  elements.openCenterButton.dataset.indeterminate = String(aggregatePercent < 0);
  elements.openCenterButton.style.setProperty(
    '--download-progress',
    `${Math.max(0, aggregatePercent)}%`,
  );
  elements.openCenterButton.setAttribute(
    'aria-label',
    activeCount > 0 ? `打开下载中心，${activeCount} 项未完成` : '打开下载中心',
  );
  elements.activeCount.hidden = activeCount === 0;
  elements.activeCount.textContent = String(activeCount);
};

export const createDownloadsView = (
  elements: DownloadsElements,
  state: DownloadsState,
  dependencies: DownloadsViewDependencies,
): DownloadsView => {
  const context = { dependencies, elements, state };
  return { render: () => renderDownloadCenter(context) };
};
