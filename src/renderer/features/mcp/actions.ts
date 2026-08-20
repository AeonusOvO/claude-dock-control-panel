import type {
  McpCatalogEntry,
  McpScope,
  McpServerView,
  TerminalStatus,
} from '../../../shared/contracts';
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
  loadCatalog: (refresh: boolean) => Promise<void>;
  removeServer: (server: McpServerView, cwd: string, button: HTMLButtonElement) => Promise<void>;
  toggleServer: (server: McpServerView, cwd: string, button: HTMLButtonElement) => Promise<void>;
}

interface McpActionsContext {
  dependencies: McpActionsDependencies;
  elements: McpElements;
  state: McpState;
  view: McpView;
}

const loadMcpBackups = async ({ elements, state }: McpActionsContext): Promise<void> => {
  try {
    const backups = await window.controlPanel.getMcpBackups();
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
): Promise<void> => {
  const { dependencies, elements, state, view } = context;
  if (state.mutationInProgress) return;
  state.mutationInProgress = true;
  const label = button.textContent;
  button.disabled = true;
  button.textContent = busyLabel;
  elements.status.textContent = `${busyLabel} 配置写入期间退出保护已开启。`;
  try {
    const result = await operation();
    state.mutationInProgress = false;
    view.renderCatalog(result.catalog);
    void loadMcpBackups(context);
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
};

const toggleServer = async (
  context: McpActionsContext,
  server: McpServerView,
  cwd: string,
  toggle: HTMLButtonElement,
): Promise<void> => {
  const { dependencies } = context;
  try {
    const preview = await window.controlPanel.previewMcpToggle(cwd, server.name, !server.enabled);
    if (
      !(await dependencies.requestConfirmation({
        confirmLabel: server.enabled ? '确认停用' : '确认启用',
        message: `目标文件：${preview.targetPath}\n\n改动预览：\n- ${preview.before}\n+ ${preview.after}\n\n写入前会创建可逐字节还原的备份。`,
        title: `${server.enabled ? '停用' : '启用'} MCP ${server.name}`,
        tone: 'danger',
      }))
    ) {
      return;
    }
    void runMcpMutation(context, toggle, '正在写入…', () =>
      window.controlPanel.applyMcpToggle(preview.id, cwd),
    );
  } catch (error) {
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
  void runMcpMutation(context, remove, '正在卸载…', () =>
    window.controlPanel.removeMcpServer({
      cwd,
      name: server.name,
      scope: server.scope,
    }),
  );
};

const installServer = (
  context: McpActionsContext,
  entry: McpCatalogEntry,
  cwd: string,
  install: HTMLButtonElement,
): void => {
  const { elements } = context;
  void runMcpMutation(context, install, '正在安装…', () =>
    window.controlPanel.installMcpServer({
      catalogId: entry.id,
      cwd,
      scope: elements.installScope.value as McpScope,
    }),
  );
};

const loadMcpCatalog = (context: McpActionsContext, refresh: boolean): Promise<void> => {
  const { dependencies, elements, state, view } = context;
  if (state.loadPromise) return state.loadPromise;
  const status = dependencies.getActiveStatus();
  if (!status) {
    elements.status.textContent = '请先打开一个项目以发现 MCP。';
    return Promise.resolve();
  }
  state.loadPromise = (async () => {
    elements.refresh.disabled = true;
    if (refresh || !state.catalog) elements.status.textContent = '正在发现 MCP 并执行受限健康检查…';
    try {
      view.renderCatalog(await window.controlPanel.getMcpCatalog(status.cwd, refresh));
      await loadMcpBackups(context);
    } catch (error) {
      elements.status.textContent = error instanceof Error ? error.message : '无法读取 MCP 配置。';
    } finally {
      state.loadPromise = undefined;
      elements.refresh.disabled = false;
    }
  })();
  return state.loadPromise;
};

const bindMcpActions = (context: McpActionsContext): (() => void) => {
  const { dependencies, elements, state, view } = context;
  const tabBindings = Array.from(
    document.querySelectorAll<HTMLButtonElement>('[data-mcp-tab]'),
    (button) => ({
      button,
      handleTab: (): void => {
        view.selectTab(button.dataset.mcpTab ?? 'installed');
      },
    }),
  );
  const handleSearch = (): void => {
    if (state.catalog) view.renderCatalog(state.catalog);
  };
  const handleScopeFilter = (): void => {
    if (state.catalog) view.renderCatalog(state.catalog);
  };
  const handleRefresh = (): void => {
    void loadMcpCatalog(context, true);
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
    void runMcpMutation(context, elements.backupRestore, '正在还原…', () =>
      window.controlPanel.restoreMcpBackup(backupId, status.cwd),
    ).then(() => loadMcpBackups(context));
  };

  for (const { button, handleTab } of tabBindings) {
    button.addEventListener('click', handleTab);
  }
  elements.search.addEventListener('input', handleSearch);
  elements.scopeFilter.addEventListener('change', handleScopeFilter);
  elements.refresh.addEventListener('click', handleRefresh);
  elements.backupRestore.addEventListener('click', handleBackupRestore);

  return () => {
    for (const { button, handleTab } of tabBindings) {
      button.removeEventListener('click', handleTab);
    }
    elements.search.removeEventListener('input', handleSearch);
    elements.scopeFilter.removeEventListener('change', handleScopeFilter);
    elements.refresh.removeEventListener('click', handleRefresh);
    elements.backupRestore.removeEventListener('click', handleBackupRestore);
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
    loadCatalog: (refresh) => loadMcpCatalog(context, refresh),
    removeServer: (server, cwd, button) => removeServer(context, server, cwd, button),
    toggleServer: (server, cwd, button) => toggleServer(context, server, cwd, button),
  };
};
