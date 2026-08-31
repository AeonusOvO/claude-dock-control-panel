import { createHash } from 'node:crypto';
import path from 'node:path';
import type {
  ClaudeConnectionAdvice,
  ClaudeConnectionHistoryEntry,
  ClaudeEndpointProtocol,
  ClaudeInstallationStatus,
  ClaudeRouterManagementState,
  ClaudeRouterProviderProtocol,
  SaveClaudeConfigInput,
  SaveClaudeRouterProviderInput,
} from '../../shared/contracts';
import { findClaudeProvider } from '../../shared/claude/providers';
import { claudeMessagesEndpoint } from './connection-test';
import type { NormalizedClaudeConfig } from './configuration';

export const connectionProtocolForRouterProvider = (
  protocol: ClaudeRouterProviderProtocol,
): Exclude<ClaudeEndpointProtocol, 'unknown'> =>
  protocol === 'anthropic_messages' ? 'anthropic' : 'openai';

export const defaultConnectionProtocolForPreset = (
  preset: SaveClaudeConfigInput['preset'],
): ClaudeEndpointProtocol =>
  preset === 'gateway' ? 'unknown' : (findClaudeProvider(preset)?.protocol ?? 'anthropic');

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', '[::1]', 'localhost']);

const projectKey = (cwd: string): string => path.resolve(cwd).toLocaleLowerCase('en-US');

const credentialDigest = (credential?: string): string =>
  createHash('sha256')
    .update(credential ?? '')
    .digest('hex');

const connectionFingerprint = (config: NormalizedClaudeConfig, credential?: string): string =>
  JSON.stringify({
    apiKeyHelperPolicy: config.apiKeyHelperPolicy,
    authMode: config.authMode,
    baseUrl: config.baseUrl,
    credentialDigest: credentialDigest(credential),
    model: config.model,
    modelFast: config.modelFast || config.model,
    preset: config.preset,
    provider: config.provider,
  });

export const connectionEndpointFingerprint = (
  config: NormalizedClaudeConfig,
  credential?: string,
  routerProviderId?: string,
  protocol: ClaudeEndpointProtocol = 'unknown',
): string =>
  JSON.stringify({
    apiKeyHelperPolicy: config.apiKeyHelperPolicy,
    authMode: config.authMode,
    baseUrl: config.baseUrl,
    credentialDigest: credentialDigest(credential),
    preset: config.preset,
    protocol,
    provider: config.provider,
    routerProviderId: routerProviderId ?? '',
  });

export const usesDefaultClaudeRouter = (config: NormalizedClaudeConfig): boolean => {
  if (config.provider !== 'gateway' || !config.baseUrl) {
    return false;
  }
  try {
    const parsed = new URL(config.baseUrl);
    const port = Number(parsed.port || (parsed.protocol === 'https:' ? 443 : 80));
    return (
      parsed.protocol === 'http:' &&
      LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase()) &&
      port === 3456
    );
  } catch {
    return false;
  }
};

export const routerRepairInputForProject = (
  config: NormalizedClaudeConfig,
  credential?: string,
): SaveClaudeRouterProviderInput => {
  let parsed: URL;
  try {
    parsed = new URL(config.baseUrl);
  } catch {
    throw new Error('当前项目没有可复制到路由器的远程 Anthropic 接口。');
  }
  if (
    config.provider !== 'gateway' ||
    usesDefaultClaudeRouter(config) ||
    parsed.protocol !== 'https:'
  ) {
    throw new Error('当前项目不是可复制到路由器的 HTTPS 远程接入配置。');
  }
  if (config.authMode !== 'apiKey' || !credential) {
    throw new Error('一键修复要求当前项目已保存接口密钥；持有者令牌或无认证上游请手动添加。');
  }
  const providerSuffix =
    parsed.hostname
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 65) || 'current-project';
  return {
    apiKey: credential,
    baseUrl: claudeMessagesEndpoint(config.baseUrl),
    credentialAction: 'replace',
    makePreferred: true,
    models: [config.model],
    name: `claudedock-${providerSuffix}`,
    protocol: 'anthropic_messages',
    useForCurrentProject: false,
  };
};

export const routerBlockingDetail = (
  config: NormalizedClaudeConfig,
  router: ClaudeRouterManagementState,
): string | undefined => {
  if (!usesDefaultClaudeRouter(config)) {
    return undefined;
  }
  if (router.providers.length === 0) {
    return '当前项目指向路由器的 3456 接口，但 CCR 没有任何服务提供方或模型。请先在“模型”页添加服务提供方。';
  }
  if (router.gatewayState !== 'running') {
    return `当前项目指向路由器的 3456 接口，但模型网关未就绪：${router.message}`;
  }
  return undefined;
};

/** A relay ("中转站") is any remote gateway base URL saved in the project configuration. */
export const usesRemoteRelay = (config: NormalizedClaudeConfig): boolean =>
  config.provider === 'gateway' && Boolean(config.baseUrl) && !usesDefaultClaudeRouter(config);

