import { requiredElement } from '../platform/dom';
import { closeOpenSelect } from '../platform/components';
import {
  CLAUDE_COMMAND_CATALOG,
  CODEX_COMMAND_CATALOG,
  type CliCommandDefinition,
} from '../../shared/ui/cli-command-catalog';
import type {
  ClaudeProjectState,
  CodexProjectState,
  DevelopmentRuntime,
  TerminalStatus,
} from '../../shared/contracts';
import type { ConfirmationRequest } from './dialogs';

const claudeWorkbench = requiredElement<HTMLElement>('#claude-workbench');
const workbenchClose = requiredElement<HTMLButtonElement>('#workbench-close');
const workbenchScrim = requiredElement<HTMLButtonElement>('#workbench-scrim');
const workbenchTrigger = requiredElement<HTMLButtonElement>('#workbench-trigger');
const workbenchTriggerLabel = requiredElement<HTMLElement>('#workbench-trigger-label');
const workbenchTitle = requiredElement<HTMLElement>('#workbench-title');
const workbenchTabs = requiredElement<HTMLElement>('#workbench-tabs');
const workbenchShortcuts = requiredElement<HTMLButtonElement>('#workbench-shortcuts');
const workbenchScope = requiredElement<HTMLElement>('#workbench-scope');
const commandArgument = requiredElement<HTMLInputElement>('#command-argument');
const claudeCommandGrid = requiredElement<HTMLElement>('#claude-command-grid');
const codexCommandGrid = requiredElement<HTMLElement>('#codex-command-grid');

export interface WorkbenchShellDeps {
  closeRailPreview: () => void;
  getActiveSessionId: () => string;
  activeDevelopmentRuntime: () => DevelopmentRuntime;
  activeStatus: () => TerminalStatus | undefined;
  loadCodexState: (
    sessionId: string,
    errorMessage?: string,
  ) => Promise<CodexProjectState | undefined>;
  loadClaudeState: (sessionId: string) => Promise<void>;
  loadConnectionAdvice: () => void;
  requestConfirmation: (request: ConfirmationRequest) => Promise<boolean>;
  renderClaudeState: (
    state: ClaudeProjectState,
    invalidatePendingLoad?: boolean,
    renderFooter?: boolean,
  ) => void;
  resultFailureMessage: (result: unknown, fallback: string) => string;
  getComposerInput: () => HTMLTextAreaElement;
  resizeComposer: () => void;
  focusComposer: () => void;
  showToast: (message: string, tone?: 'error' | 'success') => void;
}

export interface WorkbenchShell {
  readonly claudeWorkbench: HTMLElement;
  readonly workbenchScope: HTMLElement;
  readonly workbenchTabs: HTMLElement;
  readonly workbenchTitle: HTMLElement;
  readonly workbenchTriggerLabel: HTMLElement;
  readonly workbenchTrigger: HTMLButtonElement;
  setWorkbenchOpen: (open: boolean) => void;
  selectWorkbenchPage: (page: string) => void;
}

