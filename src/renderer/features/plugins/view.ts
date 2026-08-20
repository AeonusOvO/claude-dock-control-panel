import type {
  ClaudePluginCatalog,
  ClaudePluginMarketplaceView,
  ClaudePluginOperationResult,
  ClaudePluginView,
} from '../../../shared/contracts';
import { localizePluginCopy } from '../../../shared/ui/plugin-localization';
import type { PluginsElements } from './elements';
import type { PluginsState } from './state';

export interface PluginConfirmationRequest {
  confirmLabel?: string;
  message: string;
  title: string;
  tone?: 'danger' | 'default';
}

export interface PluginsViewDependencies {
  formatTokenCount: (value: number | undefined) => string;
  installOperation: (plugin: ClaudePluginView) => () => Promise<ClaudePluginOperationResult>;
  removeMarketplaceOperation: (
    marketplace: ClaudePluginMarketplaceView,
  ) => () => Promise<ClaudePluginOperationResult>;
  requestConfirmation: (request: PluginConfirmationRequest) => Promise<boolean>;
  runMutation: (
    operation: () => Promise<ClaudePluginOperationResult>,
    busyLabel: string,
    button: HTMLButtonElement,
  ) => void;
  syncUpdateActionVisibility: () => void;
  toggleOperation: (plugin: ClaudePluginView) => () => Promise<ClaudePluginOperationResult>;
  uninstallOperation: (plugin: ClaudePluginView) => () => Promise<ClaudePluginOperationResult>;
  updateOperation: (plugin: ClaudePluginView) => () => Promise<ClaudePluginOperationResult>;
}

export interface PluginsView {
  renderCatalog: (catalog: ClaudePluginCatalog) => void;
  selectTab: (tab: string) => void;
}

interface PluginsViewContext {
  dependencies: PluginsViewDependencies;
  elements: PluginsElements;
  state: PluginsState;
}

const pluginKey = (plugin: ClaudePluginView): string =>
  `${plugin.marketplaceName}/${plugin.name}`.toLowerCase();

const pluginMatchesSearch = (plugin: ClaudePluginView, needle: string): boolean =>
  needle === '' ||
  (() => {
    const localized = localizePluginCopy(plugin);
    return [
      plugin.name,
      plugin.description,
      plugin.marketplaceName,
      plugin.sourceLabel,
      localized.category,
      localized.description,
    ].some((field) => field.toLowerCase().includes(needle));
  })();

const pluginCategory = (plugin: ClaudePluginView): string => localizePluginCopy(plugin).category;

/**
 * The category dropdown mirrors MCP's 作用域 filter: same control, same position in the toolbar, same
 * "全部" default. Its options are derived from the catalogue rather than hard-coded, so a market that
 * ships plugins in a category the localizer has not seen before is still reachable, and a category
 * nobody has installed does not sit in the list as a dead end. The current pick survives a refresh
 * whenever it still matches something.
 */
const syncPluginCategoryOptions = (
  { elements }: PluginsViewContext,
  catalog: ClaudePluginCatalog,
): void => {
  const categories = [
    ...new Set([...catalog.installed, ...catalog.available].map(pluginCategory)),
  ].sort((left, right) => left.localeCompare(right, 'zh-CN'));
  const previous = elements.categoryFilter.value;
  const options = [
    Object.assign(document.createElement('option'), { textContent: '全部', value: 'all' }),
    ...categories.map((category) =>
      Object.assign(document.createElement('option'), {
        textContent: category,
        value: category,
      }),
    ),
  ];
  elements.categoryFilter.replaceChildren(...options);
  elements.categoryFilter.value = categories.includes(previous) ? previous : 'all';
};

const selectPluginTab = (tab: string): void => {
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-plugin-tab]')) {
    button.classList.toggle('plugin-tab--active', button.dataset.pluginTab === tab);
  }
  for (const panel of document.querySelectorAll<HTMLElement>('[data-plugin-panel]')) {
    panel.classList.toggle('plugin-panel--active', panel.dataset.pluginPanel === tab);
  }
};

const pluginActionButton = (
  { dependencies, state }: PluginsViewContext,
  label: string,
  variant: 'primary' | 'quiet' | 'secondary',
  busyLabel: string,
  operation: () => Promise<ClaudePluginOperationResult>,
): HTMLButtonElement => {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `button button--${variant} button--small`;
  button.textContent = label;
  button.disabled = state.mutationInProgress;
  button.addEventListener('click', () => {
    dependencies.runMutation(operation, busyLabel, button);
  });
  return button;
};

