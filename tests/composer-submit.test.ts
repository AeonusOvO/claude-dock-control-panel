import { describe, expect, it } from 'vitest';
import { ComposerSubmitCoordinator } from '../src/renderer/composer-submit';

const deferred = <T>(): {
  promise: Promise<T>;
  reject: (reason: unknown) => void;
  resolve: (value: T) => void;
} => {
  let reject!: (reason: unknown) => void;
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    reject = rejectPromise;
    resolve = resolvePromise;
  });
  return { promise, reject, resolve };
};

const recorder = (): { events: string[]; onCancelled: () => void; onDelivered: () => void } => {
  const events: string[] = [];
  return {
    events,
    onCancelled: () => events.push('cancelled'),
    onDelivered: () => events.push('delivered'),
  };
};

describe('ComposerSubmitCoordinator', () => {
  it('keeps the composer intact when the session is replaced between the two PTY writes', async () => {
    const coordinator = new ComposerSubmitCoordinator();
    const { events, onCancelled, onDelivered } = recorder();

    // `writeTerminalSubmission` resolves false when the PTY generation changed mid-submission,
    // which means the carriage return was never written and nothing was sent.
    const outcome = await coordinator.submit({
      deliver: async () => false,
      onCancelled,
      onDelivered,
    });

    expect(outcome).toBe('cancelled');
    expect(events).toEqual(['cancelled']);
  });

  it('commits the composer only after the whole submission reached the PTY', async () => {
    const coordinator = new ComposerSubmitCoordinator();
    const { events, onCancelled, onDelivered } = recorder();

    const outcome = await coordinator.submit({
      deliver: async () => true,
      onCancelled,
      onDelivered,
    });

    expect(outcome).toBe('delivered');
    expect(events).toEqual(['delivered']);
  });

  it('refuses a second submit while the first is still between its two writes', async () => {
    const coordinator = new ComposerSubmitCoordinator();
    const { events, onCancelled, onDelivered } = recorder();
    const gate = deferred<boolean>();
    const delivered: string[] = [];

    const first = coordinator.submit({
      deliver: () => {
        delivered.push('first');
        return gate.promise;
      },
      onCancelled,
      onDelivered,
    });

    // The composer still holds the text during the 40ms gap, so a second Enter would resend it.
    const second = await coordinator.submit({
      deliver: async () => {
        delivered.push('second');
        return true;
      },
      onCancelled,
      onDelivered,
    });

    expect(second).toBe('busy');
    expect(delivered).toEqual(['first']);
    expect(events).toEqual([]);

    gate.resolve(true);
    await expect(first).resolves.toBe('delivered');
    expect(events).toEqual(['delivered']);
  });

  it('releases the in-flight lock and leaves the composer intact when delivery throws', async () => {
    const coordinator = new ComposerSubmitCoordinator();
    const { events, onCancelled, onDelivered } = recorder();

    await expect(
      coordinator.submit({
        deliver: async () => {
          throw new Error('terminal disappeared');
        },
        onCancelled,
        onDelivered,
      }),
    ).rejects.toThrow('terminal disappeared');

    // A thrown delivery is not a confirmed send, so the composer must not be committed...
    expect(events).toEqual([]);
    // ...and the coordinator must not stay locked against every later submit.
    await expect(
      coordinator.submit({ deliver: async () => true, onCancelled, onDelivered }),
    ).resolves.toBe('delivered');
    expect(events).toEqual(['delivered']);
  });
});
