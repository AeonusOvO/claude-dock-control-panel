import { requiredElement } from '../../platform/dom';
import {
  GATEWAY_STATE_LABELS,
  formatHistoryTimestamp,
  historyAuthModeLabel,
  historyDisplayName,
  historyProtocolLabel,
  historyRouteLabel,
} from './history-labels';
import {
  CONNECTION_MODEL_SOURCE_LABELS,
  filterConnectionHistoryBySource,
  type ConnectionModelSource,
} from './history-source';
import type { ClaudeConnectionHistoryEntry } from '../../../shared/contracts';
import type { ConnectionHistoryState } from './history-dependencies';

export const CONNECTION_HISTORY_SOURCES: readonly ConnectionModelSource[] = [
  'claude-subscription',
  'chatgpt-subscription',
  'domestic',
  'api',
];

export const connectionHistoryList = requiredElement<HTMLElement>('#connection-history-list');
const connectionHistoryEmpty = requiredElement<HTMLElement>('#connection-history-empty');
const connectionHistoryCount = requiredElement<HTMLElement>('#connection-history-count');
const connectionHistoryDialogSummary = requiredElement<HTMLElement>(
  '#connection-history-dialog-summary',
);
const connectionHistoryDialogSelection = requiredElement<HTMLElement>(
  '#connection-history-dialog-selection',
);
const finishConnectionHistoryButton = requiredElement<HTMLButtonElement>(
  '#finish-connection-history',
);

const dialogLists = new Map(
  CONNECTION_HISTORY_SOURCES.map((source) => [
    source,
    requiredElement<HTMLElement>(`[data-history-dialog-list="${source}"]`),
  ]),
);
const dialogEmptyStates = new Map(
  CONNECTION_HISTORY_SOURCES.map((source) => [
    source,
    requiredElement<HTMLElement>(`[data-history-dialog-empty="${source}"]`),
  ]),
);
const dialogCounts = new Map(
  CONNECTION_HISTORY_SOURCES.map((source) => [
    source,
    requiredElement<HTMLElement>(`[data-history-dialog-count="${source}"]`),
  ]),
);

export const connectionHistoryInteractionRoots: readonly HTMLElement[] = [
  connectionHistoryList,
  ...dialogLists.values(),
];

const createHistoryItem = (
  entry: ClaudeConnectionHistoryEntry,
  mutationInProgress: boolean,
  selectedEntryId: string,
): HTMLLIElement => {
  const item = document.createElement('li');
  item.className = 'connection-history__item';
  item.dataset.historyId = entry.id;
  const selected = selectedEntryId === entry.id;
  item.dataset.selected = String(selected);

  const restore = document.createElement('button');
  restore.className = 'connection-history__restore';
  restore.type = 'button';
  restore.disabled = mutationInProgress;
  restore.setAttribute('aria-pressed', String(selected));
  const displayName = historyDisplayName(entry);
  restore.title = `选择配置：${displayName}`;

  const titleRow = document.createElement('span');
  titleRow.className = 'connection-history__title-row';
  const title = document.createElement('strong');
  title.textContent = displayName;
  const selectedMark = document.createElement('span');
  selectedMark.className = 'connection-history__selected-mark';
  selectedMark.setAttribute('aria-hidden', 'true');
  selectedMark.textContent = '✓';
  const tags = document.createElement('span');
  tags.className = 'connection-history__tags';
  const protocolTag = document.createElement('span');
  protocolTag.className = 'connection-history__tag';
  protocolTag.dataset.protocol = entry.protocol;
  protocolTag.textContent = historyProtocolLabel(entry.protocol);
  const routeTag = document.createElement('span');
  routeTag.className = 'connection-history__tag connection-history__tag--route';
  routeTag.textContent = historyRouteLabel(entry);
  tags.append(protocolTag, routeTag);
  titleRow.append(title, tags, selectedMark);

  const parameters = document.createElement('span');
  parameters.className = 'connection-history__parameters';
  const appendParameter = (labelText: string, valueText: string): void => {
    const parameter = document.createElement('span');
    parameter.className = 'connection-history__parameter';
    const label = document.createElement('span');
    label.textContent = labelText;
    const value = document.createElement('code');
    value.textContent = valueText;
    parameter.append(label, value);
    parameters.append(parameter);
  };
  const displayedBaseUrl = entry.sourceBaseUrl ?? entry.baseUrl;
  const displayedModel = entry.sourceModel ?? entry.model;
  const displayedModelFast = entry.sourceModelFast ?? entry.modelFast ?? displayedModel;
  appendParameter('接口 / 网关', displayedBaseUrl || 'Anthropic 官方端点');
  if (entry.protocol === 'openai' && entry.baseUrl !== displayedBaseUrl) {
    appendParameter('本地转换', entry.baseUrl);
  } else if (entry.gatewayEndpoint && entry.gatewayEndpoint !== displayedBaseUrl) {
    appendParameter('检测网关', entry.gatewayEndpoint);
  }
  appendParameter('主模型', displayedModel || '默认模型');
  appendParameter('小型/备用模型', displayedModelFast || displayedModel || '跟随主模型');

  const meta = document.createElement('span');
  meta.className = 'connection-history__meta';
  meta.textContent = [
    formatHistoryTimestamp(entry.savedAt),
    historyAuthModeLabel(entry.sourceAuthMode ?? entry.authMode),
    (entry.sourceCredentialConfigured ?? entry.credentialConfigured) ? '含凭据' : '无凭据',
    entry.apiKeyHelperPolicy === 'inherit' ? '保留 apiKeyHelper' : 'ClaudeDock 单一凭据',
    GATEWAY_STATE_LABELS[entry.gatewayState],
  ].join(' · ');
  restore.append(titleRow, parameters, meta);

  const remove = document.createElement('button');
  remove.className = 'connection-history__delete';
  remove.type = 'button';
  remove.disabled = mutationInProgress;
  remove.title = '删除这条记录';
  remove.setAttribute('aria-label', '删除这条接入记录');
  remove.textContent = '×';
  item.append(restore, remove);
  return item;
};

