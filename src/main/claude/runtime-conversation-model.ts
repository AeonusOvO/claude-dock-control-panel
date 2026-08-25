import type {
  ClaudeConfigView,
  ClaudeConversationModelResolution,
  ConversationModelMismatchBehavior,
} from '../../shared/contracts';
import {
  type ConversationConnectionBinding,
  isConversationId,
} from '../conversation/preferences-store';
import {
  accountFromOfficialAuth,
  conversationBindingIsRestorable,
  conversationModelDifferences,
  conversationModelIdentity,
  createConversationConnectionBinding,
  type ConversationBindingAccount,
} from './conversation-model-binding';
import { MODEL_NAME_PATTERN, type NormalizedClaudeConfig } from './configuration';
import type { ClaudeLaunchConfigSnapshot } from './config-store';
import { claudeOfficialAuthProvider } from './official-auth-status';
import { ClaudeRuntimeLaunchHandoff } from './runtime-launch-handoff';
import type { PreparedClaudeConfigSave } from './runtime-types';

export interface ConversationModelResolvers {
  managedChatGptAccount: () => Promise<ConversationBindingAccount | undefined>;
  preference: () => ConversationModelMismatchBehavior;
}

/** Owns complete per-conversation connection identity without enlarging the launch state machine. */
export abstract class ClaudeRuntimeConversationModels extends ClaudeRuntimeLaunchHandoff {
  private managedChatGptAccount: ConversationModelResolvers['managedChatGptAccount'] = async () =>
    undefined;
  private conversationModelPreference: ConversationModelResolvers['preference'] = () => 'ask';

  public setConversationModelResolvers(resolvers: ConversationModelResolvers): void {
    this.managedChatGptAccount = resolvers.managedChatGptAccount;
    this.conversationModelPreference = resolvers.preference;
  }

  private async accountForConversationBinding(
    preset: NormalizedClaudeConfig['preset'],
  ): Promise<ConversationBindingAccount | undefined> {
    if (preset === 'anthropic') {
      return accountFromOfficialAuth(await claudeOfficialAuthProvider.getState());
    }
    if (preset === 'chatgpt-subscription') return this.managedChatGptAccount();
    return undefined;
  }

  protected async currentConversationBinding(
    cwd: string,
    snapshot?: ClaudeLaunchConfigSnapshot,
  ): Promise<ConversationConnectionBinding> {
    const stored = snapshot?.storage.project;
    const view: ClaudeConfigView = snapshot
      ? {
          ...snapshot.config,
          credentialConfigured: Boolean(stored?.encryptedCredential),
          protocol: snapshot.protocol,
          routerProviderId: stored?.routerProviderId,
          sourceAuthMode: stored?.sourceAuthMode,
          sourceBaseUrl: stored?.sourceBaseUrl,
          sourceCredentialConfigured: stored?.sourceCredentialConfigured,
          sourceModel: stored?.sourceModel,
          sourceModelFast: stored?.sourceModelFast,
        }
      : this.configStore.getView(cwd);
    const account = await this.accountForConversationBinding(view.preset);
    return createConversationConnectionBinding({
      account,
      credential:
        view.protocol === 'openai'
          ? snapshot
            ? snapshot.sourceCredential
            : this.configStore.getSourceCredential(cwd)
          : snapshot
            ? snapshot.credential
            : this.configStore.getCredential(cwd),
      preferReplayConfig: false,
      replay: snapshot
        ? this.conversationReplayForView(cwd, view)
        : this.conversationReplayForCurrent(cwd),
      view,
    });
  }

  public recordNativeConversationBinding(
    conversationId: string,
    binding: ConversationConnectionBinding,
    model?: string,
  ): void {
    this.conversationPreferences.record(conversationId, {
      binding,
      model: model ?? binding.config.model,
    });
  }

  public async bindConversationToCurrent(cwd: string, conversationId: string): Promise<void> {
    if (!isConversationId(conversationId)) throw new Error('历史对话标识无效。');
    const binding = await this.currentConversationBinding(cwd);
    this.conversationPreferences.record(conversationId, {
      binding,
      model: this.configStore.getConfig(cwd).model,
    });
  }

