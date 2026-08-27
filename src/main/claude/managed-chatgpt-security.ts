import { chmodSync, lstatSync, statSync } from 'node:fs';
import path from 'node:path';
import { runProcess } from '../infra/windows-command';
import { buildManagedGatewayEnvironment } from './managed-chatgpt-config';

const CONFIG_PATH_ENVIRONMENT = 'CLAUDEDOCK_GATEWAY_CONFIG_PATH';
const AUTH_TARGETS_ENVIRONMENT = 'CLAUDEDOCK_GATEWAY_AUTH_TARGETS';

const WINDOWS_CONFIG_ACL_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$configPath = [IO.Path]::GetFullPath($env:CLAUDEDOCK_GATEWAY_CONFIG_PATH)
$item = Get-Item -LiteralPath $configPath -Force
if ($item.PSIsContainer) { throw 'Managed gateway config path is a directory.' }
if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
  throw 'Managed gateway config path is a reparse point.'
}

$currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User
$systemSid = [Security.Principal.SecurityIdentifier]::new('S-1-5-18')
$security = [Security.AccessControl.FileSecurity]::new()
$security.SetOwner($currentSid)
$security.SetAccessRuleProtection($true, $false)
foreach ($sid in @($currentSid, $systemSid)) {
  $rule = [Security.AccessControl.FileSystemAccessRule]::new(
    $sid,
    [Security.AccessControl.FileSystemRights]::FullControl,
    [Security.AccessControl.AccessControlType]::Allow
  )
  [void]$security.AddAccessRule($rule)
}
[IO.File]::SetAccessControl($configPath, $security)

$verified = [IO.File]::GetAccessControl($configPath)
if (-not $verified.AreAccessRulesProtected) { throw 'Managed gateway config still inherits permissions.' }
$allowedSids = @($currentSid.Value, $systemSid.Value)
$observedSids = @()
foreach ($rule in $verified.Access) {
  $sid = $rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value
  $observedSids += $sid
  if ($allowedSids -notcontains $sid) { throw 'Managed gateway config has an unexpected access rule.' }
  if ($rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow) {
    throw 'Managed gateway config has an unexpected deny rule.'
  }
  if (($rule.FileSystemRights -band [Security.AccessControl.FileSystemRights]::FullControl) -ne [Security.AccessControl.FileSystemRights]::FullControl) {
    throw 'Managed gateway config access rule is incomplete.'
  }
}
foreach ($sid in $allowedSids) {
  if ($observedSids -notcontains $sid) { throw 'Managed gateway config is missing a required access rule.' }
}
`;

const WINDOWS_AUTH_ACL_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
function ProtectAuthTarget([string]$inputPath, [string]$kind) {
if ($kind -ne 'directory' -and $kind -ne 'file') { throw 'Invalid managed auth target kind.' }
$targetPath = [IO.Path]::GetFullPath($inputPath)
$isDirectory = $kind -eq 'directory'
$item = Get-Item -LiteralPath $targetPath -Force
if ($item.PSIsContainer -ne $isDirectory) { throw 'Managed gateway auth path kind changed.' }
if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
  throw 'Managed gateway auth path is a reparse point.'
}
$currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User
$systemSid = [Security.Principal.SecurityIdentifier]::new('S-1-5-18')
if ($isDirectory) {
  $security = [Security.AccessControl.DirectorySecurity]::new()
  $inheritance = [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
} else {
  $security = [Security.AccessControl.FileSecurity]::new()
  $inheritance = [Security.AccessControl.InheritanceFlags]::None
}
$security.SetOwner($currentSid)
$security.SetAccessRuleProtection($true, $false)
foreach ($sid in @($currentSid, $systemSid)) {
  $rule = [Security.AccessControl.FileSystemAccessRule]::new(
    $sid,
    [Security.AccessControl.FileSystemRights]::FullControl,
    $inheritance,
    [Security.AccessControl.PropagationFlags]::None,
    [Security.AccessControl.AccessControlType]::Allow
  )
  [void]$security.AddAccessRule($rule)
}
if ($isDirectory) {
  [IO.Directory]::SetAccessControl($targetPath, $security)
  $verified = [IO.Directory]::GetAccessControl($targetPath)
} else {
  [IO.File]::SetAccessControl($targetPath, $security)
  $verified = [IO.File]::GetAccessControl($targetPath)
}
if (-not $verified.AreAccessRulesProtected) { throw 'Managed gateway auth path inherits permissions.' }
$allowedSids = @($currentSid.Value, $systemSid.Value)
$observedSids = @()
foreach ($rule in $verified.Access) {
  $sid = $rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value
  $observedSids += $sid
  if ($allowedSids -notcontains $sid) { throw 'Managed gateway auth path has an unexpected rule.' }
  if ($rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow) {
    throw 'Managed gateway auth path has an unexpected deny rule.'
  }
  if (($rule.FileSystemRights -band [Security.AccessControl.FileSystemRights]::FullControl) -ne [Security.AccessControl.FileSystemRights]::FullControl) {
    throw 'Managed gateway auth path access rule is incomplete.'
  }
}
foreach ($sid in $allowedSids) {
  if ($observedSids -notcontains $sid) { throw 'Managed gateway auth path misses a required rule.' }
}
}
$targets = ConvertFrom-Json -InputObject $env:CLAUDEDOCK_GATEWAY_AUTH_TARGETS
foreach ($target in $targets) {
  ProtectAuthTarget ([string]$target.targetPath) ([string]$target.kind)
}
`;

