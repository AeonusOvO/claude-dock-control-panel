import { runProcess } from '../infra/windows-command';

const RUNTIME_STOP_PID_ENV = 'CLAUDEDOCK_RUNTIME_STOP_PID';
const RUNTIME_STOP_STARTED_AT_ENV = 'CLAUDEDOCK_RUNTIME_STOP_STARTED_AT';
const RUNTIME_STOP_FORCE_ENV = 'CLAUDEDOCK_RUNTIME_STOP_FORCE';

export interface WindowsProcessSnapshot {
  listeners: Array<{ address: string; pid: number; port: number }>;
  processes: Array<{
    name: string;
    parentPid: number;
    pid: number;
    startedAt: number;
  }>;
}

export interface RuntimeProcessStopTarget {
  pid: number;
  startedAt: number;
}

export interface RuntimeProcessStopReceipt extends RuntimeProcessStopTarget {
  reuseSafeBefore: number;
}

export interface RuntimeProcessSystem {
  capture: () => Promise<WindowsProcessSnapshot>;
  forceStop: (targets: RuntimeProcessStopTarget[]) => Promise<RuntimeProcessStopReceipt[] | void>;
  gracefulStop: (
    targets: RuntimeProcessStopTarget[],
  ) => Promise<RuntimeProcessStopReceipt[] | void>;
}

export interface RuntimeProcessRunner {
  (
    executable: string,
    argumentsList: string[],
    environment: NodeJS.ProcessEnv,
    options: { maxBuffer: number; timeout: number },
  ): Promise<{ stderr: string; stdout: string }>;
}

export interface RuntimeProcessSystemOptions {
  platform?: NodeJS.Platform;
  run?: RuntimeProcessRunner;
}

const PROCESS_SNAPSHOT_COMMAND = [
  "$ErrorActionPreference = 'Stop'",
  '$processes = @(Get-CimInstance Win32_Process -ErrorAction Stop | ForEach-Object {',
  '  $started = 0; try { $started = ([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() } catch { $started = 0 }',
  '  [pscustomobject]@{ pid = [int]$_.ProcessId; parentPid = [int]$_.ParentProcessId; name = [string]$_.Name; startedAt = [int64]$started }',
  '})',
  '$listeners = @(Get-NetTCPConnection -State Listen -ErrorAction Stop | ForEach-Object { [pscustomobject]@{ pid = [int]$_.OwningProcess; address = [string]$_.LocalAddress; port = [int]$_.LocalPort } })',
  '[pscustomobject]@{ processes = $processes; listeners = $listeners } | ConvertTo-Json -Depth 4 -Compress',
].join('; ');

