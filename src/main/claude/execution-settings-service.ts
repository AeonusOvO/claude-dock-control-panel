import { availableParallelism, freemem } from 'node:os';
import type {
  ClaudeExecutionCapabilityContext,
  ClaudeExecutionInstallationSnapshot,
  ClaudeExecutionOperations,
  ClaudeExecutionProfile,
  ClaudeExecutionProfileId,
  ClaudeExecutionRequestedValues,
  ClaudeExecutionSettingsRequest,
  ClaudeExecutionSettingsSnapshot,
  ClaudeExecutionSettingsView,
} from '../../shared/contracts/claude-execution-settings';
import {
  assertClaudeExecutionRequestedValues,
  type ClaudeExecutionRecommendation,
  type ClaudeExecutionRecommendationInput,
  recommendClaudeExecutionProfile,
} from '../../shared/claude/execution-profiles';
import {
  type ClaudeExecutionCapabilityResolution,
  type ClaudeExecutionEnvironmentPair,
  type ClaudeExecutionResolutionIntent,
  materializeClaudeExecutionEnvironments,
  type ResolveClaudeExecutionCapabilitiesInput,
} from './execution-settings-capabilities';
import type { ClaudeExecutionInstallationReader } from './execution-settings-installation';

export interface ClaudeExecutionSettingsStorePort {
  get(): ClaudeExecutionSettingsSnapshot;
  reset(): ClaudeExecutionSettingsSnapshot | Promise<ClaudeExecutionSettingsSnapshot>;
  set(
    requested: ClaudeExecutionSettingsRequest,
  ): ClaudeExecutionSettingsSnapshot | Promise<ClaudeExecutionSettingsSnapshot>;
}

export type ClaudeExecutionProfileLookup = (
  profileId: ClaudeExecutionProfileId,
) => ClaudeExecutionProfile | undefined;

export type ClaudeExecutionCapabilityResolver = (
  input: ResolveClaudeExecutionCapabilitiesInput,
) => ClaudeExecutionCapabilityResolution;

export type ClaudeExecutionRecommendationResolver = (
  input: ClaudeExecutionRecommendationInput,
) => ClaudeExecutionRecommendation;

export interface ClaudeExecutionRecommendationInputProvider {
  getRecommendationInput():
    ClaudeExecutionRecommendationInput | Promise<ClaudeExecutionRecommendationInput>;
}

export interface ClaudeExecutionSettingsServiceDependencies {
  capabilityResolver: ClaudeExecutionCapabilityResolver;
  installationProvider: ClaudeExecutionInstallationReader;
  profileLookup: ClaudeExecutionProfileLookup;
  recommendationInputProvider?: ClaudeExecutionRecommendationInputProvider;
  recommendationResolver?: ClaudeExecutionRecommendationResolver;
  store: ClaudeExecutionSettingsStorePort;
}

export interface ClaudeExecutionLaunchInput extends ClaudeExecutionCapabilityContext {
  processEnvironment: Readonly<Record<string, null | string | undefined>>;
  settingsEnvironment: Readonly<Record<string, string | undefined>>;
}

/** Main-only launch materialization. IPC consumers must receive ClaudeExecutionSettingsView instead. */
export interface ClaudeExecutionLaunchResolution extends ClaudeExecutionSettingsView {
  environments: ClaudeExecutionEnvironmentPair;
  operations: ClaudeExecutionOperations;
}

/** Narrow future runtime seam; existing and already-prepared sessions are intentionally untouched. */
export interface ClaudeExecutionSettingsLaunchResolver {
  resolveLaunch(input: ClaudeExecutionLaunchInput): Promise<ClaudeExecutionLaunchResolution>;
}

const deepFreeze = <T>(value: T): T => {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value as Record<string, unknown>)) {
    deepFreeze(child);
  }
  return Object.freeze(value);
};

const immutableClone = <T>(value: T): T => deepFreeze(structuredClone(value));

const localRecommendationInputProvider: ClaudeExecutionRecommendationInputProvider = Object.freeze({
  getRecommendationInput: () => ({
    availableMemoryBytes: freemem(),
    logicalCpuCount: availableParallelism(),
  }),
});

const captureContext = (
  context: ClaudeExecutionCapabilityContext = {},
): ClaudeExecutionCapabilityContext => {
  const now = context.now ?? Date.now();
  if (!Number.isFinite(now) || now < 0) {
    throw new Error('Claude 执行能力证据时间无效。');
  }
  return immutableClone({ ...context, now });
};

const validateInstallation = (
  installation: ClaudeExecutionInstallationSnapshot,
): ClaudeExecutionInstallationSnapshot => {
  if (
    typeof installation.installed !== 'boolean' ||
    (installation.version !== undefined && typeof installation.version !== 'string')
  ) {
    throw new Error('Claude Code 安装与版本提供器返回了无效快照。');
  }
  return immutableClone({
    installed: installation.installed,
    ...(installation.version === undefined ? {} : { version: installation.version }),
  });
};

/** Global execution-settings orchestration; it has no project or open-session dependency. */
export class ClaudeExecutionSettingsService implements ClaudeExecutionSettingsLaunchResolver {
  private mutationTail: Promise<void> = Promise.resolve();
  private readonly recommend: ClaudeExecutionRecommendationResolver;
  private readonly recommendationInputProvider: ClaudeExecutionRecommendationInputProvider;

