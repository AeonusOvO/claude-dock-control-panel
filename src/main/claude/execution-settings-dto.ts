import { CLAUDE_EXECUTION_PROFILES } from '../../shared/claude/execution-profiles';
import type {
  ClaudeExecutionEffectiveSetting,
  ClaudeExecutionEffectiveSettingDto,
  ClaudeExecutionProfileDto,
  ClaudeExecutionSettingsDto,
  ClaudeExecutionSettingsView,
} from '../../shared/contracts/claude-execution-settings';

const freezeSettingDto = <T>(
  setting: ClaudeExecutionEffectiveSetting<T>,
): ClaudeExecutionEffectiveSettingDto<T> =>
  Object.freeze({
    ...(setting.defaultValue === undefined ? {} : { defaultValue: setting.defaultValue }),
    ...(setting.effectiveValue === undefined ? {} : { effectiveValue: setting.effectiveValue }),
    reason: setting.reason,
    ...(setting.requestedValue === undefined ? {} : { requestedValue: setting.requestedValue }),
    source: Object.freeze({
      ...(setting.source.expiresAt === undefined ? {} : { expiresAt: setting.source.expiresAt }),
      kind: setting.source.kind,
      ...(setting.source.verifiedAt === undefined ? {} : { verifiedAt: setting.source.verifiedAt }),
    }),
    status: setting.status,
  });

const profiles: readonly ClaudeExecutionProfileDto[] = Object.freeze(
  CLAUDE_EXECUTION_PROFILES.map((profile) =>
    Object.freeze({
      id: profile.id,
      label: profile.label,
      values: Object.freeze({ ...profile.values }),
    }),
  ),
);

/**
 * Projects the main-only service view onto the renderer allowlist. Keep this field-by-field: spread
 * would risk leaking operations, environment authority, raw evidence references, or future fields.
 */
export const toClaudeExecutionSettingsDto = (
  view: ClaudeExecutionSettingsView,
): ClaudeExecutionSettingsDto =>
  Object.freeze({
    catalogVersion: view.catalogVersion,
    effective: Object.freeze({
      concurrentSubagents: freezeSettingDto(view.effective.concurrentSubagents),
      spawnDepth: freezeSettingDto(view.effective.spawnDepth),
      toolSearch: freezeSettingDto(view.effective.toolSearch),
      toolUseConcurrency: freezeSettingDto(view.effective.toolUseConcurrency),
    }),
    installation: Object.freeze({
      installed: view.installation.installed,
      ...(view.installation.version === undefined ? {} : { version: view.installation.version }),
    }),
    profiles,
    requested:
      view.requested.mode === 'custom'
        ? Object.freeze({
            mode: 'custom' as const,
            values: Object.freeze({ ...view.requested.values }),
          })
        : view.requested.mode === 'profile'
          ? Object.freeze({ mode: 'profile' as const, profileId: view.requested.profileId })
          : Object.freeze({ mode: 'claude-default' as const }),
    version: view.version,
  });
