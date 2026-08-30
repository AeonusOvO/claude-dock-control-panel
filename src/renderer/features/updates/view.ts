import type {
  ApplicationUpdaterState,
  ClaudePluginCatalog,
  SoftwareUpdateState,
} from '../../../shared/contracts';
import { localizePluginCopy } from '../../../shared/ui/plugin-localization';
import { deriveUpdateActionState } from '../../../shared/ui/update-actions';
import type { UpdatesElements } from './elements';
import type { UpdatesState } from './state';

export type UpdateCenterCategory = 'application' | 'extensions' | 'tools';

export interface UpdateCenterItem {
  actionLabel: string;
  category: UpdateCenterCategory;
  detail: string;
  disabled?: boolean;
  id: string;
  run: () => Promise<void>;
  title: string;
  version: string;
}

export interface UpdatesViewDependencies {
  applyRouterRelevance: (state: SoftwareUpdateState | undefined) => void;
  getPluginCatalog: () => ClaudePluginCatalog | undefined;
  hasActiveProject: () => boolean;
  isPluginMutationInProgress: () => boolean;
  isRouterOperationInProgress: () => boolean;
  runApplicationUpdateAction: () => Promise<void>;
  runClaudeInstallUpdate: () => Promise<void>;
  runPluginUpdate: (pluginId: string) => Promise<void>;
  runRouterUpdate: () => Promise<void>;
  runUpdateCenterAction: (item: UpdateCenterItem) => Promise<void>;
  setApplicationUpdaterState: (state: ApplicationUpdaterState) => void;
  setPluginUpdateActionVisibility: (visible: boolean) => void;
  setRouterUpdateAction: (visible: boolean, label: string) => void;
}

export interface UpdatesView {
  applyRouterRelevance: () => void;
  renderApplicationUpdater: (state: ApplicationUpdaterState) => void;
  renderSoftwareUpdates: (state: SoftwareUpdateState) => void;
  renderUpdateCenter: () => void;
  syncUpdateActionVisibility: () => void;
}

interface UpdatesViewContext {
  dependencies: UpdatesViewDependencies;
  elements: UpdatesElements;
  state: UpdatesState;
}

const syncUpdateActionVisibility = ({
  dependencies,
  elements,
  state,
}: UpdatesViewContext): void => {
  const actions = deriveUpdateActionState(
    state.softwareUpdates,
    dependencies.getPluginCatalog(),
    state.applicationUpdaterState,
  );
  const claudeActionVisible = actions.claudeCode !== 'hidden';
  const routerActionVisible = actions.router !== 'hidden';

  elements.claudeInstallActions.hidden = !claudeActionVisible;
  elements.installUpdateClaudeButton.hidden = !claudeActionVisible;
  elements.installUpdateClaudeButton.textContent =
    actions.claudeCode === 'update' ? '一键更新' : '一键安装';
  dependencies.setRouterUpdateAction(
    routerActionVisible,
    actions.router === 'update' ? '一键更新' : '一键安装',
  );
  dependencies.setPluginUpdateActionVisibility(actions.plugins);

  const refreshLabel =
    actions.totalAvailable > 0
      ? `检查全部更新，当前发现 ${actions.totalAvailable} 项可更新`
      : '检查全部更新';
  elements.refreshUpdatesButton.dataset.update = String(actions.totalAvailable > 0);
  elements.refreshUpdatesButton.title = refreshLabel;
  elements.refreshUpdatesButton.setAttribute('aria-label', refreshLabel);
};

