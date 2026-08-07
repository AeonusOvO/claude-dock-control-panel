import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import type { PtyGeneration, RuntimeWebProcessView } from '../shared/contracts';

const execFileAsync = promisify(execFile);
const SCAN_INTERVAL_MS = 2_000;
const WEB_EXECUTABLES = new Set([
  'bun.exe',
  'deno.exe',
  'dotnet.exe',
  'java.exe',
  'node.exe',
  'php.exe',
  'python.exe',
  'pythonw.exe',
  'ruby.exe',
  'uvicorn.exe',
]);
const FORBIDDEN_EXECUTABLE_PARTS = [
  'chrome',
  'msedge',
  'firefox',
  'browser',
  'docker',
  'dockerd',
  'claude',
  'codex',
  'ccr',
];
const TREE_BARRIER_EXECUTABLE_PARTS = [
  'chrome',
  'msedge',
  'firefox',
  'browser',
  'docker',
  'dockerd',
];

export interface RuntimeProcessOwner {
  launchGeneration: number;
  ptyGeneration: PtyGeneration;
  rootPid: number;
  sessionId: string;
}

export interface WindowsProcessSnapshot {
  listeners: Array<{ address: string; pid: number; port: number }>;
  processes: Array<{
    commandLine: string;
    name: string;
    parentPid: number;
    pid: number;
    startedAt: number;
  }>;
}

interface OwnedProcess {
  identity: string;
  owner: RuntimeProcessOwner;
  process: WindowsProcessSnapshot['processes'][number];
  processKey: string;
  rootStartedAt: number;
  view: RuntimeWebProcessView;
}

export interface RuntimeProcessSystem {
  capture: () => Promise<WindowsProcessSnapshot>;
  forceStop: (pids: number[]) => Promise<void>;
  gracefulStop: (pids: number[]) => Promise<void>;
}

const PROCESS_SNAPSHOT_COMMAND = [
  '$processes = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | ForEach-Object {',
  '  $started = 0; try { $started = ([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() } catch {}',
  '  [pscustomobject]@{ pid = [int]$_.ProcessId; parentPid = [int]$_.ParentProcessId; name = [string]$_.Name; commandLine = [string]$_.CommandLine; startedAt = [int64]$started }',
  '})',
  '$listeners = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | ForEach-Object { [pscustomobject]@{ pid = [int]$_.OwningProcess; address = [string]$_.LocalAddress; port = [int]$_.LocalPort } })',
  '[pscustomobject]@{ processes = $processes; listeners = $listeners } | ConvertTo-Json -Depth 4 -Compress',
].join('; ');

const normalizedArray = <T>(value: T | T[] | undefined): T[] =>
  value === undefined ? [] : Array.isArray(value) ? value : [value];

export const parseWindowsProcessSnapshot = (raw: string): WindowsProcessSnapshot => {
  const parsed = JSON.parse(raw) as {
    listeners?: unknown;
    processes?: unknown;
  };
  const processes = normalizedArray<Record<string, unknown>>(
    parsed.processes as Record<string, unknown> | Record<string, unknown>[] | undefined,
  )
    .map((entry) => ({
      commandLine: typeof entry.commandLine === 'string' ? entry.commandLine : '',
      name: typeof entry.name === 'string' ? entry.name : '',
      parentPid: Number(entry.parentPid),
      pid: Number(entry.pid),
      startedAt: Number(entry.startedAt),
    }))
    .filter(
      (entry) =>
        Number.isInteger(entry.pid) &&
        entry.pid > 0 &&
        Number.isInteger(entry.parentPid) &&
        Number.isFinite(entry.startedAt),
    );
  const listeners = normalizedArray<Record<string, unknown>>(
    parsed.listeners as Record<string, unknown> | Record<string, unknown>[] | undefined,
  )
    .map((entry) => ({
      address: typeof entry.address === 'string' ? entry.address : '',
      pid: Number(entry.pid),
      port: Number(entry.port),
    }))
    .filter(
      (entry) =>
        Number.isInteger(entry.pid) &&
        entry.pid > 0 &&
        Number.isInteger(entry.port) &&
        entry.port > 0 &&
        entry.port <= 65_535,
    );
  return { listeners, processes };
};

