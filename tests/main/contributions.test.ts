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

    runQuitContributions([() => calls.push('first'), () => calls.push('second')]);

    expect(calls).toEqual(['first', 'second']);
  });

  it('collects tray items from independently declared contributions', () => {
    const items = collectTrayMenuItems({ visible: true }, [
      ({ visible }) => (visible ? ['first'] : []),
      () => ['second', 'third'],
    ]);

    expect(items).toEqual(['first', 'second', 'third']);
  });
});
