import type { ChildProcess } from 'node:child_process';

const PROCESS_REPLACEMENT_BARRIER_TIMEOUT_MS = 2_000;
const PROCESS_REPLACEMENT_POLL_MS = 100;

const delay = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

export interface ManagedGatewaySpawnedProcessOwnership {
  child: ChildProcess;
  generation: number;
  processId?: number;
}

interface ManagedGatewaySpawnedProcessMetadata {
  configSignature: string;
  environmentSignature: string;
  executablePath: string;
}

interface ManagedGatewayProcessLifecycleOptions {
  invalidateModels: () => void;
  onExactProcessExit: (processId: number) => void;
  portAvailable: (port: number, timeoutMs?: number) => Promise<boolean>;
}

/** Owns process-local child identity and the bounded barrier used before a replacement spawn. */
export class ManagedGatewayProcessLifecycle {
  private configSignature?: string;
  private environmentSignature?: string;
  private executablePath?: string;
  private generation = 0;
  private process?: ChildProcess;
  private stoppingGeneration?: number;

  public constructor(private readonly options: ManagedGatewayProcessLifecycleOptions) {}

  public activeProcess(): ChildProcess | undefined {
    return this.stoppingGeneration === this.generation ? undefined : this.process;
  }

  public childHasExited(child: ChildProcess): boolean {
    return child.exitCode !== null || child.signalCode !== null;
  }

  public currentExecutablePath(processId: number): string | undefined {
    return this.process?.pid === processId ? this.executablePath : undefined;
  }

  public currentOwnership(): ManagedGatewaySpawnedProcessOwnership | undefined {
    return this.process
      ? {
          child: this.process,
          generation: this.generation,
          processId: this.process.pid,
        }
      : undefined;
  }

  public isCurrent(ownership: ManagedGatewaySpawnedProcessOwnership): boolean {
    return this.generation === ownership.generation && this.process === ownership.child;
  }

  public isStoppingProcessId(processId: number | undefined): boolean {
    return Boolean(
      processId && this.process?.pid === processId && this.stoppingGeneration === this.generation,
    );
  }

  public ownsStoppingProcess(): boolean {
    return Boolean(this.process && this.stoppingGeneration === this.generation);
  }

  public launchMatches(
    processId: number,
    configSignature: string,
    environmentSignature: string,
  ): boolean {
    return (
      this.activeProcess()?.pid === processId &&
      this.configSignature === configSignature &&
      this.environmentSignature === environmentSignature
    );
  }

  public start(
    child: ChildProcess,
    metadata: ManagedGatewaySpawnedProcessMetadata,
  ): ManagedGatewaySpawnedProcessOwnership {
    if (this.process) {
      throw new Error('旧托管网关子进程尚未完成清理，已拒绝覆盖进程所有权。');
    }
    this.generation += 1;
    this.process = child;
    this.configSignature = metadata.configSignature;
    this.environmentSignature = metadata.environmentSignature;
    this.executablePath = metadata.executablePath;
    this.stoppingGeneration = undefined;
    return {
      child,
      generation: this.generation,
      processId: child.pid,
    };
  }

  public markStopping(ownership: ManagedGatewaySpawnedProcessOwnership): void {
    if (this.isCurrent(ownership)) {
      this.stoppingGeneration = ownership.generation;
      this.options.invalidateModels();
    }
  }

  public clear(ownership?: ManagedGatewaySpawnedProcessOwnership): boolean {
    if (ownership && !this.isCurrent(ownership)) {
      return false;
    }
    this.process = undefined;
    this.configSignature = undefined;
    this.environmentSignature = undefined;
    this.executablePath = undefined;
    this.stoppingGeneration = undefined;
    this.options.invalidateModels();
    return true;
  }

  public complete(ownership: ManagedGatewaySpawnedProcessOwnership): void {
    if (this.clear(ownership) && ownership.processId) {
      this.options.onExactProcessExit(ownership.processId);
    }
  }

  public stop(): ManagedGatewaySpawnedProcessOwnership | undefined {
    const ownership = this.currentOwnership();
    if (!ownership) {
      this.clear();
      return undefined;
    }
    const alreadyStopping = this.stoppingGeneration === ownership.generation;
    this.markStopping(ownership);
    if (!alreadyStopping && !this.childHasExited(ownership.child)) {
      try {
        ownership.child.kill();
      } catch {
        // A failed signal delivery is not proof of exit. Keep exact ownership degraded until an
        // authoritative exit/close or the replacement barrier observes its deadline.
      }
    }
    return ownership;
  }

  public async stopForReplacement(port: number, timeoutMessage: string): Promise<void> {
    const ownership = this.stop();
    if (ownership && !(await this.waitForExitAndPort(ownership, port))) {
      throw new Error(timeoutMessage);
    }
  }

  private ownershipCanComplete(ownership: ManagedGatewaySpawnedProcessOwnership): boolean {
    return (
      this.generation === ownership.generation &&
      (this.process === ownership.child || this.process === undefined)
    );
  }

  private async waitForExitAndPort(
    ownership: ManagedGatewaySpawnedProcessOwnership,
    port: number,
  ): Promise<boolean> {
    const deadline = Date.now() + PROCESS_REPLACEMENT_BARRIER_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (!this.ownershipCanComplete(ownership)) {
        return false;
      }
      if (
        this.childHasExited(ownership.child) &&
        (!port || (await this.portAvailableBeforeDeadline(port, deadline)))
      ) {
        if (!this.ownershipCanComplete(ownership)) {
          return false;
        }
        this.complete(ownership);
        return true;
      }
      await delay(Math.min(PROCESS_REPLACEMENT_POLL_MS, Math.max(0, deadline - Date.now())));
    }
    if (!this.ownershipCanComplete(ownership) || !this.childHasExited(ownership.child)) {
      return false;
    }
    if (port && !(await this.portAvailableBeforeDeadline(port, deadline))) {
      return false;
    }
    if (!this.ownershipCanComplete(ownership)) {
      return false;
    }
    this.complete(ownership);
    return true;
  }

  private portAvailableBeforeDeadline(port: number, deadline: number): Promise<boolean> {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      return Promise.resolve(false);
    }
    return new Promise((resolve) => {
      let settled = false;
      const finish = (available: boolean): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(available);
      };
      const timer = setTimeout(() => finish(false), remaining);
      timer.unref();
      void this.options.portAvailable(port, remaining).then(
        (available) => finish(available),
        () => finish(false),
      );
    });
  }
}
