import { CHANNELS } from '../../shared/ipc/channels';
import { ipcMain } from 'electron';
import type {
  ClaudeOperationResult,
  ClaudeProjectState,
  PtyGeneration,
} from '../../shared/contracts';
import { claudeRunnableCommands } from '../../shared/ui/cli-command-catalog';
import type { RunClaudeProjectConfigTransaction } from '../claude/config-transaction';
import type { ClaudeConversationLifecycleCoordinator } from '../claude/conversation-lifecycle';
import type { ReportClaudeOperationFailure } from '../claude/operation-failure';
import type { PreparedClaudeConfigSave } from '../claude/runtime';
import { isValidClaudeSessionId } from '../claude/session-manager';
import type { ConversationOwner, ConversationOwnerRegistry } from '../conversation/owner-registry';
import type { WithSessionOperation } from '../coordination/session-operation';
import type { AgentRuntimeStore } from '../runtime/store';
import {
  cleanupFailedRuntimeLaunch,
  type FailedRuntimeLaunchCleanupDependencies,
  type RestartRuntimeTerminal,
  type ResumeConversationInTerminal,
} from '../terminal/lifecycle';
import type { TerminalWorkspace } from '../terminal/workspace';
import {
  validateClaudeLaunchMode,
  validateClaudeRelaunchInput,
  validateSessionId,
} from './validation';
import type { MainGuards } from './guards';

const claudeCommands = claudeRunnableCommands();

export interface ClaudeLaunchIpcDependencies {
  agentRuntimeStore: AgentRuntimeStore;
  claudeConversationLifecycle: ClaudeConversationLifecycleCoordinator;
  claudeFailure: ReportClaudeOperationFailure;
  conversationOwnerRegistry: ConversationOwnerRegistry;
  failedRuntimeLaunchCleanupDependencies: FailedRuntimeLaunchCleanupDependencies;
  guards: Pick<
    MainGuards,
    'assertOfficialProviderAllowed' | 'requireClaudeRuntime' | 'validateSender'
  >;
  releaseTerminalConversationOwner: (sessionId: string) => void;
  restartRuntimeTerminal: RestartRuntimeTerminal;
  runClaudeProjectConfigTransaction: RunClaudeProjectConfigTransaction;
  runClaudeResumeLaunch: ResumeConversationInTerminal;
  terminalConversationOwners: Map<string, ConversationOwner>;
  withDevelopmentSessionOperation: WithSessionOperation;
  workspace: TerminalWorkspace;
}

const registerClaudeRelaunchIpc = ({
  claudeFailure,
  failedRuntimeLaunchCleanupDependencies,
  guards: { assertOfficialProviderAllowed, requireClaudeRuntime, validateSender },
  restartRuntimeTerminal,
  runClaudeProjectConfigTransaction,
  withDevelopmentSessionOperation,
  workspace,
}: ClaudeLaunchIpcDependencies): void => {
  ipcMain.handle(
    CHANNELS.CLAUDE_RELAUNCH,
    async (event, sessionId: unknown, input: unknown): Promise<ClaudeOperationResult> => {
      validateSender(event);
      const validatedSessionId = validateSessionId(sessionId);
      const status = workspace.getStatus(validatedSessionId);
      const runtime = requireClaudeRuntime();
      try {
        const validatedInput = validateClaudeRelaunchInput(input);
        return await withDevelopmentSessionOperation(
          validatedSessionId,
          async (assertCurrent, signal) => {
            let launchPrepared = false;
            let ownedGeneration: PtyGeneration | undefined;
            const launchReplacement = async (): Promise<ClaudeProjectState> => {
              const prepared = await runtime.prepareLaunch(
                validatedSessionId,
                status.cwd,
                'continue',
                validatedInput.permissionMode,
              );
              launchPrepared = true;
              ownedGeneration = prepared.predecessorPtyGeneration;
              assertCurrent();
              restartRuntimeTerminal(
                runtime,
                validatedSessionId,
                prepared.environment,
                prepared.command,
                '无法为 Claude Code 启动安全终端。',
                assertCurrent,
                (ptyGeneration) => {
                  ownedGeneration = ptyGeneration;
                },
              );
              const state = await runtime.getState(validatedSessionId, status.cwd);
              assertCurrent();
              return state;
            };

            try {
              const entryId = validatedInput.entryId;
              if (!entryId) {
                const officialProvider = runtime.officialNetworkProvider(status.cwd);
                if (officialProvider) {
                  await assertOfficialProviderAllowed(officialProvider, 'cli-launch', status.cwd);
                  assertCurrent();
                }
                await runtime.compactBeforeRelaunch(
                  validatedSessionId,
                  status.cwd,
                  validatedInput.compactFirst,
                  assertCurrent,
                  signal,
                );
                assertCurrent();
                return { ok: true, state: await launchReplacement() };
              }

              const state = await runClaudeProjectConfigTransaction<PreparedClaudeConfigSave>({
                assertCurrent,
                commit: (prepared) => runtime.commitPreparedConfig(status.cwd, prepared),
                complete: async (prepared) => {
                  await runtime.completePreparedConfigSave(
                    validatedSessionId,
                    status.cwd,
                    prepared,
                  );
                  assertCurrent();
                  return launchReplacement();
                },
                cwd: status.cwd,
                prepare: async () => {
                  const officialProvider = runtime.connectionHistoryOfficialNetworkProvider(
                    status.cwd,
                    entryId,
                  );
                  if (officialProvider) {
                    await assertOfficialProviderAllowed(officialProvider, 'cli-launch', status.cwd);
                    assertCurrent();
                  }
                  await runtime.compactBeforeRelaunch(
                    validatedSessionId,
                    status.cwd,
                    validatedInput.compactFirst,
                    assertCurrent,
                    signal,
                  );
                  assertCurrent();
                  return runtime.prepareConnectionHistory(status.cwd, entryId, assertCurrent);
                },
                runtime,
                sessionId: validatedSessionId,
              });
              return { ok: true, state };
            } catch (error) {
              if (launchPrepared || ownedGeneration !== undefined) {
                cleanupFailedRuntimeLaunch(
                  failedRuntimeLaunchCleanupDependencies,
                  runtime,
                  validatedSessionId,
                  ownedGeneration,
                );
              }
              return claudeFailure(validatedSessionId, error);
            }
          },
        );
      } catch (error) {
        return claudeFailure(validatedSessionId, error);
      }
    },
  );
};