const updateCenterItems = (context: UpdatesViewContext): UpdateCenterItem[] => {
  const { dependencies, state } = context;
  const items: UpdateCenterItem[] = [];
  const applicationUpdater = state.applicationUpdaterState;
  if (
    applicationUpdater?.phase === 'available' ||
    applicationUpdater?.phase === 'downloading' ||
    applicationUpdater?.phase === 'downloaded' ||
    applicationUpdater?.phase === 'installing' ||
    applicationUpdater?.phase === 'install-recovery'
  ) {
    items.push({
      actionLabel:
        applicationUpdater.phase === 'install-recovery'
          ? '重新下载并安装'
          : applicationUpdater.phase === 'downloaded' || applicationUpdater.phase === 'installing'
            ? '正在安装…'
            : '下载并更新',
      category: 'application',
      detail: applicationUpdater.message,
      disabled:
        state.updateCenterOperationInProgress ||
        applicationUpdater.phase === 'downloading' ||
        applicationUpdater.phase === 'downloaded' ||
        applicationUpdater.phase === 'installing',
      id: 'application',
      run: dependencies.runApplicationUpdateAction,
      title: 'ClaudeDock',
      version: `v${applicationUpdater.currentVersion} → ${applicationUpdater.latestVersion ?? '未知'}`,
    });
  }
  if (state.softwareUpdates?.claudeCode.updateAvailable) {
    items.push({
      actionLabel: '更新',
      category: 'tools',
      detail: state.softwareUpdates.claudeCode.message,
      disabled: state.updateCenterOperationInProgress || state.softwareUpdateInProgress,
      id: 'claude-code',
      run: dependencies.runClaudeInstallUpdate,
      title: 'Claude Code',
      version: `v${state.softwareUpdates.claudeCode.currentVersion ?? '未知'} → ${state.softwareUpdates.claudeCode.latestVersion ?? '未知'}`,
    });
  }
  if (state.softwareUpdates?.router.updateAvailable) {
    const hasProject = dependencies.hasActiveProject();
    items.push({
      actionLabel: hasProject ? '更新' : '先打开项目',
      category: 'tools',
      detail: hasProject
        ? state.softwareUpdates.router.message
        : `${state.softwareUpdates.router.message} 路由器操作需要一个已打开项目作为安全作用域。`,
      disabled:
        state.updateCenterOperationInProgress ||
        dependencies.isRouterOperationInProgress() ||
        !hasProject,
      id: 'router',
      run: dependencies.runRouterUpdate,
      title: 'Claude Code Router',
      version: `v${state.softwareUpdates.router.currentVersion ?? '未知'} → ${state.softwareUpdates.router.latestVersion ?? '未知'}`,
    });
  }
  for (const plugin of dependencies
    .getPluginCatalog()
    ?.installed.filter(({ updateAvailable }) => updateAvailable) ?? []) {
    items.push({
      actionLabel: '更新',
      category: 'extensions',
      detail: `${plugin.marketplaceName} · ${localizePluginCopy(plugin).description}`,
      disabled: state.updateCenterOperationInProgress || dependencies.isPluginMutationInProgress(),
      id: `plugin:${plugin.pluginId}`,
      run: () => dependencies.runPluginUpdate(plugin.pluginId),
      title: plugin.name,
      version: `v${plugin.version ?? '未知'} → ${plugin.latestVersion ?? '最新'}`,
    });
  }
  return items;
};

const UPDATE_SECTION_META: ReadonlyArray<{
  category: UpdateCenterCategory;
  description: string;
  title: string;
}> = [
  {
    category: 'application',
    description: 'ClaudeDock 软件本体，始终优先处理。',
    title: 'ClaudeDock 软件本体',
  },
  {
    category: 'tools',
    description: 'Claude Code、Codex、路由器等开发工具。',
    title: 'Claude Code、Codex 等开发工具',
  },
  {
    category: 'extensions',
    description: '已安装扩展和插件的可用更新。',
    title: '扩展 / 插件',
  },
];

const DOWNLOAD_STATE_LABELS: Record<string, string> = {
  cancelled: '已取消',
  completed: '已完成',
  failed: '失败',
  paused: '已暂停',
  progressing: '下载中',
  queued: '排队中',
  verifying: '正在校验',
};

const createUpdateItemRow = (
  dependencies: UpdatesViewDependencies,
  item: UpdateCenterItem,
): HTMLElement => {
  const row = document.createElement('article');
  row.className = 'update-center-item';
  row.dataset.updateId = item.id;
  const copy = document.createElement('div');
  copy.className = 'update-center-item__copy';
  const title = document.createElement('strong');
  title.textContent = item.title;
  const version = document.createElement('span');
  version.textContent = item.version;
  const detail = document.createElement('small');
  detail.textContent = item.detail;
  copy.append(title, version, detail);
  const action = document.createElement('button');
  action.className = 'update-center-item__action';
  action.type = 'button';
  action.textContent = item.actionLabel;
  action.disabled = item.disabled === true;
  action.addEventListener('click', () => {
    void dependencies.runUpdateCenterAction(item);
  });
  row.append(copy, action);
  return row;
};