/**
 * Turns the saved config plus live Router state into one plain-language verdict. Computed in the
 * main process so the advice is identical whether or not the user ever pasted a curl command.
 */
export const computeClaudeConnectionAdvice = (
  config: NormalizedClaudeConfig,
  credentialConfigured: boolean,
  router: ClaudeRouterManagementState,
  installation: ClaudeInstallationStatus,
): ClaudeConnectionAdvice => {
  const routerNeeded = usesDefaultClaudeRouter(config);
  const routerGatewayUp = router.gatewayState === 'running' || router.gatewayState === 'starting';
  const routerRunningButUnused = !routerNeeded && routerGatewayUp;
  const credentialMissing =
    (config.authMode === 'apiKey' || config.authMode === 'authToken') && !credentialConfigured;

  if (installation.security !== 'ready') {
    return {
      actions: [],
      detail: installation.message,
      routerNeeded,
      routerRunningButUnused,
      title: 'Claude Code 尚未就绪',
      tone: 'error',
    };
  }

  if (credentialMissing) {
    return {
      actions: ['save-config'],
      detail: '当前接入方式需要密钥，但当前项目还没有保存。填好密钥后点“保存接入配置”即可。',
      routerNeeded,
      routerRunningButUnused,
      title: '还缺一个接口密钥',
      tone: 'warning',
    };
  }

  if (routerNeeded) {
    if (!router.installed) {
      return {
        actions: ['install-router', 'switch-to-direct'],
        detail:
          '当前配置选择了本机路由器 3456，但 CCR 尚未安装。请先安装路由器，或改用可用的 Anthropic 消息兼容接口。',
        routerNeeded,
        routerRunningButUnused: false,
        title: '需要先安装路由器',
        tone: 'error',
      };
    }
    if (router.providers.length === 0) {
      return {
        actions: ['open-router-management', 'switch-to-direct'],
        detail: '路由器已安装但还没有任何服务提供方，模型请求无处可去。请先添加一个服务提供方。',
        routerNeeded,
        routerRunningButUnused: false,
        title: '路由器还没有配置上游',
        tone: 'warning',
      };
    }
    if (!routerGatewayUp) {
      return {
        actions: ['start-router'],
        detail: `当前项目通过路由器连接模型服务，但模型网关没有运行：${router.message}`,
        routerNeeded,
        routerRunningButUnused: false,
        title: '路由器网关未启动',
        tone: 'warning',
      };
    }
    return {
      actions: ['test-connection'],
      detail: `路由器网关运行中，已配置 ${router.providers.length} 个服务提供方，当前项目会经由它访问模型。`,
      routerNeeded,
      routerRunningButUnused: false,
      title: '经路由器接入，一切正常',
      tone: 'success',
    };
  }

  if (usesRemoteRelay(config)) {
    return {
      actions: ['test-connection'],
      detail: `已配置 Anthropic 消息兼容接口 ${config.baseUrl}。建议保存后执行真实连接测试。`,
      routerNeeded: false,
      routerRunningButUnused,
      title: '兼容接口已配置',
      tone: 'success',
    };
  }

  if (config.provider === 'gateway') {
    return {
      actions: ['import-curl', 'save-config'],
      detail:
        '选了“网关/中转站”但还没有填接口地址。可以直接粘贴中转站给的 curl 命令，自动带出地址、密钥和模型。',
      routerNeeded: false,
      routerRunningButUnused,
      title: '还没有填写接口地址',
      tone: 'warning',
    };
  }

  return {
    actions: ['test-connection'],
    detail: 'Claude Code 将使用现有官方登录或已保存的官方凭据。可执行连接测试确认当前状态。',
    routerNeeded: false,
    routerRunningButUnused,
    title: '使用 Anthropic 官方接入',
    tone: 'success',
  };
};

/**
 * What makes two setups "the same endpoint" for switching purposes: identical route, credential
 * kind and preset. Anything else means a different PTY environment and therefore a relaunch.
 */
const endpointKey = (value: {
  apiKeyHelperPolicy: string;
  authMode: string;
  baseUrl: string;
  preset: string;
  provider: string;
}): string =>
  `${value.provider}|${value.preset}|${value.authMode}|${value.apiKeyHelperPolicy}|${value.baseUrl}`;

const customRouterProviderName = (endpoint: string): string => {
  const hostname =
    new URL(endpoint).hostname
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'openai-relay';
  const suffix = createHash('sha256').update(endpoint).digest('hex').slice(0, 8);
  return `claudedock-${hostname}-${suffix}`;
};

const describeEndpoint = (entry: ClaudeConnectionHistoryEntry): string => {
  const providerLabel = findClaudeProvider(entry.preset)?.label ?? '自定义接入';
  if (entry.provider !== 'gateway' || !entry.baseUrl) {
    return providerLabel;
  }
  try {
    return `${providerLabel} · ${new URL(entry.baseUrl).host}`;
  } catch {
    return providerLabel;
  }
};

export {
  connectionFingerprint,
  customRouterProviderName,
  describeEndpoint,
  endpointKey,
  projectKey,
};
