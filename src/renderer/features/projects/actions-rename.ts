import type { TerminalStatus } from '../../../shared/contracts';
import type { ProjectsActionsDependencies, RenameDialogCopy } from './actions-dependencies';
import type { ProjectsElements } from './elements';
import type { ProjectsState } from './state';
import type { WorkspaceRenderer } from './workspace';

export interface ProjectsRenameActions {
  requestRenamedValue: (currentValue: string, copy: RenameDialogCopy) => Promise<string | null>;
  requestConversationTitle: (currentTitle: string, historical: boolean) => Promise<string | null>;
  renameConversation: (status: TerminalStatus) => Promise<void>;
}

export const createProjectsRenameActions = (
  elements: ProjectsElements,
  state: ProjectsState,
  dependencies: ProjectsActionsDependencies,
  workspaceRenderer: WorkspaceRenderer,
): ProjectsRenameActions => {
  const requestRenamedValue = (
    currentValue: string,
    copy: RenameDialogCopy,
  ): Promise<string | null> =>
    new Promise((resolve) => {
      elements.conversationRenameDialogTitle.textContent = copy.title;
      elements.conversationRenameDialogDescription.textContent = copy.description;
      elements.conversationRenameFieldLabel.textContent = copy.fieldLabel;
      elements.conversationRenameInput.value = currentValue;
      elements.conversationRenameDialog.returnValue = 'cancel';
      elements.conversationRenameDialog.addEventListener(
        'close',
        () => {
          if (elements.conversationRenameDialog.returnValue !== 'confirm') {
            resolve(null);
            return;
          }
          const title = elements.conversationRenameInput.value.trim();
          resolve(title && title !== currentValue ? title : null);
        },
        { once: true },
      );
      elements.conversationRenameDialog.showModal();
      window.setTimeout(() => {
        elements.conversationRenameInput.focus();
        elements.conversationRenameInput.select();
      });
    });

  const requestConversationTitle = (
    currentTitle: string,
    historical: boolean,
  ): Promise<string | null> =>
    requestRenamedValue(currentTitle, {
      description: '名称会同步显示在项目列表和历史对话中。',
      fieldLabel: '对话名称',
      title: historical ? '重命名历史对话' : '重命名运行中对话',
    });

  const renameConversation = async (status: TerminalStatus): Promise<void> => {
    const nextTitle = await requestConversationTitle(status.title, false);
    if (!nextTitle) {
      return;
    }
    state.suppressedTitleAnimations.add(status.id);
    const result = await window.controlPanel.renameConversation(status.id, nextTitle);
    workspaceRenderer.renderWorkspace(result.state);
    state.suppressedTitleAnimations.delete(status.id);
    if (!result.ok) {
      dependencies.showToast(
        dependencies.resultFailureMessage(result, '无法重命名这个对话。'),
        'error',
      );
      return;
    }
    dependencies.showToast(`对话已重命名为“${nextTitle}”`);
  };

  return {
    requestRenamedValue,
    requestConversationTitle,
    renameConversation,
  };
};