const createUpdateSection = (
  dependencies: UpdatesViewDependencies,
  meta: (typeof UPDATE_SECTION_META)[number],
  items: readonly UpdateCenterItem[],
): HTMLElement => {
  const section = document.createElement('section');
  section.className = 'update-center-section';
  section.dataset.updateCategory = meta.category;
  const heading = document.createElement('header');
  const title = document.createElement('strong');
  title.textContent = meta.title;
  const description = document.createElement('small');
  description.textContent = meta.description;
  heading.append(title, description);
  const list = document.createElement('div');
  list.className = 'update-center-section__items';
  if (items.length > 0) {
    list.append(...items.map((item) => createUpdateItemRow(dependencies, item)));
  } else {
    const empty = document.createElement('p');
    empty.className = 'update-center-section__empty';
    empty.textContent = '当前没有发现可用更新';
    list.append(empty);
  }
  section.append(heading, list);
  return section;
};

const renderUpdateHistory = (elements: UpdatesElements, state: UpdatesState): void => {
  const history = [...state.downloadHistory].sort(
    (left, right) =>
      (right.finishedAt ?? right.startedAt ?? 0) - (left.finishedAt ?? left.startedAt ?? 0),
  );
  elements.updateCenterHistoryList.replaceChildren(
    ...history.map((task) => {
      const row = document.createElement('article');
      row.className = 'update-center-history-item';
      row.dataset.downloadId = task.id;
      const title = document.createElement('strong');
      title.textContent = task.label;
      const status = document.createElement('span');
      status.textContent = `${DOWNLOAD_STATE_LABELS[task.state] ?? task.state} · ${
        task.finishedAt ? new Date(task.finishedAt).toLocaleString('zh-CN') : '本次运行'
      }`;
      const detail = document.createElement('small');
      detail.textContent =
        task.errorMessage ?? `${Math.round(Math.max(0, task.percent))}% · 更新下载记录`;
      row.append(title, status, detail);
      return row;
    }),
  );
  elements.updateCenterHistoryEmpty.hidden = history.length > 0;
};

const renderUpdateCenter = (context: UpdatesViewContext): void => {
  const { dependencies, elements, state } = context;
  const items = updateCenterItems(context);
  const itemsByCategory = new Map<UpdateCenterCategory, UpdateCenterItem[]>();
  for (const meta of UPDATE_SECTION_META) itemsByCategory.set(meta.category, []);
  for (const item of items) itemsByCategory.get(item.category)?.push(item);
  elements.updateCenterList.replaceChildren(
    ...UPDATE_SECTION_META.map((meta) =>
      createUpdateSection(dependencies, meta, itemsByCategory.get(meta.category) ?? []),
    ),
  );
  elements.updateCenterEmpty.hidden = items.length > 0 || state.updateRefreshInProgress;
  elements.updateCenterSummary.textContent = state.updateRefreshInProgress
    ? '正在检查更新来源…'
    : items.length > 0
      ? `共 ${items.length} 项可更新`
      : '全部项目均为当前可检测到的最新版本';
  elements.updateCenterAllButton.hidden = items.length === 0;
  elements.updateCenterAllButton.disabled =
    state.updateCenterOperationInProgress || items.every(({ disabled }) => disabled);
  elements.updateCenterPendingTab.classList.toggle(
    'plugin-tab--active',
    state.updateCenterTab === 'pending',
  );
  elements.updateCenterHistoryTab.classList.toggle(
    'plugin-tab--active',
    state.updateCenterTab === 'history',
  );
  elements.updateCenterPendingTab.setAttribute(
    'aria-selected',
    String(state.updateCenterTab === 'pending'),
  );
  elements.updateCenterHistoryTab.setAttribute(
    'aria-selected',
    String(state.updateCenterTab === 'history'),
  );
  elements.updateCenterPendingPanel.hidden = state.updateCenterTab !== 'pending';
  elements.updateCenterHistoryList.parentElement!.hidden = state.updateCenterTab !== 'history';
  renderUpdateHistory(elements, state);
};

