import type {
  ApplicationUpdaterState,
  ClaudePluginCatalog,
  SoftwareUpdateState,
} from '../../../shared/contracts';
import { localizePluginCopy } from '../../../shared/ui/plugin-localization';
import { deriveUpdateActionState } from '../../../shared/ui/update-actions';
import type { UpdatesElements } from './elements';
import type { UpdatesState } from './state';

export interface UpdateCenterItem {
  actionLabel: string;
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
    applicationUpdater?.phase === 'installing'
  ) {
    items.push({
      actionLabel:
        applicationUpdater.phase === 'downloaded' || applicationUpdater.phase === 'installing'
          ? '正在安装…'
          : '下载并更新',
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

const renderUpdateCenter = (context: UpdatesViewContext): void => {
  const { dependencies, elements, state } = context;
  const items = updateCenterItems(context);
  elements.updateCenterList.replaceChildren(
    ...items.map((item) => {
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
    }),
  );
  elements.updateCenterEmpty.hidden = items.length > 0;
  elements.updateCenterSummary.textContent =
    items.length > 0 ? `共 ${items.length} 项可更新` : '全部项目均为当前可检测到的最新版本';
  elements.updateCenterAllButton.hidden = items.length === 0;
  elements.updateCenterAllButton.disabled =
    state.updateCenterOperationInProgress || items.every(({ disabled }) => disabled);
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
    updaterState.phase === 'downloaded' || updaterState.phase === 'installing'
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
      updaterState.phase === 'installing',
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
