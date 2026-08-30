import type {
  McpCatalog,
  McpCatalogEntry,
  McpScope,
  McpServerView,
  TerminalStatus,
} from '../../../shared/contracts';
import { WORKSPACE_STATE_CHANGE_EVENT } from '../../platform/runtime-state-events';
import type { McpElements } from './elements';
import type { McpState } from './state';
import { mcpScopeLabel, type McpView } from './view';

export interface McpConfirmationRequest {
  confirmLabel?: string;
  message: string;
  title: string;
  tone?: 'danger' | 'default';
}

export interface McpActionsDependencies {
  getActiveStatus: () => TerminalStatus | undefined;
  requestConfirmation: (request: McpConfirmationRequest) => Promise<boolean>;
  resultFailureMessage: (result: unknown, fallback: string) => string;
  showToast: (message: string, tone?: 'error' | 'success') => void;
}

export interface McpActions {
  bind: () => () => void;
  installServer: (entry: McpCatalogEntry, cwd: string, button: HTMLButtonElement) => void;
  loadCatalog: (refreshRegistry: boolean) => Promise<void>;
  removeServer: (server: McpServerView, cwd: string, button: HTMLButtonElement) => Promise<void>;
  toggleServer: (server: McpServerView, cwd: string, button: HTMLButtonElement) => Promise<void>;
}

interface McpActionsContext {
  dependencies: McpActionsDependencies;
  elements: McpElements;
  state: McpState;
  view: McpView;
}

const currentMcpCwd = ({ dependencies }: McpActionsContext): string | undefined =>
  dependencies.getActiveStatus()?.cwd;

const syncMcpCwd = (context: McpActionsContext, cwd: string | undefined): number => {
  const { state } = context;
  if (state.activeCwd === cwd) return state.activeCwdGeneration;
  state.activeCwd = cwd;
  state.activeCwdGeneration += 1;
  state.catalog = undefined;
  state.catalogCwd = undefined;
  state.renderedContext = null;
  state.renderedInstalledKeys = new Set<string>();
  state.renderedAvailableKeys = new Set<string>();
  return state.activeCwdGeneration;
};

const ownsMcpCwd = (context: McpActionsContext, cwd: string, generation: number): boolean => {
  const { state } = context;
  return (
    !state.disposed &&
    state.activeCwd === cwd &&
    state.activeCwdGeneration === generation &&
    currentMcpCwd(context) === cwd
  );
};

const isMcpPageActive = (): boolean =>
  document
    .querySelector<HTMLElement>('[data-rail-page="mcp"]')
    ?.classList.contains('rail-page--active') === true;

const acceptMcpCatalog = (context: McpActionsContext, catalog: McpCatalog, cwd: string): void => {
  context.state.catalogCwd = cwd;
  context.view.renderCatalog(catalog);
};

const loadMcpBackups = async (
  { elements, state }: McpActionsContext,
  ownership?: { context: McpActionsContext; cwd: string; generation: number },
): Promise<void> => {
  try {
    const backups = await window.controlPanel.getMcpBackups();
    if (ownership && !ownsMcpCwd(ownership.context, ownership.cwd, ownership.generation)) {
      return;
    }
    elements.backupSelect.replaceChildren(
      ...(backups.length > 0
        ? backups.map((backup) => {
            const option = document.createElement('option');
            option.value = backup.id;
            option.textContent = `${new Date(backup.createdAt).toLocaleString('zh-CN')} · ${backup.path}`;
            return option;
          })
        : [
            (() => {
              const option = document.createElement('option');
              option.value = '';
              option.textContent = '暂无可还原备份';
              return option;
            })(),
          ]),
    );
    elements.backupRestore.disabled = backups.length === 0 || state.mutationInProgress;
  } catch {
    elements.backupRestore.disabled = true;
  }
};

const runMcpMutation = async (
  context: McpActionsContext,
  button: HTMLButtonElement,
  busyLabel: string,
  operation: () => ReturnType<typeof window.controlPanel.installMcpServer>,
  expectedCwd: string,
): Promise<boolean> => {
  const { dependencies, elements, state } = context;
  const cwd = dependencies.getActiveStatus()?.cwd;
  if (
    !cwd ||
    cwd !== expectedCwd ||
    state.activeCwd !== cwd ||
    state.disposed ||
    state.mutationInProgress
  )
    return false;
  const cwdGeneration = state.activeCwdGeneration;
  state.mutationInProgress = true;
  const label = button.textContent;
  button.disabled = true;
  button.textContent = busyLabel;
  elements.status.textContent = `${busyLabel} 配置写入期间退出保护已开启。`;
  try {
    const result = await operation();
    state.mutationInProgress = false;
    if (ownsMcpCwd(context, cwd, cwdGeneration)) {
      acceptMcpCatalog(context, result.catalog, cwd);
    }
    void loadMcpBackups(context, { context, cwd, generation: cwdGeneration });
    dependencies.showToast(
      result.ok ? result.message : dependencies.resultFailureMessage(result, result.message),
      result.ok ? 'success' : 'error',
    );
  } catch (error) {
    dependencies.showToast(error instanceof Error ? error.message : 'MCP 操作发生异常。', 'error');
  } finally {
    state.mutationInProgress = false;
    if (button.isConnected) {
      button.disabled = false;
      button.textContent = label;
    }
  }
  return true;
};