const renderPluginCard = (
  context: PluginsViewContext,
  plugin: ClaudePluginView,
  fresh: boolean,
): HTMLElement => {
  const { dependencies, state } = context;
  const card = document.createElement('article');
  card.className = 'plugin-card';
  card.dataset.enabled = String(plugin.enabled);
  card.dataset.fresh = String(fresh);
  /*
   * The dimmed treatment means "installed but switched off", so it needs the installation state as
   * well: a plugin in the 可安装 list is also `enabled: false`, and keying the dimming on that alone
   * greyed out the entire catalogue of things the user had not installed yet.
   */
  card.dataset.installed = String(plugin.installed);

  const header = document.createElement('div');
  header.className = 'plugin-card__header';
  const title = document.createElement('strong');
  title.textContent = plugin.name;
  const badge = document.createElement('span');
  badge.className = 'plugin-card__badge';
  badge.textContent = plugin.updateAvailable
    ? '可更新'
    : plugin.installed
      ? plugin.enabled
        ? '已启用'
        : '已停用'
      : '未安装';
  badge.dataset.update = String(plugin.updateAvailable);
  header.append(title, badge);

  const localized = localizePluginCopy(plugin);
  const description = document.createElement('p');
  description.textContent = localized.description;

  const meta = document.createElement('div');
  meta.className = 'plugin-card__meta';
  const source = document.createElement('span');
  source.textContent = plugin.sourceLabel;
  const category = document.createElement('span');
  category.className = 'plugin-card__category';
  category.textContent = localized.category;
  meta.append(category, source);
  if (plugin.version) {
    const version = document.createElement('span');
    version.textContent = `v${plugin.version}`;
    meta.append(version);
  }
  if (plugin.latestVersion && plugin.updateAvailable) {
    const latest = document.createElement('span');
    latest.textContent = `最新 v${plugin.latestVersion}`;
    meta.append(latest);
  }
  if (plugin.scope) {
    const scope = document.createElement('span');
    scope.textContent =
      plugin.scope === 'user' ? '用户级' : plugin.scope === 'project' ? '项目级' : '本机级';
    meta.append(scope);
  }
  if (plugin.installCount !== undefined) {
    const installs = document.createElement('span');
    installs.textContent = `${dependencies.formatTokenCount(plugin.installCount)} 次安装`;
    meta.append(installs);
  }

  const actions = document.createElement('div');
  actions.className = 'plugin-card__actions';
  if (plugin.installed) {
    actions.append(
      pluginActionButton(
        context,
        plugin.enabled ? '停用' : '启用',
        'secondary',
        plugin.enabled ? '正在停用…' : '正在启用…',
        dependencies.toggleOperation(plugin),
      ),
    );
    if (plugin.updateAvailable) {
      actions.append(
        pluginActionButton(
          context,
          '更新',
          'quiet',
          '正在更新…',
          dependencies.updateOperation(plugin),
        ),
      );
    }
    const uninstall = document.createElement('button');
    uninstall.type = 'button';
    uninstall.className = 'button button--quiet button--small plugin-card__danger';
    uninstall.textContent = '卸载';
    uninstall.disabled = state.mutationInProgress;
    uninstall.addEventListener('click', async () => {
      if (
        !(await dependencies.requestConfirmation({
          confirmLabel: '卸载',
          message: `卸载插件“${plugin.name}”？`,
          title: '卸载插件',
          tone: 'danger',
        }))
      ) {
        return;
      }
      dependencies.runMutation(dependencies.uninstallOperation(plugin), '正在卸载…', uninstall);
    });
    actions.append(uninstall);
  } else {
    actions.append(
      pluginActionButton(
        context,
        '安装',
        'primary',
        '正在安装…',
        dependencies.installOperation(plugin),
      ),
    );
  }

  card.append(header, description, meta, actions);
  return card;
};

const renderPluginList = (
  context: PluginsViewContext,
  container: HTMLElement,
  plugins: ClaudePluginView[],
  emptyMessage: string,
  isFresh: (plugin: ClaudePluginView) => boolean,
): void => {
  container.replaceChildren();
  if (plugins.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'plugin-empty';
    empty.textContent = emptyMessage;
    container.append(empty);
    return;
  }
  for (const plugin of plugins) {
    container.append(renderPluginCard(context, plugin, isFresh(plugin)));
  }
};

