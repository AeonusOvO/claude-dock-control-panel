import type { ProjectsState } from './state';

/**
 * Reference-counts overlapping new/restore operations before projecting one main-process quit
 * barrier. The main lease intentionally survives a renderer crash, while ordinary completions
 * release it after the last concurrent operation settles.
 */
export const beginWorkspaceConversationTransition = (state: ProjectsState): (() => void) => {
  state.workspaceTransitionDepth += 1;
  if (state.workspaceTransitionDepth === 1) {
    try {
      void window.controlPanel.setWorkspaceTransitionBusy(true).catch(() => undefined);
    } catch {
      // Older preload/test surfaces may not expose the advisory quit lease yet.
    }
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    state.workspaceTransitionDepth = Math.max(0, state.workspaceTransitionDepth - 1);
    if (state.workspaceTransitionDepth === 0) {
      try {
        void window.controlPanel.setWorkspaceTransitionBusy(false).catch(() => undefined);
      } catch {
        // The main process also drops the lease when a replacement renderer initializes.
      }
    }
  };
};
