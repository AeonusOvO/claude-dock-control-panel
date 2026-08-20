import type { ClaudeSessionMetadata, TerminalStatus } from '../../../shared/contracts';
import type { ProjectsRowHandlers, ProjectsRowsDependencies } from './rows-dependencies';
import type { ProjectsTitleView } from './view';

export interface ProjectsRowItemsActions {
  renderConversationRow: (status: TerminalStatus) => HTMLElement;
  renderHistoryRow: (projectPath: string, session: ClaudeSessionMetadata) => HTMLElement;
}

export const createProjectsRowItemsActions = (
  dependencies: ProjectsRowsDependencies,
  handlers: ProjectsRowHandlers,
  titleView: ProjectsTitleView,
): ProjectsRowItemsActions => {
  const renderConversationRow = (status: TerminalStatus): HTMLElement => {
    const row = document.createElement('div');
    row.className = 'conversation-item';
    row.dataset.active = String(status.id === dependencies.getWorkspaceState().activeSessionId);
    row.dataset.phase = status.phase;
    row.dataset.sessionId = status.id;

    const selectButton = document.createElement('button');
    selectButton.className = 'conversation-item__select';
    selectButton.type = 'button';
    selectButton.title = `${status.title} · ${status.cwd}`;
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
    phaseText.textContent = dependencies.phaseCopy[status.phase].pill;

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
    renameButton.addEventListener('click', () => {
      void handlers.renameConversation(status);
    });
    row.addEventListener('contextmenu', (event) => {
      handlers.showConversationContextMenu(event, { kind: 'running', status });
    });

    const closeButton = document.createElement('button');
    closeButton.className = 'conversation-item__action conversation-item__action--close';
    closeButton.type = 'button';
    closeButton.textContent = '×';
    closeButton.title = `关闭并归档 ${status.title}`;
    closeButton.setAttribute('aria-label', `关闭对话 ${status.title}，归档到历史对话`);
    closeButton.addEventListener('click', () => {
      void handlers.closeProject(status);
    });

    row.append(selectButton, renameButton, closeButton);
    return row;
  };

  const renderHistoryRow = (projectPath: string, session: ClaudeSessionMetadata): HTMLElement => {
    const row = document.createElement('div');
    row.className = 'history-item';
    row.setAttribute('role', 'listitem');
    row.title = `恢复或删除历史对话：${session.sessionId}`;
    const selectButton = document.createElement('button');
    selectButton.className = 'history-item__select';
    selectButton.type = 'button';
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
      handlers.showConversationContextMenu(event, { kind: 'history', projectPath, session });
    });
    return row;
  };

  return {
    renderConversationRow,
    renderHistoryRow,
  };
};
