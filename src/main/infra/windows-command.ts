import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';

const COMMAND_ENV = 'CLAUDEDOCK_COMMAND_NAME';
const RESOLVE_COMMAND = `$command = Get-Command $env:${COMMAND_ENV} -ErrorAction Stop | Select-Object -First 1; [Console]::Out.Write($command.Source)`;

export interface WindowsCommandOptions {
  cwd?: string;
  env?: Record<string, null | string | undefined>;
  maxBuffer?: number;
  onLine?: (line: string, stream: 'stderr' | 'stdout') => void;
  signal?: AbortSignal;
  timeout?: number;
}

const commandEnvironment = (
  overrides: Record<string, null | string | undefined> = {},
): NodeJS.ProcessEnv => {
  const environment: NodeJS.ProcessEnv = { ...process.env };
  for (const [name, value] of Object.entries(overrides)) {
    if (value === null || value === undefined) {
      delete environment[name];
    } else {
      environment[name] = value;
    }
  }
  delete environment.ELECTRON_RUN_AS_NODE;
  return environment;
};

interface CommandOutput {
  stderr: string;
  stdout: string;
}

const abortReason = (signal: AbortSignal): Error =>
  signal.reason instanceof Error
    ? signal.reason
    : new DOMException('This operation was aborted', 'AbortError');

const attachErrorMetadata = (error: Error, metadata: Record<string, unknown>): void => {
  try {
    Object.assign(error, metadata);
  } catch {
    // A frozen AbortSignal reason remains the exact authoritative rejection value.
  }
};

const PROCESS_CLEANUP_BUDGET_MS = 5_000;
const TREE_KILL_TIMEOUT_MS = 3_000;
const EXITED_ROOT_PID_ENV = 'CLAUDEDOCK_EXITED_ROOT_PID';
const EXITED_ROOT_STARTED_AT_ENV = 'CLAUDEDOCK_EXITED_ROOT_STARTED_AT';
const TERMINATE_EXITED_DESCENDANTS = [
  "$ErrorActionPreference = 'Stop'",
  `$rootPid = [uint32]$env:${EXITED_ROOT_PID_ENV}`,
  `$minimumCreatedAt = [long]$env:${EXITED_ROOT_STARTED_AT_ENV}`,
  '$processes = @(Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, CreationDate)',
  "$known = New-Object 'System.Collections.Generic.HashSet[uint32]'",
  '[void]$known.Add($rootPid)',
  "$targets = New-Object 'System.Collections.Generic.List[object]'",
  '$depth = 0',
  'do {',
  '  $added = $false',
  '  $depth += 1',
  '  foreach ($candidate in $processes) {',
  '    $candidatePid = [uint32]$candidate.ProcessId',
  '    $parentPid = [uint32]$candidate.ParentProcessId',
  '    if (!$known.Contains($candidatePid) -and $known.Contains($parentPid)) {',
  '      $createdAt = ([DateTimeOffset]$candidate.CreationDate).ToUnixTimeMilliseconds()',
  '      if ($createdAt -ge $minimumCreatedAt) {',
  '        [void]$known.Add($candidatePid)',
  '        [void]$targets.Add([pscustomobject]@{ Pid = $candidatePid; CreatedAt = $createdAt; Depth = $depth })',
  '        $added = $true',
  '      }',
  '    }',
  '  }',
  '} while ($added)',
  'foreach ($target in @($targets | Sort-Object Depth -Descending)) {',
  '  $current = Get-CimInstance Win32_Process -Filter "ProcessId = $($target.Pid)" -ErrorAction SilentlyContinue',
  '  if ($null -eq $current) { continue }',
  '  $createdAt = ([DateTimeOffset]$current.CreationDate).ToUnixTimeMilliseconds()',
  '  if ($createdAt -ne $target.CreatedAt) { continue }',
  '  & taskkill.exe /F /T /PID ([string]$target.Pid) *> $null',
  '}',
  '$remaining = 0',
  'foreach ($target in $targets) {',
  '  $current = Get-CimInstance Win32_Process -Filter "ProcessId = $($target.Pid)" -ErrorAction SilentlyContinue',
  '  if ($null -eq $current) { continue }',
  '  $createdAt = ([DateTimeOffset]$current.CreationDate).ToUnixTimeMilliseconds()',
  '  if ($createdAt -eq $target.CreatedAt) { $remaining += 1 }',
  '}',
  'if ($remaining -gt 0) { exit 1 }',
].join('\n');

type ProcessState = 'running' | 'settled' | 'stopping';

interface ProcessTerminationMetadata {
  cleanupTimedOut: boolean;
  directKillAttempted: boolean;
  treeKillAttempted: boolean;
  treeKillCode?: number | null;
  treeKillError?: string;
  treeKillSignal?: NodeJS.Signals | null;
  treeKillTimedOut: boolean;
}