const renderApplicationUpdater = (
  context: UpdatesViewContext,
  updaterState: ApplicationUpdaterState,
): void => {
  const { dependencies, elements, state } = context;
  state.applicationUpdaterState = updaterState;
  const sourceRate = updaterState.sourceThroughputBps
    ? ` · ${(updaterState.sourceThroughputBps / 1024 / 1024).toFixed(1)} MiB/s`
    : '';
  elements.applicationUpdateDetail.textContent = `${updaterState.message}${
    updaterState.sourceLabel ? ` · ${updaterState.sourceLabel}${sourceRate}` : ''
  }`;
  elements.applicationUpdateVersion.textContent = updaterState.latestVersion
    ? `v${updaterState.currentVersion} → ${updaterState.latestVersion}`
    : `v${updaterState.currentVersion}`;
  elements.applicationUpdateAction.hidden =
    updaterState.phase === 'disabled' || updaterState.phase === 'up-to-date';
  elements.applicationUpdateAction.disabled =
    updaterState.phase === 'checking' ||
    updaterState.phase === 'downloading' ||
    updaterState.phase === 'downloaded' ||
    updaterState.phase === 'installing';
  elements.applicationUpdateAction.textContent =
    updaterState.phase === 'install-recovery'
      ? '重新下载并安装'
      : updaterState.phase === 'downloaded' || updaterState.phase === 'installing'
        ? '正在安装…'
        : updaterState.phase === 'checking'
          ? '正在检查…'
          : updaterState.phase === 'downloading'
            ? `正在下载${updaterState.percent === undefined ? '…' : ` ${Math.round(updaterState.percent)}%`}`
            : updaterState.phase === 'error'
              ? '重试检查'
              : updaterState.phase === 'available'
                ? '下载并更新'
                : '检查应用更新';
  elements.applicationUpdateVersion.dataset.update = String(
    updaterState.phase === 'available' ||
      updaterState.phase === 'downloaded' ||
      updaterState.phase === 'downloading' ||
      updaterState.phase === 'installing' ||
      updaterState.phase === 'install-recovery',
  );
  dependencies.setApplicationUpdaterState(updaterState);
  if (elements.updateCenterDialog.open) renderUpdateCenter(context);
};

const renderSoftwareUpdates = (
  context: UpdatesViewContext,
  softwareUpdates: SoftwareUpdateState,
): void => {
  const { dependencies, elements, state } = context;
  state.softwareUpdates = softwareUpdates;
  const target = softwareUpdates.claudeCode;
  elements.claudeUpdateDetail.textContent = target.message;
  elements.claudeUpdateVersion.textContent = target.installed
    ? `v${target.currentVersion ?? '未知'}${target.updateAvailable ? ` → ${target.latestVersion}` : ''}`
    : target.latestVersion
      ? `可安装 v${target.latestVersion}`
      : '未安装';
  elements.claudeUpdateVersion.dataset.update = String(target.updateAvailable);
  elements.installUpdateClaudeButton.disabled = state.softwareUpdateInProgress;
  elements.softwareUpdateCheckedAt.textContent = `上次检查 ${new Date(
    softwareUpdates.checkedAt,
  ).toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
  })}`;
  syncUpdateActionVisibility(context);
  dependencies.applyRouterRelevance(softwareUpdates);
};

export const createUpdatesView = (
  elements: UpdatesElements,
  state: UpdatesState,
  dependencies: UpdatesViewDependencies,
): UpdatesView => {
  const context = { dependencies, elements, state };
  return {
    applyRouterRelevance: () => dependencies.applyRouterRelevance(state.softwareUpdates),
    renderApplicationUpdater: (updaterState) => renderApplicationUpdater(context, updaterState),
    renderSoftwareUpdates: (softwareUpdates) => renderSoftwareUpdates(context, softwareUpdates),
    renderUpdateCenter: () => renderUpdateCenter(context),
    syncUpdateActionVisibility: () => syncUpdateActionVisibility(context),
  };
};
