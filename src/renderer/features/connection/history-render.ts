import { requiredElement } from '../../platform/dom';
import {
  GATEWAY_STATE_LABELS,
  formatHistoryTimestamp,
  historyAuthModeLabel,
  historyDisplayName,
  historyProtocolLabel,
  historyRouteLabel,
} from './history-labels';
import type { ConnectionHistoryState } from './history-dependencies';

export const connectionHistoryList = requiredElement<HTMLElement>('#connection-history-list');
const connectionHistoryEmpty = requiredElement<HTMLElement>('#connection-history-empty');
const connectionHistoryCount = requiredElement<HTMLElement>('#connection-history-count');

export interface ConnectionHistoryRenderActions {
  renderConnectionHistory: () => void;
}

export const createConnectionHistoryRenderActions = (
  state: ConnectionHistoryState,
): ConnectionHistoryRenderActions => {
  const renderConnectionHistory = (): void => {
    connectionHistoryList.replaceChildren();
    connectionHistoryEmpty.hidden = state.entries.length > 0;
    connectionHistoryCount.textContent =
      state.entries.length > 0
        ? `${state.entries.length} 条历史配置 · 点击恢复全部参数`
        : '记录曾填写的接口、网关和模型参数，点击即可一键恢复。';

    for (const entry of state.entries) {
      const item = document.createElement('li');
      item.className = 'connection-history__item';
      item.dataset.historyId = entry.id;

      const restore = document.createElement('button');
      restore.className = 'connection-history__restore';
      restore.type = 'button';
      const displayName = historyDisplayName(entry);
      restore.title = `恢复连接：${displayName}`;

      const titleRow = document.createElement('span');
      titleRow.className = 'connection-history__title-row';
      const title = document.createElement('strong');
      title.textContent = displayName;
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
      titleRow.append(title, tags);
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
      remove.title = '删除这条记录';
      remove.setAttribute('aria-label', '删除这条接入记录');
      remove.textContent = '×';

      item.append(restore, remove);
      connectionHistoryList.append(item);
    }
  };

  return { renderConnectionHistory };
};