const toggleServer = async (
  context: McpActionsContext,
  server: McpServerView,
  cwd: string,
  toggle: HTMLButtonElement,
): Promise<void> => {
  const { dependencies } = context;
  let previewId: string | undefined;
  let submitted = false;
  try {
    const preview = await window.controlPanel.previewMcpToggle(cwd, server.name, !server.enabled);
    previewId = preview.id;
    if (
      !(await dependencies.requestConfirmation({
        confirmLabel: server.enabled ? '确认停用' : '确认启用',
        message: `目标文件：${preview.targetPath}\n\n改动预览：\n- ${preview.before}\n+ ${preview.after}\n\n写入前会创建可逐字节还原的备份。`,
        title: `${server.enabled ? '停用' : '启用'} MCP ${server.name}`,
        tone: 'danger',
      }))
    ) {
      await window.controlPanel.discardMcpToggle(preview.id);
      previewId = undefined;
      return;
    }
    submitted = true;
    const started = await runMcpMutation(
      context,
      toggle,
      '正在写入…',
      () => window.controlPanel.applyMcpToggle(preview.id, cwd),
      cwd,
    );
    if (!started && previewId) {
      await window.controlPanel.discardMcpToggle(previewId);
      previewId = undefined;
    }
  } catch (error) {
    if (previewId && !submitted) void window.controlPanel.discardMcpToggle(previewId);
    dependencies.showToast(
      error instanceof Error ? error.message : '无法生成 MCP 改动预览。',
      'error',
    );
  }
};

const removeServer = async (
  context: McpActionsContext,
  server: McpServerView,
  cwd: string,
  remove: HTMLButtonElement,
): Promise<void> => {
  const { dependencies } = context;
  if (
    !(await dependencies.requestConfirmation({
      confirmLabel: '卸载',
      message: `从 ${mcpScopeLabel(server.scope)} 移除 MCP“${server.name}”？\n\n配置来源：${server.configPath}`,
      title: '卸载 MCP',
      tone: 'danger',
    }))
  ) {
    return;
  }
  void runMcpMutation(
    context,
    remove,
    '正在卸载…',
    () =>
      window.controlPanel.removeMcpServer({
        cwd,
        name: server.name,
        scope: server.scope,
      }),
    cwd,
  );
};

const installServer = (
  context: McpActionsContext,
  entry: McpCatalogEntry,
  cwd: string,
  install: HTMLButtonElement,
): void => {
  if (!entry.installable) return;
  const { elements } = context;
  void runMcpMutation(
    context,
    install,
    '正在安装…',
    () =>
      window.controlPanel.installMcpServer({
        catalogId: entry.id,
        cwd,
        scope: elements.installScope.value as McpScope,
      }),
    cwd,
  );
};

const loadMcpCatalog = (context: McpActionsContext, refreshRegistry: boolean): Promise<void> => {
  const { dependencies, elements, state } = context;
  const status = dependencies.getActiveStatus();
  const cwd = status?.cwd;
  const generation = syncMcpCwd(context, cwd);
  if (!cwd) {
    elements.status.textContent = '请先打开一个项目以发现 MCP。';
    return Promise.resolve();
  }
  // Keep same-cwd requests deduplicated, but let a newly selected workspace own a new request.
  if (state.loadPromise && state.loadCwd === cwd) return state.loadPromise;

  const promise = Promise.resolve().then(async () => {
    elements.refresh.disabled = true;
    if (refreshRegistry || !state.catalog)
      elements.status.textContent = '正在发现 MCP 并同步 Registry…';
    try {
      const catalog = await window.controlPanel.getMcpCatalog(cwd, refreshRegistry);
      if (!ownsMcpCwd(context, cwd, generation)) return;
      acceptMcpCatalog(context, catalog, cwd);
      await loadMcpBackups(context, { context, cwd, generation });
    } catch (error) {
      if (ownsMcpCwd(context, cwd, generation)) {
        elements.status.textContent =
          error instanceof Error ? error.message : '无法读取 MCP 配置。';
      }
    } finally {
      if (state.loadPromise === promise) {
        state.loadPromise = undefined;
        state.loadCwd = undefined;
        if (ownsMcpCwd(context, cwd, generation)) elements.refresh.disabled = false;
      }
    }
  });
  state.loadPromise = promise;
  state.loadCwd = cwd;
  return promise;
};

