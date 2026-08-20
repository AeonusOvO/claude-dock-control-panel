const requiredElement = <T extends HTMLElement>(selector: string): T => {
  const element = document.querySelector<T>(selector);
  if (!element) {
    throw new Error(`Missing required element: ${selector}`);
  }
  return element;
};

export interface ProjectsElements {
  chooseDirectoryButton: HTMLButtonElement;
  conversationContextMenu: HTMLElement;
  conversationRenameCancel: HTMLButtonElement;
  conversationRenameDialog: HTMLDialogElement;
  conversationRenameDialogDescription: HTMLElement;
  conversationRenameDialogTitle: HTMLElement;
  conversationRenameFieldLabel: HTMLElement;
  conversationRenameInput: HTMLInputElement;
  dropZone: HTMLButtonElement;
  projectCount: HTMLElement;
  projectList: HTMLElement;
}

export const createProjectsElements = (): ProjectsElements => {
  const chooseDirectoryButton = requiredElement<HTMLButtonElement>('#choose-directory');
  return {
    chooseDirectoryButton,
    conversationContextMenu: requiredElement<HTMLElement>('#conversation-context-menu'),
    conversationRenameCancel: requiredElement<HTMLButtonElement>('#conversation-rename-cancel'),
    conversationRenameDialog: requiredElement<HTMLDialogElement>('#conversation-rename-dialog'),
    conversationRenameDialogDescription: requiredElement<HTMLElement>(
      '#conversation-rename-dialog-description',
    ),
    conversationRenameDialogTitle: requiredElement<HTMLElement>(
      '#conversation-rename-dialog-title',
    ),
    conversationRenameFieldLabel: requiredElement<HTMLElement>('#conversation-rename-field-label'),
    conversationRenameInput: requiredElement<HTMLInputElement>('#conversation-rename-input'),
    dropZone: chooseDirectoryButton,
    projectCount: requiredElement<HTMLElement>('#project-count'),
    projectList: requiredElement<HTMLElement>('#project-list'),
  };
};
