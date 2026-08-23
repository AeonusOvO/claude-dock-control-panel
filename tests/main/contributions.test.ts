import { describe, expect, it } from 'vitest';
import {
  collectTrayMenuItems,
  runQuitContributions,
  runStartupContributions,
} from '../../src/main/infra/contributions';

describe('main contribution points', () => {
  it('awaits startup contributions in declaration order', async () => {
    const calls: string[] = [];

    await runStartupContributions([
      async () => {
        await Promise.resolve();
        calls.push('first');
      },
      () => {
        calls.push('second');
      },
    ]);

    expect(calls).toEqual(['first', 'second']);
  });

  it('runs quit contributions in declaration order', () => {
    const calls: string[] = [];

    expect(runQuitContributions([() => calls.push('first'), () => calls.push('second')])).toEqual(
      [],
    );

    expect(calls).toEqual(['first', 'second']);
  });

  it('keeps tearing down after a quit contribution throws', () => {
    /*
     * The last quit contribution is the sweep that force-kills the PowerShell trees ConPTY cannot
     * reach, so an earlier failure must not be allowed to skip it — that would leave shells running
     * after the app is gone.
     */
    const calls: string[] = [];
    const boom = new Error('journal flush failed');

    const failures = runQuitContributions([
      () => calls.push('first'),
      () => {
        throw boom;
      },
      () => calls.push('third'),
    ]);

    expect(calls).toEqual(['first', 'third']);
    expect(failures).toEqual([boom]);
  });

  it('collects tray items from independently declared contributions', () => {
    const items = collectTrayMenuItems({ visible: true }, [
      ({ visible }) => (visible ? ['first'] : []),
      () => ['second', 'third'],
    ]);

    expect(items).toEqual(['first', 'second', 'third']);
  });
});
