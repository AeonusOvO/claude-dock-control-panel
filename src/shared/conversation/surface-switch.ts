import type { RuntimeActivitySnapshot } from '../contracts';
import type { ConversationSnapshot } from './native';

const ACTIVE_TASK_STATUSES = new Set(['queued', 'running', 'waiting']);

export interface ConfirmableConversationSurfaceSwitchResult {
  ok: boolean;
  requiresConfirmation?: boolean;
}

export type ConversationSurfaceSwitchAttempt<TResult> =
  { cancelled: true } | { cancelled: false; result: TResult };

/**
 * Runs one renderer surface switch without ever sending an interrupt-authorized IPC before the
 * user confirms it. The main process remains authoritative: an apparently idle renderer can make
 * one non-destructive attempt and ask only if the main process reports a late busy transition.
 */
export const runConfirmableConversationSurfaceSwitch = async <
  TResult extends ConfirmableConversationSurfaceSwitchResult,
>(
  locallyBusy: boolean,
  confirmInterrupt: () => Promise<boolean>,
  invoke: (allowInterrupt: boolean) => Promise<TResult>,
): Promise<ConversationSurfaceSwitchAttempt<TResult>> => {
  const allowInterrupt = locallyBusy;
  if (allowInterrupt && !(await confirmInterrupt())) return { cancelled: true };

  let result = await invoke(allowInterrupt);
  if (!allowInterrupt && result.requiresConfirmation) {
    if (!(await confirmInterrupt())) return { cancelled: true };
    result = await invoke(true);
  }
  return { cancelled: false, result };
};

/** Prefer the tab already bound to the conversation, then a compatible active tab. */
export const selectReusableConversationSurfaceSession = (
  candidates: readonly (string | undefined)[],
  isUsable: (sessionId: string) => boolean,
): string | undefined => {
  for (const candidate of candidates) {
    if (candidate && isUsable(candidate)) return candidate;
  }
  return undefined;
};

/**
 * True when replacing the terminal runtime could interrupt work that is still in flight.
 *
 * The top-level phase is not sufficient on its own: Claude can be idle while a background task or
 * a derived Web process is still alive, and it can be between background completion and resuming
 * the foreground response.
 */
export const terminalConversationHasRunningWork = (
  activity: RuntimeActivitySnapshot | undefined,
): boolean =>
  Boolean(
    activity &&
    (activity.phase === 'foreground-running' ||
      activity.phase === 'waiting-background' ||
      activity.phase === 'resuming' ||
      activity.tasks.some((task) => ACTIVE_TASK_STATUSES.has(task.status)) ||
      activity.webProcesses.some(
        (process) => process.status === 'running' || process.status === 'stopping',
      )),
  );

/** True when closing the Agent SDK runtime could interrupt a turn or unfinished background task. */
export const nativeConversationHasRunningWork = (
  snapshot: ConversationSnapshot | undefined,
): boolean =>
  Boolean(
    snapshot &&
    (snapshot.phase === 'starting' ||
      snapshot.phase === 'running' ||
      snapshot.phase === 'requires-action' ||
      snapshot.phase === 'stopping' ||
      snapshot.tasks.some((task) => ACTIVE_TASK_STATUSES.has(task.status))),
  );
