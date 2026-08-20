import { describe, expect, it } from 'vitest';
import { RollbackCoordinator } from '../../src/main/coordination/rollback';

describe('RollbackCoordinator', () => {
  it('runs rollback in reverse order exactly once', async () => {
    const calls: number[] = [];
    const transaction = new RollbackCoordinator();
    transaction.add(() => {
      calls.push(1);
    });
    transaction.add(() => {
      calls.push(2);
    });

    await transaction.rollback();
    await transaction.rollback();

    expect(calls).toEqual([2, 1]);
  });

  it('does nothing after commit', async () => {
    const calls: string[] = [];
    const transaction = new RollbackCoordinator();
    transaction.add(() => {
      calls.push('rollback');
    });
    transaction.commit();

    await transaction.rollback();

    expect(calls).toEqual([]);
  });
});