const renderList = (
  list: HTMLElement,
  entries: readonly ClaudeConnectionHistoryEntry[],
  mutationInProgress: boolean,
  selectedEntryId: string,
): void => {
  list.replaceChildren(
    ...entries.map((entry) => createHistoryItem(entry, mutationInProgress, selectedEntryId)),
  );
  list.setAttribute('aria-busy', String(mutationInProgress));
};

export interface ConnectionHistoryRenderActions {
  renderConnectionHistory: () => void;
  setConnectionHistoryBusy: (busy: boolean) => void;
}

export const createConnectionHistoryRenderActions = (
  state: ConnectionHistoryState,
): ConnectionHistoryRenderActions => {
  const setConnectionHistoryBusy = (busy: boolean): void => {
    for (const root of connectionHistoryInteractionRoots) {
      root.setAttribute('aria-busy', String(busy));
      for (const button of root.querySelectorAll<HTMLButtonElement>('button')) {
        button.disabled = busy;
      }
    }
    finishConnectionHistoryButton.disabled = busy;
    finishConnectionHistoryButton.setAttribute('aria-busy', String(busy));
  };

  const renderConnectionHistory = (): void => {
    renderList(
      connectionHistoryList,
      state.entries,
      state.mutationInProgress,
      state.selectedEntryId,
    );
    connectionHistoryEmpty.hidden = state.entries.length > 0;
    const selectedLabel = state.selectedSource
      ? CONNECTION_MODEL_SOURCE_LABELS[state.selectedSource]
      : undefined;
    connectionHistoryEmpty.textContent = selectedLabel
      ? `还没有${selectedLabel}历史配置；完成一次保存后会显示在这里。`
      : '选择模型来源后，这里只显示同类历史配置。';
    connectionHistoryCount.textContent = selectedLabel
      ? state.entries.length > 0
        ? `${selectedLabel} · ${state.entries.length} 条历史配置 · 点击恢复全部参数`
        : `只显示${selectedLabel}的历史配置。`
      : '记录仍完整保留，可从右上角“接入历史记录”分类查看。';

    for (const source of CONNECTION_HISTORY_SOURCES) {
      const sourceEntries = filterConnectionHistoryBySource(state.allEntries, source);
      const list = dialogLists.get(source);
      const empty = dialogEmptyStates.get(source);
      const count = dialogCounts.get(source);
      if (!list || !empty || !count) continue;
      renderList(list, sourceEntries, state.mutationInProgress, state.selectedEntryId);
      list.hidden = sourceEntries.length === 0;
      empty.hidden = sourceEntries.length > 0;
      count.textContent = `${sourceEntries.length} 条`;
    }
    connectionHistoryDialogSummary.textContent = `当前项目共 ${state.allEntries.length} 条接入记录`;
    const selectedEntry = state.allEntries.find((entry) => entry.id === state.selectedEntryId);
    connectionHistoryDialogSelection.hidden = !selectedEntry;
    connectionHistoryDialogSelection.textContent = selectedEntry
      ? `当前选择：${historyDisplayName(selectedEntry)}`
      : '';
    finishConnectionHistoryButton.dataset.mode = selectedEntry ? 'confirm' : 'cancel';
    finishConnectionHistoryButton.textContent = selectedEntry ? '完成' : '取消';
    finishConnectionHistoryButton.classList.toggle('button--primary', Boolean(selectedEntry));
    finishConnectionHistoryButton.classList.toggle('button--quiet', !selectedEntry);
    finishConnectionHistoryButton.disabled = state.mutationInProgress;
    finishConnectionHistoryButton.setAttribute('aria-busy', String(state.mutationInProgress));
  };

  return { renderConnectionHistory, setConnectionHistoryBusy };
};
