import type { ClaudeLaunchMode } from '../../../shared/contracts';
import { resolveClaudeNativeCommand } from '../../../shared/claude/native-commands';
import type {
  ConversationContentBlock,
  ConversationSnapshot,
} from '../../../shared/conversation/native';
import type { ConversationActions } from './actions';
import type { ConversationElements } from './elements';
import type { ConversationLaunchActionsDependencies } from './launch-dependencies';
import type { ConversationState } from './state';

export interface NativeSlashCommandActions {
  handleNativeSlashCommand: (rawInput: string, snapshot: ConversationSnapshot) => Promise<boolean>;
}

export const createNativeSlashCommandActions = (
  elements: ConversationElements,
  state: ConversationState,
  dependencies: ConversationLaunchActionsDependencies,
  actions: ConversationActions,
  launchNativeClaude: (mode: ClaudeLaunchMode, exactConversationId?: string) => Promise<void>,
  refreshNativeRecoveries: () => Promise<void>,
): NativeSlashCommandActions => {
  const handleNativeSlashCommand = async (
    rawInput: string,
    snapshot: ConversationSnapshot,
  ): Promise<boolean> => {
    const trimmed = rawInput.trim();
    if (!trimmed.startsWith('/')) return false;
    const [invocation = '', ...argumentParts] = trimmed.split(/\s+/);
    const argument = argumentParts.join(' ').trim();
    const command =
      resolveClaudeNativeCommand(trimmed) ??
      snapshot.commands.find((candidate) =>
        [candidate.name, ...candidate.aliases].some(
          (name) => name.toLowerCase() === invocation.toLowerCase(),
        ),
      );
    if (!command || command.mapping === 'unknown') {
      const enterTerminal = await dependencies.requestConfirmation({
        confirmLabel: '进入安全终端',
        message:
          '这是当前 ClaudeDock 尚未识别的新版命令。为避免把控制命令误当普通提示词，它已被拦截；可返回安全终端使用 Claude 原生 TUI。',
        title: `尚未适配 ${invocation}`,
        tone: 'default',
      });
      if (enterTerminal) elements.nativeTerminalToggle.click();
      return true;
    }
    if (command.mapping === 'adapter') return false;
    if (command.mapping === 'terminal-only') {
      const enterTerminal = await dependencies.requestConfirmation({
        confirmLabel: '进入安全终端',
        message: `${command.name} 控制的是 TUI 显示或终端键位，在原生 DOM 对话中不适用。可以返回安全终端继续。`,
        title: `${command.name} 仅适用于安全终端`,
        tone: 'default',
      });
      if (enterTerminal) elements.nativeTerminalToggle.click();
      return true;
    }

    if (command.mapping === 'claudedock') {
      if (['/model', '/effort', '/fast', '/permissions'].includes(command.name)) {
        if (command.name === '/model' && argument)
          await actions.updateNativeControls({ model: argument });
        else if (command.name === '/effort' && argument)
          await actions.updateNativeControls({ effort: argument.toLowerCase() });
        else if (command.name === '/fast' && argument)
          await actions.updateNativeControls({
            fast: !['off', 'false', '0'].includes(argument.toLowerCase()),
          });
        else if (command.name === '/permissions' && argument)
          await actions.updateNativeControls({ permissionMode: argument });
        else if (command.name === '/model') actions.openNativeModelMenu();
        else if (command.name === '/effort') actions.openNativeEffortMenu();
        else if (command.name === '/permissions') actions.openNativeModeMenu();
        else actions.openNativeSpeedMenu();
        return true;
      }
      if (['/context', '/cost', '/status', '/usage', '/usage-credits'].includes(command.name)) {
        dependencies.renderRuntimeActivity();
        dependencies.setRuntimeSummaryOpen(true);
        return true;
      }
      if (command.name === '/theme' || command.name === '/color') {
        dependencies.terminalThemeSelect.focus({ preventScroll: true });
        dependencies.terminalThemeSelect.click();
        return true;
      }
      if (command.name === '/mcp') dependencies.selectRailTab('mcp');
      else if (['/plugin', '/reload-plugins', '/reload-skills'].includes(command.name))
        dependencies.selectRailTab('plugins');
      else dependencies.selectRailTab('connection');
      actions.setNativeConversationVisible(false);
      dependencies.showToast(`${command.name} 已转到 ClaudeDock 的对应管理页面。`);
      return true;
    }

    if (command.name === '/stop') {
      const result = await window.controlPanel.interruptNativeConversation(snapshot.conversationId);
      if (!result.ok) {
        dependencies.showToast(
          dependencies.resultFailureMessage(result, '当前没有可中断的前台轮次。'),
          'error',
        );
      }
      return true;
    }
    if (command.name === '/tasks') {
      dependencies.renderRuntimeActivity();
      dependencies.setRuntimeSummaryOpen(true);
      return true;
    }
    if (command.name === '/resume') {
      if (/^[0-9a-f-]{36}$/i.test(argument)) {
        await launchNativeClaude('resume', argument);
      } else {
        await launchNativeClaude('resume');
      }
      return true;
    }
    if (command.name === '/rename') {
      if (!argument) {
        dependencies.showToast('请输入新的对话名称，例如 /rename 发布前检查。', 'error');
        return true;
      }
      const renamed = await window.controlPanel.renameNativeConversation(
        snapshot.conversationId,
        argument,
      );
      dependencies.showToast(renamed ? `已重命名为“${argument}”。` : '名称没有变化。');
      return true;
    }
    if (command.name === '/copy') {
      const latest = [...snapshot.messages]
        .reverse()
        .find((message) => message.role === 'assistant');
      const text = latest?.blocks
        .filter((block): block is Extract<ConversationContentBlock, { type: 'text' }> =>
          Boolean(block.type === 'text'),
        )
        .map((block) => block.text)
        .join('\n\n');
      if (!text) dependencies.showToast('还没有可复制的助手回复。', 'error');
      else {
        await navigator.clipboard.writeText(text);
        dependencies.showToast('已复制最近一条助手回复。');
      }
      return true;
    }
    if (command.name === '/effort') {
      if (argument) await actions.updateNativeControls({ effort: argument.toLowerCase() });
      else actions.openNativeEffortMenu();
      return true;
    }
    if (command.name === '/plan') {
      await actions.updateNativeControls({ permissionMode: 'plan' });
      if (argument) {
        elements.nativeComposerInput.value = argument;
        actions.resizeNativeComposer();
        elements.nativeComposerInput.focus();
        dependencies.showToast('已进入规划模式；规划目标已放回输入框，确认后手动发送。');
      }
      return true;
    }
    if (command.name === '/clear' || command.name === '/exit') {
      const confirmed = await dependencies.requestConfirmation({
        confirmLabel: command.name === '/clear' ? '结束并新建' : '结束对话',
        message:
          command.name === '/clear'
            ? '当前对话会安全关闭并回到历史，然后创建一个全新的 UUID。'
            : '当前原生对话会安全关闭；历史正文不会删除。',
        title: command.name === '/clear' ? '开始新对话？' : '结束当前对话？',
        tone: 'danger',
      });
      if (!confirmed) return true;
      const result = await window.controlPanel.closeNativeConversation(snapshot.conversationId);
      if (!result.ok) {
        dependencies.showToast(
          dependencies.resultFailureMessage(result, '无法关闭当前对话。'),
          'error',
        );
        return true;
      }
      for (const [sessionId, boundId] of [...state.nativeConversationBySession.entries()]) {
        if (boundId === snapshot.conversationId)
          state.nativeConversationBySession.delete(sessionId);
      }
      state.nativeQueuedMessages.delete(snapshot.conversationId);
      state.nativeQueuedAutoFlush.delete(snapshot.conversationId);
      // The snapshot holds the whole transcript; keeping it after close leaks it for the app's life.
      state.nativeConversationSnapshots.delete(snapshot.conversationId);
      state.activeNativeConversationId = '';
      actions.renderNativeQueuedMessage();
      await refreshNativeRecoveries();
      if (command.name === '/clear') await launchNativeClaude('new');
      else actions.setNativeConversationVisible(false);
      return true;
    }
    return false;
  };

  return {
    handleNativeSlashCommand,
  };
};
