import type { ApplicationUpdaterState } from '../../../shared/contracts';
import { createRegistryToken, type Registry } from '../../platform/registry';
import { createDownloadsActions, type DownloadsActionsDependencies } from './actions';
import { createDownloadsElements } from './elements';
import { createDownloadsState } from './state';
import { createDownloadsView } from './view';

export interface DownloadsFeatureDependencies extends DownloadsActionsDependencies {
  formatDuration: (milliseconds: number | undefined) => string;
}

export interface DownloadsFeature {
  dispose: () => void;
  isOpen: () => boolean;
  load: () => Promise<void>;
  open: () => void;
  setApplicationUpdaterState: (state: ApplicationUpdaterState) => void;
}

export const DOWNLOADS_FEATURE = createRegistryToken<DownloadsFeature>(
  'renderer.feature.downloads',
);

const createDownloadsFeature = (dependencies: DownloadsFeatureDependencies): DownloadsFeature => {
  const elements = createDownloadsElements();
  const state = createDownloadsState();
  const renderDelegate = { current: (): void => undefined };
  const actions = createDownloadsActions(elements, state, dependencies, () =>
    renderDelegate.current(),
  );
  const view = createDownloadsView(elements, state, {
    formatDuration: dependencies.formatDuration,
    onDeleteHistory: actions.deleteHistory,
    onTaskAction: actions.runTaskAction,
  });
  renderDelegate.current = view.render;
  const dispose = actions.bind();

  return {
    dispose,
    isOpen: () => elements.centerDialog.open,
    load: actions.load,
    open: actions.open,
    setApplicationUpdaterState: (updaterState) => {
      state.applicationUpdater = updaterState;
      view.render();
    },
  };
};

export const registerDownloadsFeature = (
  registry: Registry,
  dependencies: DownloadsFeatureDependencies,
): void => {
  registry.register(DOWNLOADS_FEATURE, () => createDownloadsFeature(dependencies));
};
