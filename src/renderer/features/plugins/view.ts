import type {
  ClaudePluginCatalog,
  ClaudePluginMarketplaceView,
  ClaudePluginOperationKind,
  ClaudePluginOperationResult,
  ClaudePluginOperationView,
  ClaudePluginView,
} from '../../../shared/contracts';
import { localizePluginCopy } from '../../../shared/ui/plugin-localization';
import type { PluginsElements } from './elements';
import { pluginOperationInProgress, type PluginsState } from './state';

export interface PluginConfirmationRequest {
  confirmLabel?: string;
  message: string;
  title: string;
  tone?: 'danger' | 'default';
}

export interface PluginsViewDependencies {
  formatTokenCount: (value: number | undefined) => string;
  installOperation: (plugin: ClaudePluginView) => () => Promise<ClaudePluginOperationResult>;
  openExternal: (url: string) => Promise<void>;
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
  renderOperationPresentation: () => void;
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

const comparePluginText = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const knownPluginStars = (plugin: ClaudePluginView): number | undefined => {
  const stars = plugin.github?.stars;
  return typeof stars === 'number' && Number.isSafeInteger(stars) && stars >= 0 ? stars : undefined;
};

/** Known star counts sort first; all ties use stable identity text rather than locale collation. */
export const comparePluginsByGithubStars = (
  left: ClaudePluginView,
  right: ClaudePluginView,
): number => {
  const leftStars = knownPluginStars(left);
  const rightStars = knownPluginStars(right);
  if (leftStars !== undefined && rightStars !== undefined && leftStars !== rightStars) {
    return rightStars - leftStars;
  }
  if (leftStars !== undefined && rightStars === undefined) {
    return -1;
  }
  if (leftStars === undefined && rightStars !== undefined) {
    return 1;
  }
  for (const [leftValue, rightValue] of [
    [left.pluginId, right.pluginId],
    [left.marketplaceName, right.marketplaceName],
    [left.name, right.name],
  ] as const) {
    const difference = comparePluginText(leftValue, rightValue);
    if (difference !== 0) {
      return difference;
    }
  }
  return 0;
};

export const sortPluginsByGithubStars = (
  plugins: readonly ClaudePluginView[],
): ClaudePluginView[] => [...plugins].sort(comparePluginsByGithubStars);

const safeGithubRepositoryUri = (value: unknown): string | undefined => {
  if (typeof value !== 'string') {
    return undefined;
  }
  try {
    const uri = new URL(value);
    if (
      uri.protocol !== 'https:' ||
      !/^(?:www\.)?github\.com$/i.test(uri.hostname) ||
      uri.username ||
      uri.password ||
      uri.search ||
      uri.hash
    ) {
      return undefined;
    }
    const segments = uri.pathname.split('/').filter(Boolean);
    if (
      segments.length !== 2 ||
      !/^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,98}[A-Za-z0-9])?$/.test(segments[0] ?? '') ||
      !/^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,98}[A-Za-z0-9])?$/.test(segments[1] ?? '')
    ) {
      return undefined;
    }
    return `https://github.com/${segments[0]!.toLowerCase()}/${segments[1]!.toLowerCase()}`;
  } catch {
    return undefined;
  }
};

const githubProvenanceLabel = (value: ClaudePluginView['github']): string => {
  switch (value?.provenance) {
    case 'live':
      return '实时';
    case 'cached':
      return '缓存';
    case 'built-in':
      return '内置';
    default:
      return '未知';
  }
};

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

const pluginOperationObject = (operation: ClaudePluginOperationView): string => {
  switch (operation.kind) {
    case 'disable':
      return `停用 ${operation.target}`;
    case 'enable':
      return `启用 ${operation.target}`;
    case 'install':
      return `安装 ${operation.target}`;
    case 'marketplace-add':
      return '添加插件市场';
    case 'marketplace-remove':
      return `移除插件市场 ${operation.target}`;
    case 'refresh':
      return '刷新插件市场';
    case 'uninstall':
      return `卸载 ${operation.target}`;
    case 'update':
      return `更新 ${operation.target}`;
    case 'update-all':
      return '更新所有插件';
  }
};

const pluginOperationStatus = (operation: ClaudePluginOperationView): string =>
  operation.phase === 'refreshing'
    ? `正在刷新插件列表以确认“${pluginOperationObject(operation)}”的结果…`
    : `正在${pluginOperationObject(operation)}…`;