const EXACT_PROCESS_STOP_COMMAND = [
  "$ErrorActionPreference = 'Stop'",
  `$targetPid = [int]::Parse($env:${RUNTIME_STOP_PID_ENV}, [Globalization.CultureInfo]::InvariantCulture)`,
  `$expectedStartedAt = [long]::Parse($env:${RUNTIME_STOP_STARTED_AT_ENV}, [Globalization.CultureInfo]::InvariantCulture)`,
  `$force = [int]::Parse($env:${RUNTIME_STOP_FORCE_ENV}, [Globalization.CultureInfo]::InvariantCulture)`,
  'try { $process = [Diagnostics.Process]::GetProcessById($targetPid); $process.Handle | Out-Null } catch [ArgumentException] { exit 0 } catch { exit 3 }',
  '$target = Get-CimInstance Win32_Process -Filter ("ProcessId = {0}" -f $targetPid) -ErrorAction Stop',
  'if ($null -eq $target) { exit 0 }',
  '$startedAt = 0; try { $startedAt = ([DateTimeOffset]$target.CreationDate).ToUnixTimeMilliseconds() } catch { exit 3 }',
  'if ($startedAt -ne $expectedStartedAt) { exit 0 }',
  "$stopArgs = @('/PID', [string]$targetPid)",
  "if ($force -eq 1) { $stopArgs = @('/F') + $stopArgs }",
  "$taskkill = [IO.Path]::Combine([Environment]::GetFolderPath([Environment+SpecialFolder]::Windows), 'System32', 'taskkill.exe')",
  '& $taskkill $stopArgs',
  '$taskkillCode = $LASTEXITCODE',
  '$exited = $process.HasExited; if (-not $exited) { try { $exited = $process.WaitForExit(1500) } catch { $exited = $false } }',
  'if ($taskkillCode -ne 0 -and -not $exited) { exit $taskkillCode }',
  'if ($exited) { [Console]::Out.Write(([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()).ToString([Globalization.CultureInfo]::InvariantCulture)) }',
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
        entry.parentPid >= 0 &&
        Number.isSafeInteger(entry.startedAt),
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

const commandEnvironment = (overrides: Record<string, string> = {}): NodeJS.ProcessEnv => {
  const environment: NodeJS.ProcessEnv = { ...process.env, ...overrides };
  delete environment.ELECTRON_RUN_AS_NODE;
  return environment;
};

const validStartedAt = (startedAt: number): boolean =>
  Number.isSafeInteger(startedAt) && startedAt > 0;

const stopExactWindowsProcess = async (
  target: RuntimeProcessStopTarget,
  force: boolean,
  platform: NodeJS.Platform,
  runner: RuntimeProcessRunner,
): Promise<RuntimeProcessStopReceipt | undefined> => {
  if (platform !== 'win32') return undefined;
  if (!Number.isSafeInteger(target.pid) || target.pid <= 0 || !validStartedAt(target.startedAt)) {
    throw new Error('进程身份无效，已拒绝结束。');
  }
  const { stdout } = await runner(
    'powershell.exe',
    [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      EXACT_PROCESS_STOP_COMMAND,
    ],
    commandEnvironment({
      [RUNTIME_STOP_FORCE_ENV]: force ? '1' : '0',
      [RUNTIME_STOP_PID_ENV]: String(target.pid),
      [RUNTIME_STOP_STARTED_AT_ENV]: String(target.startedAt),
    }),
    { maxBuffer: 64 * 1024, timeout: 3_000 },
  );
  const reuseSafeBefore = Number(stdout.trim());
  return Number.isSafeInteger(reuseSafeBefore) && reuseSafeBefore >= target.startedAt
    ? { ...target, reuseSafeBefore }
    : undefined;
};

const stopExactWindowsProcesses = async (
  targets: RuntimeProcessStopTarget[],
  force: boolean,
  platform: NodeJS.Platform,
  runner: RuntimeProcessRunner,
): Promise<RuntimeProcessStopReceipt[]> => {
  const receipts: RuntimeProcessStopReceipt[] = [];
  let firstError: unknown;
  for (const target of targets) {
    try {
      const receipt = await stopExactWindowsProcess(target, force, platform, runner);
      if (receipt) receipts.push(receipt);
    } catch (error) {
      firstError ??= error;
    }
  }
  if (firstError !== undefined) throw firstError;
  return receipts;
};

export const createRuntimeProcessSystem = (
  options: RuntimeProcessSystemOptions = {},
): RuntimeProcessSystem => {
  const platform = options.platform ?? process.platform;
  const runner = options.run ?? runProcess;
  return {
    capture: async () => {
      if (platform !== 'win32') return { listeners: [], processes: [] };
      const { stdout } = await runner(
        'powershell.exe',
        [
          '-NoLogo',
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-Command',
          PROCESS_SNAPSHOT_COMMAND,
        ],
        commandEnvironment(),
        { maxBuffer: 8 * 1024 * 1024, timeout: 8_000 },
      );
      return parseWindowsProcessSnapshot(stdout.trim());
    },
    gracefulStop: (targets) => stopExactWindowsProcesses(targets, false, platform, runner),
    forceStop: (targets) => stopExactWindowsProcesses(targets, true, platform, runner),
  };
};

export const defaultRuntimeProcessSystem = createRuntimeProcessSystem();