const defaultSystem: RuntimeProcessSystem = {
  capture: async () => {
    if (process.platform !== 'win32') return { listeners: [], processes: [] };
    const { stdout } = await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', PROCESS_SNAPSHOT_COMMAND],
      { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 8_000, windowsHide: true },
    );
    return parseWindowsProcessSnapshot(stdout.trim());
  },
  gracefulStop: async (pids) => {
    for (const pid of pids) {
      await execFileAsync('taskkill.exe', ['/PID', String(pid)], {
        timeout: 3_000,
        windowsHide: true,
      }).catch(() => undefined);
    }
  },
  forceStop: async (pids) => {
    for (const pid of pids) {
      await execFileAsync('taskkill.exe', ['/F', '/PID', String(pid)], {
        timeout: 3_000,
        windowsHide: true,
      }).catch(() => undefined);
    }
  },
};

const forbiddenProcess = (name: string): boolean => {
  const normalized = name.toLowerCase();
  return FORBIDDEN_EXECUTABLE_PARTS.some((part) => normalized.includes(part));
};

const webProcess = (name: string): boolean => WEB_EXECUTABLES.has(name.toLowerCase());
const processIdentity = (pid: number, startedAt: number): string => `${pid}:${startedAt}`;
const treeBarrierProcess = (name: string): boolean => {
  const normalized = name.toLowerCase();
  return TREE_BARRIER_EXECUTABLE_PARTS.some((part) => normalized.includes(part));
};

const descendantPids = (
  snapshot: WindowsProcessSnapshot,
  rootPid: number,
  barrier: (name: string) => boolean = treeBarrierProcess,
): Set<number> => {
  const descendants = new Set<number>();
  let frontier = [rootPid];
  while (frontier.length > 0) {
    const parents = new Set(frontier);
    const next = snapshot.processes
      .filter(
        (process) =>
          parents.has(process.parentPid) && !descendants.has(process.pid) && !barrier(process.name),
      )
      .map((process) => process.pid);
    for (const pid of next) descendants.add(pid);
    frontier = next;
  }
  return descendants;
};

const safeUrl = (value: string): boolean => {
  try {
    const url = new URL(value);
    return (
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      ['127.0.0.1', 'localhost', '0.0.0.0', '[::]', '[::1]'].includes(url.hostname)
    );
  } catch {
    return false;
  }
};

export class RuntimeProcessRegistry {
  private readonly confirmedUrls = new Map<string, Array<{ observedAt: number; url: string }>>();
  private readonly owned = new Map<string, OwnedProcess>();
  private ownerProvider: () => RuntimeProcessOwner[] = () => [];
  private scanInFlight?: Promise<void>;
  private timer?: NodeJS.Timeout;

  public constructor(
    private readonly onChange: (sessionId: string, processes: RuntimeWebProcessView[]) => void,
    private readonly system: RuntimeProcessSystem = defaultSystem,
  ) {}

  public start(ownerProvider: () => RuntimeProcessOwner[]): void {
    this.ownerProvider = ownerProvider;
    if (this.timer) return;
    this.timer = setInterval(() => void this.scan().catch(() => undefined), SCAN_INTERVAL_MS);
    this.timer.unref();
    void this.scan().catch(() => undefined);
  }

  public observeTerminalOutput(
    sessionId: string,
    ptyGeneration: PtyGeneration,
    data: string,
  ): void {
    const urls =
      data
        .replaceAll(String.fromCharCode(27), '')
        .match(
          /https?:\/\/(?:127\.0\.0\.1|localhost|0\.0\.0\.0|\[::1?\])(?::\d{1,5})?(?:\/\S*)?/gi,
        ) ?? [];
    if (urls.length === 0) return;
    const key = `${sessionId}:${ptyGeneration}`;
    const retained = (this.confirmedUrls.get(key) ?? []).filter(
      (entry) => Date.now() - entry.observedAt <= 24 * 60 * 60 * 1_000,
    );
    for (const url of urls.filter(safeUrl).slice(0, 20)) {
      if (!retained.some((entry) => entry.url === url))
        retained.push({ observedAt: Date.now(), url });
    }
    this.confirmedUrls.set(key, retained.slice(-20));
  }