  public constructor(private readonly dependencies: ClaudeExecutionSettingsServiceDependencies) {
    this.recommend = dependencies.recommendationResolver ?? recommendClaudeExecutionProfile;
    this.recommendationInputProvider =
      dependencies.recommendationInputProvider ?? localRecommendationInputProvider;
  }

  public get(): Promise<ClaudeExecutionSettingsView> {
    const capturedContext = captureContext();
    const snapshot = immutableClone(this.dependencies.store.get());
    return this.resolveView(snapshot, capturedContext).then(({ view }) => view);
  }

  public update(requested: ClaudeExecutionSettingsRequest): Promise<ClaudeExecutionSettingsView> {
    const capturedContext = captureContext();
    const capturedRequest = immutableClone(requested);
    return this.enqueueMutation(() => this.updateAdmitted(capturedRequest, capturedContext));
  }

  public resetToClaudeDefault(): Promise<ClaudeExecutionSettingsView> {
    const capturedContext = captureContext();
    return this.enqueueMutation(() => this.resetAdmitted(capturedContext));
  }

  public useRecommended(): Promise<ClaudeExecutionSettingsView> {
    const capturedContext = captureContext();
    return this.enqueueMutation(async () => {
      const capturedEvidence = immutableClone(
        await this.recommendationInputProvider.getRecommendationInput(),
      );
      const recommendation = this.recommend(capturedEvidence);
      const requested = immutableClone({
        mode: 'profile' as const,
        profileId: recommendation.profileId,
      });
      return this.updateAdmitted(requested, capturedContext);
    });
  }

  public async resolveLaunch(
    input: ClaudeExecutionLaunchInput,
  ): Promise<ClaudeExecutionLaunchResolution> {
    // Capture every mutable input before awaiting the installation provider: one launch uses one view.
    const snapshot = immutableClone(this.dependencies.store.get());
    const context = captureContext({
      evidence: input.evidence,
      now: input.now,
      route: input.route,
    });
    const processEnvironment = immutableClone(input.processEnvironment);
    const settingsEnvironment = immutableClone(input.settingsEnvironment);
    const { resolution, view } = await this.resolveView(snapshot, context);
    const environments = materializeClaudeExecutionEnvironments(
      resolution.operations,
      processEnvironment,
      settingsEnvironment,
    );
    return immutableClone({
      ...view,
      environments,
      operations: resolution.operations,
    });
  }

  private enqueueMutation<Result>(operation: () => Promise<Result>): Promise<Result> {
    const admitted = this.mutationTail.then(operation);
    this.mutationTail = admitted.then(
      () => undefined,
      () => undefined,
    );
    return admitted;
  }

  private async updateAdmitted(
    requested: ClaudeExecutionSettingsRequest,
    context: ClaudeExecutionCapabilityContext,
  ): Promise<ClaudeExecutionSettingsView> {
    // Re-read only after FIFO admission; every mutation resolves against its predecessor's result.
    const candidate = immutableClone({
      ...this.dependencies.store.get(),
      requested,
    });
    const { view } = await this.resolveView(candidate, context);
    const persisted = immutableClone(await this.dependencies.store.set(requested));
    return immutableClone({ ...view, ...persisted });
  }

  private async resetAdmitted(
    context: ClaudeExecutionCapabilityContext,
  ): Promise<ClaudeExecutionSettingsView> {
    // This one-shot delete view is the future wiring seam. Persisted default launches use omit.
    const candidate = immutableClone({
      ...this.dependencies.store.get(),
      requested: { mode: 'claude-default' as const },
    });
    const { view } = await this.resolveView(candidate, context, 'restore-default');
    const persisted = immutableClone(await this.dependencies.store.reset());
    return immutableClone({ ...view, ...persisted });
  }

  private resolveRequestedValues(
    requested: ClaudeExecutionSettingsRequest,
  ): ClaudeExecutionRequestedValues | undefined {
    if (requested.mode === 'claude-default') {
      return undefined;
    }
    if (requested.mode === 'custom') {
      assertClaudeExecutionRequestedValues(requested.values);
      return immutableClone(requested.values);
    }
    const profile = this.dependencies.profileLookup(requested.profileId);
    if (!profile || profile.id !== requested.profileId) {
      throw new Error(`Claude 执行档位 ${requested.profileId} 不存在。`);
    }
    assertClaudeExecutionRequestedValues(profile.values);
    return immutableClone(profile.values);
  }

  private async resolveView(
    snapshot: ClaudeExecutionSettingsSnapshot,
    context: ClaudeExecutionCapabilityContext,
    intent: ClaudeExecutionResolutionIntent = 'launch',
  ): Promise<{
    resolution: ClaudeExecutionCapabilityResolution;
    view: ClaudeExecutionSettingsView;
  }> {
    const requestedValues = this.resolveRequestedValues(snapshot.requested);
    const installation = validateInstallation(
      await this.dependencies.installationProvider.getInstallation(),
    );
    const resolution = immutableClone(
      this.dependencies.capabilityResolver({
        context,
        installation,
        intent,
        requested: snapshot.requested,
        requestedValues,
      }),
    );
    const view = immutableClone({
      ...snapshot,
      effective: resolution.effective,
      installation,
    });
    return { resolution, view };
  }
}
