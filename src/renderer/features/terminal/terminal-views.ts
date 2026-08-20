import type {
  ClaudePermissionMode,
  PtyGeneration,
  TerminalStatus,
} from '../../../shared/contracts';
import type { TerminalElements } from './elements';
import type { TerminalIo } from './terminal-io';
import type { TerminalState, TerminalView } from './state';
import { createTerminalViewLifecycleActions } from './terminal-views-lifecycle';
import { createTerminalViewPermissionActions } from './terminal-views-permission';
import { createTerminalViewActions } from './terminal-views-create';
import { createTerminalViewFitActions } from './terminal-views-fit';

export type { TerminalFitResult, TerminalViewsDependencies } from './terminal-views-dependencies';
import type { TerminalViewsDependencies } from './terminal-views-dependencies';

export interface TerminalViews {
  debounceTerminalFit: () => void;
  disposeTerminalView: (sessionId: string, view: TerminalView) => void;
  ensureTerminalView: (status: TerminalStatus, active: boolean) => TerminalView;
  ownsTerminalGeneration: (
    sessionId: string,
    ptyGeneration: PtyGeneration,
    view: TerminalView,
  ) => boolean;
  queueTerminalOutput: (sessionId: string, ptyGeneration: PtyGeneration, data: string) => void;
  readTerminalPermissionMode: (view: TerminalView) => ClaudePermissionMode | undefined;
  retryTerminalFitUntilMeasured: () => void;
}

export const createTerminalViews = (
  state: TerminalState,
  elements: TerminalElements,
  dependencies: TerminalViewsDependencies,
  io: TerminalIo,
): TerminalViews => {
  const permissionActions = createTerminalViewPermissionActions(state, io);
  const createActions = createTerminalViewActions(
    state,
    elements,
    dependencies,
    io,
    permissionActions,
  );
  const lifecycleActions = createTerminalViewLifecycleActions(
    state,
    createActions.createTerminalView,
    permissionActions.rejectPermissionModeProbes,
  );
  const fitActions = createTerminalViewFitActions(state, dependencies, io);

  return {
    debounceTerminalFit: fitActions.debounceTerminalFit,
    disposeTerminalView: lifecycleActions.disposeTerminalView,
    ensureTerminalView: lifecycleActions.ensureTerminalView,
    ownsTerminalGeneration: io.ownsTerminalGeneration,
    queueTerminalOutput: permissionActions.queueTerminalOutput,
    readTerminalPermissionMode: permissionActions.readTerminalPermissionMode,
    retryTerminalFitUntilMeasured: fitActions.retryTerminalFitUntilMeasured,
  };
};