type ProcessRunner = typeof runProcess;

export interface ManagedGatewayConfigProtectionOptions {
  platform?: NodeJS.Platform;
  run?: ProcessRunner;
}

export const protectManagedGatewayConfig = async (
  configPath: string,
  options: ManagedGatewayConfigProtectionOptions = {},
): Promise<void> => {
  if (!path.isAbsolute(configPath)) {
    throw new Error('托管网关配置文件路径无效。');
  }
  const platform = options.platform ?? process.platform;
  if (platform !== 'win32') {
    if (lstatSync(configPath).isSymbolicLink()) {
      throw new Error('托管网关配置文件路径无效。');
    }
    chmodSync(configPath, 0o600);
    if ((statSync(configPath).mode & 0o077) !== 0) {
      throw new Error('托管网关配置文件权限无法限制为当前用户。');
    }
    return;
  }

  const environment = buildManagedGatewayEnvironment();
  for (const name of Object.keys(environment)) {
    if (name.toUpperCase() === CONFIG_PATH_ENVIRONMENT) {
      delete environment[name];
    }
  }
  environment[CONFIG_PATH_ENVIRONMENT] = configPath;

  try {
    await (options.run ?? runProcess)(
      'powershell.exe',
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        WINDOWS_CONFIG_ACL_SCRIPT,
      ],
      environment,
      { maxBuffer: 64 * 1024, timeout: 10_000 },
    );
  } catch (error) {
    throw new Error('无法确认托管网关配置文件仅允许当前 Windows 用户和系统账户访问。', {
      cause: error,
    });
  }
};

export const protectManagedGatewayAuthentication = async (
  authDirectory: string,
  artifactPaths: readonly string[],
  options: ManagedGatewayConfigProtectionOptions = {},
): Promise<void> => {
  if (!path.isAbsolute(authDirectory)) {
    throw new Error('托管网关授权目录路径无效。');
  }
  const normalizedDirectory = path.resolve(authDirectory);
  const targets = [
    { kind: 'directory', targetPath: normalizedDirectory },
    ...artifactPaths.map((artifactPath) => ({
      kind: 'file',
      targetPath: path.resolve(artifactPath),
    })),
  ] as const;
  const platform = options.platform ?? process.platform;
  const pathEquals = (left: string, right: string): boolean =>
    platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
  if (
    targets
      .slice(1)
      .some(({ targetPath }) => !pathEquals(path.dirname(targetPath), normalizedDirectory))
  ) {
    throw new Error('托管网关授权文件路径无效。');
  }
  if (platform !== 'win32') {
    for (const { kind, targetPath } of targets) {
      const stats = lstatSync(targetPath);
      if (
        stats.isSymbolicLink() ||
        (kind === 'directory' ? !stats.isDirectory() : !stats.isFile())
      ) {
        throw new Error('托管网关授权文件路径无效。');
      }
      chmodSync(targetPath, kind === 'directory' ? 0o700 : 0o600);
      if ((statSync(targetPath).mode & 0o077) !== 0) {
        throw new Error('托管网关授权路径权限无法限制为当前用户。');
      }
    }
    return;
  }
  const environment = buildManagedGatewayEnvironment();
  for (const name of Object.keys(environment)) {
    if (name.toUpperCase() === AUTH_TARGETS_ENVIRONMENT) delete environment[name];
  }
  environment[AUTH_TARGETS_ENVIRONMENT] = JSON.stringify(targets);
  try {
    // Protect and verify the directory plus all exact child artifacts in one helper process.
    await (options.run ?? runProcess)(
      'powershell.exe',
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        WINDOWS_AUTH_ACL_SCRIPT,
      ],
      environment,
      { maxBuffer: 64 * 1024, timeout: 10_000 },
    );
  } catch (error) {
    throw new Error('无法确认托管网关授权路径仅允许当前 Windows 用户和系统账户访问。', {
      cause: error,
    });
  }
};
