import { clampPercentage } from '../../platform/percentage-utils';
import type { ClaudeProjectState, CodexProjectState } from '../../../shared/contracts';
import type { FooterMenusContextWindowActions } from './menus-context-window';
import type { FooterMenusDeps } from './menus-dependencies';
import type { FooterMenusFormatActions } from './menus-format';
import {
  claudeContextWindowOptions,
  claudeContextWindowStatus,
  footerContextLabel,
  footerContextRing,
  footerContextWindowOptions,
  footerResource,
  footerResourceDetails,
  footerResourceMenu,
} from './elements';
import { footerState } from './state';

export interface FooterMenusResourceActions {
  renderClaudeContextWindowStatus: (
    usage: ClaudeProjectState['resourceUsage'] | CodexProjectState['resourceUsage'],
  ) => void;
  renderFooterResource: (
    usage: ClaudeProjectState['resourceUsage'] | CodexProjectState['resourceUsage'],
    contextWindowSelectable?: boolean,
  ) => void;
}

export const createFooterMenusResourceActions = (
  deps: FooterMenusDeps,
  formatActions: FooterMenusFormatActions,
  contextWindowActions: FooterMenusContextWindowActions,
): FooterMenusResourceActions => {
  const { formatTokenCount } = deps;
  const { formatResourceAmount, formatResetTime, resourceSourceLabel } = formatActions;
  const { syncManagedChatGptContextWindowSelection, syncClaudeContextWindowSelection } =
    contextWindowActions;
  const { requestedClaudeContextWindowTokens } = contextWindowActions;

  const renderClaudeContextWindowStatus = (
    usage: ClaudeProjectState['resourceUsage'] | CodexProjectState['resourceUsage'],
  ): void => {
    const requested = requestedClaudeContextWindowTokens();
    const source = usage?.source;
    const hasRuntimeReport = source === 'claude-statusline' || source === 'claude-agent-sdk';
    const lastReported = hasRuntimeReport ? usage?.contextWindowTokens : undefined;
    if (lastReported !== undefined && usage?.availability === 'stale') {
      claudeContextWindowStatus.textContent =
        requested === undefined
          ? `自动模式；上次上报 ${formatTokenCount(lastReported)}，数据已过期，等待当前会话确认。`
          : `已请求 ${formatTokenCount(requested)}；上次上报 ${formatTokenCount(lastReported)}，数据已过期，尚未确认当前会话。`;
      return;
    }
    const reported = usage?.availability === 'available' ? lastReported : undefined;
    if (reported !== undefined) {
      const reportedText = formatTokenCount(reported);
      if (requested === undefined) {
        claudeContextWindowStatus.textContent = `自动模式；当前会话由 Claude Code 上报 ${reportedText}。`;
      } else if (requested === reported) {
        claudeContextWindowStatus.textContent = `已请求 ${formatTokenCount(requested)}；Claude Code 当前会话已采用。`;
      } else {
        claudeContextWindowStatus.textContent = `已请求 ${formatTokenCount(requested)}，当前会话上报 ${reportedText}；请重启会话，若仍不一致则当前模型未采用该档位。`;
      }
      return;
    }
    claudeContextWindowStatus.textContent =
      requested === undefined
        ? '自动模式；新会话将由 Claude Code 按模型判定。'
        : `已请求 ${formatTokenCount(requested)}；等待新会话由 Claude Code 上报实际采用值。`;
  };

  const renderFooterResource = (
    usage: ClaudeProjectState['resourceUsage'] | CodexProjectState['resourceUsage'],
    contextWindowSelectable = false,
  ): void => {
    const preference = footerState.footerResourcePreference;
    const context = usage?.contextUsedPercent;
    const window = usage?.windows?.[0];
    const balance = usage?.balance?.balances?.[0];
    // Clamp all percentages to 0-100 range for display
    const clampedContext = clampPercentage(context);
    const clampedWindowPercent = clampPercentage(window?.usedPercent);
    const quotaText =
      clampedWindowPercent === undefined ? undefined : `额度 ${clampedWindowPercent.toFixed(0)}%`;
    const contextText =
      clampedContext === undefined ? undefined : `上下文 ${clampedContext.toFixed(0)}%`;
    const anomaly = usage?.contextCountingAnomaly;
    const balanceText = balance
      ? `余额 ${formatResourceAmount(balance.amount, balance.currency)}`
      : undefined;
    const selected =
      usage?.availability === 'stale'
        ? { percent: clampedWindowPercent ?? clampedContext, text: '资源 已过期' }
        : usage?.availability === 'unavailable'
          ? { percent: undefined, text: '资源 不可用' }
          : preference === 'context'
            ? {
                percent: clampedContext ?? clampedWindowPercent,
                text: contextText ?? quotaText ?? balanceText ?? '资源 —',
              }
            : {
                percent: clampedWindowPercent ?? clampedContext,
                text: quotaText ?? balanceText ?? contextText ?? '资源 —',
              };
    footerContextLabel.textContent = selected.text;
    footerContextRing.hidden = selected.percent === undefined;
    const clampedPercent = clampPercentage(selected.percent) ?? 0;
    footerContextRing.style.setProperty('--context-progress', `${clampedPercent}%`);
    footerContextRing.dataset.level = anomaly
      ? 'danger'
      : selected.percent !== undefined && selected.percent >= 85
        ? 'danger'
        : selected.percent !== undefined && selected.percent >= 65
          ? 'warning'
          : 'normal';
    footerResource.dataset.availability = usage?.availability ?? 'unavailable';
    footerResource.title = anomaly
      ? '状态行的输入计数与窗口用量不一致，不能据此判断端点容量'
      : '点击查看上下文、订阅窗口、余额和显示偏好';
    footerResourceDetails.replaceChildren();
    const lines = [
      anomaly
        ? `⚠ 计数异常：CLI 原始输入计数为 ${formatTokenCount(anomaly.reportedTokens)}，窗口用量按 ${formatTokenCount(anomaly.windowTokens)} 钳制；这只说明计数或配置不一致。`
        : undefined,
      usage?.contextUsedTokens === undefined || usage.contextWindowTokens === undefined
        ? contextText
        : `上下文：${formatTokenCount(usage.contextUsedTokens)} / ${formatTokenCount(usage.contextWindowTokens)}（${clampedContext?.toFixed(1) ?? '—'}%）`,
      usage?.autoCompactAtTokens === undefined
        ? undefined
        : `自动压缩线：约 ${formatTokenCount(usage.autoCompactAtTokens)}`,
      ...(usage?.windows ?? []).map((item) => {
        const clampedItemPercent = clampPercentage(item.usedPercent);
        return `${item.label}：${clampedItemPercent === undefined ? '缺失' : `已用 ${clampedItemPercent.toFixed(0)}%`} · ${formatResetTime(item.resetsAt)}`;
      }),
      ...(usage?.balance?.balances ?? []).map(
        (item) => `余额：${formatResourceAmount(item.amount, item.currency)}`,
      ),
      usage?.balance?.used === undefined
        ? undefined
        : `累计用量：$${usage.balance.used.toFixed(2)}`,
      usage?.detail,
      usage ? `来源：${resourceSourceLabel(usage.source)}` : undefined,
    ].filter((line): line is string => Boolean(line));
    for (const line of lines.length > 0 ? lines : ['尚无资源数据。']) {
      const paragraph = document.createElement('p');
      paragraph.textContent = line;
      footerResourceDetails.append(paragraph);
    }
    for (const button of footerResourceMenu.querySelectorAll<HTMLButtonElement>(
      '[data-resource-preference]',
    )) {
      button.setAttribute('aria-checked', String(button.dataset.resourcePreference === preference));
    }
    footerContextWindowOptions.hidden = !contextWindowSelectable;
    syncManagedChatGptContextWindowSelection();
    const claudeContextSource =
      usage?.source === 'claude-statusline' ||
      usage?.source === 'claude-agent-sdk' ||
      usage?.source === 'claude-configured-target';
    // Managed ChatGPT owns its separate 272K / 1.05M profile; never show or apply both selectors.
    claudeContextWindowOptions.hidden = contextWindowSelectable || !claudeContextSource;
    syncClaudeContextWindowSelection();
    renderClaudeContextWindowStatus(usage);
  };

  return {
    renderClaudeContextWindowStatus,
    renderFooterResource,
  };
};
