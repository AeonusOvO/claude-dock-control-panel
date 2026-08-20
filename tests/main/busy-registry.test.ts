import { describe, expect, it, vi } from 'vitest';
import { BusyRegistry, type BusyLease } from '../../src/main/coordination/busy-registry';

const lease = (overrides: Partial<BusyLease> = {}): BusyLease => ({
  cancellable: false,
  id: 'task-1',
  kind: 'install',
  label: '安装组件',
  severity: 'blocking',
  ...overrides,
});

describe('busy registry', () => {
  it('keeps insertion order and supports severity filtering', () => {
    const registry = new BusyRegistry();
    registry.acquire(lease());
    registry.acquire(
      lease({
        cancellable: true,
        id: 'task-2',
        kind: 'download',
        label: '下载组件',
        severity: 'resumable',
      }),
    );

    expect(registry.list().map(({ id }) => id)).toEqual(['task-1', 'task-2']);
    expect(registry.list().filter(({ severity }) => severity === 'blocking')).toHaveLength(1);
    expect(registry.list().filter(({ severity }) => severity === 'resumable')).toHaveLength(1);
    expect(registry.has()).toBe(true);
  });

  it('releases idempotently without emitting duplicate changes', () => {
    const listener = vi.fn();
    const registry = new BusyRegistry(listener);
    const release = registry.acquire(lease());

    release();
    release();

    expect(listener).toHaveBeenCalledTimes(2);
    expect(listener).toHaveBeenLastCalledWith([]);
    expect(registry.has()).toBe(false);
  });

  it('rejects duplicate active lease ids and allows unsubscribe', () => {
    const listener = vi.fn();
    const registry = new BusyRegistry();
    const unsubscribe = registry.onChange(listener);
    registry.acquire(lease());
    expect(() => registry.acquire(lease())).toThrow('已存在');
    unsubscribe();
    registry.acquire(lease({ id: 'task-2' }));
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