const registerClaudeStartIpc = ({
  agentRuntimeStore,
  claudeConversationLifecycle,
  claudeFailure,
  failedRuntimeLaunchCleanupDependencies,
  guards: { assertOfficialProviderAllowed, requireClaudeRuntime, validateSender },
  restartRuntimeTerminal,
  withDevelopmentSessionOperation,
  workspace,
}: ClaudeLaunchIpcDependencies): void => {
  ipcMain.handle(
    CHANNELS.CLAUDE_LAUNCH,
    async (event, sessionId: unknown, mode: unknown): Promise<ClaudeOperationResult> => {
      validateSender(event);
      const validatedSessionId = validateSessionId(sessionId);
      const status = workspace.getStatus(validatedSessionId);
      const runtime = requireClaudeRuntime();
      try {
        const launchMode = validateClaudeLaunchMode(mode);
        return await withDevelopmentSessionOperation(validatedSessionId, async (assertCurrent) => {
          const executeLaunch = async (
            assertConversationCurrent: () => void = () => undefined,
          ): Promise<ClaudeOperationResult> => {
            const assertLaunchCurrent = (): void => {
              assertConversationCurrent();
              assertCurrent();
            };
            let launchPrepared = false;
            let ownedGeneration: PtyGeneration | undefined;
            try {
              if (agentRuntimeStore.get(status.cwd) !== 'claude') {
                throw new Error('当前项目尚未选择 Claude Code 开发引擎。');
              }
              const officialProvider = runtime.officialNetworkProvider(status.cwd);
              if (officialProvider) {
                await assertOfficialProviderAllowed(officialProvider, 'cli-launch', status.cwd);
                assertLaunchCurrent();
              }
              const prepared = await runtime.prepareLaunch(
                validatedSessionId,
                status.cwd,
                launchMode,
              );
              launchPrepared = true;
              ownedGeneration = prepared.predecessorPtyGeneration;
              assertLaunchCurrent();
              if (agentRuntimeStore.get(status.cwd) !== 'claude') {
                throw new Error('当前项目已切换开发引擎，这次 Claude 启动已取消。');
              }
              restartRuntimeTerminal(
                runtime,
                validatedSessionId,
                prepared.environment,
                prepared.command,
                '无法为 Claude Code 启动安全终端。',
                assertLaunchCurrent,
                (ptyGeneration) => {
                  ownedGeneration = ptyGeneration;
                },
              );
              const state = await runtime.getState(validatedSessionId, status.cwd);
              assertLaunchCurrent();
              return { ok: true, state };
            } catch (error) {
              if (launchPrepared || ownedGeneration !== undefined) {
                cleanupFailedRuntimeLaunch(
                  failedRuntimeLaunchCleanupDependencies,
                  runtime,
                  validatedSessionId,
                  ownedGeneration,
                );
              }
              return claudeFailure(validatedSessionId, error);
            }
          };

          return launchMode === 'new'
            ? executeLaunch()
            : claudeConversationLifecycle.runResume(
                status.cwd,
                undefined,
                validatedSessionId,
                async (conversationOwnership) =>
                  executeLaunch(() => conversationOwnership.assertCurrent()),
              );
        });
      } catch (error) {
        return claudeFailure(validatedSessionId, error);
      }
    },
  );
};

