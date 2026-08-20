const requiredElement = <T extends HTMLElement>(selector: string): T => {
  const element = document.querySelector<T>(selector);
  if (!element) {
    throw new Error(`Missing required element: ${selector}`);
  }
  return element;
};

export interface TerminalElements {
  clearTerminalButton: HTMLButtonElement;
  composerForm: HTMLFormElement;
  composerInput: HTMLTextAreaElement;
  composerSendButton: HTMLButtonElement;
  drawerResizer: HTMLElement;
  panelResizer: HTMLElement;
  restartButton: HTMLButtonElement;
  terminalContextMenu: HTMLElement;
  terminalDiagnostic: HTMLElement;
  terminalDiagnosticCopy: HTMLButtonElement;
  terminalDiagnosticMessage: HTMLElement;
  terminalDiagnosticResult: HTMLElement;
  terminalDiagnosticRetry: HTMLButtonElement;
  terminalDiagnosticRun: HTMLButtonElement;
  terminalDiagnosticScrim: HTMLButtonElement;
  terminalStage: HTMLElement;
  toggleButton: HTMLButtonElement;
}

export const createTerminalElements = (): TerminalElements => ({
  clearTerminalButton: requiredElement<HTMLButtonElement>('#clear-terminal'),
  composerForm: requiredElement<HTMLFormElement>('#terminal-composer'),
  composerInput: requiredElement<HTMLTextAreaElement>('#composer-input'),
  composerSendButton: requiredElement<HTMLButtonElement>('#composer-send'),
  drawerResizer: requiredElement<HTMLElement>('#drawer-resizer'),
  panelResizer: requiredElement<HTMLElement>('#panel-resizer'),
  restartButton: requiredElement<HTMLButtonElement>('#restart-terminal'),
  terminalContextMenu: requiredElement<HTMLElement>('#terminal-context-menu'),
  terminalDiagnostic: requiredElement<HTMLElement>('#terminal-diagnostic'),
  terminalDiagnosticCopy: requiredElement<HTMLButtonElement>('#terminal-diagnostic-copy'),
  terminalDiagnosticMessage: requiredElement<HTMLElement>('#terminal-diagnostic-message'),
  terminalDiagnosticResult: requiredElement<HTMLElement>('#terminal-diagnostic-result'),
  terminalDiagnosticRetry: requiredElement<HTMLButtonElement>('#terminal-diagnostic-retry'),
  terminalDiagnosticRun: requiredElement<HTMLButtonElement>('#terminal-diagnostic-run'),
  terminalDiagnosticScrim: requiredElement<HTMLButtonElement>('#terminal-diagnostic-scrim'),
  terminalStage: requiredElement<HTMLElement>('#terminal-stage'),
  toggleButton: requiredElement<HTMLButtonElement>('#toggle-terminal'),
});
