import { CHANNELS } from '../../shared/ipc/channels';
import { ipcMain } from 'electron';
import type { OperationResult, TerminalStatus } from '../../shared/contracts';
import { MAX_TERMINAL_WRITE_LENGTH } from '../../shared/contracts/terminal';
import { createFailureReporter } from '../infra/logger';
import type { Registry } from '../infra/registry';
import { MAIN_WINDOW } from '../infra/service-tokens';
import type { TerminalTransitionCoordinator } from '../terminal/lifecycle';
import type { TerminalWorkspace } from '../terminal/workspace';
import { validatePtyGeneration, validateSessionId } from './validation';
import type { MainGuards } from './guards';

export interface TerminalIpcDependencies {
  /* The tray menu drives the same transitions, so the coordinator is owned by the assembly. */
  directTerminalTransitions: TerminalTransitionCoordinator;
  guards: Pick<MainGuards, 'validateSender'>;
  services: Registry;
  workspace: TerminalWorkspace;
}

const reportTerminalFailure = createFailureReporter('terminal');

export const registerTerminalIpc = ({
  directTerminalTransitions,
  guards: { validateSender },
  services,
  workspace,
}: TerminalIpcDependencies): void => {
  const failedOperation = (
    message: string,
    detail: unknown,
    status: TerminalStatus | undefined,
  ): OperationResult => ({
    ...reportTerminalFailure('environment', message, detail),
    error: message,
    ok: false,
    status,
  });
  const operationFromStatus = (status: TerminalStatus): OperationResult =>
    status.phase === 'error'
      ? failedOperation(status.message ?? '终端操作失败。', status, status)
      : { ok: true, status };
  ipcMain.handle(
    CHANNELS.TERMINAL_START,
    async (event, sessionId: unknown, expectedGeneration: unknown) => {
      validateSender(event);
      try {
        const validatedSessionId = validateSessionId(sessionId);
        const validatedGeneration = validatePtyGeneration(expectedGeneration);
        const status = await directTerminalTransitions.run(
          validatedSessionId,
          validatedGeneration,
          () => workspace.start(validatedSessionId),
        );
        return operationFromStatus(status);
      } catch (error) {
        const message = error instanceof Error ? error.message : '无法启动终端。';
        return failedOperation(message, error, workspace.getActiveStatus());
      }
    },
  );
  ipcMain.handle(
    CHANNELS.TERMINAL_RESTART,
    async (event, sessionId: unknown, expectedGeneration: unknown) => {
      validateSender(event);
      try {
        const validatedSessionId = validateSessionId(sessionId);
        const validatedGeneration = validatePtyGeneration(expectedGeneration);
        const status = await directTerminalTransitions.run(
          validatedSessionId,
          validatedGeneration,
          () => workspace.restart(validatedSessionId),
        );
        return operationFromStatus(status);
      } catch (error) {
        const message = error instanceof Error ? error.message : '无法重启终端。';
        return failedOperation(message, error, workspace.getActiveStatus());
      }
    },
  );
  ipcMain.handle(
    CHANNELS.TERMINAL_STOP,
    async (event, sessionId: unknown, expectedGeneration: unknown) => {
      validateSender(event);
      try {
        const validatedSessionId = validateSessionId(sessionId);
        const validatedGeneration = validatePtyGeneration(expectedGeneration);
        const status = await directTerminalTransitions.run(
          validatedSessionId,
          validatedGeneration,
          () => workspace.stop(validatedSessionId),
        );
        return operationFromStatus(status);
      } catch (error) {
        const message = error instanceof Error ? error.message : '无法停止终端。';
        return failedOperation(message, error, workspace.getActiveStatus());
      }
    },
  );
  ipcMain.on(
    CHANNELS.TERMINAL_WRITE,
    (event, sessionId: unknown, ptyGeneration: unknown, data: unknown) => {
      validateSender(event);
      if (typeof data !== 'string' || data.length > MAX_TERMINAL_WRITE_LENGTH) {
        return;
      }
      try {
        workspace.write(validateSessionId(sessionId), validatePtyGeneration(ptyGeneration), data);
      } catch {
        // A stale renderer event can arrive immediately after a project is closed.
      }
    },
  );
  ipcMain.on(
    CHANNELS.TERMINAL_RESIZE,
    (
      event,
      sessionId: unknown,
      ptyGeneration: unknown,
      resizeRevision: unknown,
      cols: unknown,
      rows: unknown,
    ) => {
      validateSender(event);
      if (
        typeof resizeRevision !== 'number' ||
        !Number.isSafeInteger(resizeRevision) ||
        resizeRevision < 0 ||
        typeof cols !== 'number' ||
        typeof rows !== 'number'
      ) {
        return;
      }
      try {
        const validatedSessionId = validateSessionId(sessionId);
        const validatedGeneration = validatePtyGeneration(ptyGeneration);
        const applied = workspace.resize(validatedSessionId, validatedGeneration, cols, rows);
        if (!applied) {
          return;
        }
        // This is the app-normalized request, not an OS/ConPTY acknowledgement.
        services
          .resolve(MAIN_WINDOW)
          .current?.webContents.send(
            CHANNELS.TERMINAL_SIZE,
            validatedSessionId,
            validatedGeneration,
            resizeRevision,
            applied.cols,
            applied.rows,
          );
      } catch {
        // A ResizeObserver callback can race with project closure.
      }
    },
  );
};
