/**
 * Owns one terminal composer submit at a time.
 *
 * `writeTerminalSubmission` hands the body and the carriage return to the PTY as two separate
 * writes and re-checks ownership across the gap, so it resolves `false` whenever the session was
 * stopped, closed or replaced mid-submission — meaning the return never landed and nothing was
 * sent. The composer may therefore only be cleared, remembered in history and given its send
 * animation once delivery is actually confirmed; committing up front makes a cancelled submit look
 * exactly like a successful one and the typed prompt silently disappears.
 *
 * The in-flight lock exists because the composer legitimately still holds the text during that gap:
 * without it a second Enter would deliver the same submission twice.
 */
export type ComposerSubmitOutcome = 'busy' | 'cancelled' | 'delivered';

export interface ComposerSubmitPorts {
  /** Resolves true only when the complete submission reached the PTY. */
  deliver: () => Promise<boolean>;
  /** The submission was abandoned mid-flight; the composer keeps what the user typed. */
  onCancelled: () => void;
  /** Confirmed delivery; safe to clear the composer, record history and play feedback. */
  onDelivered: () => void;
}

export class ComposerSubmitCoordinator {
  private inFlight = false;

  public async submit(ports: ComposerSubmitPorts): Promise<ComposerSubmitOutcome> {
    if (this.inFlight) {
      return 'busy';
    }
    this.inFlight = true;
    try {
      const delivered = await ports.deliver();
      if (delivered) {
        ports.onDelivered();
        return 'delivered';
      }
      ports.onCancelled();
      return 'cancelled';
    } finally {
      // A throwing delivery is not a confirmed send: the composer stays untouched and the error
      // propagates to the caller, but the lock must not outlive this attempt.
      this.inFlight = false;
    }
  }
}
