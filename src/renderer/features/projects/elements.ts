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
  conversationModelCurrent: HTMLButtonElement;
  conversationModelCurrentCard: HTMLElement;
  conversationModelDialog: HTMLDialogElement;
  conversationModelDialogDescription: HTMLElement;
  conversationModelDialogTitle: HTMLElement;
  conversationModelDifferences: HTMLElement;
  conversationModelOriginal: HTMLButtonElement;
  conversationModelOriginalCard: HTMLElement;
  conversationModelRemember: HTMLInputElement;
  conversationModelWarning: HTMLElement;
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
    conversationModelCurrent: requiredElement<HTMLButtonElement>(
      '#conversation-model-dialog-current',
    ),
    conversationModelCurrentCard: requiredElement<HTMLElement>(
      '#conversation-model-dialog-current-card',
    ),
    conversationModelDialog: requiredElement<HTMLDialogElement>('#conversation-model-dialog'),
    conversationModelDialogDescription: requiredElement<HTMLElement>(
      '#conversation-model-dialog-description',
    ),
    conversationModelDialogTitle: requiredElement<HTMLElement>('#conversation-model-dialog-title'),
    conversationModelDifferences: requiredElement<HTMLElement>(
      '#conversation-model-dialog-differences',
    ),
    conversationModelOriginal: requiredElement<HTMLButtonElement>(
      '#conversation-model-dialog-original',
    ),
    conversationModelOriginalCard: requiredElement<HTMLElement>(
      '#conversation-model-dialog-original-card',
    ),
    conversationModelRemember: requiredElement<HTMLInputElement>(
      '#conversation-model-dialog-remember',
    ),
    conversationModelWarning: requiredElement<HTMLElement>('#conversation-model-dialog-warning'),
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