const waitWithin = async (operation: Promise<void>, timeoutMs: number): Promise<boolean> => {
  if (timeoutMs <= 0) return false;
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation.then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

const terminateWindowsProcessTree = (
  pid: number,
  timeoutMs: number,
): Promise<
  Pick<
    ProcessTerminationMetadata,
    'treeKillCode' | 'treeKillError' | 'treeKillSignal' | 'treeKillTimedOut'
  >
> =>
  new Promise((resolve) => {
    if (!Number.isSafeInteger(pid) || pid <= 0) {
      resolve({ treeKillError: 'invalid-pid', treeKillTimedOut: false });
      return;
    }
    let settled = false;
    let terminator: ReturnType<typeof spawn>;
    const finish = (
      result: Pick<
        ProcessTerminationMetadata,
        'treeKillCode' | 'treeKillError' | 'treeKillSignal' | 'treeKillTimedOut'
      >,
    ): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      terminator?.removeListener('error', onError);
      terminator?.removeListener('close', onClose);
      resolve(result);
    };
    const onError = (error: NodeJS.ErrnoException): void => {
      finish({ treeKillError: error.code ?? error.name, treeKillTimedOut: false });
    };
    const onClose = (code: number | null, signal: NodeJS.Signals | null): void => {
      finish({ treeKillCode: code, treeKillSignal: signal, treeKillTimedOut: false });
    };
    try {
      terminator = spawn('taskkill.exe', ['/F', '/T', '/PID', String(pid)], {
        stdio: 'ignore',
        windowsHide: true,
      });
    } catch (error) {
      resolve({
        treeKillError: error instanceof Error ? error.name : 'spawn-failed',
        treeKillTimedOut: false,
      });
      return;
    }
    terminator.once('error', onError);
    terminator.once('close', onClose);
    const timer = setTimeout(
      () => {
        try {
          terminator.kill();
        } catch {
          // The timeout result remains authoritative.
        }
        finish({ treeKillTimedOut: true });
      },
      Math.max(1, timeoutMs),
    );
    timer.unref();
  });

const terminateExitedWindowsDescendants = (
  rootPid: number,
  startedAt: number,
  timeoutMs: number,
): Promise<
  Pick<
    ProcessTerminationMetadata,
    'treeKillCode' | 'treeKillError' | 'treeKillSignal' | 'treeKillTimedOut'
  >
> =>
  new Promise((resolve) => {
    if (!Number.isSafeInteger(rootPid) || rootPid <= 0) {
      resolve({ treeKillError: 'invalid-pid', treeKillTimedOut: false });
      return;
    }
    let settled = false;
    let terminator: ReturnType<typeof spawn>;
    const finish = (
      result: Pick<
        ProcessTerminationMetadata,
        'treeKillCode' | 'treeKillError' | 'treeKillSignal' | 'treeKillTimedOut'
      >,
    ): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      terminator?.removeListener('error', onError);
      terminator?.removeListener('close', onClose);
      resolve(result);
    };
    const onError = (error: NodeJS.ErrnoException): void => {
      finish({ treeKillError: error.code ?? error.name, treeKillTimedOut: false });
    };
    const onClose = (code: number | null, signal: NodeJS.Signals | null): void => {
      finish({ treeKillCode: code, treeKillSignal: signal, treeKillTimedOut: false });
    };
    const environment: NodeJS.ProcessEnv = {
      ...process.env,
      [EXITED_ROOT_PID_ENV]: String(rootPid),
      [EXITED_ROOT_STARTED_AT_ENV]: String(startedAt),
    };
    delete environment.ELECTRON_RUN_AS_NODE;
    try {
      terminator = spawn(
        'powershell.exe',
        [
          '-NoLogo',
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-Command',
          TERMINATE_EXITED_DESCENDANTS,
        ],
        {
          env: environment,
          stdio: 'ignore',
          windowsHide: true,
        },
      );
    } catch (error) {
      resolve({
        treeKillError: error instanceof Error ? error.name : 'spawn-failed',
        treeKillTimedOut: false,
      });
      return;
    }
    terminator.once('error', onError);
    terminator.once('close', onClose);
    const timer = setTimeout(
      () => {
        try {
          terminator.kill();
        } catch {
          // The timeout result remains authoritative.
        }
        finish({ treeKillTimedOut: true });
      },
      Math.max(1, timeoutMs),
    );
    timer.unref();
  });