const bindMcpActions = (context: McpActionsContext): (() => void) => {
  const { dependencies, elements, state, view } = context;
  state.disposed = false;
  const tabBindings = Array.from(
    document.querySelectorAll<HTMLButtonElement>('[data-mcp-tab]'),
    (button) => ({
      button,
      handleTab: (): void => {
        view.selectTab(button.dataset.mcpTab ?? 'installed');
      },
    }),
  );
  const renderCurrentCatalog = (): void => {
    if (state.catalog && state.catalogCwd === currentMcpCwd(context)) {
      view.renderCatalog(state.catalog);
    }
  };
  const handleSearch = (): void => {
    renderCurrentCatalog();
  };
  const handleScopeFilter = (): void => {
    renderCurrentCatalog();
  };
  const handleInstallScope = (): void => {
    renderCurrentCatalog();
  };
  const handleRefresh = (): void => {
    void loadMcpCatalog(context, true);
  };
  const handleWorkspaceStateChange = (): void => {
    const previousCwd = state.activeCwd;
    const cwd = currentMcpCwd(context);
    syncMcpCwd(context, cwd);
    if (previousCwd === cwd || !isMcpPageActive()) return;
    if (!cwd) {
      elements.status.textContent = '请先打开一个项目以发现 MCP。';
      elements.installedList.replaceChildren();
      elements.catalogList.replaceChildren();
      return;
    }
    elements.status.textContent = '正在切换项目并发现 MCP…';
    void loadMcpCatalog(context, false);
  };
  const handleBackupRestore = async (): Promise<void> => {
    const status = dependencies.getActiveStatus();
    const backupId = elements.backupSelect.value;
    if (!status || !backupId || state.mutationInProgress) return;
    if (
      !(await dependencies.requestConfirmation({
        confirmLabel: '还原备份',
        message: `将用备份 ${backupId} 逐字节替换 ~/.claude.json。\n\n当前文件会先另存为新的安全备份，失败时自动回滚。`,
        title: '还原 MCP 配置备份',
        tone: 'danger',
      }))
    ) {
      return;
    }
    void runMcpMutation(
      context,
      elements.backupRestore,
      '正在还原…',
      () => window.controlPanel.restoreMcpBackup(backupId, status.cwd),
      status.cwd,
    ).then(() => loadMcpBackups(context));
  };

  for (const { button, handleTab } of tabBindings) {
    button.addEventListener('click', handleTab);
  }
  elements.search.addEventListener('input', handleSearch);
  elements.scopeFilter.addEventListener('change', handleScopeFilter);
  elements.installScope.addEventListener('change', handleInstallScope);
  elements.refresh.addEventListener('click', handleRefresh);
  elements.backupRestore.addEventListener('click', handleBackupRestore);
  document.addEventListener(WORKSPACE_STATE_CHANGE_EVENT, handleWorkspaceStateChange);

  return () => {
    state.disposed = true;
    state.activeCwdGeneration += 1;
    for (const { button, handleTab } of tabBindings) {
      button.removeEventListener('click', handleTab);
    }
    elements.search.removeEventListener('input', handleSearch);
    elements.scopeFilter.removeEventListener('change', handleScopeFilter);
    elements.installScope.removeEventListener('change', handleInstallScope);
    elements.refresh.removeEventListener('click', handleRefresh);
    elements.backupRestore.removeEventListener('click', handleBackupRestore);
    document.removeEventListener(WORKSPACE_STATE_CHANGE_EVENT, handleWorkspaceStateChange);
  };
};

export const createMcpActions = (
  elements: McpElements,
  state: McpState,
  dependencies: McpActionsDependencies,
  view: McpView,
): McpActions => {
  const context = { dependencies, elements, state, view };
  return {
    bind: () => bindMcpActions(context),
    installServer: (entry, cwd, button) => installServer(context, entry, cwd, button),
    loadCatalog: (refreshRegistry) => loadMcpCatalog(context, refreshRegistry),
    removeServer: (server, cwd, button) => removeServer(context, server, cwd, button),
    toggleServer: (server, cwd, button) => toggleServer(context, server, cwd, button),
  };
};
