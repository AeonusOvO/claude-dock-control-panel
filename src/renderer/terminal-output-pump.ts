export interface PendingTerminalOutput {
  data: string;
  revision: number;
}

export interface TerminalWritePlan {
  completedRevision: number;
  data: string;
  endIndex: number;
  endOffset: number;
  units: number;
}

export interface TerminalOutputPumpOptions {
  cancelFrame: (handle: number) => void;
  isCurrent: () => boolean;
  onAppliedRevision: (revision: number) => void;
  scheduleFrame: (callback: () => void) => number;
  write: (data: string, callback: () => void) => void;
  writeQuantumUnits?: number;
}

export const TERMINAL_WRITE_QUANTUM_UNITS = 64 * 1024;

const isHighSurrogate = (unit: string | undefined): boolean => {
  const code = unit?.charCodeAt(0);
  return code !== undefined && code >= 0xd800 && code <= 0xdbff;
};

const isLowSurrogate = (unit: string | undefined): boolean => {
  const code = unit?.charCodeAt(0);
  return code !== undefined && code >= 0xdc00 && code <= 0xdfff;
};

/** Builds one bounded xterm write without consuming the live queue. */
export const createTerminalWritePlan = (
  pending: readonly PendingTerminalOutput[],
  maximumUnits: number,
): TerminalWritePlan | undefined => {
  if (!Number.isSafeInteger(maximumUnits) || maximumUnits < 2) {
    throw new Error('Terminal write quantum must contain at least two UTF-16 units.');
  }

  const parts: string[] = [];
  let completedRevision = 0;
  let endIndex = -1;
  let endOffset = 0;
  let units = 0;

  for (let index = 0; index < pending.length && units < maximumUnits; index += 1) {
    const output = pending[index];
    if (!output || output.data.length === 0) {
      continue;
    }
    const remaining = maximumUnits - units;
    if (index > 0 && output.data.length > remaining) {
      // Do not start a later revision unless this plan can finish it. A probe waiting for an earlier
      // revision must never inspect a screen containing only the first half of a later IPC batch.
      break;
    }

    let take = Math.min(output.data.length, remaining);
    if (
      take < output.data.length &&
      isHighSurrogate(output.data[take - 1]) &&
      isLowSurrogate(output.data[take])
    ) {
      take -= 1;
    } else if (
      take === output.data.length &&
      units + take === maximumUnits &&
      isHighSurrogate(output.data[take - 1]) &&
      isLowSurrogate(pending[index + 1]?.data[0])
    ) {
      take -= 1;
    }
    if (take === 0) {
      break;
    }

    parts.push(output.data.slice(0, take));
    units += take;
    endIndex = index;
    endOffset = take;
    if (take === output.data.length) {
      completedRevision = output.revision;
    } else {
      break;
    }
  }

  if (endIndex < 0 || units === 0) {
    return undefined;
  }
  return {
    completedRevision,
    data: parts.join(''),
    endIndex,
    endOffset,
    units,
  };
};

/**
 * Feeds xterm losslessly with exactly one write in flight. Queue entries are consumed only after
 * xterm's callback confirms that its parser and screen buffer accepted the complete write.
 */
export class TerminalOutputPump {
  private appliedRevisionValue = 0;
  private disposed = false;
  private inFlight = false;
  private nextRevision = 0;
  private readonly pending: PendingTerminalOutput[] = [];
  private scheduledFrame: number | undefined;
  private readonly writeQuantumUnits: number;

  public constructor(private readonly options: TerminalOutputPumpOptions) {
    this.writeQuantumUnits = options.writeQuantumUnits ?? TERMINAL_WRITE_QUANTUM_UNITS;
    if (!Number.isSafeInteger(this.writeQuantumUnits) || this.writeQuantumUnits < 2) {
      throw new Error('Terminal write quantum must contain at least two UTF-16 units.');
    }
  }

  public get acceptedRevision(): number {
    return this.nextRevision;
  }

  public get appliedRevision(): number {
    return this.appliedRevisionValue;
  }

  public enqueue(data: string): number {
    if (this.disposed || data.length === 0 || !this.options.isCurrent()) {
      return this.nextRevision;
    }
    const revision = ++this.nextRevision;
    this.pending.push({ data, revision });
    this.schedule();
    return revision;
  }

  public dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    if (this.scheduledFrame !== undefined) {
      this.options.cancelFrame(this.scheduledFrame);
      this.scheduledFrame = undefined;
    }
    this.pending.length = 0;
  }

  private consume(plan: TerminalWritePlan): void {
    const finalOutput = this.pending[plan.endIndex];
    if (!finalOutput) {
      return;
    }
    if (plan.endOffset >= finalOutput.data.length) {
      this.pending.splice(0, plan.endIndex + 1);
      return;
    }
    finalOutput.data = finalOutput.data.slice(plan.endOffset);
    this.pending.splice(0, plan.endIndex);
  }

  private schedule(): void {
    if (
      this.disposed ||
      this.inFlight ||
      this.scheduledFrame !== undefined ||
      this.pending.length === 0
    ) {
      return;
    }
    this.scheduledFrame = this.options.scheduleFrame(() => {
      this.scheduledFrame = undefined;
      this.writeNext();
    });
  }

  private writeNext(): void {
    if (this.disposed || this.inFlight || this.pending.length === 0) {
      return;
    }
    if (!this.options.isCurrent()) {
      this.pending.length = 0;
      return;
    }
    const plan = createTerminalWritePlan(this.pending, this.writeQuantumUnits);
    if (!plan) {
      return;
    }

    this.inFlight = true;
    let settled = false;
    const finish = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      this.inFlight = false;
      if (this.disposed) {
        return;
      }
      if (!this.options.isCurrent()) {
        this.pending.length = 0;
        return;
      }

      this.consume(plan);
      if (plan.completedRevision > this.appliedRevisionValue) {
        this.appliedRevisionValue = plan.completedRevision;
        this.options.onAppliedRevision(this.appliedRevisionValue);
      }
      this.schedule();
    };

    try {
      this.options.write(plan.data, finish);
    } catch (error) {
      this.inFlight = false;
      throw error;
    }
  }
}
