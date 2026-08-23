import path from 'node:path';
import { runProcess } from '../infra/windows-command';

const OPERATION_ENVIRONMENT_PREFIX = 'CLAUDEDOCK_GATEWAY_PROCESS_';
const PROCESS_OPERATION_TIMEOUT_MS = 2_000;
const CAPTURE_RETRY_DELAY_MS = 25;
const PROCESS_BIRTH_TOKEN = /^\d{10,20}$/;

const WINDOWS_PROCESS_OPERATION_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class ClaudeDockCommandLine {
  [DllImport(
    "shell32.dll",
    EntryPoint = "CommandLineToArgvW",
    SetLastError = true,
    CharSet = CharSet.Unicode,
    ExactSpelling = true
  )]
  private static extern IntPtr CommandLineToArgvW(
    [MarshalAs(UnmanagedType.LPWStr)] string commandLine,
    out int argc
  );
  [DllImport("kernel32.dll")]
  private static extern IntPtr LocalFree(IntPtr value);
  public static string[] Parse(string commandLine) {
    int argc;
    IntPtr argv = CommandLineToArgvW(commandLine, out argc);
    if (argv == IntPtr.Zero) throw new InvalidOperationException("Command line parsing failed.");
    try {
      string[] values = new string[argc];
      for (int index = 0; index < argc; index++) {
        IntPtr value = Marshal.ReadIntPtr(argv, index * IntPtr.Size);
        values[index] = Marshal.PtrToStringUni(value);
      }
      return values;
    } finally {
      LocalFree(argv);
    }
  }
}
'@

function Finish([string]$value) {
  [Console]::Out.Write($value)
  exit 0
}

function SamePath([string]$left, [string]$right) {
  return [String]::Equals(
    [IO.Path]::GetFullPath($left).TrimEnd('\\'),
    [IO.Path]::GetFullPath($right).TrimEnd('\\'),
    [StringComparison]::OrdinalIgnoreCase
  )
}

$mode = $env:CLAUDEDOCK_GATEWAY_PROCESS_MODE
$expectedPid = 0
if (-not [Int32]::TryParse($env:CLAUDEDOCK_GATEWAY_PROCESS_PID, [ref]$expectedPid) -or $expectedPid -le 0) {
  Finish 'INVALID'
}
try {
  $process = [Diagnostics.Process]::GetProcessById($expectedPid)
  $process.Handle | Out-Null
} catch [ArgumentException] {
  Finish 'ABSENT'
} catch {
  Finish 'INACCESSIBLE'
}

try {
  $birth = $process.StartTime.ToUniversalTime().Ticks.ToString([Globalization.CultureInfo]::InvariantCulture)
  if ($mode -ne 'capture' -and $birth -ne $env:CLAUDEDOCK_GATEWAY_PROCESS_BIRTH) {
    Finish 'MISMATCH'
  }
  if (-not (SamePath $process.MainModule.FileName $env:CLAUDEDOCK_GATEWAY_PROCESS_EXE)) {
    Finish 'MISMATCH'
  }
  $cim = Get-CimInstance Win32_Process -Filter "ProcessId = $expectedPid"
  if ($null -eq $cim -or -not (SamePath $cim.ExecutablePath $env:CLAUDEDOCK_GATEWAY_PROCESS_EXE)) {
    Finish 'MISMATCH'
  }
  $arguments = [ClaudeDockCommandLine]::Parse($cim.CommandLine)
  if (
    $arguments.Length -ne 3 -or
    -not (SamePath $arguments[0] $env:CLAUDEDOCK_GATEWAY_PROCESS_EXE) -or
    $arguments[1] -cne '-config' -or
    -not (SamePath $arguments[2] $env:CLAUDEDOCK_GATEWAY_PROCESS_CONFIG)
  ) {
    Finish 'MISMATCH'
  }
} catch {
  Finish 'INACCESSIBLE'
}

if ($mode -eq 'capture') {
  Finish ("MATCH:" + $birth)
}
if ($mode -eq 'terminate') {
  try {
    # Keep the verified Process handle open while taskkill addresses the PID. Windows cannot reuse
    # that PID while this handle remains open, so /T targets only this exact verified root instance.
    $windows = [Environment]::GetFolderPath([Environment+SpecialFolder]::Windows)
    $taskkill = [IO.Path]::Combine($windows, 'System32', 'taskkill.exe')
    & $taskkill '/F' '/T' '/PID' ([string]$expectedPid) 2>$null | Out-Null
    $taskkillCode = $LASTEXITCODE
    if (-not $process.WaitForExit(1500)) { Finish 'TIMEOUT' }
    if ($taskkillCode -ne 0 -and -not $process.HasExited) { Finish 'INACCESSIBLE' }
    Finish 'TERMINATED'
  } catch {
    Finish 'INACCESSIBLE'
  }
}

