export type ClaudeProviderGroupId =
  'advanced' | 'domestic' | 'local' | 'official' | 'overseas' | 'subscription';

export interface ClaudeProviderDefinition {
  authMode: 'apiKey' | 'authToken' | 'existing' | 'none';
  baseUrl: string;
  caveat?: string;
  consoleUrl?: string;
  description: string;
  docsUrl?: string;
  editableBaseUrl: boolean;
  group: ClaudeProviderGroupId;
  id:
    | 'anthropic'
    | 'anthropic-api'
    | 'chatgpt-subscription'
    | 'curl'
    | 'custom'
    | 'deepseek'
    | 'doubao'
    | 'gateway'
    | 'glm-cn'
    | 'glm-global'
    | 'kimi-code'
    | 'kimi-open'
    | 'minimax-cn'
    | 'minimax-global'
    | 'mimo'
    | 'ollama'
    | 'openrouter'
    | 'qwen-cn'
    | 'qwen-global'
    | 'siliconflow'
    | 'stepfun';
  keyHint?: string;
  label: string;
  model: string;
  modelFast?: string;
}

export type ClaudeProviderId = ClaudeProviderDefinition['id'];

export const CLAUDE_PROVIDER_GROUPS = [
  { id: 'official', label: '官方接入' },
  { id: 'subscription', label: '订阅接入（实验性）' },
  { id: 'domestic', label: '国内服务' },
  { id: 'overseas', label: '海外与聚合服务' },
  { id: 'local', label: '本地服务' },
  { id: 'advanced', label: '高级方式' },
] as const satisfies ReadonlyArray<{ id: ClaudeProviderGroupId; label: string }>;

/**
 * Claude Code provider endpoints verified against each provider's current integration guide.
 * Keep this catalog as the only source for presets, UI copy and external-link allowlisting.
 */
