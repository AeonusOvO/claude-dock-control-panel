export type ConversationTransitionQueueState =
  { phase: 'running' } | { phase: 'queued'; position: number; total: number };

export type ConversationTransitionQueueOutcome<T> =
  { status: 'cancelled' } | { status: 'completed'; value: T };

export interface ConversationTransitionQueueTicket<T> {
  /** Cancels only work that has not been admitted yet. */
  cancel: () => boolean;
  result: Promise<ConversationTransitionQueueOutcome<T>>;
}

interface QueueEntry {
  cancelled: boolean;
  notify: (state: ConversationTransitionQueueState) => void;
  run: () => Promise<void>;
  started: boolean;
}

const safeNotify = (entry: QueueEntry, state: ConversationTransitionQueueState): void => {
  try {
    entry.notify(state);
  } catch {
    // Queue ownership must not depend on presentation code surviving a re-render.
  }
};

/**
 * Uses logical processors as a conservative proxy for how many simultaneous CLI preparations the
 * device can absorb without turning Electron's main/renderer loops into a scheduling bottleneck.
 */
export const resolveConversationTransitionConcurrency = (
  hardwareConcurrency = globalThis.navigator?.hardwareConcurrency,
): number => {
  const processors =
    typeof hardwareConcurrency === 'number' &&
    Number.isSafeInteger(hardwareConcurrency) &&
    hardwareConcurrency > 0
      ? hardwareConcurrency
      : 4;
  if (processors <= 2) return 1;
  if (processors <= 4) return 2;
  return Math.min(8, Math.max(3, Math.floor(processors / 2)));
};

/**
 * Shared admission queue for new and restored workspace conversations. Work below the device limit
 * starts concurrently; overflow remains cancellable and is admitted FIFO without blocking the UI.
 */
export class ConversationTransitionQueue {
  private activeCount = 0;
  private drainScheduled = false;
  private readonly waiting: QueueEntry[] = [];

  public constructor(
    private readonly maximumConcurrency = resolveConversationTransitionConcurrency(),
  ) {
    if (!Number.isSafeInteger(maximumConcurrency) || maximumConcurrency < 1) {
      throw new Error('对话任务并发数必须是正整数。');
    }
  }

  public enqueue<T>(
    operation: () => Promise<T>,
    notify: (state: ConversationTransitionQueueState) => void,
  ): ConversationTransitionQueueTicket<T> {
    let resolveResult!: (outcome: ConversationTransitionQueueOutcome<T>) => void;
    let rejectResult!: (reason?: unknown) => void;
    const result = new Promise<ConversationTransitionQueueOutcome<T>>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    const entry: QueueEntry = {
      cancelled: false,
      notify,
      run: async () => {
        try {
          resolveResult({ status: 'completed', value: await operation() });
        } catch (error) {
          rejectResult(error);
        }
      },
      started: false,
    };
    this.waiting.push(entry);
    this.publishWaiting();
    this.scheduleDrain();

    return {
      cancel: () => {
        if (entry.started || entry.cancelled) return false;
        const index = this.waiting.indexOf(entry);
        if (index < 0) return false;
        entry.cancelled = true;
        this.waiting.splice(index, 1);
        resolveResult({ status: 'cancelled' });
        this.publishWaiting();
        return true;
      },
      result,
    };
  }

  private drain(): void {
    this.drainScheduled = false;
    while (this.activeCount < this.maximumConcurrency) {
      const entry = this.waiting.shift();
      if (!entry) break;
      if (entry.cancelled) continue;
      entry.started = true;
      this.activeCount += 1;
      safeNotify(entry, { phase: 'running' });
      void entry.run().finally(() => {
        this.activeCount = Math.max(0, this.activeCount - 1);
        this.publishWaiting();
        this.scheduleDrain();
      });
    }
    this.publishWaiting();
  }

  private publishWaiting(): void {
    const total = this.waiting.length;
    this.waiting.forEach((entry, index) => {
      safeNotify(entry, { phase: 'queued', position: index + 1, total });
    });
  }

  private scheduleDrain(): void {
    if (this.drainScheduled) return;
    this.drainScheduled = true;
    void Promise.resolve().then(() => this.drain());
  }
}
