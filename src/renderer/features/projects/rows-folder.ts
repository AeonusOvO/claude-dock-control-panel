import type { WorkspaceProjectView } from '../../../shared/contracts';
import type { ProjectsState } from './state';
import { storedConversationRestoreKey } from './state';
import type { ProjectsRowHandlers, ProjectsRowsDependencies } from './rows-dependencies';
import type { ProjectsRowItemsActions } from './rows-items';

export interface ProjectsRowFolderActions {
  renderProjectFolder: (project: WorkspaceProjectView) => HTMLElement;
}

export const createProjectsRowFolderActions = (
  state: ProjectsState,
  dependencies: ProjectsRowsDependencies,
  handlers: ProjectsRowHandlers,
  itemsActions: ProjectsRowItemsActions,
  renderProjectList: () => void,
): ProjectsRowFolderActions => {
  const { renderConversationRow, renderHistoryRow, renderPendingConversationRow } = itemsActions;

  const renderProjectFolder = (project: WorkspaceProjectView): HTMLElement => {
    const key = project.path.toLowerCase();
    const sessions = dependencies
      .getWorkspaceState()
      .sessions.filter((session) => project.sessionIds.includes(session.id));
    const pendingConversations = [...state.pendingConversations.values()].filter(
      (pending) => pending.projectPath.toLowerCase() === key,
    );
    const containsActive = project.sessionIds.includes(
      dependencies.getWorkspaceState().activeSessionId,
    );
    /*
     * Expansion only governs the history section. Running conversations always stay visible, so a
     * folder that is in use can still be collapsed — collapsing it tucks the history away and keeps
     * the live rows. Before, an active folder was forced open and its disclosure did nothing.
     */
    const expanded = state.expandedFolders.has(key);
    const showsRunning = sessions.length + pendingConversations.length > 0;

    const folder = document.createElement('section');
    folder.className = 'project-folder';
    folder.dataset.open = String(project.open);
    folder.dataset.expanded = String(expanded);
    folder.dataset.missing = String(project.missing);
    folder.dataset.active = String(containsActive);

    const header = document.createElement('div');
    header.className = 'project-folder__header';

    const disclosure = document.createElement('button');
    disclosure.className = 'project-folder__disclosure';
    disclosure.type = 'button';
    disclosure.setAttribute('aria-expanded', String(expanded));
    disclosure.title = project.path;

    const chevron = document.createElement('span');
    chevron.className = 'project-folder__chevron';
    chevron.setAttribute('aria-hidden', 'true');
    chevron.textContent = '▸';

    const copy = document.createElement('span');
    copy.className = 'project-folder__copy';
    const name = document.createElement('strong');
    name.textContent = project.name;
    const detail = document.createElement('span');
    detail.textContent = project.missing
      ? '文件夹已不存在'
      : project.open
        ? pendingConversations.length > 0
          ? `${sessions.length + pendingConversations.length} 个对话 · ${pendingConversations.length} 个正在准备`
          : `${sessions.length} 个对话进行中`
        : project.lastActiveAt
          ? `上次使用 ${dependencies.formatRelativeTime(project.lastActiveAt)}`
          : '已记住，未打开';
    copy.append(name, detail);

    disclosure.append(chevron, copy);
    disclosure.addEventListener('click', () => {
      if (expanded) {
        state.expandedFolders.delete(key);
      } else {
        state.expandedFolders.add(key);
        if (!project.missing) {
          void handlers.loadFolderHistory(project.path);
        }
      }
      renderProjectList();
    });

    const actions = document.createElement('div');
    actions.className = 'project-folder__actions';

    const newConversation = document.createElement('button');
    newConversation.className = 'project-folder__action';
    newConversation.type = 'button';
    newConversation.textContent = '+';
    newConversation.title = `在 ${project.name} 里新开一个对话`;
    newConversation.setAttribute('aria-label', `在 ${project.name} 里新开一个对话`);
    newConversation.disabled = project.missing;
    newConversation.addEventListener('click', () => {
      state.expandedFolders.add(key);
      void handlers.openConversation(project.path);
    });
    actions.append(newConversation);

    const removeButton = document.createElement('button');
    removeButton.className = 'project-folder__action project-folder__action--close';
    removeButton.type = 'button';
    removeButton.textContent = '×';
    removeButton.title = project.open
      ? `关闭 ${project.name} 的所有对话`
      : `从列表中移除 ${project.name}`;
    removeButton.setAttribute('aria-label', removeButton.title);
    removeButton.addEventListener('click', () => {
      void (project.open ? handlers.closeProjectFolder(project) : handlers.forgetProject(project));
    });
    actions.append(removeButton);

    header.append(disclosure, actions);
    folder.append(header);

    if (!expanded && !showsRunning) {
      return folder;
    }

    const body = document.createElement('div');
    body.className = 'project-folder__body';

    for (const session of sessions) {
      body.append(renderConversationRow(session));
    }
    for (const pending of pendingConversations) {
      body.append(renderPendingConversationRow(pending));
    }

    if (!expanded) {
      // Collapsed while in use: live conversations stay, the history section is tucked away.
      folder.append(body);
      return folder;
    }

    if (sessions.length === 0 && pendingConversations.length === 0) {
      const reopen = document.createElement('button');
      reopen.className = 'project-folder__reopen';
      reopen.type = 'button';
      reopen.textContent = project.missing ? '文件夹已不存在，可从列表中移除' : '打开一个新对话';
      reopen.disabled = project.missing;
      reopen.addEventListener('click', () => {
        void handlers.openConversation(project.path);
      });
      body.append(reopen);
    }

    // Optimistic moves are an overlay, never a rewrite/rollback of the shared history cache.
    const history = state.storedConversations.get(key)?.filter((conversation) => {
      const restoreKey = storedConversationRestoreKey(project.path, conversation.conversationId);
      return (
        !state.storedConversationRestores.has(restoreKey) &&
        !state.restoredConversationSessions.has(restoreKey)
      );
    });
    if (history === undefined && !project.missing && state.folderHistoryLoads.hasFailed(key)) {
      // A failed read is never rendered as "no history": that is indistinguishable from an empty
      // folder and would quietly hide the user's real conversations.
      const failure = document.createElement('span');
      failure.className = 'project-folder__hint';
      failure.textContent = '读取历史对话失败。';
      body.append(failure);

      const retry = document.createElement('button');
      retry.className = 'project-folder__reopen';
      retry.type = 'button';
      retry.textContent = '重试读取历史对话';
      retry.addEventListener('click', () => {
        void handlers.loadFolderHistory(project.path, true);
      });
      body.append(retry);
    } else if (history === undefined && !project.missing) {
      void handlers.loadFolderHistory(project.path);
      const loading = document.createElement('span');
      loading.className = 'project-folder__hint';
      loading.textContent = '正在读取历史对话…';
      body.append(loading);
    } else if (history && history.length > 0) {
      const heading = document.createElement('span');
      heading.className = 'project-folder__hint';
      heading.textContent = `历史对话（点击可在新对话中恢复，共 ${history.length} 个）`;
      body.append(heading);

      // Running conversations above stay put; only the history list itself scrolls.
      const scroller = document.createElement('div');
      scroller.className = 'project-folder__history';
      scroller.setAttribute('role', 'list');
      scroller.setAttribute('aria-label', `${project.name} 的历史对话`);
      for (const session of history) {
        scroller.append(renderHistoryRow(project.path, session));
      }
      const savedScroll = state.historyScrollPositions.get(key) ?? 0;
      if (savedScroll > 0) {
        // The list is rebuilt on every workspace tick; restore after it has a layout box.
        requestAnimationFrame(() => {
          scroller.scrollTop = savedScroll;
        });
      }
      scroller.addEventListener('scroll', () => {
        state.historyScrollPositions.set(key, scroller.scrollTop);
      });
      body.append(scroller);
    }

    folder.append(body);
    return folder;
  };

  return {
    renderProjectFolder,
  };
};