export const CLAUDE_PROVIDERS: readonly ClaudeProviderDefinition[] = [
  {
    authMode: 'existing',
    baseUrl: '',
    consoleUrl: 'https://claude.ai/settings/usage',
    description: '使用 Claude Code 已有的官方登录，不保存接口密钥。',
    docsUrl: 'https://docs.anthropic.com/en/docs/claude-code/overview',
    editableBaseUrl: false,
    group: 'official',
    id: 'anthropic',
    label: 'Anthropic 官方登录',
    model: 'default',
  },
  {
    authMode: 'apiKey',
    baseUrl: '',
    consoleUrl: 'https://platform.claude.com/settings/keys',
    description: '使用 Anthropic Console 创建的 API Key 直连官方 Messages API。',
    docsUrl: 'https://platform.claude.com/docs/en/api/overview',
    editableBaseUrl: false,
    group: 'official',
    id: 'anthropic-api',
    keyHint: 'sk-ant-…',
    label: 'Anthropic API Key',
    model: 'claude-sonnet-5',
    modelFast: 'claude-haiku-4-5',
  },
  {
    authMode: 'authToken',
    baseUrl: 'http://127.0.0.1:8317',
    caveat:
      '这条路径由 OpenAI Codex 负责人 Thibault “Tibo” Sottiaux 公开分享；CLIProxyAPI 仍是第三方开源网关，不是 OpenAI 或 Anthropic 官方产品，相关条款、套餐限制与模型可用性仍然适用。',
    consoleUrl: 'https://x.com/thsottiaux/status/2076119366647894371',
    description:
      '由 ClaudeDock 一键安装、授权并托管本机网关，把 ChatGPT Codex 订阅接入当前 Claude Code 项目。',
    docsUrl: 'https://github.com/router-for-me/CLIProxyAPI',
    editableBaseUrl: false,
    group: 'subscription',
    id: 'chatgpt-subscription',
    label: 'ChatGPT 订阅（ClaudeDock 托管）',
    model: 'gpt-5.6-sol',
    modelFast: 'gpt-5.4-mini',
  },
  {
    authMode: 'authToken',
    baseUrl: 'https://api.deepseek.com/anthropic',
    consoleUrl: 'https://platform.deepseek.com/api_keys',
    description: 'DeepSeek 官方 Anthropic 兼容接口，适合国内网络环境。',
    docsUrl: 'https://api-docs.deepseek.com/guides/coding_agents/',
    editableBaseUrl: false,
    group: 'domestic',
    id: 'deepseek',
    keyHint: 'sk-…',
    label: 'DeepSeek',
    model: 'deepseek-v4-pro[1m]',
    modelFast: 'deepseek-v4-flash',
  },
  {
    authMode: 'authToken',
    baseUrl: 'https://open.bigmodel.cn/api/anthropic',
    consoleUrl: 'https://bigmodel.cn/usercenter/proj-mgmt/apikeys',
    description: '智谱国内 Anthropic 兼容接口。',
    docsUrl: 'https://docs.bigmodel.cn/cn/guide/develop/claude',
    editableBaseUrl: false,
    group: 'domestic',
    id: 'glm-cn',
    label: '智谱 GLM（国内）',
    model: 'glm-5.2[1m]',
    modelFast: 'glm-4.7',
  },
  {
    authMode: 'authToken',
    baseUrl: 'https://api.z.ai/api/anthropic',
    consoleUrl: 'https://z.ai/manage-apikey/apikey-list',
    description: 'Z.AI 国际站 Anthropic 兼容接口。',
    docsUrl: 'https://docs.z.ai/scenario-example/develop-tools/claude',
    editableBaseUrl: false,
    group: 'overseas',
    id: 'glm-global',
    label: '智谱 GLM（国际）',
    model: 'glm-5.2',
    modelFast: 'glm-4.5-air',
  },
  {
    authMode: 'authToken',
    baseUrl: 'https://api.moonshot.cn/anthropic',
    caveat: '这里只接受 Kimi 开放平台密钥；Kimi Code 会员密钥不能在这里使用。',
    consoleUrl: 'https://platform.kimi.com/console/api-keys',
    description: 'Kimi 开放平台按量计费的 Anthropic 兼容接口。',
    docsUrl: 'https://platform.kimi.com/docs/guide/claude-code-kimi',
    editableBaseUrl: false,
    group: 'domestic',
    id: 'kimi-open',
    label: 'Kimi 开放平台',
    model: 'kimi-k3[1m]',
    modelFast: 'kimi-k3',
  },
  {
    authMode: 'apiKey',
    baseUrl: 'https://api.kimi.com/coding',
    caveat: 'Kimi Code 会员密钥与开放平台密钥、基址互不通用。',
    consoleUrl: 'https://www.kimi.com/code/console',
    description: 'Kimi Code 会员专用接口。',
    docsUrl: 'https://www.kimi.com/code/docs/third-party-tools/claude-code.html',
    editableBaseUrl: false,
    group: 'domestic',
    id: 'kimi-code',
    label: 'Kimi Code 会员',
    model: 'kimi-for-coding',
    modelFast: 'kimi-for-coding',
  },
  {
    authMode: 'authToken',
    baseUrl: 'https://coding.dashscope.aliyuncs.com/apps/anthropic',
    caveat: '此预设对应百炼 Coding Plan；按量计费工作空间需要在高级设置中改用专属基址。',
    consoleUrl: 'https://bailian.console.aliyun.com/?tab=model#/api-key',
    description: '阿里云百炼 Coding Plan 国内 Anthropic 兼容接口。',
    docsUrl: 'https://help.aliyun.com/zh/model-studio/claude-code',
    editableBaseUrl: false,
    group: 'domestic',
    id: 'qwen-cn',
    label: '通义千问（国内）',
    model: 'qwen3.7-plus',
    modelFast: 'qwen3.6-flash',
  },
  {
    authMode: 'authToken',
    baseUrl: 'https://coding-intl.dashscope.aliyuncs.com/apps/anthropic',
    caveat: '请确认 API Key 与所选地域一致；新加坡工作空间应使用自己的专属基址。',
    consoleUrl: 'https://modelstudio.console.alibabacloud.com/',
    description: '阿里云 Model Studio 国际站 Anthropic 兼容接口。',
    docsUrl: 'https://www.alibabacloud.com/help/en/model-studio/claude-code',
    editableBaseUrl: false,
    group: 'overseas',
    id: 'qwen-global',
    label: '通义千问（国际）',
    model: 'qwen3.7-plus',
    modelFast: 'qwen3.6-flash',
  },
  {
    authMode: 'authToken',
    baseUrl: 'https://api.minimaxi.com/anthropic',
    consoleUrl: 'https://platform.minimaxi.com/user-center/basic-information/interface-key',
    description: 'MiniMax 国内 Anthropic 兼容接口。',
    docsUrl: 'https://platform.minimaxi.com/docs/token-plan/claude-code',
    editableBaseUrl: false,
    group: 'domestic',
    id: 'minimax-cn',
    label: 'MiniMax（国内）',
    model: 'MiniMax-M3[1m]',
    modelFast: 'MiniMax-M3[1m]',
  },
  {
    authMode: 'authToken',
    baseUrl: 'https://api.minimax.io/anthropic',
    consoleUrl: 'https://platform.minimax.io/user-center/basic-information/interface-key',
    description: 'MiniMax 国际站 Anthropic 兼容接口。',
    docsUrl: 'https://platform.minimax.io/docs/token-plan/claude-code',
    editableBaseUrl: false,
    group: 'overseas',
    id: 'minimax-global',
    label: 'MiniMax（国际）',
    model: 'MiniMax-M3[1m]',
    modelFast: 'MiniMax-M3[1m]',
  },
  {
    authMode: 'authToken',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/coding',
    consoleUrl: 'https://console.volcengine.com/ark/region:ark+cn-beijing/apikey',
    description: '火山方舟 Coding Plan 的 Anthropic 兼容入口。',
    docsUrl: 'https://www.volcengine.com/article/37538',
    editableBaseUrl: false,
    group: 'domestic',
    id: 'doubao',
    label: '豆包 / 火山方舟',
    model: 'doubao-seed-2.0-code',
    modelFast: 'ark-code-latest',
  },
  {
    authMode: 'authToken',
    baseUrl: 'https://api.xiaomimimo.com/anthropic',
    caveat: '按量密钥与 Token Plan 密钥前缀不同，请不要混用。',
    consoleUrl: 'https://platform.xiaomimimo.com/',
    description: '小米 MiMo 官方 Anthropic 兼容接口。',
    docsUrl: 'https://mimo.mi.com/docs/en-US/integration/claudecode',
    editableBaseUrl: false,
    group: 'domestic',
    id: 'mimo',
    label: '小米 MiMo',
    model: 'mimo-v2.5-pro',
    modelFast: 'mimo-v2.5-pro',
  },
  {
    authMode: 'authToken',
    baseUrl: 'https://api.stepfun.com/step_plan',
    consoleUrl: 'https://platform.stepfun.com/interface-key',
    description: '阶跃星辰 Step Plan 的 Claude Code 接入。',
    docsUrl: 'https://platform.stepfun.com/docs/zh/step-plan/quick-start',
    editableBaseUrl: false,
    group: 'domestic',
    id: 'stepfun',
    label: '阶跃星辰 StepFun',
    model: 'step-3.7-flash',
    modelFast: 'step-3.7-flash',
  },
  {
    authMode: 'apiKey',
    baseUrl: 'https://api.siliconflow.cn',
    caveat: 'SiliconFlow 官方 Claude Code 接法使用 x-api-key，不是 Bearer Token。',
    consoleUrl: 'https://cloud.siliconflow.cn/account/ak',
    description: '硅基流动 Anthropic 兼容接口，可选择平台支持的模型。',
    docsUrl: 'https://docs.siliconflow.cn/cn/usercases/use-siliconcloud-in-ClaudeCode',
    editableBaseUrl: false,
    group: 'domestic',
    id: 'siliconflow',
    label: 'SiliconFlow',
    model: 'moonshotai/Kimi-K2-Instruct-0905',
    modelFast: 'Qwen/Qwen3-8B',
  },
  {
    authMode: 'authToken',
    baseUrl: 'https://openrouter.ai/api',
    consoleUrl: 'https://openrouter.ai/settings/keys',
    description: '通过 OpenRouter 的 Anthropic 兼容入口选择多家模型。',
    docsUrl: 'https://openrouter.ai/docs/guides/coding-agents/claude-code-integration',
    editableBaseUrl: false,
    group: 'overseas',
    id: 'openrouter',
    label: 'OpenRouter',
    model: '~anthropic/claude-sonnet-latest',
    modelFast: '~anthropic/claude-haiku-4.5',
  },
  {
    authMode: 'authToken',
    baseUrl: 'http://localhost:11434',
    caveat: 'Ollama 不校验令牌，但 Claude Code 要求该变量存在；ClaudeDock 会使用占位值 ollama。',
    description: '连接本机 Ollama 0.14+ 的 Anthropic Messages 兼容接口。',
    docsUrl: 'https://docs.ollama.com/api/anthropic-compatibility',
    editableBaseUrl: false,
    group: 'local',
    id: 'ollama',
    keyHint: '由 ClaudeDock 自动填入 ollama',
    label: 'Ollama 本地模型',
    model: 'qwen3-coder',
    modelFast: 'qwen3-coder',
  },
  {
    authMode: 'authToken',
    baseUrl: 'https://gateway.example.com',
    description: '手动填写 Anthropic 或 OpenAI 兼容的第三方中转站。',
    editableBaseUrl: true,
    group: 'advanced',
    id: 'custom',
    label: '自定义中转站接口',
    model: 'default',
  },
  {
    authMode: 'authToken',
    baseUrl: 'http://127.0.0.1:3456',
    description: '安装、发现并连接本机 Claude Code Router。',
    docsUrl: 'https://github.com/musistudio/claude-code-router',
    editableBaseUrl: true,
    group: 'advanced',
    id: 'gateway',
    label: '本地路由器',
    model: 'default',
  },
  {
    authMode: 'authToken',
    baseUrl: 'http://127.0.0.1:3456',
    description: '粘贴服务商 cURL，识别协议后自动填入或交给本地路由器转换。',
    docsUrl: 'https://code.claude.com/docs/en/llm-gateway',
    editableBaseUrl: true,
    group: 'advanced',
    id: 'curl',
    label: '粘贴 cURL',
    model: 'default',
  },
];