export const runProcess = (
  executable: string,
  argumentsList: string[],
  environment: NodeJS.ProcessEnv,
  options: WindowsCommandOptions,
): Promise<CommandOutput> =>
  new Promise((resolve, reject) => {
    const signal = options.signal;
    if (signal?.aborted) {
      reject(abortReason(signal));
      return;
    }
    const childStartedAt = Date.now() - 1_000;
    const child = spawn(executable, argumentsList, {
      cwd: options.cwd,
      env: environment,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const maximumBytes = options.maxBuffer ?? 1024 * 1024;
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const decoders = {
      stderr: new StringDecoder('utf8'),
      stdout: new StringDecoder('utf8'),
    };
    const lineRemainders = { stderr: '', stdout: '' };
    let outputBytes = 0;
    let state: ProcessState = 'running';
    let operationTimer: NodeJS.Timeout | undefined;
    let abortListener: (() => void) | undefined;
    let childClosed = false;
    let resolveChildClose!: () => void;
    const childClose = new Promise<void>((resolveClose) => {
      resolveChildClose = resolveClose;
    });
    const emitLines = (stream: 'stderr' | 'stdout', text: string, flush = false): void => {
      const combined = `${lineRemainders[stream]}${text}`;
      const lines = combined.split(/\r?\n/);
      const remainder = lines.pop() ?? '';
      lineRemainders[stream] = flush ? '' : remainder;
      if (flush && lines.at(-1) === '') lines.pop();
      if (flush && remainder) lines.push(remainder);
      for (const line of lines) {
        try {
          options.onLine?.(line, stream);
        } catch {
          // Progress observers must never be able to break the child process lifecycle.
        }
      }
    };
    const stdoutCapture = (chunk: Buffer): void => capture(stdout, 'stdout', chunk);
    const stderrCapture = (chunk: Buffer): void => capture(stderr, 'stderr', chunk);
    const cleanupOwnedListeners = (): void => {
      child.stdout.removeListener('data', stdoutCapture);
      child.stderr.removeListener('data', stderrCapture);
      child.removeListener('error', onChildError);
      child.removeListener('close', onChildClose);
      if (abortListener && signal) signal.removeEventListener('abort', abortListener);
      if (operationTimer) clearTimeout(operationTimer);
    };
    const finish = (
      error?: Error,
      termination?: ProcessTerminationMetadata,
      flushProgress = true,
    ): void => {
      if (state === 'settled') return;
      state = 'settled';
      cleanupOwnedListeners();
      if (flushProgress) {
        emitLines('stdout', decoders.stdout.end(), true);
        emitLines('stderr', decoders.stderr.end(), true);
      } else {
        decoders.stdout.end();
        decoders.stderr.end();
      }
      const standardOutput = Buffer.concat(stdout).toString('utf8');
      const standardError = Buffer.concat(stderr).toString('utf8');
      if (error) {
        attachErrorMetadata(error, {
          stderr: standardError,
          stdout: standardOutput,
          ...(termination ? { killed: true, termination } : {}),
        });
        reject(error);
      } else {
        resolve({ stderr: standardError, stdout: standardOutput });
      }
    };
    const stop = (error: Error): void => {
      if (state !== 'running') return;
      state = 'stopping';
      if (operationTimer) clearTimeout(operationTimer);
      if (abortListener && signal) signal.removeEventListener('abort', abortListener);
      void (async () => {
        const deadline = Date.now() + PROCESS_CLEANUP_BUDGET_MS;
        const pid = child.pid;
        const processAlreadyExited = child.exitCode !== null || child.signalCode !== null;
        const termination: ProcessTerminationMetadata = {
          cleanupTimedOut: false,
          directKillAttempted: false,
          treeKillAttempted: process.platform === 'win32' && pid !== undefined,
          treeKillTimedOut: false,
        };
        if (termination.treeKillAttempted && pid !== undefined) {
          const treeKillTimeout = Math.min(
            TREE_KILL_TIMEOUT_MS,
            Math.max(1, deadline - Date.now()),
          );
          const treeResult = processAlreadyExited
            ? await terminateExitedWindowsDescendants(pid, childStartedAt, treeKillTimeout)
            : await terminateWindowsProcessTree(pid, treeKillTimeout);
          Object.assign(termination, treeResult);
        }
        const treeKillSucceeded = termination.treeKillAttempted && termination.treeKillCode === 0;
        if (!treeKillSucceeded && !childClosed) {
          termination.directKillAttempted = true;
          try {
            child.kill();
          } catch {
            // Cleanup metadata records that the direct fallback was attempted.
          }
        }
        if (!childClosed) {
          const closedWithinBudget = await waitWithin(
            childClose,
            Math.max(0, deadline - Date.now()),
          );
          termination.cleanupTimedOut = !closedWithinBudget;
        }
        if (termination.cleanupTimedOut) {
          child.stdout.destroy();
          child.stderr.destroy();
        }
        finish(error, termination, false);
      })().catch(() => {
        const termination: ProcessTerminationMetadata = {
          cleanupTimedOut: true,
          directKillAttempted: false,
          treeKillAttempted: false,
          treeKillError: 'cleanup-failed',
          treeKillTimedOut: false,
        };
        child.stdout.destroy();
        child.stderr.destroy();
        finish(error, termination, false);
      });
    };
    function capture(target: Buffer[], stream: 'stderr' | 'stdout', chunk: Buffer): void {
      if (state !== 'running') return;
      if (outputBytes + chunk.length > maximumBytes) {
        stop(new Error(`命令输出超过 ${maximumBytes} 字节限制。`));
        return;
      }
      outputBytes += chunk.length;
      target.push(chunk);
      emitLines(stream, decoders[stream].write(chunk));
    }
    function onChildError(error: Error): void {
      stop(error);
    }
    function onChildClose(code: number | null, closeSignal: NodeJS.Signals | null): void {
      childClosed = true;
      resolveChildClose();
      if (state !== 'running') return;
      if (code === 0) {
        finish();
        return;
      }
      const error = new Error(`命令执行失败（退出代码 ${code ?? closeSignal ?? '未知'}）。`);
      attachErrorMetadata(error, { code, killed: closeSignal !== null, signal: closeSignal });
      finish(error);
    }

    child.stdout.on('data', stdoutCapture);
    child.stderr.on('data', stderrCapture);
    child.on('error', onChildError);
    child.on('close', onChildClose);
    if (signal) {
      abortListener = () => stop(abortReason(signal));
      signal.addEventListener('abort', abortListener, { once: true });
      if (signal.aborted) abortListener();
    }
    if (options.timeout !== undefined && state === 'running') {
      operationTimer = setTimeout(() => {
        stop(new Error(`命令执行超过 ${options.timeout} 毫秒。`));
      }, options.timeout);
      operationTimer.unref();
    }
  });

export const resolveWindowsCommand = async (
  command: string,
  environment: NodeJS.ProcessEnv,
  cwd?: string,
  signal?: AbortSignal,
): Promise<string> => {
  const result = await runProcess(
    'powershell.exe',
    [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      RESOLVE_COMMAND,
    ],
    { ...environment, [COMMAND_ENV]: command },
    { cwd, maxBuffer: 64 * 1024, signal, timeout: 5_000 },
  );
  signal?.throwIfAborted();
  const resolved = result.stdout.trim();
  if (!resolved || !path.isAbsolute(resolved)) {
    throw new Error(`未找到 ${command} 命令。`);
  }
  return resolved;
};

export interface WindowsCommandInvocation {
  argumentsPrefix: string[];
  executable: string;
  source: string;
}

export const windowsCommandInvocationForPath = (
  resolved: string,
  command = path.basename(resolved, path.extname(resolved)),
): WindowsCommandInvocation => {
  if (!path.isAbsolute(resolved)) {
    throw new Error(`${command} 命令路径无效。`);
  }
  const extension = path.extname(resolved).toLowerCase();
  if (extension === '.ps1') {
    return {
      argumentsPrefix: [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        resolved,
      ],
      executable: 'powershell.exe',
      source: resolved,
    };
  }
  if (extension === '.cmd' || extension === '.bat') {
    const powershellShim = `${resolved.slice(0, -extension.length)}.ps1`;
    if (!existsSync(powershellShim)) {
      throw new Error(`${command} 只有批处理启动器，无法安全传递参数。请重新安装对应工具。`);
    }
    return windowsCommandInvocationForPath(powershellShim, command);
  }
  return { argumentsPrefix: [], executable: resolved, source: resolved };
};

export const resolveWindowsCommandInvocation = async (
  command: string,
  options: Pick<WindowsCommandOptions, 'cwd'> = {},
): Promise<WindowsCommandInvocation> => {
  const environment: NodeJS.ProcessEnv = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;
  return windowsCommandInvocationForPath(
    await resolveWindowsCommand(command, environment, options.cwd),
    command,
  );
};

/**
 * Resolves Windows `.ps1` shims and native executables first, then invokes the target with a closed
 * stdin handle. Arguments are always passed as an argv array and never interpolated into shell
 * source, so package names and marketplace URLs cannot become commands.
 */
export const runWindowsCommand = async (
  command: string,
  argumentsList: string[],
  options: WindowsCommandOptions = {},
): Promise<string> => {
  const environment = commandEnvironment(options.env);
  const resolved = await resolveWindowsCommand(command, environment, options.cwd, options.signal);
  options.signal?.throwIfAborted();
  const invocation = windowsCommandInvocationForPath(resolved, command);
  return (
    await runProcess(
      invocation.executable,
      [...invocation.argumentsPrefix, ...argumentsList],
      environment,
      options,
    )
  ).stdout;
};