  public async scan(): Promise<void> {
    if (this.scanInFlight) return this.scanInFlight;
    const operation = this.scanOnce();
    this.scanInFlight = operation;
    try {
      await operation;
    } finally {
      if (this.scanInFlight === operation) this.scanInFlight = undefined;
    }
  }

  public async terminate(sessionId: string, processKey: string): Promise<void> {
    await this.scan();
    const target = this.owned.get(processKey);
    if (!target || target.owner.sessionId !== sessionId) {
      throw new Error('该进程已结束或不再属于当前会话。');
    }
    const current = await this.system.capture();
    const verified = this.verifyTarget(target, current, this.ownerProvider());
    if (!verified) throw new Error('进程所有权已变化，已拒绝结束。');
    target.view.status = 'stopping';
    this.publishSession(sessionId);
    const subtree = this.verifiedSubtree(target, current);
    await this.system.gracefulStop(subtree.map((process) => process.pid).reverse());
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    const afterGraceful = await this.system.capture();
    const remaining = this.verifiedSubtree(target, afterGraceful)
      .map((process) => process.pid)
      .reverse();
    if (remaining.length > 0) await this.system.forceStop(remaining);
    await this.scanOnce();
  }

  public async terminateSession(sessionId: string): Promise<void> {
    await this.scan();
    const keys = [...this.owned.values()]
      .filter((entry) => entry.owner.sessionId === sessionId)
      .map((entry) => entry.processKey);
    for (const key of keys) await this.terminate(sessionId, key).catch(() => undefined);
    await this.scan();
    if ([...this.owned.values()].some((entry) => entry.owner.sessionId === sessionId)) {
      throw new Error('当前会话仍有已验证的 Web 进程未能结束。');
    }
  }

  public async terminateAll(): Promise<void> {
    await this.scan();
    const sessions = [...new Set([...this.owned.values()].map((entry) => entry.owner.sessionId))];
    let failed = false;
    for (const sessionId of sessions) {
      try {
        await this.terminateSession(sessionId);
      } catch {
        failed = true;
      }
    }
    if (failed) throw new Error('仍有已验证的 Web 进程未能结束。');
  }

  public list(): Array<{ sessionId: string; view: RuntimeWebProcessView }> {
    return [...this.owned.values()].map((entry) => ({
      sessionId: entry.owner.sessionId,
      view: {
        ...entry.view,
        ports: [...entry.view.ports],
        urls: entry.view.urls.map((url) => ({ ...url })),
      },
    }));
  }