const registerClaudeCommandIpc = ({
  claudeFailure,
  guards: { requireClaudeRuntime, validateSender },
  withDevelopmentSessionOperation,
  workspace,
}: ClaudeLaunchIpcDependencies): void => {
  ipcMain.handle(
    CHANNELS.CLAUDE_COMMAND,
    async (
      event,
      sessionId: unknown,
      command: unknown,
      argument: unknown,
    ): Promise<ClaudeOperationResult> => {
      validateSender(event);
      const validatedSessionId = validateSessionId(sessionId);
      const runtime = requireClaudeRuntime();
      try {
        if (typeof command !== 'string' || !claudeCommands.has(command)) {
          throw new Error('该 Claude 命令不在可视化命令白名单中。');
        }
        if (!runtime.isActive(validatedSessionId)) {
          throw new Error('请先通过 Claude 工作台启动会话，再执行可视化命令。');
        }
        const acceptsArgument = claudeCommands.get(command) ?? false;
        const normalizedArgument =
          typeof argument === 'string' && acceptsArgument ? argument.trim() : '';
        if (
          normalizedArgument.length > 500 ||
          /[\r\n]/.test(normalizedArgument) ||
          (!acceptsArgument && typeof argument === 'string' && argument.trim())
        ) {
          throw new Error('命令参数无效。');
        }
        const status = workspace.getStatus(validatedSessionId);
        return {
          ok: true,
          state: await withDevelopmentSessionOperation(validatedSessionId, () =>
            runtime.runCommand(
              validatedSessionId,
              status.cwd,
              `${command}${normalizedArgument ? ` ${normalizedArgument}` : ''}`,
            ),
          ),
        };
      } catch (error) {
        return claudeFailure(validatedSessionId, error);
      }
    },
  );
};

const registerClaudeSessionLaunchIpc = ({
  claudeConversationLifecycle,
  claudeFailure,
  conversationOwnerRegistry,
  guards: { assertOfficialProviderAllowed, requireClaudeRuntime, validateSender },
  releaseTerminalConversationOwner,
  runClaudeResumeLaunch,
  terminalConversationOwners,
  withDevelopmentSessionOperation,
  workspace,
}: ClaudeLaunchIpcDependencies): void => {
  ipcMain.handle(
    CHANNELS.CLAUDE_LAUNCH_WITH_SESSION,
    async (event, sessionId: unknown, conversationId: unknown): Promise<ClaudeOperationResult> => {
      validateSender(event);
      const validatedSessionId = validateSessionId(sessionId);
      const status = workspace.getStatus(validatedSessionId);
      const runtime = requireClaudeRuntime();
      try {
        return await withDevelopmentSessionOperation(validatedSessionId, async (assertCurrent) => {
          if (typeof conversationId !== 'string' || !isValidClaudeSessionId(conversationId)) {
            throw new Error('会话标识无效。');
          }
          const existingOwner = conversationOwnerRegistry.ownerFor({
            conversationId,
            projectPath: status.cwd,
            runtime: 'claude',
          });
          if (existingOwner) {
            if (existingOwner.ownerId === `terminal:${validatedSessionId}`) {
              return { ok: true, state: await runtime.getState(validatedSessionId, status.cwd) };
            }
            throw new Error(
              existingOwner.ownerKind === 'native'
                ? '该对话已在原生界面运行。'
                : '该对话已在另一个高级终端运行。',
            );
          }
          const terminalOwner: ConversationOwner = {
            conversationId: conversationId.toLowerCase(),
            generation: Number(status.ptyGeneration) + 1,
            ownerId: `terminal:${validatedSessionId}`,
            ownerKind: 'terminal',
            phase: 'starting',
            projectPath: status.cwd,
            runtime: 'claude',
          };
          const ownerClaim = conversationOwnerRegistry.claim(terminalOwner);
          if (ownerClaim.status === 'conflict') {
            throw new Error('该对话刚刚被其他界面接管。');
          }
          terminalConversationOwners.set(validatedSessionId, ownerClaim.owner);
          return claudeConversationLifecycle.runResume(
            status.cwd,
            conversationId,
            validatedSessionId,
            async (conversationOwnership) => {
              const assertResumeCurrent = (): void => {
                conversationOwnership.assertCurrent();
                assertCurrent();
              };
              try {
                const officialProvider = runtime.officialNetworkProvider(status.cwd);
                if (officialProvider) {
                  await assertOfficialProviderAllowed(officialProvider, 'cli-launch', status.cwd);
                  assertResumeCurrent();
                }
                await runClaudeResumeLaunch(
                  validatedSessionId,
                  status.cwd,
                  conversationId,
                  '无法为 Claude Code 启动安全终端。',
                  assertResumeCurrent,
                );
                const state = await runtime.getState(validatedSessionId, status.cwd);
                assertResumeCurrent();
                conversationOwnerRegistry.updatePhase(
                  terminalOwner,
                  terminalOwner.ownerId,
                  terminalOwner.generation,
                  'active',
                );
                return { ok: true, state };
              } catch (error) {
                releaseTerminalConversationOwner(validatedSessionId);
                return claudeFailure(validatedSessionId, error);
              }
            },
          );
        });
      } catch (error) {
        return claudeFailure(validatedSessionId, error);
      }
    },
  );
};

export const registerClaudeLaunchIpc = (dependencies: ClaudeLaunchIpcDependencies): void => {
  registerClaudeRelaunchIpc(dependencies);
  registerClaudeStartIpc(dependencies);
  registerClaudeCommandIpc(dependencies);
  registerClaudeSessionLaunchIpc(dependencies);
};
