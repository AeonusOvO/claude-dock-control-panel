import type { ClaudeAuthMode, ClaudeEndpointProtocol, ClaudePreset } from '../contracts';

export interface ClaudeCurlAnalysis {
  authMode: Exclude<ClaudeAuthMode, 'existing' | 'none'> | 'none';
  baseUrl: string;
  credential?: string;
  credentialDetected: boolean;
  endpoint: string;
  explanation: string;
  model: string;
  protocol: ClaudeEndpointProtocol;
  suggestedPreset: ClaudePreset;
}

const CURL_MAX_LENGTH = 50_000;
const HEADER_PATTERN = /(?:^|\s)(?:-H|--header)\s+(?:"([^"]*)"|'([^']*)'|([^\s\\]+))/gim;
const URL_PATTERN = /https?:\/\/[^\s"'`\\]+/i;

const stripKnownEndpoint = (url: URL): string => {
  const suffixes = [
    /\/v1\/chat\/completions\/?$/i,
    /\/chat\/completions\/?$/i,
    /\/v1\/messages\/?$/i,
    /\/messages\/?$/i,
  ];
  let pathname = url.pathname.replace(/\/+$/, '');
  for (const suffix of suffixes) {
    if (suffix.test(pathname)) {
      pathname = pathname.replace(suffix, '');
      break;
    }
  }
  url.pathname = pathname || '/';
  const normalized = url.toString();
  return normalized.endsWith('/') ? normalized.slice(0, -1) : normalized;
};

const extractModel = (command: string): string => {
  const match = /["']model["']\s*:\s*["']([^"'\\]{1,200})["']/i.exec(command);
  return match?.[1]?.trim() ?? '';
};

const extractHeaders = (command: string): Map<string, string> => {
  const headers = new Map<string, string>();
  for (const match of command.matchAll(HEADER_PATTERN)) {
    const value = match[1] ?? match[2] ?? match[3] ?? '';
    const separator = value.indexOf(':');
    if (separator <= 0) {
      continue;
    }
    headers.set(value.slice(0, separator).trim().toLowerCase(), value.slice(separator + 1).trim());
  }
  return headers;
};

export const parseClaudeCurl = (command: string): ClaudeCurlAnalysis => {
  const trimmed = command.trim();
  if (!trimmed || trimmed.length > CURL_MAX_LENGTH) {
    throw new Error('请粘贴不超过 50,000 个字符的 cURL 命令。');
  }

  const urlText = URL_PATTERN.exec(trimmed)?.[0];
  if (!urlText) {
    throw new Error('没有在这段内容中找到 http:// 或 https:// 接口地址。');
  }

  let endpoint: URL;
  try {
    endpoint = new URL(urlText);
  } catch {
    throw new Error('cURL 中的接口地址不是有效 URL。');
  }
  if (endpoint.username || endpoint.password) {
    throw new Error('接口地址不能内嵌用户名或密码。');
  }
  endpoint.search = '';
  endpoint.hash = '';

  const pathname = endpoint.pathname.replace(/\/+$/, '').toLowerCase();
  const protocol: ClaudeEndpointProtocol = pathname.endsWith('/v1/messages')
    ? 'anthropic'
    : pathname.endsWith('/v1/chat/completions') || pathname.endsWith('/chat/completions')
      ? 'openai'
      : 'unknown';
  const headers = extractHeaders(trimmed);
  const authorization = headers.get('authorization') ?? '';
  const bearerMatch = /^bearer\s+(.+)$/i.exec(authorization);
  const apiKey = headers.get('x-api-key');
  const credential = bearerMatch?.[1]?.trim() || apiKey?.trim() || undefined;
  const authMode = bearerMatch ? 'authToken' : apiKey ? 'apiKey' : 'none';

  return {
    authMode,
    baseUrl: stripKnownEndpoint(new URL(endpoint)),
    credential,
    credentialDetected: Boolean(credential),
    endpoint: endpoint.toString(),
    explanation:
      protocol === 'anthropic'
        ? '这是 Claude Code 可直接使用的 Anthropic 消息格式。'
        : protocol === 'openai'
          ? '这是 OpenAI 对话补全格式，不能直接填给 Claude Code；需要先经过本地转换器。'
          : '暂时无法只凭路径确认协议；请让服务商确认是否提供 /v1/messages。',
    model: extractModel(trimmed),
    protocol,
    suggestedPreset: protocol === 'anthropic' ? 'custom' : 'gateway',
  };
};
