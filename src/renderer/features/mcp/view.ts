import type {
  McpCatalog,
  McpCatalogEntry,
  McpScope,
  McpServerView,
  TerminalStatus,
} from '../../../shared/contracts';
import type { McpElements } from './elements';
import type { McpState } from './state';

/** Same tab machinery as the plugins page, pointed at the MCP page's data attributes. */
const selectMcpTab = (tab: string): void => {
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-mcp-tab]')) {
    button.classList.toggle('plugin-tab--active', button.dataset.mcpTab === tab);
  }
  for (const panel of document.querySelectorAll<HTMLElement>('[data-mcp-panel]')) {
    panel.classList.toggle('plugin-panel--active', panel.dataset.mcpPanel === tab);
  }
};

export const mcpScopeLabel = (scope: McpScope): string =>
  scope === 'user'
    ? 'user · 用户级'
    : scope === 'project'
      ? 'project · 项目共享'
      : 'local · 项目私有';

/*
 * Every MCP render rebuilds both lists from scratch, so without a memory of what was on screen the
 * card entrance replays for every row and an install looks like the whole panel blinking. Keying the
 * previous render lets a card that survived sit still while a genuinely new server animates in.
 * `null` means "no comparable previous render" (first paint, project switch) — then everything is new
 * and the list arrives as a whole, which is what it actually is.
 */
const mcpServerKey = (server: McpServerView): string =>
  `${server.client}\\u0000${server.scope}\\u0000${server.name}`;

const mcpCatalogEntryKey = (entry: McpCatalogEntry): string => `${entry.id}\\u0000${entry.name}`;

const mcpInstalledIdentityKey = (
  client: McpServerView['client'],
  scope: McpScope,
  name: string,
): string => `${client}\\u0000${scope}\\u0000${name}`;

const mcpMatchesSearch = (
  value: Pick<McpServerView, 'configPath' | 'name'> | Pick<McpCatalogEntry, 'description' | 'name'>,
  needle: string,
): boolean =>
  needle === '' ||
  Object.values(value).some(
    (field) => typeof field === 'string' && field.toLowerCase().includes(needle),
  );

export interface McpViewDependencies {
  getActiveStatus: () => TerminalStatus | undefined;
  onInstall: (entry: McpCatalogEntry, cwd: string, button: HTMLButtonElement) => void;
  onRemove: (server: McpServerView, cwd: string, button: HTMLButtonElement) => Promise<void>;
  onToggle: (server: McpServerView, cwd: string, button: HTMLButtonElement) => Promise<void>;
}

export interface McpView {
  renderCatalog: (catalog: McpCatalog) => void;
  selectTab: (tab: string) => void;
}

interface McpViewContext {
  dependencies: McpViewDependencies;
  elements: McpElements;
  state: McpState;
}

const renderMcpInstalledCard = (
  { dependencies, state }: McpViewContext,
  server: McpServerView,
  cwd: string,
  fresh: boolean,
): HTMLElement => {
  const card = document.createElement('article');
  card.className = 'plugin-card';
  card.dataset.enabled = String(server.enabled);
  card.dataset.fresh = String(fresh);
  card.dataset.installed = 'true';
  const header = document.createElement('div');
  header.className = 'plugin-card__header';
  const title = document.createElement('strong');
  title.textContent = server.name;
  const badge = document.createElement('span');
  badge.className = 'plugin-card__badge';
  badge.textContent = `${server.client === 'claude' ? 'Claude' : 'Codex'} · ${server.transport}`;
  header.append(title, badge);

  const health = document.createElement('p');
  health.className = 'mcp-card__health';
  health.dataset.health = server.health;
  health.textContent = `${
    server.health === 'connected'
      ? '已连接'
      : server.health === 'failed'
        ? '连接失败'
        : server.health === 'disabled'
          ? '已停用'
          : '状态未知'
  } · ${server.healthDetail ?? '目录读取不会执行连接检查。'}`;
  const meta = document.createElement('div');
  meta.className = 'plugin-card__meta';
  const scope = document.createElement('span');
  scope.textContent = mcpScopeLabel(server.scope);
  const pathLabel = document.createElement('code');
  pathLabel.className = 'mcp-card__path';
  pathLabel.textContent = server.configPath;
  meta.append(scope);

  const actions = document.createElement('div');
  actions.className = 'plugin-card__actions';
  if (server.toggleSupported) {
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'button button--secondary button--small';
    toggle.textContent = server.enabled ? '停用' : '启用';
    toggle.disabled = state.mutationInProgress;
    toggle.addEventListener('click', () => {
      void dependencies.onToggle(server, cwd, toggle);
    });
    actions.append(toggle);
  }
  if (server.client === 'claude') {
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'button button--quiet button--small plugin-card__danger';
    remove.textContent = '卸载';
    remove.disabled = state.mutationInProgress;
    remove.addEventListener('click', () => {
      void dependencies.onRemove(server, cwd, remove);
    });
    actions.append(remove);
  }
  card.append(header, health, meta, pathLabel, actions);
  return card;
};