export const findClaudeProvider = (id: string | undefined): ClaudeProviderDefinition | undefined =>
  CLAUDE_PROVIDERS.find((provider) => provider.id === id);

/**
 * The connection page opens only the group containing the last provider selection. Keeping this
 * pure makes the official/custom and empty-state combinations independently testable.
 */
export const collapsedClaudeProviderGroups = (
  providerId: ClaudeProviderId | undefined,
): ClaudeProviderGroupId[] => {
  const expandedGroup = findClaudeProvider(providerId)?.group;
  return CLAUDE_PROVIDER_GROUPS.map((group) => group.id).filter(
    (groupId) => groupId !== expandedGroup,
  );
};

export const claudeProviderIdSet = new Set<string>(CLAUDE_PROVIDERS.map((provider) => provider.id));

export const providerForPreset = (id: ClaudeProviderId): 'anthropic' | 'gateway' =>
  findClaudeProvider(id)?.group === 'official' ? 'anthropic' : 'gateway';

/**
 * Only first-party presets inherit an official network profile. Anthropic presets use the Claude
 * profile; the managed subscription bridge uses the OpenAI/Codex profile behind that bridge.
 * Overseas, domestic, local and advanced providers retain their own endpoint semantics.
 */
export const officialNetworkProviderForClaudePreset = (
  id: ClaudeProviderId,
): 'anthropic-claude' | 'openai-codex' | undefined => {
  const group = findClaudeProvider(id)?.group;
  if (group === 'official') return 'anthropic-claude';
  if (group === 'subscription') return 'openai-codex';
  return undefined;
};

export const CLAUDE_PROVIDER_EXTERNAL_HOSTS = new Set(
  CLAUDE_PROVIDERS.flatMap((provider) => [provider.consoleUrl, provider.docsUrl])
    .filter((url): url is string => Boolean(url))
    .map((url) => new URL(url).hostname.toLowerCase()),
);