const renderPluginCatalog = (context: PluginsViewContext, catalog: ClaudePluginCatalog): void => {
  const { dependencies, elements, state } = context;
  state.catalog = catalog;
  syncPluginCategoryOptions(context, catalog);
  const needle = elements.search.value.trim().toLowerCase();
  const categoryFilter = elements.categoryFilter.value;
  const matches = (plugin: ClaudePluginView): boolean =>
    (categoryFilter === 'all' || pluginCategory(plugin) === categoryFilter) &&
    pluginMatchesSearch(plugin, needle);
  const installed = catalog.installed.filter(matches);
  const installedKeys = new Set(catalog.installed.map(pluginKey));
  const available = catalog.available
    .filter((plugin) => !installedKeys.has(pluginKey(plugin)))
    .filter(matches);

  const renderContext = `${categoryFilter}|${needle}`;
  const previousKeys = state.renderedContext === null ? null : state.renderedKeys;
  const isFresh = (plugin: ClaudePluginView): boolean =>
    previousKeys === null || !previousKeys.has(pluginKey(plugin));
  state.renderedContext = renderContext;
  state.renderedKeys = new Set([...catalog.installed, ...catalog.available].map(pluginKey));

  elements.installedCount.textContent = String(installed.length);
  elements.availableCount.textContent = String(available.length);
  elements.railDot.hidden = catalog.updatesAvailable === 0;
  elements.railDot.dataset.tone = 'warning';
  elements.railDot.title =
    catalog.updatesAvailable > 0 ? `${catalog.updatesAvailable} 个插件可更新` : '';
  elements.status.textContent = catalog.cliAvailable
    ? `${catalog.message}${
        catalog.updatesAvailable > 0 ? ` · ${catalog.updatesAvailable} 个可更新` : ''
      } · 上次读取 ${new Date(catalog.checkedAt).toLocaleTimeString('zh-CN', {
        hour: '2-digit',
        minute: '2-digit',
      })}`
    : catalog.message;

  const filtered = needle !== '' || categoryFilter !== 'all';
  renderPluginList(
    context,
    elements.installedList,
    installed,
    filtered ? '没有匹配当前筛选条件的已安装插件。' : '还没有安装任何插件。到“可安装”里挑一个吧。',
    isFresh,
  );
  renderPluginList(
    context,
    elements.availableList,
    available,
    filtered
      ? '没有匹配当前筛选条件的可安装插件。'
      : '当前插件市场里没有更多可安装的插件；可以在下面添加新的市场。',
    isFresh,
  );

  elements.marketplaceList.replaceChildren();
  if (catalog.marketplaces.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'plugin-empty';
    empty.textContent = '还没有添加插件市场。添加后即可浏览它提供的插件。';
    elements.marketplaceList.append(empty);
  }
  for (const marketplace of catalog.marketplaces) {
    elements.marketplaceList.append(
      renderMarketplaceCard(context, marketplace, previousKeys === null),
    );
  }
  elements.addMarketplaceButton.disabled = state.mutationInProgress || !catalog.cliAvailable;
  elements.updateAllButton.disabled =
    state.mutationInProgress || !catalog.cliAvailable || catalog.updatesAvailable === 0;
  dependencies.syncUpdateActionVisibility();
};

const renderMarketplaceCard = (
  context: PluginsViewContext,
  marketplace: ClaudePluginMarketplaceView,
  fresh: boolean,
): HTMLElement => {
  const { dependencies, state } = context;
  const card = document.createElement('article');
  card.className = 'plugin-card plugin-card--marketplace';
  card.dataset.fresh = String(fresh);

  const header = document.createElement('div');
  header.className = 'plugin-card__header';
  const title = document.createElement('strong');
  title.textContent = marketplace.name;
  header.append(title);

  const source = document.createElement('code');
  source.textContent = marketplace.repo ?? marketplace.source;

  const actions = document.createElement('div');
  actions.className = 'plugin-card__actions';
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'button button--quiet button--small plugin-card__danger';
  remove.textContent = '移除市场';
  remove.disabled = state.mutationInProgress;
  remove.addEventListener('click', async () => {
    if (
      !(await dependencies.requestConfirmation({
        confirmLabel: '移除',
        message: `移除插件市场“${marketplace.name}”？来自它的插件将不再可见。`,
        title: '移除插件市场',
        tone: 'danger',
      }))
    ) {
      return;
    }
    dependencies.runMutation(
      dependencies.removeMarketplaceOperation(marketplace),
      '正在移除…',
      remove,
    );
  });
  actions.append(remove);

  card.append(header, source, actions);
  return card;
};

export const createPluginsView = (
  elements: PluginsElements,
  state: PluginsState,
  dependencies: PluginsViewDependencies,
): PluginsView => {
  const context = { dependencies, elements, state };
  return {
    renderCatalog: (catalog) => renderPluginCatalog(context, catalog),
    selectTab: selectPluginTab,
  };
};
