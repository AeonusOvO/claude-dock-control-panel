import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type {
  ClaudeContextWindowMode,
  ClaudeLaunchMode,
  ClaudePermissionMode,
  ManagedChatGptContextWindowMode,
} from '../../shared/contracts';
import { TERMINAL_THEMES, type TerminalThemeId } from '../../shared/ui/terminal-themes';
import { POWERSHELL_STARTUP_COMMAND_ENV } from '../terminal/session';
import {
  buildClaudeEnvironment,
  buildClaudeLaunchCommand,
  buildClaudePermissionHookCommand,
  buildClaudeSettingsEnvironment,
  buildClaudeSpeedSettings,
  buildRuntimeActivityCommand,
  buildRuntimeSignalCommand,
  buildStatusLineCommand,
  buildWebSearchGuardCommand,
  shouldDisableInheritedApiKeyHelper,
  type ClaudeEnvironmentOverrides,
  type ClaudeServingSpeedProfile,
  type NormalizedClaudeConfig,
} from './configuration';
import {
  CLAUDEDOCK_WEB_RESEARCH_AGENTS,
  CLAUDEDOCK_WEB_RESEARCH_AGENT_NAME,
  CLAUDEDOCK_WEB_RESEARCH_SYSTEM_PROMPT,
} from './web-research';

const RUNTIME_ARTIFACT_DIRECTORY_PREFIX = 'launch-';

interface ClaudeContextWindowSelection {
  customTokens?: number;
  mode: ClaudeContextWindowMode;
}

export interface ClaudeLaunchArtifactInput {
  activityScriptPath?: string;
  allowBypass: boolean;
  claudeContextWindow: ClaudeContextWindowSelection;
  config: NormalizedClaudeConfig;
  contextWindowMode: ManagedChatGptContextWindowMode;
  credential?: string;
  createPermissionEndpoint?: (
    sessionId: string,
    launchGeneration: number,
  ) => { pipeName: string; token: string };
  launchConfig: NormalizedClaudeConfig;
  launchGeneration: number;
  mode: ClaudeLaunchMode;
  permissionHookScriptPath?: string;
  resumeSessionId?: string;
  runtimeLaunchToken: string;
  runtimeModel: string;
  runtimeRoot: string;
  sessionId: string;
  signalScriptPath: string;
  speedProfile: ClaudeServingSpeedProfile;
  startMode?: ClaudePermissionMode;
  statusLineScriptPath: string;
  themeId: TerminalThemeId;
  isWebResearchIsolationEnabled: () => boolean;
  webSearchGuardScriptPath: string;
}

export interface PreparedClaudeLaunchArtifacts {
  activityEventsPath: string;
  artifactDirectory: string;
  environment: ClaudeEnvironmentOverrides;
  exitMarker: string;
  metricsPath: string;
  sessionDirectory: string;
  settingsPath: string;
  signalPath: string;
  turnStopPath: string;
}

interface ClaudeLaunchArtifactPaths {
  activityEventsPath: string;
  artifactDirectory: string;
  metricsPath: string;
  sessionDirectory: string;
  settingsPath: string;
  signalPath: string;
  turnStopPath: string;
}

interface ClaudeLaunchHook {
  command: string;
  shell: string;
  timeout?: number;
  type: string;
}

interface PreparedClaudeLaunchHooks {
  hooks: Record<string, Array<{ hooks: ClaudeLaunchHook[]; matcher?: string }>>;
  webResearchIsolation: boolean;
}

const createArtifactPaths = (
  runtimeRoot: string,
  runtimeLaunchToken: string,
  sessionId: string,
  launchGeneration: number,
): ClaudeLaunchArtifactPaths => {
  const sessionDirectory = path.join(runtimeRoot, sessionId);
  const artifactDirectory = path.join(
    sessionDirectory,
    `${RUNTIME_ARTIFACT_DIRECTORY_PREFIX}${runtimeLaunchToken}-${launchGeneration}`,
  );
  return {
    activityEventsPath: path.join(artifactDirectory, 'events'),
    artifactDirectory,
    metricsPath: path.join(artifactDirectory, 'metrics.json'),
    sessionDirectory,
    settingsPath: path.join(artifactDirectory, 'settings.json'),
    signalPath: path.join(artifactDirectory, 'signal.json'),
    turnStopPath: path.join(artifactDirectory, 'turn-stop.json'),
  };
};

