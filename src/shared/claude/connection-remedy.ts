import type {
  ClaudeAuthMode,
  ClaudeConnectionTestResult,
  ClaudeSecurityStatus,
} from '../contracts';
import type { ClaudeProviderDefinition } from './providers';

export type ClaudeConnectionRemedyActionKind =
  | 'install-claude'
  | 'install-router'
  | 'open-console'
  | 'open-docs'
  | 'retry'
  | 'start-router'
  | 'switch-auth-mode'
  | 'switch-provider'
  | 'use-fast-model';

export interface ClaudeConnectionRemedyAction {
  authMode?: ClaudeAuthMode;
  kind: ClaudeConnectionRemedyActionKind;
  label: string;
  providerId?: string;
  url?: string;
}

export interface ClaudeConnectionRemedy {
  actions: ClaudeConnectionRemedyAction[];
  cause: string;
  fix: string;
  title: string;
}

export interface ClaudeConnectionRemedyContext {
  installationSecurity?: ClaudeSecurityStatus;
  provider?: ClaudeProviderDefinition;
  routerInstalled?: boolean;
  routerRunning?: boolean;
}

const providerLinks = (
  provider: ClaudeProviderDefinition | undefined,
): ClaudeConnectionRemedyAction[] => [
  ...(provider?.consoleUrl
    ? [{ kind: 'open-console' as const, label: '打开密钥控制台', url: provider.consoleUrl }]
    : []),
  ...(provider?.docsUrl
    ? [{ kind: 'open-docs' as const, label: '查看官方接入文档', url: provider.docsUrl }]
    : []),
];

export const diagnoseClaudeConnection = (
  result: ClaudeConnectionTestResult,
  context: ClaudeConnectionRemedyContext = {},
): ClaudeConnectionRemedy | undefined => {
  if (result.ok) {
    return undefined;
  }

  const { provider } = context;
  const retry: ClaudeConnectionRemedyAction = { kind: 'retry', label: '重新测试' };
  if (
    context.installationSecurity === 'not-installed' ||
    context.installationSecurity === 'blocked-version' ||
    context.installationSecurity === 'update-required'
  ) {
    return {
      actions: [{ kind: 'install-claude', label: '安装或更新 Claude Code' }],
      cause: 'Claude Code 尚未达到受保护启动要求。',
      fix: '先完成安装或更新，再继续配置服务商。',
      title: '先准备 Claude Code 环境',
    };
  }

  if (provider?.id === 'gateway' && !context.routerInstalled) {
    return {
      actions: [
        { kind: 'install-router', label: '安装本地路由器' },
        { kind: 'switch-provider', label: '改用直连服务商' },
      ],
      cause: '当前选择本地路由器，但这台电脑还没有可管理的路由器。',
      fix: '安装路由器，或返回第一步选择支持 Anthropic Messages 的直连服务商。',
      title: '本地路由器尚未安装',
    };
  }

  if (provider?.id === 'gateway' && context.routerInstalled && !context.routerRunning) {
    return {
      actions: [
        { kind: 'start-router', label: '启动本地路由器' },
        { kind: 'switch-provider', label: '改用直连服务商' },
      ],
      cause: '本地路由器已安装，但模型接口当前没有运行。',
      fix: '启动路由器后重试，或改用直连服务商。',
      title: '本地路由器未运行',
    };
  }

  if (result.failureKind === 'authentication') {
    const alternative: ClaudeAuthMode =
      result.authMode === 'apiKey'
        ? 'authToken'
        : result.authMode === 'authToken'
          ? 'apiKey'
          : 'apiKey';
    const kimiMismatch =
      provider?.id === 'kimi-open' || provider?.id === 'kimi-code'
        ? 'Kimi 开放平台与 Kimi Code 会员的密钥和基址不能混用。'
        : '服务端已响应，但拒绝了当前凭据或认证请求头。';
    return {
      actions: [
        { authMode: alternative, kind: 'switch-auth-mode', label: '切换认证方式' },
        ...providerLinks(provider),
        retry,
      ],
      cause: kimiMismatch,
      fix: '核对密钥所属平台和有效期；若文档要求 Bearer，请使用持有者令牌认证。',
      title: '认证没有通过',
    };
  }

  if (result.failureKind === 'not-found') {
    return {
      actions: [
        { kind: 'switch-provider', label: '返回选择服务商' },
        { kind: 'install-router', label: '用本地路由器转换' },
        ...providerLinks(provider),
      ],
      cause: '当前基址下没有 Anthropic /v1/messages 端点，常见原因是粘贴了 OpenAI 接口。',
      fix: '换成服务商的 Anthropic 兼容基址；只有 OpenAI 接口时先通过本地路由器转换。',
      title: '接口协议或路径不匹配',
    };
  }

  if (result.failureKind === 'model') {
    return {
      actions: [
        ...(provider?.modelFast
          ? [{ kind: 'use-fast-model' as const, label: '改用推荐快速模型' }]
          : []),
        ...providerLinks(provider),
        retry,
      ],
      cause: '端点和认证已通过，但服务端没有接受当前模型名或请求字段。',
      fix: '从服务商控制台复制可用模型标识，或先尝试目录中的快速模型。',
      title: '模型配置需要调整',
    };
  }

  if (result.failureKind === 'response-shape') {
    const openAiResponse = result.observedProtocol === 'openai';
    return {
      actions: [
        ...(openAiResponse
          ? [{ kind: 'install-router' as const, label: '安装本地路由器' }]
          : providerLinks(provider)),
        { kind: 'switch-provider', label: '改用其他服务商' },
        retry,
      ],
      cause: openAiResponse
        ? '接口返回的是 OpenAI Chat Completions 格式，不是 Claude Code 直连需要的 Anthropic Messages 格式。'
        : '接口返回了成功状态，但正文缺少 Anthropic Messages 所需字段；这也可能是兼容服务使用了不同的消息编号。',
      fix: openAiResponse
        ? '安装路由器后，在“自定义接口”中选择 OpenAI 协议，由 ClaudeDock 完成上游配置与转换。'
        : '先核对服务商的 Anthropic 兼容地址；无法识别协议时不会盲目启动路由转换。',
      title: '响应格式不兼容',
    };
  }

  if (result.failureKind === 'timeout' || result.failureKind === 'network') {
    return {
      actions: [...providerLinks(provider), retry],
      cause:
        result.failureKind === 'timeout'
          ? '接口在 15 秒内没有完成响应。'
          : '当前电脑无法与接口建立连接。',
      fix: '检查服务状态、基址、DNS 和本机网络后重新测试。',
      title: result.failureKind === 'timeout' ? '连接超时' : '网络连接失败',
    };
  }

  return {
    actions: [...providerLinks(provider), retry],
    cause: result.message,
    fix: '按三阶段结果逐项检查端点、认证和模型，再重新测试。',
    title: '接入尚未完成',
  };
};
