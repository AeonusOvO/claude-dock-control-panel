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

export const runProcess = (
  executable: string,
  argumentsList: string[],
  environment: NodeJS.ProcessEnv,
  options: WindowsCommandOptions,
): Promise<CommandOutput> =>
  new Promise((resolve, reject) => {
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
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const emitLines = (stream: 'stderr' | 'stdout', text: string, flush = false): void => {
      const combined = `${lineRemainders[stream]}${text}`;
      const lines = combined.split(/\r?\n/);
      const remainder = lines.pop() ?? '';
      lineRemainders[stream] = flush ? '' : remainder;
      if (flush && lines.at(-1) === '') {
        lines.pop();
      }
      if (flush && remainder) {
        lines.push(remainder);
      }
      for (const line of lines) {
        try {
          options.onLine?.(line, stream);
        } catch {
          // Progress observers must never be able to break the child process lifecycle.
        }
      }
    };
    const finish = (error?: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer) {
        clearTimeout(timer);
      }
      emitLines('stdout', decoders.stdout.end(), true);
      emitLines('stderr', decoders.stderr.end(), true);
      const standardOutput = Buffer.concat(stdout).toString('utf8');
      const standardError = Buffer.concat(stderr).toString('utf8');
      if (error) {
        Object.assign(error, { stderr: standardError, stdout: standardOutput });
        reject(error);
      } else {
        resolve({ stderr: standardError, stdout: standardOutput });
      }
    };
    const capture =
      (target: Buffer[], stream: 'stderr' | 'stdout') =>
      (chunk: Buffer): void => {
        outputBytes += chunk.length;
        if (outputBytes > maximumBytes) {
          child.kill();
          finish(new Error(`命令输出超过 ${maximumBytes} 字节限制。`));
          return;
        }
        target.push(chunk);
        emitLines(stream, decoders[stream].write(chunk));
      };
    child.stdout.on('data', capture(stdout, 'stdout'));
    child.stderr.on('data', capture(stderr, 'stderr'));
    child.on('error', finish);
    child.on('close', (code, signal) => {
      if (code === 0) {
        finish();
        return;
      }
      const error = new Error(`命令执行失败（退出代码 ${code ?? signal ?? '未知'}）。`);
      Object.assign(error, { code, killed: signal !== null, signal });
      finish(error);
    });
    if (options.timeout !== undefined) {
      timer = setTimeout(() => {
        child.kill();
        const error = new Error(`命令执行超过 ${options.timeout} 毫秒。`);
        Object.assign(error, { killed: true });
        finish(error);
      }, options.timeout);
      timer.unref();
    }
  });

export const resolveWindowsCommand = async (
  command: string,
  environment: NodeJS.ProcessEnv,
  cwd?: string,
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
    { cwd, maxBuffer: 64 * 1024, timeout: 5_000 },
  );
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
  const resolved = await resolveWindowsCommand(command, environment, options.cwd);
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
