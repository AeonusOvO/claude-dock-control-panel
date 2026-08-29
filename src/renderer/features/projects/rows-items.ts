import type { ClaudeSessionMetadata, TerminalStatus } from '../../../shared/contracts';
import type { ProjectsRowHandlers, ProjectsRowsDependencies } from './rows-dependencies';
import type { ProjectsTitleView } from './view';
import type { PendingConversation, ProjectsState } from './state';
import { isConversationClosing, isProjectClosing } from './state';

export interface ProjectsRowItemsActions {
  renderConversationRow: (status: TerminalStatus) => HTMLElement;
  renderHistoryRow: (projectPath: string, session: ClaudeSessionMetadata) => HTMLElement;
  renderPendingConversationRow: (pending: PendingConversation) => HTMLElement;
}

export const createProjectsRowItemsActions = (
  state: ProjectsState,
  dependencies: ProjectsRowsDependencies,
  handlers: ProjectsRowHandlers,
  titleView: ProjectsTitleView,
): ProjectsRowItemsActions => {
  const renderConversationRow = (status: TerminalStatus): HTMLElement => {
    const transition = state.transitioningConversations.get(status.id);
    const transitionFailure = state.failedConversationTransitions.get(status.id);
    const closing = isConversationClosing(state, status);
    const row = document.createElement('div');
    row.className = 'conversation-item';
    row.dataset.active = String(status.id === dependencies.getWorkspaceState().activeSessionId);
    row.dataset.phase = transitionFailure ? 'error' : status.phase;
    row.dataset.sessionId = status.id;
    row.dataset.closing = String(closing);
    row.setAttribute('aria-busy', String(closing || Boolean(transition)));
    if (transition) row.dataset.transition = transition;
    if (transitionFailure) row.dataset.transitionFailure = transitionFailure;

    const selectButton = document.createElement('button');
    selectButton.className = 'conversation-item__select';
    selectButton.type = 'button';
    selectButton.title = `${status.title} · ${status.cwd}`;
    selectButton.disabled = closing;
    selectButton.setAttribute(
      'aria-pressed',
      String(status.id === dependencies.getWorkspaceState().activeSessionId),
    );

    const indicator = document.createElement('span');
    indicator.className = 'conversation-item__status';
    indicator.setAttribute('aria-hidden', 'true');

    const label = document.createElement('span');
    label.className = 'conversation-item__label';
    label.textContent = titleView.displayedConversationTitle(status);
    label.dataset.titleTyping = String(titleView.isTitleAnimating(status.id));

    const phaseText = document.createElement('span');
    phaseText.className = 'conversation-item__phase';
    phaseText.textContent = closing
      ? '正在关闭并归档…'
      : transitionFailure
        ? transitionFailure === 'restoring'
          ? '恢复失败 · 请关闭'
          : '创建失败 · 请关闭'
        : transition
          ? (state.transitionProgress.get(status.id) ??
            (transition === 'restoring' ? '正在恢复…' : '正在新建…'))
          : dependencies.phaseCopy[status.phase].pill;
    if (transition) {
      phaseText.setAttribute('role', 'status');
      phaseText.setAttribute('aria-live', 'polite');
      phaseText.setAttribute('aria-atomic', 'true');
    }

    selectButton.append(indicator, label, phaseText);
    selectButton.addEventListener('click', () => {
      void handlers.activateProject(status.id);
    });

    const renameButton = document.createElement('button');
    renameButton.className = 'conversation-item__action';
    renameButton.type = 'button';
    renameButton.textContent = '✎';
    renameButton.title = `重命名 ${status.title}`;
    renameButton.setAttribute('aria-label', `重命名对话 ${status.title}`);
    renameButton.disabled = Boolean(closing || transition || transitionFailure);
    renameButton.addEventListener('click', () => {
      void handlers.renameConversation(status);
    });
    row.addEventListener('contextmenu', (event) => {
      if (closing || transition || transitionFailure) {
        event.preventDefault();
        return;
      }
      handlers.showConversationContextMenu(event, { kind: 'running', status });
    });

    const closeButton = document.createElement('button');
    closeButton.className = 'conversation-item__action conversation-item__action--close';
    closeButton.type = 'button';
    closeButton.textContent = '×';
    closeButton.title = closing
      ? '正在关闭并归档，请稍候'
      : transitionFailure
        ? `移除失败的临时会话 ${status.title}`
        : `关闭并归档 ${status.title}`;
    closeButton.setAttribute(
      'aria-label',
      transitionFailure
        ? `移除失败的临时会话 ${status.title}`
        : `关闭对话 ${status.title}，归档到历史对话`,
    );
    closeButton.disabled = Boolean(closing || transition);
    closeButton.addEventListener('click', () => {
      void handlers.closeProject(status);
    });

    row.append(selectButton, renameButton, closeButton);
    return row;
  };

  const renderHistoryRow = (projectPath: string, session: ClaudeSessionMetadata): HTMLElement => {
    const closing = isProjectClosing(state, projectPath);
    const row = document.createElement('div');
    row.className = 'history-item';
    row.setAttribute('role', 'listitem');
    row.title = `恢复或删除历史对话：${session.sessionId}`;
    const selectButton = document.createElement('button');
    selectButton.className = 'history-item__select';
    selectButton.type = 'button';
    selectButton.disabled = closing;
    selectButton.setAttribute(
      'aria-label',
      `恢复历史对话 ${session.sessionName || session.sessionId.slice(0, 8)}`,
    );

    const icon = document.createElement('span');
    icon.className = 'history-item__icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = '⏱';

    const label = document.createElement('span');
    label.className = 'history-item__label';
    label.textContent = session.sessionName || session.sessionId.slice(0, 8);

    const time = document.createElement('span');
    time.className = 'history-item__time';
    time.textContent = dependencies.formatRelativeTime(session.lastActiveAt);

    selectButton.append(icon, label, time);
    selectButton.addEventListener('click', () => {
      void handlers.resumeStoredConversation(projectPath, session);
    });
    const deleteButton = document.createElement('button');
    deleteButton.className = 'history-item__delete';
    deleteButton.type = 'button';
    deleteButton.disabled = closing;
    deleteButton.textContent = '×';
    deleteButton.title = '删除历史对话';
    deleteButton.setAttribute(
      'aria-label',
      `删除历史对话 ${session.sessionName || session.sessionId.slice(0, 8)}`,
    );
    deleteButton.addEventListener('click', () => {
      void handlers.deleteStoredConversation(projectPath, session);
    });
    row.append(selectButton, deleteButton);
    row.addEventListener('contextmenu', (event) => {
      if (closing) {
        event.preventDefault();
        return;
      }
      handlers.showConversationContextMenu(event, { kind: 'history', projectPath, session });
    });
    return row;
  };

  const renderPendingConversationRow = (pending: PendingConversation): HTMLElement => {
    const row = document.createElement('div');
    row.className = 'conversation-item conversation-item--pending';
    row.dataset.pendingId = pending.id;
    row.dataset.phase = pending.phase;
    row.setAttribute('role', 'status');
    row.setAttribute('aria-live', 'polite');

    const content = document.createElement('div');
    content.className = 'conversation-item__select';

    const indicator = document.createElement('span');
    indicator.className = 'conversation-item__status';
    indicator.setAttribute('aria-hidden', 'true');

    const label = document.createElement('span');
    label.className = 'conversation-item__label';
    label.textContent = pending.title;

    const phaseText = document.createElement('span');
    phaseText.className = 'conversation-item__phase';
    phaseText.textContent =
      pending.phase === 'queued'
        ? `排队中${pending.queuePosition ? ` · 第 ${pending.queuePosition} 位` : ''}`
        : pending.progressLabel;

    content.append(indicator, label, phaseText);
    if (pending.phase === 'queued' && pending.cancel) {
      const cancelButton = document.createElement('button');
      cancelButton.className = 'conversation-item__action conversation-item__action--close';
      cancelButton.type = 'button';
      cancelButton.textContent = '×';
      cancelButton.title = `取消排队 ${pending.title}`;
      cancelButton.setAttribute('aria-label', `取消排队中的${pending.title}`);
      cancelButton.addEventListener('click', () => {
        pending.cancel?.();
      });
      row.append(content, cancelButton);
    } else {
      row.append(content);
    }
    return row;
  };

  return {
    renderConversationRow,
    renderHistoryRow,
    renderPendingConversationRow,
  };
};