const pluginActionButton = (
  { dependencies, state }: PluginsViewContext,
  label: string,
  variant: 'primary' | 'quiet' | 'secondary',
  busyLabel: string,
  operationKind: ClaudePluginOperationKind,
  operationTarget: string,
  operation: () => Promise<ClaudePluginOperationResult>,
): HTMLButtonElement => {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `button button--${variant} button--small`;
  button.dataset.busyLabel = busyLabel;
  button.dataset.pluginOperationKind = operationKind;
  button.dataset.pluginOperationTarget = operationTarget;
  button.textContent = label;
  button.disabled = pluginOperationInProgress(state);
  button.setAttribute('aria-busy', 'false');
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
  const repositoryUri = safeGithubRepositoryUri(plugin.github?.repositoryUri);
  if (plugin.github && repositoryUri) {
    const stars = document.createElement('span');
    stars.className = 'plugin-card__github-stars';
    stars.dataset.provenance = plugin.github.provenance;
    stars.textContent = `★ ${
      knownPluginStars(plugin) === undefined
        ? '暂无'
        : dependencies.formatTokenCount(knownPluginStars(plugin))
    }（${githubProvenanceLabel(plugin.github)}）`;
    const repository = document.createElement('a');
    repository.className = 'plugin-card__category';
    repository.href = repositoryUri;
    repository.rel = 'noopener noreferrer';
    repository.target = '_blank';
    repository.textContent = repositoryUri.slice('https://github.com/'.length);
    repository.title = repositoryUri;
    repository.addEventListener('click', (event) => {
      event.preventDefault();
      void dependencies.openExternal(repositoryUri);
    });
    meta.append(stars, repository);
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
        plugin.enabled ? 'disable' : 'enable',
        plugin.pluginId,
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
          'update',
          plugin.pluginId,
          dependencies.updateOperation(plugin),
        ),
      );
    }
    const uninstall = document.createElement('button');
    uninstall.type = 'button';
    uninstall.className = 'button button--quiet button--small plugin-card__danger';
    uninstall.dataset.busyLabel = '正在卸载…';
    uninstall.dataset.pluginOperationKind = 'uninstall';
    uninstall.dataset.pluginOperationTarget = plugin.pluginId;
    uninstall.textContent = '卸载';
    uninstall.disabled = pluginOperationInProgress(state);
    uninstall.setAttribute('aria-busy', 'false');
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
        'install',
        plugin.pluginId,
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

const renderPluginOperationPresentation = ({ elements, state }: PluginsViewContext): void => {
  const activeOperation = state.catalog?.activeOperation;
  const localMutation = Boolean(state.mutationOperation);
  const refreshing = Boolean(state.refreshOperation) || activeOperation?.kind === 'refresh';
  const busy = pluginOperationInProgress(state);
  const catalogAvailable = state.catalog?.cliAvailable ?? false;
  for (const button of [
    ...elements.installedList.querySelectorAll<HTMLButtonElement>('button'),
    ...elements.availableList.querySelectorAll<HTMLButtonElement>('button'),
    ...elements.marketplaceList.querySelectorAll<HTMLButtonElement>('button'),
  ]) {
    button.disabled = busy;
    if (activeOperation) {
      const ownsOperation =
        button.dataset.pluginOperationKind === activeOperation.kind &&
        button.dataset.pluginOperationTarget === activeOperation.target;
      button.setAttribute('aria-busy', String(ownsOperation));
      if (ownsOperation && button.dataset.busyLabel) {
        button.textContent = button.dataset.busyLabel;
      }
    } else if (!localMutation) {
      button.setAttribute('aria-busy', 'false');
    }
  }

  const addingMarketplace = activeOperation?.kind === 'marketplace-add';
  const updatingAll = activeOperation?.kind === 'update-all';
  elements.marketplaceSource.disabled = busy;
  elements.marketplaceSource.setAttribute('aria-busy', String(busy));
  elements.addMarketplaceButton.disabled = busy || !catalogAvailable;
  elements.addMarketplaceButton.setAttribute('aria-busy', String(addingMarketplace));
  elements.updateAllButton.disabled =
    busy || !catalogAvailable || (state.catalog?.updatesAvailable ?? 0) === 0;
  elements.updateAllButton.setAttribute('aria-busy', String(updatingAll));
  if (activeOperation) {
    elements.addMarketplaceButton.textContent = addingMarketplace ? '正在添加…' : '添加市场';
    elements.updateAllButton.textContent = updatingAll ? '正在更新…' : '更新全部';
  } else if (!localMutation) {
    elements.addMarketplaceButton.textContent = '添加市场';
    elements.updateAllButton.textContent = '更新全部';
  }

  elements.refreshButton.disabled = busy;
  elements.refreshButton.setAttribute('aria-busy', String(refreshing));
  elements.refreshButton.textContent = refreshing ? '正在刷新…' : '检查更新';
  elements.status.setAttribute('aria-busy', String(busy));
  if (activeOperation) {
    elements.status.textContent = pluginOperationStatus(activeOperation);
  } else if (refreshing) {
    elements.status.textContent = '正在刷新插件市场并检查更新…';
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
  const installed = sortPluginsByGithubStars(catalog.installed.filter(matches));
  const installedKeys = new Set(catalog.installed.map(pluginKey));
  const available = sortPluginsByGithubStars(
    catalog.available.filter((plugin) => !installedKeys.has(pluginKey(plugin))).filter(matches),
  );

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
  elements.addMarketplaceButton.disabled =
    pluginOperationInProgress(state) || !catalog.cliAvailable;
  elements.updateAllButton.disabled =
    pluginOperationInProgress(state) || !catalog.cliAvailable || catalog.updatesAvailable === 0;
  renderPluginOperationPresentation(context);
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
  remove.dataset.busyLabel = '正在移除…';
  remove.dataset.pluginOperationKind = 'marketplace-remove';
  remove.dataset.pluginOperationTarget = marketplace.name;
  remove.textContent = '移除市场';
  remove.disabled = pluginOperationInProgress(state);
  remove.setAttribute('aria-busy', 'false');
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
    renderOperationPresentation: () => renderPluginOperationPresentation(context),
    selectTab: selectPluginTab,
  };
};
