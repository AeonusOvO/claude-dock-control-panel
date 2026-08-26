import type {
  StartupModelConnectionCancelResult,
  StartupModelConnectionState,
} from '../../shared/contracts';
import type { StartupModelRestoreOutcome } from './startup-model-restore';

export interface StartupModelConnectionTiming {
  cancelAfterMs: number;
  forceStopAfterMs: number;
}

export interface StartupModelConnectionRunContext {
  assertActive: () => void;
  signal: AbortSignal;
  updateDetail: (detail: string) => void;
}

type StartupModelConnectionListener = (state: StartupModelConnectionState) => void;

interface ActiveStartupModelConnection {
  cancelReason?: 'shutdown' | 'timeout' | 'user';
  completion: Promise<void>;
  controller: AbortController;
  forceStopTimer: NodeJS.Timeout;
  resolveCompletion: () => void;
}

const initialState = (): StartupModelConnectionState => ({
  active: false,
  detail: '当前没有正在进行的启动模型接入。',
  phase: 'idle',
  updatedAt: Date.now(),
});

const completedPhase = (
  outcome: StartupModelRestoreOutcome,
): Pick<StartupModelConnectionState, 'detail' | 'phase'> => {
  if (outcome === 'restored') {
    return { detail: '最近一次选择的平台和模型已完成验证并接入。', phase: 'connected' };
  }
  if (outcome === 'failed') {
    return { detail: '自动接入未完成，原接入保持不变。', phase: 'failed' };
  }
  if (outcome === 'cancelled') {
    return { detail: '启动模型接入已取消，原接入保持不变。', phase: 'cancelled' };
  }
  return { detail: '本次启动不需要恢复模型接入。', phase: 'skipped' };
};

/**
 * Owns the one startup model-connection transaction across window navigation and renderer reloads.
 * Cancellation aborts the main-process operation; the operation remains active until rollback has
 * unwound, so the UI can never report success while stale work is still able to commit.
 */
export class StartupModelConnectionCoordinator {
  private active: ActiveStartupModelConnection | undefined;
  private readonly listeners = new Set<StartupModelConnectionListener>();
  private state = initialState();

  public getState(): StartupModelConnectionState {
    return { ...this.state };
  }

  public onChanged(listener: StartupModelConnectionListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public async run(
    timing: StartupModelConnectionTiming,
    operation: (context: StartupModelConnectionRunContext) => Promise<StartupModelRestoreOutcome>,
  ): Promise<StartupModelRestoreOutcome> {
    if (this.active) {
      throw new Error('启动模型接入已经在进行中。');
    }
    if (
      !Number.isSafeInteger(timing.cancelAfterMs) ||
      !Number.isSafeInteger(timing.forceStopAfterMs) ||
      timing.cancelAfterMs < 0 ||
      timing.forceStopAfterMs <= timing.cancelAfterMs
    ) {
      throw new Error('启动模型接入超时设置无效。');
    }

    const startedAt = Date.now();
    let resolveCompletion!: () => void;
    const completion = new Promise<void>((resolve) => {
      resolveCompletion = resolve;
    });
    const controller = new AbortController();
    const active: ActiveStartupModelConnection = {
      completion,
      controller,
      forceStopTimer: setTimeout(() => {
        void this.cancel('timeout');
      }, timing.forceStopAfterMs),
      resolveCompletion,
    };
    this.active = active;
    this.publish({
      active: true,
      cancelAvailableAt: startedAt + timing.cancelAfterMs,
      detail: '正在读取最近一次会话的平台、账号与模型配置。',
      forceStopAt: startedAt + timing.forceStopAfterMs,
      phase: 'connecting',
      startedAt,
      updatedAt: startedAt,
    });

    const assertActive = (): void => {
      if (this.active !== active || controller.signal.aborted) {
        const reason = controller.signal.reason;
        throw reason instanceof Error ? reason : new Error('启动模型接入已取消。');
      }
    };

    let outcome: StartupModelRestoreOutcome = 'failed';
    try {
      outcome = await operation({
        assertActive,
        signal: controller.signal,
        updateDetail: (detail) => {
          if (this.active !== active || active.cancelReason) return;
          this.publish({ ...this.state, detail, updatedAt: Date.now() });
        },
      });
      if (controller.signal.aborted) {
        outcome = 'cancelled';
      }
      return outcome;
    } catch (error) {
      if (controller.signal.aborted) {
        outcome = 'cancelled';
        return outcome;
      }
      throw error;
    } finally {
      clearTimeout(active.forceStopTimer);
      if (this.active === active) {
        this.active = undefined;
      }
      const finishedAt = Date.now();
      const completionState = active.cancelReason
        ? active.cancelReason === 'timeout'
          ? {
              detail: '自动接入已达到最大等待时间并安全终止，原接入保持不变。',
              phase: 'timed-out' as const,
            }
          : active.cancelReason === 'shutdown'
            ? {
                detail: '启动模型接入已为软件退出安全取消，原接入保持不变。',
                phase: 'cancelled' as const,
              }
            : {
                detail: '启动模型接入已取消，原接入保持不变。',
                phase: 'cancelled' as const,
              }
        : completedPhase(outcome);
      this.publish({
        active: false,
        detail: completionState.detail,
        finishedAt,
        phase: completionState.phase,
        startedAt,
        updatedAt: finishedAt,
      });
      active.resolveCompletion();
    }
  }

  public async cancel(
    reason: 'shutdown' | 'timeout' | 'user' = 'user',
  ): Promise<StartupModelConnectionCancelResult> {
    const active = this.active;
    if (!active) {
      return { message: '当前没有正在进行的启动模型接入。', ok: false, state: this.getState() };
    }
    const now = Date.now();
    if (
      reason === 'user' &&
      this.state.cancelAvailableAt !== undefined &&
      now < this.state.cancelAvailableAt
    ) {
      return {
        message: '自动接入仍在正常准备阶段，请等待取消按钮出现。',
        ok: false,
        state: this.getState(),
      };
    }
    if (!active.cancelReason) {
      active.cancelReason = reason;
      this.publish({
        ...this.state,
        active: true,
        detail:
          reason === 'timeout'
            ? '已达到最大等待时间，正在终止接入并回滚临时状态…'
            : reason === 'shutdown'
              ? '软件正在退出，正在取消接入并回滚临时状态…'
              : '正在取消接入并回滚临时状态…',
        phase: 'cancelling',
        updatedAt: now,
      });
      active.controller.abort(
        new Error(
          reason === 'timeout'
            ? '启动模型接入达到最大等待时间。'
            : reason === 'shutdown'
              ? '软件退出时取消了启动模型接入。'
              : '用户取消了启动模型接入。',
        ),
      );
    }
    await active.completion;
    return {
      message:
        reason === 'timeout'
          ? '自动接入已达到最大等待时间并安全终止。'
          : reason === 'shutdown'
            ? '启动模型接入已在退出前安全取消。'
            : '启动模型接入已取消。',
      ok: true,
      state: this.getState(),
    };
  }

  private publish(state: StartupModelConnectionState): void {
    // Date.now() can repeat inside one millisecond. Keep this fence strictly monotonic so a delayed
    // renderer snapshot can never overwrite a newer progress event with an equal timestamp.
    this.state = {
      ...state,
      updatedAt: Math.max(state.updatedAt, this.state.updatedAt + 1),
    };
    for (const listener of this.listeners) {
      try {
        listener(this.getState());
      } catch {
        // A renderer/tray observer is presentation-only and must never abort or commit the owner.
      }
    }
  }
}