  public stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private async scanOnce(): Promise<void> {
    const owners = this.ownerProvider().filter(
      (owner) => Number.isInteger(owner.rootPid) && owner.rootPid > 0,
    );
    if (owners.length === 0) {
      const previousSessions = new Set(
        [...this.owned.values()].map((entry) => entry.owner.sessionId),
      );
      this.owned.clear();
      for (const sessionId of previousSessions) this.onChange(sessionId, []);
      return;
    }
    const snapshot = await this.system.capture();
    const previous = new Map(
      [...this.owned.values()].map((entry) => [
        `${entry.owner.sessionId}:${entry.owner.launchGeneration}:${entry.owner.ptyGeneration}:${entry.rootStartedAt}:${entry.identity}`,
        entry,
      ]),
    );
    const next = new Map<string, OwnedProcess>();
    for (const owner of owners) {
      const rootProcess = snapshot.processes.find((process) => process.pid === owner.rootPid);
      if (!rootProcess) continue;
      const descendants = descendantPids(snapshot, owner.rootPid);
      for (const process of snapshot.processes) {
        if (
          !descendants.has(process.pid) ||
          !webProcess(process.name) ||
          forbiddenProcess(process.name)
        ) {
          continue;
        }
        const listeners = snapshot.listeners.filter((listener) => listener.pid === process.pid);
        if (listeners.length === 0) continue;
        const identity = processIdentity(process.pid, process.startedAt);
        const ownershipKey = `${owner.sessionId}:${owner.launchGeneration}:${owner.ptyGeneration}:${rootProcess.startedAt}:${identity}`;
        const known = previous.get(ownershipKey);
        const processKey = known?.processKey ?? randomUUID();
        const confirmed = this.confirmedUrls.get(`${owner.sessionId}:${owner.ptyGeneration}`) ?? [];
        const ports = [...new Set(listeners.map((listener) => listener.port))].sort(
          (a, b) => a - b,
        );
        const confirmedForPorts = confirmed.filter((entry) => {
          try {
            const url = new URL(entry.url);
            const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
            return ports.includes(port);
          } catch {
            return false;
          }
        });
        const urls = [
          ...confirmedForPorts.map((entry) => ({ confirmed: true, url: entry.url })),
          ...ports
            .filter(
              (port) =>
                !confirmedForPorts.some((entry) => new URL(entry.url).port === String(port)),
            )
            .map((port) => ({ confirmed: false, url: `http://127.0.0.1:${port}` })),
        ];
        const exposed = listeners.some(
          (listener) => listener.address === '0.0.0.0' || listener.address === '::',
        );
        const view: RuntimeWebProcessView = {
          commandSummary: `${process.name} · 当前终端的已验证后代进程`,
          ...(exposed ? { exposureWarning: '监听所有网络接口，可能可从局域网访问。' } : {}),
          name: process.name.replace(/\.exe$/i, ''),
          pid: process.pid,
          ports,
          processKey,
          startedAt: process.startedAt,
          status: known?.view.status ?? 'running',
          urls,
        };
        next.set(processKey, {
          identity,
          owner: { ...owner },
          process,
          processKey,
          rootStartedAt: rootProcess.startedAt,
          view,
        });
      }
    }
    const sessions = new Set([
      ...owners.map((owner) => owner.sessionId),
      ...[...this.owned.values()].map((entry) => entry.owner.sessionId),
    ]);
    this.owned.clear();
    for (const [key, entry] of next) this.owned.set(key, entry);
    for (const sessionId of sessions) this.publishSession(sessionId);
  }

  private verifyTarget(
    target: OwnedProcess,
    snapshot: WindowsProcessSnapshot,
    owners: RuntimeProcessOwner[],
  ): boolean {
    const owner = owners.find(
      (candidate) =>
        candidate.sessionId === target.owner.sessionId &&
        candidate.launchGeneration === target.owner.launchGeneration &&
        candidate.ptyGeneration === target.owner.ptyGeneration &&
        candidate.rootPid === target.owner.rootPid,
    );
    const rootProcess = snapshot.processes.find((process) => process.pid === target.owner.rootPid);
    if (
      !owner ||
      rootProcess?.startedAt !== target.rootStartedAt ||
      !descendantPids(snapshot, owner.rootPid).has(target.process.pid)
    ) {
      return false;
    }
    const process = snapshot.processes.find((candidate) => candidate.pid === target.process.pid);
    return Boolean(
      process &&
      processIdentity(process.pid, process.startedAt) === target.identity &&
      webProcess(process.name) &&
      !forbiddenProcess(process.name) &&
      snapshot.listeners.some((listener) => listener.pid === process.pid),
    );
  }

  private verifiedSubtree(
    target: OwnedProcess,
    snapshot: WindowsProcessSnapshot,
  ): WindowsProcessSnapshot['processes'] {
    const root = snapshot.processes.find(
      (process) => processIdentity(process.pid, process.startedAt) === target.identity,
    );
    if (!root) return [];
    const descendants = descendantPids(snapshot, root.pid, forbiddenProcess);
    return snapshot.processes.filter(
      (process) =>
        (process.pid === root.pid || descendants.has(process.pid)) &&
        !forbiddenProcess(process.name),
    );
  }

  private publishSession(sessionId: string): void {
    this.onChange(
      sessionId,
      [...this.owned.values()]
        .filter((entry) => entry.owner.sessionId === sessionId)
        .map((entry) => ({
          ...entry.view,
          ports: [...entry.view.ports],
          urls: entry.view.urls.map((url) => ({ ...url })),
        })),
    );
  }
}
