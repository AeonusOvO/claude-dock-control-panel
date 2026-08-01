import type { BusyLease } from '../shared/contracts';

export type { BusyKind, BusyLease, BusySeverity } from '../shared/contracts';

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
    this.leases.set(lease.id, Object.freeze({ ...lease }));
    this.notify();
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      if (this.leases.delete(lease.id)) {
        this.notify();
      }
    };
  }

  public has(): boolean {
    return this.leases.size > 0;
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
