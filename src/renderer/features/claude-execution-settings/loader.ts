import type {
  ClaudeExecutionSettingsFeature,
  ClaudeExecutionSettingsFeatureDependencies,
} from './index';

export interface ClaudeExecutionSettingsFeatureModule {
  createClaudeExecutionSettingsFeature: (
    dependencies: ClaudeExecutionSettingsFeatureDependencies,
  ) => ClaudeExecutionSettingsFeature;
}

export interface ClaudeExecutionSettingsLoaderDependencies {
  featureDependencies: ClaudeExecutionSettingsFeatureDependencies;
  importFeature: () => Promise<ClaudeExecutionSettingsFeatureModule>;
  showToast: (message: string, tone?: 'error' | 'success') => void;
}

export interface ClaudeExecutionSettingsLoader {
  activate: () => Promise<void>;
  dispose: () => void;
  endDialogSession: (restore: boolean) => void;
  isDirty: () => boolean;
  savePending: () => Promise<boolean>;
}

export const createClaudeExecutionSettingsLoader = ({
  featureDependencies,
  importFeature,
  showToast,
}: ClaudeExecutionSettingsLoaderDependencies): ClaudeExecutionSettingsLoader => {
  let disposed = false;
  let feature: ClaudeExecutionSettingsFeature | undefined;
  let featurePromise: Promise<ClaudeExecutionSettingsFeature> | undefined;
  let lifecycleGeneration = 0;

  const load = (): Promise<ClaudeExecutionSettingsFeature> => {
    if (feature) return Promise.resolve(feature);
    featurePromise ??= importFeature()
      .then((module) => {
        feature ??= module.createClaudeExecutionSettingsFeature(featureDependencies);
        if (disposed) feature.dispose();
        return feature;
      })
      .catch((error: unknown) => {
        featurePromise = undefined;
        throw error;
      });
    return featurePromise;
  };

  return {
    activate: async () => {
      if (disposed) return;
      const generation = ++lifecycleGeneration;
      try {
        const loadedFeature = await load();
        if (disposed || generation !== lifecycleGeneration) return;
        await loadedFeature.activate();
      } catch {
        if (!disposed && generation === lifecycleGeneration) {
          showToast('无法加载 Claude 执行设置。', 'error');
        }
      }
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      lifecycleGeneration += 1;
      feature?.dispose();
    },
    endDialogSession: (restore) => {
      lifecycleGeneration += 1;
      feature?.endDialogSession(restore);
    },
    isDirty: () => feature?.isDirty() ?? false,
    savePending: () => feature?.savePending() ?? Promise.resolve(true),
  };
};