const renderMcpCatalogCard = (
  { dependencies, state }: McpViewContext,
  entry: McpCatalogEntry,
  cwd: string,
  installedKeys: ReadonlySet<string>,
  installScope: McpScope,
  fresh: boolean,
): HTMLElement => {
  const card = document.createElement('article');
  card.className = 'plugin-card';
  card.dataset.fresh = String(fresh);
  const installed = installedKeys.has(mcpInstalledIdentityKey('claude', installScope, entry.name));
  card.dataset.installed = String(installed);
  const header = document.createElement('div');
  header.className = 'plugin-card__header';
  const title = document.createElement('strong');
  title.textContent = entry.name;
  const badge = document.createElement('span');
  badge.className = 'plugin-card__badge';
  badge.textContent = entry.featured ? `精选 · ${entry.transport}` : `注册表 · ${entry.transport}`;
  header.append(title, badge);
  const description = document.createElement('p');
  description.textContent = entry.description;
  const actions = document.createElement('div');
  actions.className = 'plugin-card__actions';
  const install = document.createElement('button');
  install.type = 'button';
  install.className = 'button button--primary button--small';
  install.textContent = installed ? '已安装' : entry.installable ? '安装' : '仅浏览';
  install.disabled =
    state.mutationInProgress || installed || !entry.installable || entry.requiresCredential;
  install.title = !entry.installable
    ? 'Registry 条目仅供浏览；ClaudeDock 不会执行其安装配置。'
    : entry.requiresCredential
      ? '该条目需要凭据，不能自动写入明文配置。'
      : '';
  if (entry.installable) {
    install.addEventListener('click', () => {
      dependencies.onInstall(entry, cwd, install);
    });
  }
  actions.append(install);
  card.append(header, description, actions);
  return card;
};

const renderMcpCatalog = (context: McpViewContext, catalog: McpCatalog): void => {
  const { dependencies, elements, state } = context;
  state.catalog = catalog;
  const status = dependencies.getActiveStatus();
  const cwd = status?.cwd;
  const needle = elements.search.value.trim().toLowerCase();
  const scopeFilter = elements.scopeFilter.value;
  const installScope = elements.installScope.value as McpScope;
  const installed = catalog.installed.filter(
    (server) =>
      (scopeFilter === 'all' || server.scope === scopeFilter) && mcpMatchesSearch(server, needle),
  );
  const available = catalog.available.filter((entry) => mcpMatchesSearch(entry, needle));
  const renderContext = `${cwd ?? ''}|${scopeFilter}|${needle}`;
  const previousInstalledKeys = state.renderedContext === null ? null : state.renderedInstalledKeys;
  const previousAvailableKeys = state.renderedContext === null ? null : state.renderedAvailableKeys;
  const isInstalledFresh = (server: McpServerView): boolean =>
    previousInstalledKeys === null || !previousInstalledKeys.has(mcpServerKey(server));
  const isAvailableFresh = (entry: McpCatalogEntry): boolean =>
    previousAvailableKeys === null || !previousAvailableKeys.has(mcpCatalogEntryKey(entry));
  state.renderedContext = renderContext;
  state.renderedInstalledKeys = new Set(catalog.installed.map(mcpServerKey));
  state.renderedAvailableKeys = new Set(catalog.available.map(mcpCatalogEntryKey));
  elements.installedCount.textContent = String(installed.length);
  elements.catalogCount.textContent = String(available.length);
  elements.status.textContent = `${catalog.message} · 上次读取 ${new Date(catalog.checkedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`;
  elements.installedList.replaceChildren();
  if (!cwd || installed.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'plugin-empty';
    empty.textContent = cwd
      ? needle || scopeFilter !== 'all'
        ? '没有匹配当前筛选条件的 MCP。'
        : '当前没有发现 MCP。可以从“可安装”里定向安装一个。'
      : '请先打开一个项目，再发现或安装 MCP。';
    if (cwd && !needle && scopeFilter === 'all') {
      const browse = document.createElement('button');
      browse.type = 'button';
      browse.textContent = '去目录看看';
      browse.addEventListener('click', () => selectMcpTab('catalog'));
      empty.append(document.createElement('br'), browse);
    }
    elements.installedList.append(empty);
  } else {
    elements.installedList.append(
      ...installed.map((server) =>
        renderMcpInstalledCard(context, server, cwd, isInstalledFresh(server)),
      ),
    );
  }
  elements.catalogList.replaceChildren();
  if (!cwd || available.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'plugin-empty';
    empty.textContent = cwd ? '目录中没有匹配项。' : '打开项目后即可安装精选 MCP。';
    elements.catalogList.append(empty);
  } else {
    const installedKeys = new Set(catalog.installed.map(mcpServerKey));
    elements.catalogList.append(
      ...available.map((entry) =>
        renderMcpCatalogCard(
          context,
          entry,
          cwd,
          installedKeys,
          installScope,
          isAvailableFresh(entry),
        ),
      ),
    );
  }
};

export const createMcpView = (
  elements: McpElements,
  state: McpState,
  dependencies: McpViewDependencies,
): McpView => {
  const context = { dependencies, elements, state };
  return {
    renderCatalog: (catalog) => renderMcpCatalog(context, catalog),
    selectTab: selectMcpTab,
  };
};
