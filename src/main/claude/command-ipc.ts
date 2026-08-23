import { ipcMain } from 'electron';
import type { ClaudeOperationResult } from '../../shared/contracts';
import { CHANNELS } from '../../shared/ipc/channels';
import { claudeRunnableCommands } from '../../shared/ui/cli-command-catalog';
import { validateSessionId } from '../ipc/validation';
import type { ClaudeLaunchIpcDependencies } from './launch-ipc-dependencies';

const claudeCommands = claudeRunnableCommands();

export const registerClaudeCommandIpc = ({
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