const buildClaudeLaunchHooks = (
  input: ClaudeLaunchArtifactInput,
  paths: ClaudeLaunchArtifactPaths,
): PreparedClaudeLaunchHooks => {
  const activityHook = (event: string): ClaudeLaunchHook | undefined =>
    input.activityScriptPath
      ? {
          command: buildRuntimeActivityCommand(
            input.activityScriptPath,
            paths.activityEventsPath,
            event,
            input.sessionId,
            input.launchGeneration,
            0,
          ),
          shell: 'powershell',
          type: 'command',
        }
      : undefined;
  const activityHookGroup = (event: string): Array<{ hooks: ClaudeLaunchHook[] }> => {
    const hook = activityHook(event);
    return hook ? [{ hooks: [hook] }] : [];
  };
  const stopActivityHook = activityHook('Stop');
  const permissionEndpoint =
    input.permissionHookScriptPath && input.createPermissionEndpoint
      ? input.createPermissionEndpoint(input.sessionId, input.launchGeneration)
      : undefined;
  const permissionRequestHook =
    permissionEndpoint && input.permissionHookScriptPath
      ? {
          command: buildClaudePermissionHookCommand(
            input.permissionHookScriptPath,
            permissionEndpoint.pipeName,
            permissionEndpoint.token,
            input.sessionId,
            input.launchGeneration,
          ),
          shell: 'powershell',
          timeout: 600,
          type: 'command',
        }
      : undefined;

  const webResearchIsolation = input.isWebResearchIsolationEnabled();
  return {
    hooks: {
      ...(input.activityScriptPath
        ? {
            SessionEnd: activityHookGroup('SessionEnd'),
            StopFailure: activityHookGroup('StopFailure'),
            SubagentStart: activityHookGroup('SubagentStart'),
            SubagentStop: activityHookGroup('SubagentStop'),
            TaskCompleted: activityHookGroup('TaskCompleted'),
            TaskCreated: activityHookGroup('TaskCreated'),
            UserPromptSubmit: activityHookGroup('UserPromptSubmit'),
          }
        : {}),
      ...(permissionRequestHook
        ? {
            PermissionRequest: [{ hooks: [permissionRequestHook] }],
          }
        : {}),
      PostCompact: [
        {
          hooks: [
            {
              command: buildRuntimeSignalCommand(
                input.signalScriptPath,
                paths.signalPath,
                'PostCompact',
              ),
              shell: 'powershell',
              type: 'command',
            },
          ],
        },
      ],
      ...(webResearchIsolation
        ? {
            PreToolUse: [
              {
                matcher: 'WebSearch|WebFetch',
                hooks: [
                  {
                    command: buildWebSearchGuardCommand(
                      input.webSearchGuardScriptPath,
                      CLAUDEDOCK_WEB_RESEARCH_AGENT_NAME,
                    ),
                    shell: 'powershell',
                    type: 'command',
                  },
                ],
              },
            ],
          }
        : {}),
      Stop: [
        {
          hooks: [
            {
              command: buildRuntimeSignalCommand(
                input.signalScriptPath,
                paths.turnStopPath,
                'Stop',
              ),
              shell: 'powershell',
              type: 'command',
            },
            ...(stopActivityHook ? [stopActivityHook] : []),
          ],
        },
      ],
    },
    webResearchIsolation,
  };
};

export const claudeCodeThemeForTerminalTheme = (themeId: TerminalThemeId): 'dark' | 'light' =>
  TERMINAL_THEMES[themeId].appearance === 'light' ? 'light' : 'dark';

export const prepareClaudeLaunchArtifacts = (
  input: ClaudeLaunchArtifactInput,
): PreparedClaudeLaunchArtifacts => {
  const paths = createArtifactPaths(
    input.runtimeRoot,
    input.runtimeLaunchToken,
    input.sessionId,
    input.launchGeneration,
  );
  mkdirSync(paths.artifactDirectory, { recursive: true });
  if (input.activityScriptPath) mkdirSync(paths.activityEventsPath, { recursive: true });
  const { hooks, webResearchIsolation } = buildClaudeLaunchHooks(input, paths);

  /*
   * Off unless the user turned it on: the guard hook, the subagent definition and the appended
   * system prompt are a workaround for relays that reject web search at higher effort levels, and
   * a relay without that fault should get a plain Claude Code session.
   */
  const settings = {
    $schema: 'https://json.schemastore.org/claude-code-settings.json',
    ...buildClaudeSpeedSettings(input.speedProfile),
    ...(shouldDisableInheritedApiKeyHelper(input.config) ? { apiKeyHelper: '' } : {}),
    env: buildClaudeSettingsEnvironment(
      input.launchConfig,
      input.contextWindowMode,
      input.speedProfile,
      input.claudeContextWindow.mode,
      input.claudeContextWindow.customTokens,
    ),
    // Hooks remain session-local because this file is passed through Claude Code's --settings.
    hooks,
    model: input.runtimeModel,
    skipWebFetchPreflight: true,
    theme: claudeCodeThemeForTerminalTheme(input.themeId),
    statusLine: {
      command: buildStatusLineCommand(input.statusLineScriptPath, paths.metricsPath),
      refreshInterval: 1,
      type: 'command',
    },
  };
  writeFileSync(paths.settingsPath, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');

  const exitMarker = `${String.fromCharCode(27)}]9;claudedock-exit:${input.sessionId}:${input.launchGeneration}:${Date.now()}${String.fromCharCode(7)}`;
  const launchCommand = buildClaudeLaunchCommand(
    paths.settingsPath,
    input.mode,
    exitMarker,
    input.resumeSessionId,
    { allowBypass: input.allowBypass, startMode: input.startMode },
    webResearchIsolation
      ? {
          agents: CLAUDEDOCK_WEB_RESEARCH_AGENTS,
          appendSystemPrompt: CLAUDEDOCK_WEB_RESEARCH_SYSTEM_PROMPT,
        }
      : {},
  );
  const environment = buildClaudeEnvironment(
    input.launchConfig,
    input.credential,
    input.contextWindowMode,
    input.speedProfile,
    input.claudeContextWindow.mode,
    input.claudeContextWindow.customTokens,
  );
  environment[POWERSHELL_STARTUP_COMMAND_ENV] = launchCommand;

  return {
    ...paths,
    environment,
    exitMarker,
  };
};
