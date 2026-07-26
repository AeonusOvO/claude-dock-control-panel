import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

const COMMAND_ENV = 'CLAUDEDOCK_COMMAND_NAME';
const RESOLVE_COMMAND = `$command = Get-Command $env:${COMMAND_ENV} -ErrorAction Stop | Select-Object -First 1; [Console]::Out.Write($command.Source)`;

export interface WindowsCommandOptions {
  cwd?: string;
  maxBuffer?: number;
  timeout?: number;
}

interface CommandOutput {
  stderr: string;
  stdout: string;
}

const runProcess = (
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
    let outputBytes = 0;
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (error?: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer) {
        clearTimeout(timer);
      }
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
      (target: Buffer[]) =>
      (chunk: Buffer): void => {
        outputBytes += chunk.length;
        if (outputBytes > maximumBytes) {
          child.kill();
          finish(new Error(`命令输出超过 ${maximumBytes} 字节限制。`));
          return;
        }
        target.push(chunk);
      };
    child.stdout.on('data', capture(stdout));
    child.stderr.on('data', capture(stderr));
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

const resolveWindowsCommand = async (
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
  const environment: NodeJS.ProcessEnv = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;
  const resolved = await resolveWindowsCommand(command, environment, options.cwd);
  const extension = path.extname(resolved).toLowerCase();
  let executable = resolved;
  let finalArguments = argumentsList;
  if (extension === '.ps1') {
    executable = 'powershell.exe';
    finalArguments = [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      resolved,
      ...argumentsList,
    ];
  } else if (extension === '.cmd' || extension === '.bat') {
    const powershellShim = `${resolved.slice(0, -extension.length)}.ps1`;
    if (!existsSync(powershellShim)) {
      throw new Error(`${command} 只有批处理启动器，无法安全传递参数。请重新安装对应工具。`);
    }
    executable = 'powershell.exe';
    finalArguments = [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      powershellShim,
      ...argumentsList,
    ];
  }
  return (await runProcess(executable, finalArguments, environment, options)).stdout;
};
