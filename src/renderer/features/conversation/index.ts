import type { WorkspaceState } from '../../../shared/contracts';
import type { ConversationSnapshot } from '../../../shared/conversation/native';
import { createRegistryToken, type Registry } from '../../platform/registry';
import {
  createConversationActions,
  type ConversationActions,
  type ConversationActionsDependencies,
} from './actions';
import { createConversationElements } from './elements';
import {
  createConversationLaunchActions,
  type ConversationLaunchActions,
  type ConversationLaunchActionsDependencies,
} from './launch-actions';
import { createConversationState } from './state';
import { createConversationView, type ConversationViewDependencies } from './view';

export type ConversationFeatureDependencies = ConversationActionsDependencies &
  ConversationLaunchActionsDependencies &
  ConversationViewDependencies;

export interface ConversationFeature {
  activeSnapshot: () => ConversationSnapshot | undefined;
  dispose: () => void;
  hasActiveConversation: () => boolean;
  openNativeEffortMenu: () => void;
  openNativeModeMenu: () => void;
  openNativeModelMenu: () => void;
  openNativeSpeedMenu: () => void;
  reconcileBinding: (state: WorkspaceState) => void;
  refreshRecoveries: () => Promise<void>;
  renderActiveConversation: () => void;
  renderActiveFooter: () => void;
  setPanelVisible: (visible: boolean) => void;
  startingSessionId: () => string | undefined;
}

export const CONVERSATION_FEATURE = createRegistryToken<ConversationFeature>(
  'renderer.feature.conversation',
);

const createConversationFeature = (
  dependencies: ConversationFeatureDependencies,
): ConversationFeature => {
  const elements = createConversationElements();
  const state = createConversationState();
  const view = createConversationView(state, {
    footerEffort: dependencies.footerEffort,
    footerMode: dependencies.footerMode,
    footerModel: dependencies.footerModel,
    footerSpeed: dependencies.footerSpeed,
    getMarkdownRenderer: dependencies.getMarkdownRenderer,
  });
  const actions: ConversationActions = createConversationActions(
    elements,
    state,
    dependencies,
    view,
  );
  const launch: ConversationLaunchActions = createConversationLaunchActions(
    elements,
    state,
    dependencies,
    actions,
  );

  return {
    activeSnapshot: () => state.nativeConversationSnapshots.get(state.activeNativeConversationId),
    dispose: launch.dispose,
    hasActiveConversation: () => Boolean(state.activeNativeConversationId),
    openNativeEffortMenu: actions.openNativeEffortMenu,
    openNativeModeMenu: actions.openNativeModeMenu,
    openNativeModelMenu: actions.openNativeModelMenu,
    openNativeSpeedMenu: actions.openNativeSpeedMenu,
    reconcileBinding: launch.reconcileNativeConversationBinding,
    refreshRecoveries: launch.refreshNativeRecoveries,
    renderActiveConversation: () => {
      const snapshot = state.nativeConversationSnapshots.get(state.activeNativeConversationId);
      if (snapshot) actions.renderNativeConversation(snapshot);
    },
    renderActiveFooter: () => {
      const snapshot = state.nativeConversationSnapshots.get(state.activeNativeConversationId);
      if (snapshot) view.renderNativeFooter(snapshot);
    },
    setPanelVisible: actions.setNativeConversationVisible,
    startingSessionId: () => state.nativeConversationStartingSessionId,
  };
};

export const registerConversationFeature = (
  registry: Registry,
  dependencies: ConversationFeatureDependencies,
): void => {
  registry.register(CONVERSATION_FEATURE, () => createConversationFeature(dependencies));
};

export { nativePhaseLabel } from './view';