export const createWorkbenchShell = (deps: WorkbenchShellDeps): WorkbenchShell => {
  const {
    closeRailPreview,
    getActiveSessionId,
    activeDevelopmentRuntime,
    activeStatus,
    loadCodexState,
    loadClaudeState,
    loadConnectionAdvice,
    requestConfirmation,
    renderClaudeState,
    resultFailureMessage,
    getComposerInput,
    resizeComposer,
    focusComposer,
    showToast,
  } = deps;

  const setWorkbenchOpen = (open: boolean): void => {
    if (open) closeRailPreview();
    // The listbox is a fixed-position popup on `body`, so closing the panel underneath it has to
    // dismiss it explicitly or it would hang over the terminal.
    closeOpenSelect();
    claudeWorkbench.classList.toggle('claude-workbench--open', open);
    claudeWorkbench.setAttribute('aria-hidden', String(!open));
    workbenchScrim.classList.toggle('workbench-scrim--visible', open);
    workbenchTrigger.setAttribute('aria-expanded', String(open));
    const activeSessionId = getActiveSessionId();
    if (open && activeSessionId) {
      if (activeDevelopmentRuntime() === 'codex') {
        void loadCodexState(activeSessionId);
      } else {
        void loadClaudeState(activeSessionId);
        void loadConnectionAdvice();
      }
    }
  };

  const selectWorkbenchPage = (page: string): void => {
    for (const tab of document.querySelectorAll<HTMLButtonElement>('[data-workbench-tab]')) {
      tab.classList.toggle('workbench-tab--active', tab.dataset.workbenchTab === page);
    }
    for (const panel of document.querySelectorAll<HTMLElement>('[data-workbench-page]')) {
      panel.classList.toggle('workbench-page--active', panel.dataset.workbenchPage === page);
    }
  };

  const renderCliCommandCatalog = (grid: HTMLElement, entries: CliCommandDefinition[]): void => {
    const nodes: HTMLElement[] = [];
    let previousCategory = '';
    for (const entry of entries) {
      if (entry.category !== previousCategory) {
        const heading = document.createElement('h4');
        heading.className = 'command-grid__category';
        heading.textContent = entry.category;
        nodes.push(heading);
        previousCategory = entry.category;
      }
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.commandAction = entry.action;
      button.dataset.commandRuntime = entry.runtime;
      button.dataset.commandValue = entry.command;
      button.dataset.commandRisk = entry.risk;
      if (entry.runtime === 'claude' && entry.action === 'run') {
        button.dataset.claudeCommand = entry.command;
        if (entry.syntax.includes('[参数]')) button.dataset.usesArgument = 'true';
      }
      if (entry.risk === 'destructive') button.classList.add('command-danger');
      const code = document.createElement('code');
      code.textContent = entry.command;
      const description = document.createElement('span');
      description.textContent = entry.aliases.length
        ? `${entry.description} · 别名 ${entry.aliases.join('、')}`
        : entry.description;
      const requirements = entry.requirements.length
        ? ` · 条件：${entry.requirements.join('；')}`
        : '';
      button.title = `${entry.syntax} · ${entry.documentedVersion} · ${entry.platforms.join('/')} · ${entry.action === 'run' ? '可视化执行' : '填入输入框确认'}${requirements}`;
      button.append(code, description);
      nodes.push(button);
    }
    grid.replaceChildren(...nodes);
  };

  renderCliCommandCatalog(claudeCommandGrid, CLAUDE_COMMAND_CATALOG);
  renderCliCommandCatalog(codexCommandGrid, CODEX_COMMAND_CATALOG);

  workbenchClose.addEventListener('click', () => {
    setWorkbenchOpen(false);
  });
  workbenchScrim.addEventListener('click', () => {
    setWorkbenchOpen(false);
  });
  for (const tab of document.querySelectorAll<HTMLButtonElement>('[data-workbench-tab]')) {
    tab.addEventListener('click', () => {
      selectWorkbenchPage(tab.dataset.workbenchTab ?? 'session');
    });
  }
  workbenchTrigger.addEventListener('click', () => {
    setWorkbenchOpen(!claudeWorkbench.classList.contains('claude-workbench--open'));
  });
  workbenchShortcuts.addEventListener('click', () => {
    setWorkbenchOpen(true);
    if (activeDevelopmentRuntime() === 'claude') {
      selectWorkbenchPage('shortcuts');
    }
  });

  const composeWorkbenchCommand = async (button: HTMLButtonElement): Promise<void> => {
    const command = button.dataset.commandValue;
    if (!command) return;
    if (
      button.dataset.commandRisk === 'destructive' &&
      !(await requestConfirmation({
        confirmLabel: '填入命令',
        message: `${command} 可能结束、删除或清空当前状态。ClaudeDock 只会填入输入框，不会自动发送。`,
        title: '确认高风险命令',
        tone: 'danger',
      }))
    ) {
      return;
    }
    const composerInput = getComposerInput();
    composerInput.value = `${command}${button.title.includes('[参数]') ? ' ' : ''}`;
    resizeComposer();
    composerInput.focus();
    composerInput.setSelectionRange(composerInput.value.length, composerInput.value.length);
    setWorkbenchOpen(false);
    showToast(`已填入 ${command}，确认后按 Enter 发送`);
  };

  claudeCommandGrid.addEventListener('click', async (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-command-value]');
    const status = activeStatus();
    if (!button || !status) return;
    if (button.dataset.commandAction !== 'run') {
      await composeWorkbenchCommand(button);
      return;
    }
    const command = button.dataset.claudeCommand;
    if (!command) return;
    const argument = button.dataset.usesArgument === 'true' ? commandArgument.value : undefined;
    const result = await window.controlPanel.runClaudeCommand(status.id, command, argument);
    renderClaudeState(result.state);
    if (!result.ok) {
      showToast(resultFailureMessage(result, '无法执行 Claude 命令。'), 'error');
      return;
    }
    showToast(`已执行 ${command}`);
    focusComposer();
  });

  codexCommandGrid.addEventListener('click', (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-command-value]');
    if (button) void composeWorkbenchCommand(button);
  });

  return {
    claudeWorkbench,
    workbenchScope,
    workbenchTabs,
    workbenchTitle,
    workbenchTriggerLabel,
    workbenchTrigger,
    setWorkbenchOpen,
    selectWorkbenchPage,
  };
};