$expectedPort = 0
if (-not [Int32]::TryParse($env:CLAUDEDOCK_GATEWAY_PROCESS_PORT, [ref]$expectedPort)) {
  Finish 'INVALID'
}
try {
  if ($mode -eq 'connection') {
    $clientPort = 0
    if (-not [Int32]::TryParse($env:CLAUDEDOCK_GATEWAY_PROCESS_CLIENT_PORT, [ref]$clientPort)) {
      Finish 'INVALID'
    }
    $connections = @(
      Get-NetTCPConnection -State Established -LocalPort $expectedPort -RemotePort $clientPort |
        Where-Object {
          $_.OwningProcess -eq $expectedPid -and
          $_.LocalAddress -eq '127.0.0.1' -and
          $_.RemoteAddress -eq '127.0.0.1'
        }
    )
    if ($connections.Count -ne 1) { Finish 'MISMATCH' }
    Finish 'MATCH'
  }
  $listeners = @(
    Get-NetTCPConnection -State Listen -LocalPort $expectedPort |
      Where-Object { $_.OwningProcess -eq $expectedPid -and $_.LocalAddress -eq '127.0.0.1' }
  )
  if ($listeners.Count -ne 1) { Finish 'MISMATCH' }
  Finish 'MATCH'
} catch {
  Finish 'INACCESSIBLE'
}
`;

type ProcessRunner = typeof runProcess;

export interface ManagedGatewayProcessBirthIdentity {
  startedAtTicks: string;
  version: 1;
}

export interface ManagedGatewayExactProcess {
  configPath: string;
  executablePath: string;
  identity: ManagedGatewayProcessBirthIdentity;
  port: number;
  processId: number;
}

export type ManagedGatewayProcessMatch = 'absent' | 'inaccessible' | 'match' | 'mismatch';
export type ManagedGatewayProcessTermination =
  'inaccessible' | 'mismatch' | 'terminated' | 'timeout';

export interface ManagedGatewayEstablishedConnection {
  clientPort: number;
  process: ManagedGatewayExactProcess;
}

export interface ManagedGatewayProcessIdentityOptions {
  platform?: NodeJS.Platform;
  run?: ProcessRunner;
}

const inheritedSystemEnvironment = (): NodeJS.ProcessEnv => {
  const environment: NodeJS.ProcessEnv = {};
  const allowed = new Set([
    'COMSPEC',
    'PATH',
    'PATHEXT',
    'PSMODULEPATH',
    'SYSTEMDRIVE',
    'SYSTEMROOT',
    'TEMP',
    'TMP',
    'WINDIR',
  ]);
  for (const [name, value] of Object.entries(process.env)) {
    if (allowed.has(name.toUpperCase()) && value !== undefined) {
      environment[name] = value;
    }
  }
  return environment;
};

const setEnvironment = (environment: NodeJS.ProcessEnv, name: string, value: string): void => {
  const normalized = name.toUpperCase();
  for (const existing of Object.keys(environment)) {
    if (existing.toUpperCase() === normalized) delete environment[existing];
  }
  environment[name] = value;
};

const validateDescriptor = (process: Omit<ManagedGatewayExactProcess, 'identity'>): void => {
  if (
    !Number.isInteger(process.processId) ||
    process.processId <= 0 ||
    !Number.isInteger(process.port) ||
    process.port <= 0 ||
    process.port > 65_535 ||
    !path.isAbsolute(process.executablePath) ||
    !path.isAbsolute(process.configPath)
  ) {
    throw new Error('托管网关进程身份参数无效。');
  }
};

const delay = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    timer.unref();
  });

/** Uses one fixed main-process operation so expected paths never become generated script text. */
export class ManagedGatewayProcessIdentity {
  private readonly platform: NodeJS.Platform;
  private readonly run: ProcessRunner;

  public constructor(options: ManagedGatewayProcessIdentityOptions = {}) {
    this.platform = options.platform ?? process.platform;
    this.run = options.run ?? runProcess;
  }

  public async capture(
    process: Omit<ManagedGatewayExactProcess, 'identity'>,
    timeoutMs = PROCESS_OPERATION_TIMEOUT_MS,
  ): Promise<ManagedGatewayProcessBirthIdentity | undefined> {
    validateDescriptor(process);
    const deadline = Date.now() + timeoutMs;
    do {
      const result = await this.operation('capture', process, undefined, deadline - Date.now());
      if (result.startsWith('MATCH:')) {
        const startedAtTicks = result.slice('MATCH:'.length);
        return PROCESS_BIRTH_TOKEN.test(startedAtTicks)
          ? { startedAtTicks, version: 1 }
          : undefined;
      }
      if (result === 'MISMATCH' || result === 'ABSENT') return undefined;
      await delay(Math.min(CAPTURE_RETRY_DELAY_MS, Math.max(1, deadline - Date.now())));
    } while (Date.now() < deadline);
    return undefined;
  }

  public async matches(
    process: ManagedGatewayExactProcess,
    timeoutMs = PROCESS_OPERATION_TIMEOUT_MS,
  ): Promise<ManagedGatewayProcessMatch> {
    validateDescriptor(process);
    if (
      process.identity.version !== 1 ||
      !PROCESS_BIRTH_TOKEN.test(process.identity.startedAtTicks)
    ) {
      return 'mismatch';
    }
    return this.matchResult(await this.operation('inspect', process, undefined, timeoutMs));
  }

  public async ownsEstablishedConnection(
    connection: ManagedGatewayEstablishedConnection,
    timeoutMs = PROCESS_OPERATION_TIMEOUT_MS,
  ): Promise<boolean> {
    try {
      validateDescriptor(connection.process);
    } catch {
      return false;
    }
    if (
      connection.process.identity.version !== 1 ||
      !PROCESS_BIRTH_TOKEN.test(connection.process.identity.startedAtTicks) ||
      !Number.isInteger(connection.clientPort) ||
      connection.clientPort <= 0 ||
      connection.clientPort > 65_535
    ) {
      return false;
    }
    return (
      (await this.operation('connection', connection.process, connection.clientPort, timeoutMs)) ===
      'MATCH'
    );
  }

  public async terminate(
    process: ManagedGatewayExactProcess,
    timeoutMs = PROCESS_OPERATION_TIMEOUT_MS,
  ): Promise<ManagedGatewayProcessTermination> {
    validateDescriptor(process);
    if (
      process.identity.version !== 1 ||
      !PROCESS_BIRTH_TOKEN.test(process.identity.startedAtTicks)
    ) {
      return 'mismatch';
    }
    const result = await this.operation('terminate', process, undefined, timeoutMs);
    if (result === 'TERMINATED') return 'terminated';
    if (result === 'TIMEOUT') return 'timeout';
    return result === 'MISMATCH' || result === 'ABSENT' ? 'mismatch' : 'inaccessible';
  }

  private matchResult(result: string): ManagedGatewayProcessMatch {
    if (result === 'MATCH') return 'match';
    if (result === 'ABSENT') return 'absent';
    if (result === 'MISMATCH') return 'mismatch';
    return 'inaccessible';
  }

  private async operation(
    mode: 'capture' | 'connection' | 'inspect' | 'terminate',
    process: Omit<ManagedGatewayExactProcess, 'identity'> &
      Partial<Pick<ManagedGatewayExactProcess, 'identity'>>,
    clientPort?: number,
    timeoutMs = PROCESS_OPERATION_TIMEOUT_MS,
  ): Promise<string> {
    if (this.platform !== 'win32') return 'INACCESSIBLE';
    const environment = inheritedSystemEnvironment();
    const values: Record<string, string> = {
      BIRTH: process.identity?.startedAtTicks ?? '',
      CLIENT_PORT: clientPort === undefined ? '' : String(clientPort),
      CONFIG: process.configPath,
      EXE: process.executablePath,
      MODE: mode,
      PID: String(process.processId),
      PORT: String(process.port),
    };
    for (const [name, value] of Object.entries(values)) {
      setEnvironment(environment, `${OPERATION_ENVIRONMENT_PREFIX}${name}`, value);
    }
    try {
      const { stdout } = await this.run(
        'powershell.exe',
        [
          '-NoLogo',
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-Command',
          WINDOWS_PROCESS_OPERATION_SCRIPT,
        ],
        environment,
        { maxBuffer: 4 * 1024, timeout: Math.max(1, timeoutMs) },
      );
      return stdout.trim();
    } catch {
      return 'INACCESSIBLE';
    }
  }
}
