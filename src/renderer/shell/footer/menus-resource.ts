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

type FooterResourceUsage = ClaudeProjectState['resourceUsage'] | CodexProjectState['resourceUsage'];

interface FooterResourcePresentation {
  availability: string;
  claudeContextSource: boolean;
  claudeContextStatus: string;
  claudeContextWindowCustomDraftOpen: boolean;
  claudeContextWindowCustomTokens: number | undefined;
  claudeContextWindowMode: string;
  contextWindowSelectable: boolean;
  details: string[];
  label: string;
  level: 'danger' | 'normal' | 'warning';
  managedChatGptContextWindowMode: string;
  percent: number | undefined;
  preference: string;
  title: string;
}

export interface FooterMenusResourceActions {
  renderClaudeContextWindowStatus: (usage: FooterResourceUsage) => void;
  renderFooterResource: (usage: FooterResourceUsage, contextWindowSelectable?: boolean) => void;
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
  let lastPresentationKey = '';

  const claudeContextWindowStatusText = (usage: FooterResourceUsage): string => {
    const requested = requestedClaudeContextWindowTokens();
    const source = usage?.source;
    const hasRuntimeReport = source === 'claude-statusline' || source === 'claude-agent-sdk';
    const lastReported = hasRuntimeReport ? usage?.contextWindowTokens : undefined;
    if (lastReported !== undefined && usage?.availability === 'stale') {
      return requested === undefined
        ? `自动模式；上次上报 ${formatTokenCount(lastReported)}，数据已过期，等待当前会话确认。`
        : `已请求 ${formatTokenCount(requested)}；上次上报 ${formatTokenCount(lastReported)}，数据已过期，尚未确认当前会话。`;
    }
    const reported = usage?.availability === 'available' ? lastReported : undefined;
    if (reported !== undefined) {
      const reportedText = formatTokenCount(reported);
      if (requested === undefined) {
        return `自动模式；当前会话由 Claude Code 上报 ${reportedText}。`;
      }
      if (requested === reported) {
        return `已请求 ${formatTokenCount(requested)}；Claude Code 当前会话已采用。`;
      }
      return `已请求 ${formatTokenCount(requested)}，当前会话上报 ${reportedText}；请重启会话，若仍不一致则当前模型未采用该档位。`;
    }
    return requested === undefined
      ? '自动模式；新会话将由 Claude Code 按模型判定。'
      : `已请求 ${formatTokenCount(requested)}；等待新会话由 Claude Code 上报实际采用值。`;
  };

  const renderClaudeContextWindowStatus = (usage: FooterResourceUsage): void => {
    claudeContextWindowStatus.textContent = claudeContextWindowStatusText(usage);
  };

  const footerResourcePresentation = (
    usage: FooterResourceUsage,
    contextWindowSelectable: boolean,
  ): FooterResourcePresentation => {
    const preference = footerState.footerResourcePreference;
    const context = usage?.contextUsedPercent;
    const window = usage?.windows?.[0];
    const balance = usage?.balance?.balances?.[0];
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
    const details = [
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
    const claudeContextSource =
      usage?.source === 'claude-statusline' ||
      usage?.source === 'claude-agent-sdk' ||
      usage?.source === 'claude-configured-target';
    return {
      availability: usage?.availability ?? 'unavailable',
      claudeContextSource,
      claudeContextStatus: claudeContextWindowStatusText(usage),
      claudeContextWindowCustomDraftOpen: footerState.claudeContextWindowCustomDraftOpen,
      claudeContextWindowCustomTokens: footerState.claudeContextWindowCustomTokens,
      claudeContextWindowMode: footerState.claudeContextWindowMode,
      contextWindowSelectable,
      details: details.length > 0 ? details : ['尚无资源数据。'],
      label: selected.text,
      level: anomaly
        ? 'danger'
        : selected.percent !== undefined && selected.percent >= 85
          ? 'danger'
          : selected.percent !== undefined && selected.percent >= 65
            ? 'warning'
            : 'normal',
      managedChatGptContextWindowMode: footerState.managedChatGptContextWindowMode,
      percent: selected.percent,
      preference,
      title: anomaly
        ? '状态行的输入计数与窗口用量不一致，不能据此判断端点容量'
        : '点击查看上下文、订阅窗口、余额和显示偏好',
    };
  };

  const renderFooterResource = (
    usage: FooterResourceUsage,
    contextWindowSelectable = false,
  ): void => {
    const presentation = footerResourcePresentation(usage, contextWindowSelectable);
    const presentationKey = JSON.stringify(presentation);
    if (presentationKey === lastPresentationKey) return;

    footerContextLabel.textContent = presentation.label;
    footerContextRing.hidden = presentation.percent === undefined;
    footerContextRing.style.setProperty(
      '--context-progress',
      `${clampPercentage(presentation.percent) ?? 0}%`,
    );
    footerContextRing.dataset.level = presentation.level;
    footerResource.dataset.availability = presentation.availability;
    footerResource.title = presentation.title;
    footerResourceDetails.replaceChildren();
    for (const line of presentation.details) {
      const paragraph = document.createElement('p');
      paragraph.textContent = line;
      footerResourceDetails.append(paragraph);
    }
    for (const button of footerResourceMenu.querySelectorAll<HTMLButtonElement>(
      '[data-resource-preference]',
    )) {
      button.setAttribute(
        'aria-checked',
        String(button.dataset.resourcePreference === presentation.preference),
      );
    }
    footerContextWindowOptions.hidden = !presentation.contextWindowSelectable;
    syncManagedChatGptContextWindowSelection();
    // Managed ChatGPT owns its separate 272K / 1.05M profile; never show or apply both selectors.
    claudeContextWindowOptions.hidden =
      presentation.contextWindowSelectable || !presentation.claudeContextSource;
    syncClaudeContextWindowSelection();
    claudeContextWindowStatus.textContent = presentation.claudeContextStatus;
    lastPresentationKey = presentationKey;
  };

  return {
    renderClaudeContextWindowStatus,
    renderFooterResource,
  };
};
