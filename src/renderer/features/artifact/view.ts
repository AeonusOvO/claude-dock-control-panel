import {
  SHELL_CSS_VARIABLES,
  TERMINAL_THEMES,
  type TerminalThemeId,
} from '../../../shared/ui/terminal-themes';
import type { ArtifactElements } from './elements';
import type { ArtifactState } from './state';

export interface ArtifactViewDependencies {
  getActiveTheme: () => TerminalThemeId;
}

export interface ArtifactView {
  isDetailsOpen: () => boolean;
  renderNetworkLog: () => void;
  themePayload: () => {
    appearance: 'dark' | 'light';
    variables: Record<string, string>;
  };
}

interface ArtifactViewContext {
  dependencies: ArtifactViewDependencies;
  elements: ArtifactElements;
  state: ArtifactState;
}

const artifactThemePayload = (
  context: ArtifactViewContext,
): {
  appearance: 'dark' | 'light';
  variables: Record<string, string>;
} => {
  const { dependencies } = context;
  const styles = getComputedStyle(document.documentElement);
  return {
    appearance: TERMINAL_THEMES[dependencies.getActiveTheme()].appearance,
    variables: Object.values(SHELL_CSS_VARIABLES).reduce<Record<string, string>>(
      (variables, property) => {
        const value = styles.getPropertyValue(property).trim();
        if (value) {
          variables[property] = value;
        }
        return variables;
      },
      {},
    ),
  };
};

const formatArtifactBytes = (bytes: number | undefined): string => {
  if (bytes === undefined) {
    return '字节数未知';
  }
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
};

const renderArtifactNetworkLog = (context: ArtifactViewContext): void => {
  const { elements, state } = context;
  elements.networkAllowed.checked = state.network.allowed;
  elements.networkLog.replaceChildren();
  const entries = state.network.entries.slice(-100).reverse();
  if (entries.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'artifact-details__empty';
    empty.textContent = '还没有网络请求。内置库不会计入外部联网审计。';
    elements.networkLog.append(empty);
    return;
  }
  for (const entry of entries) {
    const row = document.createElement('li');
    row.className = 'artifact-network-log__item';
    row.dataset.blocked = String(entry.blocked);
    const top = document.createElement('div');
    const method = document.createElement('strong');
    method.textContent = entry.method;
    const status = document.createElement('span');
    status.textContent = entry.blocked
      ? '已拦截'
      : entry.error
        ? '失败'
        : String(entry.status ?? '完成');
    top.append(method, status);
    const url = document.createElement('code');
    url.textContent = entry.url;
    url.title = entry.url;
    const meta = document.createElement('small');
    meta.textContent = `${new Intl.DateTimeFormat('zh-CN', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).format(entry.startedAt)} · ${formatArtifactBytes(entry.responseBytes)}${
      entry.error ? ` · ${entry.error}` : ''
    }`;
    row.append(top, url, meta);
    elements.networkLog.append(row);
  }
};

export const createArtifactView = (
  elements: ArtifactElements,
  state: ArtifactState,
  dependencies: ArtifactViewDependencies,
): ArtifactView => {
  const context: ArtifactViewContext = { dependencies, elements, state };
  return {
    isDetailsOpen: () => elements.detailsButton.getAttribute('aria-expanded') === 'true',
    renderNetworkLog: () => renderArtifactNetworkLog(context),
    themePayload: () => artifactThemePayload(context),
  };
};
