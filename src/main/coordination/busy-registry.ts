import type { BusyLease } from '../../shared/contracts';

export type { BusyKind, BusyLease, BusySeverity } from '../../shared/contracts';

export type BusyRegistryListener = (leases: BusyLease[]) => void;

export class BusyRegistry {
  private readonly leases = new Map<string, BusyLease>();
  private readonly listeners = new Set<BusyRegistryListener>();

  public constructor(onChange?: BusyRegistryListener) {
    if (onChange) {
      this.listeners.add(onChange);
    }
  }

  public acquire(lease: BusyLease): () => void {
    if (this.leases.has(lease.id)) {
      throw new Error(`忙碌任务 ${lease.id} 已存在。`);
    }
    this.leases.set(
      lease.id,
      Object.freeze({ ...lease, startedAt: lease.startedAt ?? Date.now() }),
    );
    try {
      this.notify();
    } catch (error) {
      // acquire() must be transactional: callers cannot release a lease if notification throws before
      // the release callback is returned.
      this.leases.delete(lease.id);
      throw error;
    }
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      if (this.leases.delete(lease.id)) {
        try {
          this.notify();
        } catch {
          // The lease is already released; observer failure must not interrupt owner teardown.
        }
      }
    };
  }

  public has(): boolean {
    return this.leases.size > 0;
  }

  public update(
    id: string,
    patch: Partial<
      Pick<BusyLease, 'label' | 'logTail' | 'queuePosition' | 'queueTotal' | 'stage' | 'target'>
    >,
  ): BusyLease | undefined {
    const current = this.leases.get(id);
    if (!current) return undefined;
    const next = Object.freeze({ ...current, ...patch });
    this.leases.set(id, next);
    this.notify();
    return next;
  }

  public list(): BusyLease[] {
    return [...this.leases.values()];
  }

  public onChange(listener: BusyRegistryListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify(): void {
    const snapshot = this.list();
    for (const listener of this.listeners) {
      listener(snapshot);
    }
  }
}
