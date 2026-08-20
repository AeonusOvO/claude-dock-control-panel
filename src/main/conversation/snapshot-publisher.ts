import { CHANNELS } from '../../shared/ipc/channels';
import type { ConversationSnapshot } from '../../shared/conversation/native';
import type { Registry } from '../infra/registry';
import { MAIN_WINDOW } from '../infra/service-tokens';
import type { MainState } from '../ipc/context';

export interface NativeSnapshotPublisherDependencies {
  services: Registry;
  state: MainState;
}

export type PublishNativeSnapshot = (snapshot: ConversationSnapshot) => void;

/**
 * Coalesces snapshot broadcasts onto a short timer. `onSnapshot` fires for every adapter event,
 * and with `includePartialMessages` that is once per streamed token; each send structured-clones
 * the whole transcript in the main process and again in the renderer. Sending only the newest
 * snapshot per conversation per tick keeps that cost bounded by wall time instead of token rate,
 * without changing what the renderer receives — snapshots are absolute, so dropping an
 * intermediate one loses nothing.
 *
 * Terminal phases bypass the timer: the renderer releases queued input and tears down owners on
 * those, and they must not sit behind a pending tick.
 */
const NATIVE_SNAPSHOT_FLUSH_MS = 50;

export const createPublishNativeSnapshot = ({
  services,
  state,
}: NativeSnapshotPublisherDependencies): PublishNativeSnapshot => {
  const pendingNativeSnapshots = new Map<string, ConversationSnapshot>();

  const flushNativeSnapshots = (): void => {
    if (state.nativeSnapshotFlushTimer) {
      clearTimeout(state.nativeSnapshotFlushTimer);
      state.nativeSnapshotFlushTimer = undefined;
    }
    if (pendingNativeSnapshots.size === 0) return;
    const snapshots = [...pendingNativeSnapshots.values()];
    pendingNativeSnapshots.clear();
    // Unlike the direct send this replaced, this can now run from a timer, so the window may have gone
    // away in between. Sending to a destroyed webContents throws, and from a timer that would surface
    // as an uncaught main-process exception dialog rather than a rejected IPC call.
    const target = services.resolve(MAIN_WINDOW).current?.webContents;
    if (!target || target.isDestroyed() || target.isCrashed()) return;
    for (const snapshot of snapshots) {
      target.send(CHANNELS.NATIVE_CONVERSATION_SNAPSHOT, snapshot);
    }
  };

  const publishNativeSnapshot: PublishNativeSnapshot = (snapshot) => {
    if (
      snapshot.phase === 'idle' ||
      snapshot.phase === 'failed' ||
      snapshot.phase === 'stopped' ||
      snapshot.phase === 'requires-action'
    ) {
      pendingNativeSnapshots.set(snapshot.conversationId, snapshot);
      flushNativeSnapshots();
      return;
    }
    pendingNativeSnapshots.set(snapshot.conversationId, snapshot);
    state.nativeSnapshotFlushTimer ??= setTimeout(flushNativeSnapshots, NATIVE_SNAPSHOT_FLUSH_MS);
  };

  return publishNativeSnapshot;
};
