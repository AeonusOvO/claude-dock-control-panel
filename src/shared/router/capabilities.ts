import type { ClaudeProviderId } from '../claude/providers';

export interface RouterCapability {
  mode: 'direct' | 'router-optional' | 'router-required';
  reason: string;
  verifiedAt: string;
}

const VERIFIED_AT = '2026-08-04';
const OPENAI_API: RouterCapability = {
  mode: 'router-required',
  reason: 'OpenAI 兼容 API 由本地路由器自动转换。',
  verifiedAt: '2026-08-27',
};

export const ROUTER_CAPABILITIES: Readonly<Record<ClaudeProviderId, RouterCapability>> = {
  'glm-api': OPENAI_API,
  'qwen-api': OPENAI_API,
  'doubao-api': OPENAI_API,
  'stepfun-api': OPENAI_API,
  hunyuan: OPENAI_API,
  qianfan: OPENAI_API,
  spark: OPENAI_API,
  anthropic: {
    mode: 'direct',
    reason: 'Claude Code 官方登录原生直连 Anthropic，不需要协议转换。',
    verifiedAt: VERIFIED_AT,
  },
  'anthropic-api': {
    mode: 'direct',
    reason: 'Anthropic API Key 直接调用官方 Messages API。',
    verifiedAt: VERIFIED_AT,
  },
  'chatgpt-subscription': {
    mode: 'direct',
    reason: '不需要 CCR；必须由用户另行运行能输出 Anthropic Messages 的本地订阅网关。',
    verifiedAt: VERIFIED_AT,
  },
  curl: {
    mode: 'router-optional',
    reason: 'Anthropic 协议可直连；识别为 OpenAI 协议时需要路由器转换。',
    verifiedAt: VERIFIED_AT,
  },
  custom: {
    mode: 'router-optional',
    reason: 'Anthropic 兼容端点可直连，OpenAI 兼容端点需要路由器转换。',
    verifiedAt: VERIFIED_AT,
  },
  deepseek: {
    mode: 'direct',
    reason: 'DeepSeek 提供原生 Anthropic 兼容端点，直连即可，无需路由器。',
    verifiedAt: VERIFIED_AT,
  },
  doubao: {
    mode: 'direct',
    reason: '火山方舟 Coding Plan 提供 Anthropic 兼容入口。',
    verifiedAt: VERIFIED_AT,
  },
  gateway: {
    mode: 'router-required',
    reason: '该项本身就是本地协议路由器入口，使用前必须安装并启动路由内核。',
    verifiedAt: VERIFIED_AT,
  },
  'glm-cn': {
    mode: 'direct',
    reason: '智谱国内站提供 Claude Code 使用的 Anthropic 兼容端点。',
    verifiedAt: VERIFIED_AT,
  },
  'glm-global': {
    mode: 'direct',
    reason: 'Z.AI 国际站提供 Claude Code 使用的 Anthropic 兼容端点。',
    verifiedAt: VERIFIED_AT,
  },
  'kimi-code': {
    mode: 'direct',
    reason: 'Kimi Code 会员端点原生面向 Claude Code。',
    verifiedAt: VERIFIED_AT,
  },
  'kimi-open': {
    mode: 'direct',
    reason: 'Kimi 开放平台提供 Anthropic 兼容端点。',
    verifiedAt: VERIFIED_AT,
  },
  'minimax-cn': {
    mode: 'direct',
    reason: 'MiniMax 国内站提供 Anthropic 兼容端点。',
    verifiedAt: VERIFIED_AT,
  },
  'minimax-global': {
    mode: 'direct',
    reason: 'MiniMax 国际站提供 Anthropic 兼容端点。',
    verifiedAt: VERIFIED_AT,
  },
  mimo: {
    mode: 'direct',
    reason: 'MiMo 提供 Anthropic 兼容端点。',
    verifiedAt: VERIFIED_AT,
  },
  ollama: {
    mode: 'direct',
    reason: 'Ollama 0.14+ 提供本地 Anthropic Messages 兼容接口。',
    verifiedAt: VERIFIED_AT,
  },
  openrouter: {
    mode: 'direct',
    reason: 'OpenRouter 提供面向 Claude Code 的 Anthropic 兼容入口。',
    verifiedAt: VERIFIED_AT,
  },
  'qwen-cn': {
    mode: 'direct',
    reason: '百炼 Coding Plan 提供 Anthropic 兼容入口。',
    verifiedAt: VERIFIED_AT,
  },
  'qwen-global': {
    mode: 'direct',
    reason: '阿里云 Model Studio 国际站提供 Anthropic 兼容入口。',
    verifiedAt: VERIFIED_AT,
  },
  siliconflow: {
    mode: 'direct',
    reason: 'SiliconFlow 提供 Claude Code 可直连的 Anthropic 兼容接口。',
    verifiedAt: VERIFIED_AT,
  },
  stepfun: {
    mode: 'direct',
    reason: 'Step Plan 提供 Claude Code 专用兼容入口。',
    verifiedAt: VERIFIED_AT,
  },
};

export const routerCapabilityFor = (providerId: ClaudeProviderId): RouterCapability =>
  ROUTER_CAPABILITIES[providerId];
