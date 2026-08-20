import { createHash } from 'node:crypto';
import type {
  ClaudeAuthMode,
  ClaudePreset,
  ClaudeProvider,
  ModelSpeedAvailability,
  ModelSpeedMechanism,
  ModelSpeedMode,
} from '../../shared/contracts';
import { compareSemanticVersions } from '../../shared/router/provider-profiles';

export const MINIMUM_CLAUDE_FAST_VERSION = '2.1.219';
export const MINIMUM_MANAGED_GPT_FAST_GATEWAY_VERSION = '7.2.117';

const MANAGED_GPT_FAST_MODELS = new Set([
  'gpt-5.4',
  'gpt-5.5',
  'gpt-5.6',
  'gpt-5.6-luna',
  'gpt-5.6-sol',
  'gpt-5.6-terra',
]);

export interface ModelSpeedTarget {
  authMode: ClaudeAuthMode;
  baseUrl: string;
  model: string;
  preset: ClaudePreset;
  provider: ClaudeProvider;
}

export interface ModelSpeedCapability {
  availability: ModelSpeedAvailability;
  canSelectFast: boolean;
  detail: string;
  mechanism: ModelSpeedMechanism;
}

export interface ModelSpeedCapabilityInput {
  claudeVersion?: string;
  config: Omit<ModelSpeedTarget, 'model'>;
  managedGatewayVersion?: string;
  model: string;
}

const normalizedModel = (model: string): string => model.trim().toLowerCase();
const modelWithoutContextSuffix = (model: string): string =>
  normalizedModel(model).replace(/\[1m\]$/, '');

const supportsNativeClaudeFast = (model: string): boolean => {
  const normalized = modelWithoutContextSuffix(model);
  return (
    normalized === 'opus' ||
    /^claude-opus-5(?:$|[-.])/.test(normalized) ||
    /^claude-opus-4-8(?:$|[-.])/.test(normalized)
  );
};

const knownUnsupportedClaudeModel = (model: string): boolean => {
  const normalized = modelWithoutContextSuffix(model);
  return (
    normalized.includes('sonnet') ||
    normalized.includes('haiku') ||
    normalized === 'opusplan' ||
    /^claude-opus-(?!5(?:$|[-.])|4-8(?:$|[-.]))/.test(normalized)
  );
};

const versionAtLeast = (version: string | undefined, minimum: string): boolean =>
  Boolean(version && compareSemanticVersions(version, minimum) >= 0);

export const classifyModelSpeed = (input: ModelSpeedCapabilityInput): ModelSpeedCapability => {
  const model = normalizedModel(input.model);
  const officialAnthropic =
    input.config.provider === 'anthropic' &&
    (input.config.preset === 'anthropic' || input.config.preset === 'anthropic-api');

  if (officialAnthropic) {
    if (!supportsNativeClaudeFast(model)) {
      if (model === 'default' || !knownUnsupportedClaudeModel(model)) {
        return {
          availability: 'unverified',
          canSelectFast: false,
          detail: '当前模型标识尚未解析为明确的 Opus 5 或 Opus 4.8，不能安全开启 Claude Fast。',
          mechanism: 'none',
        };
      }
      return {
        availability: 'unsupported',
        canSelectFast: false,
        detail: 'Claude 原生快速模式仅支持 Opus 5 和 Opus 4.8。',
        mechanism: 'none',
      };
    }
    if (!versionAtLeast(input.claudeVersion, MINIMUM_CLAUDE_FAST_VERSION)) {
      return {
        availability: 'update-required',
        canSelectFast: false,
        detail: `Claude Fast 需要 Claude Code ${MINIMUM_CLAUDE_FAST_VERSION} 或更高版本。`,
        mechanism: 'claude-native-fast',
      };
    }
    return {
      availability: 'available',
      canSelectFast: true,
      detail: 'Claude Code 原生快速模式；仅影响服务速度，不会更换模型，但按更高单价计费。',
      mechanism: 'claude-native-fast',
    };
  }

  if (input.config.preset === 'chatgpt-subscription') {
    if (!MANAGED_GPT_FAST_MODELS.has(model)) {
      return {
        availability: model.startsWith('gpt-') ? 'unsupported' : 'unverified',
        canSelectFast: false,
        detail: '当前托管模型没有出现在 Codex 已确认支持快速服务档位的目录中。',
        mechanism: 'none',
      };
    }
    if (!versionAtLeast(input.claudeVersion, MINIMUM_CLAUDE_FAST_VERSION)) {
      return {
        availability: 'update-required',
        canSelectFast: false,
        detail: `通过 Claude Code 请求 GPT 快速档需要 Claude Code ${MINIMUM_CLAUDE_FAST_VERSION} 或更高版本。`,
        mechanism: 'gpt-service-tier',
      };
    }
    if (!versionAtLeast(input.managedGatewayVersion, MINIMUM_MANAGED_GPT_FAST_GATEWAY_VERSION)) {
      return {
        availability: 'update-required',
        canSelectFast: false,
        detail: `GPT 快速档需要 CLIProxyAPI ${MINIMUM_MANAGED_GPT_FAST_GATEWAY_VERSION} 或更高版本；请到“接入”页运行“检查并自动修复”。`,
        mechanism: 'gpt-service-tier',
      };
    }
    return {
      availability: 'available',
      canSelectFast: true,
      detail: 'ClaudeDock 会请求 GPT 快速服务档位；实际资格和上游是否采用仍由 ChatGPT 决定。',
      mechanism: 'gpt-service-tier',
    };
  }

  return {
    availability: 'unsupported',
    canSelectFast: false,
    detail: '当前接入没有经过验证的服务速度档位，继续使用标准速度。',
    mechanism: 'none',
  };
};

const canonicalEndpointIdentity = (target: ModelSpeedTarget): string => {
  if (target.preset === 'chatgpt-subscription') {
    return 'managed-chatgpt://local';
  }
  if (target.provider === 'anthropic') {
    return 'anthropic://official';
  }
  try {
    const url = new URL(target.baseUrl);
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    url.hostname = url.hostname.toLowerCase();
    if (
      (url.protocol === 'https:' && url.port === '443') ||
      (url.protocol === 'http:' && url.port === '80')
    ) {
      url.port = '';
    }
    url.pathname = url.pathname.replace(/\/{2,}/g, '/').replace(/\/$/, '') || '/';
    return url.toString().replace(/\/$/, '');
  } catch {
    return target.baseUrl.trim().toLowerCase();
  }
};

export const modelSpeedTargetKey = (target: ModelSpeedTarget): string =>
  createHash('sha256')
    .update(
      JSON.stringify([
        'claude',
        target.provider,
        target.preset,
        target.authMode,
        canonicalEndpointIdentity(target),
        normalizedModel(target.model),
      ]),
    )
    .digest('hex');

export const modelSpeedSignature = (
  capability: ModelSpeedCapability,
  preference: ModelSpeedMode,
): string =>
  preference === 'fast' && capability.canSelectFast ? `${capability.mechanism}:fast` : 'standard';