  public conversationNetworkAccess(
    cwd: string,
    conversationId: string,
  ): ReturnType<ClaudeRuntimeConversationModels['networkAccessForConfigInput']> {
    const remembered = this.conversationPreferences.get(conversationId);
    const binding =
      remembered?.binding ??
      (remembered?.model
        ? this.conversationReplayForModel(cwd, remembered.model)?.config
        : undefined);
    if (!binding) return undefined;
    return this.networkAccessForConfigInput('config' in binding ? binding.config : binding);
  }

  public async prepareConversationConnection(
    cwd: string,
    conversationId: string,
    assertCurrent: () => void = () => undefined,
  ): Promise<PreparedClaudeConfigSave> {
    const remembered = this.conversationPreferences.get(conversationId);
    let binding = remembered?.binding;
    if (!binding && remembered?.model) {
      const replay = this.conversationReplayForModel(cwd, remembered.model);
      if (replay) {
        binding = createConversationConnectionBinding({
          account: await this.accountForConversationBinding(replay.config.preset),
          credential: replay.config.credential,
          replay,
          view: this.configStore.getView(cwd),
        });
      }
    }
    if (!binding) throw new Error('这个旧对话没有可恢复的原始接入记录。');
    const current = await this.currentConversationBinding(cwd);
    if (!conversationBindingIsRestorable(binding, current)) {
      throw new Error('该对话的原订阅账户与当前账户不同，无法在不重新登录的情况下安全恢复。');
    }
    assertCurrent();
    return this.prepareConnectionConfig(binding.config, binding.connectionName, assertCurrent);
  }

  public async inspectConversationModel(
    cwd: string,
    conversationId: string,
    legacyModelHint?: string,
    preference: ConversationModelMismatchBehavior = this.conversationModelPreference(),
  ): Promise<ClaudeConversationModelResolution> {
    if (!isConversationId(conversationId)) throw new Error('历史对话标识无效。');
    const current = await this.currentConversationBinding(cwd);
    const remembered = this.conversationPreferences.get(conversationId);
    const legacyModel =
      remembered?.model ??
      (legacyModelHint && MODEL_NAME_PATTERN.test(legacyModelHint) ? legacyModelHint : undefined);
    let conversation = remembered?.binding;
    let source: ClaudeConversationModelResolution['conversation']['source'] = 'bound';
    let restorable = false;

    if (!conversation && legacyModel) {
      const replay = this.conversationReplayForModel(cwd, legacyModel);
      if (replay) {
        conversation = createConversationConnectionBinding({
          account:
            replay.config.preset === current.config.preset
              ? {
                  accountIdentity: current.accountIdentity,
                  authMethod: current.authMethod,
                }
              : await this.accountForConversationBinding(replay.config.preset),
          credential: replay.config.credential,
          replay,
          view: this.configStore.getView(cwd),
        });
        source = 'legacy-inferred';
      }
    }

    if (!conversation) {
      conversation = {
        ...current,
        config: {
          ...current.config,
          model: legacyModel ?? current.config.model,
          modelFast: legacyModel ?? current.config.model,
        },
      };
      source = 'legacy-model-only';
    } else {
      restorable = conversationBindingIsRestorable(conversation, current);
    }

    const displayedModel =
      legacyModel &&
      (legacyModel === conversation.config.model ||
        legacyModel.endsWith(`/${conversation.config.model}`))
        ? conversation.config.model
        : legacyModel;
    const differences = conversationModelDifferences(conversation, current, displayedModel);
    const identity = conversationModelIdentity(conversation, source, displayedModel);
    return {
      conversation:
        source === 'legacy-model-only'
          ? {
              ...identity,
              accountDetail: '旧对话未记录账户或 API 身份',
              accountIdentity: undefined,
              credentialFingerprint: undefined,
            }
          : identity,
      current: conversationModelIdentity(current, 'current'),
      differences,
      mismatch: differences.length > 0,
      preference,
      restorable,
    };
  }
}
