import type { TerminalStatus, WorkspaceState } from '../../../shared/contracts';
import type { ProjectsElements } from './elements';
import type { ProjectsState } from './state';

export const TITLE_ERASE_MS = 24;
export const TITLE_TYPE_MS = 44;
export const TITLE_PHASE_PAUSE_MS = 200;

export interface ProjectsViewDependencies {
  getWorkspaceState: () => WorkspaceState;
  projectNameFromPath: (directoryPath: string) => string;
  terminalProject: HTMLElement;
  workbenchScope: HTMLElement;
}

export interface ProjectsTitleView {
  cancelTitleAnimation: (sessionId: string) => void;
  displayedConversationTitle: (status: TerminalStatus) => string;
  isTitleAnimating: (sessionId: string) => boolean;
  startTitleAnimation: (sessionId: string, fromTitle: string, toTitle: string) => void;
  syncConversationTitles: (state: WorkspaceState) => void;
}

export const createProjectsTitleView = (
  state: ProjectsState,
  elements: ProjectsElements,
  dependencies: ProjectsViewDependencies,
): ProjectsTitleView => {
  const displayedConversationTitle = (status: TerminalStatus): string => {
    const animation = state.titleAnimations.get(status.id);
    return animation ? animation.chars.join('') : status.title;
  };

  const isTitleAnimating = (sessionId: string): boolean => state.titleAnimations.has(sessionId);

  const applyAnimatedTitleFrame = (sessionId: string): void => {
    const status = dependencies
      .getWorkspaceState()
      .sessions.find((session) => session.id === sessionId);
    if (!status) {
      return;
    }
    const text = displayedConversationTitle(status);
    const typing = String(isTitleAnimating(sessionId));
    const label = elements.projectList.querySelector<HTMLElement>(
      `.conversation-item[data-session-id="${CSS.escape(sessionId)}"] .conversation-item__label`,
    );
    if (label) {
      label.textContent = text;
      label.dataset.titleTyping = typing;
    }
    if (sessionId === dependencies.getWorkspaceState().activeSessionId) {
      const scoped = `${dependencies.projectNameFromPath(status.cwd)} · ${text}`;
      dependencies.terminalProject.textContent = scoped;
      dependencies.terminalProject.dataset.titleTyping = typing;
      dependencies.workbenchScope.textContent = scoped;
      dependencies.workbenchScope.dataset.titleTyping = typing;
    }
  };

  const cancelTitleAnimation = (sessionId: string): void => {
    const animation = state.titleAnimations.get(sessionId);
    if (!animation) {
      return;
    }
    window.clearTimeout(animation.timer);
    state.titleAnimations.delete(sessionId);
  };

  const stepTitleAnimation = (sessionId: string): void => {
    const animation = state.titleAnimations.get(sessionId);
    if (!animation) {
      return;
    }

    let delay: number;
    if (animation.phase === 'erasing') {
      if (animation.chars.length > animation.keep) {
        animation.chars.pop();
        delay = TITLE_ERASE_MS;
      } else {
        animation.phase = 'typing';
        delay = TITLE_PHASE_PAUSE_MS;
      }
    } else if (animation.chars.length < animation.target.length) {
      animation.chars.push(animation.target[animation.chars.length] ?? '');
      // Slightly uneven keystrokes read as typing rather than a mechanical ticker.
      delay = TITLE_TYPE_MS + Math.random() * 42;
    } else {
      cancelTitleAnimation(sessionId);
      applyAnimatedTitleFrame(sessionId);
      return;
    }

    applyAnimatedTitleFrame(sessionId);
    animation.timer = window.setTimeout(() => {
      stepTitleAnimation(sessionId);
    }, delay);
  };

  const startTitleAnimation = (sessionId: string, fromTitle: string, toTitle: string): void => {
    const existing = state.titleAnimations.get(sessionId);
    // A retarget mid-animation continues from whatever is on screen right now.
    const chars = existing ? existing.chars : [...fromTitle];
    if (existing) {
      window.clearTimeout(existing.timer);
    }

    const target = [...toTitle];
    let keep = 0;
    while (keep < chars.length && keep < target.length && chars[keep] === target[keep]) {
      keep += 1;
    }

    const animation = {
      chars,
      keep,
      phase: chars.length > keep ? ('erasing' as const) : ('typing' as const),
      target,
      timer: 0,
    };
    state.titleAnimations.set(sessionId, animation);
    animation.timer = window.setTimeout(() => {
      stepTitleAnimation(sessionId);
    }, TITLE_ERASE_MS);
  };

  const syncConversationTitles = (workspace: WorkspaceState): void => {
    const validSessionIds = new Set(workspace.sessions.map((session) => session.id));
    for (const sessionId of [...state.renderedConversationTitles.keys()]) {
      if (!validSessionIds.has(sessionId)) {
        state.renderedConversationTitles.delete(sessionId);
        state.suppressedTitleAnimations.delete(sessionId);
        cancelTitleAnimation(sessionId);
      }
    }

    for (const status of workspace.sessions) {
      const previous = state.renderedConversationTitles.get(status.id);
      state.renderedConversationTitles.set(status.id, status.title);
      if (previous === undefined || previous === status.title) {
        continue;
      }
      if (
        state.suppressedTitleAnimations.delete(status.id) ||
        window.matchMedia('(prefers-reduced-motion: reduce)').matches
      ) {
        cancelTitleAnimation(status.id);
        continue;
      }
      startTitleAnimation(status.id, previous, status.title);
    }
  };

  return {
    cancelTitleAnimation,
    displayedConversationTitle,
    isTitleAnimating,
    startTitleAnimation,
    syncConversationTitles,
  };
};
