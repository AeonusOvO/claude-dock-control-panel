import type { ClaudeRouterProviderProtocol } from './contracts';

export type ConfigurableEndpointProtocol = 'anthropic' | 'openai';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', '[::1]', 'localhost']);
const KNOWN_ENDPOINT_SUFFIX =
  /\/(?:v1\/messages|v1\/chat\/completions|v1\/responses|chat\/completions|responses)\/?$/i;

const stripMatchingQuotes = (value: string): string => {
  const first = value[0];
  const last = value.at(-1);
  return value.length >= 2 && first === last && (first === '"' || first === "'")
    ? value.slice(1, -1).trim()
    : value;
};

const withInferredScheme = (value: string): string => {
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(value)) {
    return value;
  }
  if (value.startsWith('//')) {
    const hostname =
      (/^\/\/\[([^\]]+)\]/.exec(value)?.[1] ?? value.slice(2).split(/[/:]/, 1)[0])
        ?.toLowerCase() ?? '';
    return `${LOOPBACK_HOSTS.has(hostname) ? 'http' : 'https'}:${value}`;
  }

  const withoutLeadingSlash = value.replace(/^\/(?!\/)/, '');
  const hostname =
    (/^\[([^\]]+)\]/.exec(withoutLeadingSlash)?.[1] ?? withoutLeadingSlash.split(/[/:]/, 1)[0])
      ?.toLowerCase() ?? '';
  const scheme = LOOPBACK_HOSTS.has(hostname) || /^\[?::1\]?$/i.test(hostname) ? 'http' : 'https';
  return `${scheme}://${withoutLeadingSlash}`;
};

/**
 * Accepts the address forms people normally paste into a settings field and returns the complete
 * protocol endpoint. The main process calls the same function again, so renderer convenience never
 * becomes the security boundary.
 */
export const completeConnectionEndpoint = (
  value: string,
  protocol: ConfigurableEndpointProtocol,
): string => {
  let raw = stripMatchingQuotes(value.trim()).replaceAll('\\', '/');
  raw = raw.replace(/^([a-z][a-z\d+.-]*):\/(?!\/)/i, '$1://');
  if (!raw || raw === '/') {
    throw new Error('请至少填写接口域名；可以省略 https:// 和接口路径。');
  }
  if (raw.length > 2048 || /\s/.test(raw)) {
    throw new Error('接口地址不能包含空白，且长度不能超过 2048 个字符。');
  }
  raw = withInferredScheme(raw);

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error('无法识别接口地址；请填写域名、域名加路径或完整 URL。');
  }
  const hostname = parsed.hostname.toLowerCase();
  if (!hostname || parsed.username || parsed.password) {
    throw new Error('接口地址必须包含有效域名，且不能内嵌用户名或密码。');
  }
  if (parsed.search || parsed.hash) {
    throw new Error('接口地址不能包含查询参数或片段。');
  }
  if (
    parsed.protocol !== 'https:' &&
    !(parsed.protocol === 'http:' && LOOPBACK_HOSTS.has(hostname))
  ) {
    throw new Error('远程接口必须使用 HTTPS；仅本机回环地址允许 HTTP。');
  }

  const pathname = parsed.pathname.replace(/\/{2,}/g, '/').replace(/\/+$/, '');
  const selectedEndpoint =
    protocol === 'anthropic'
      ? /\/v1\/messages$/i.test(pathname)
      : /\/(?:v1\/)?(?:chat\/completions|responses)$/i.test(pathname);
  if (selectedEndpoint) {
    parsed.pathname = pathname;
    return parsed.toString();
  }

  const basePath = pathname.replace(KNOWN_ENDPOINT_SUFFIX, '').replace(/\/+$/, '');
  if (protocol === 'anthropic') {
    parsed.pathname = /\/v1$/i.test(basePath)
      ? `${basePath}/messages`
      : `${basePath}/v1/messages`;
  } else {
    parsed.pathname = /\/v1$/i.test(basePath)
      ? `${basePath}/chat/completions`
      : `${basePath}/v1/chat/completions`;
  }
  parsed.pathname = parsed.pathname.replace(/\/{2,}/g, '/');
  return parsed.toString();
};

export const routerProtocolForOpenAiEndpoint = (
  endpoint: string,
): Extract<ClaudeRouterProviderProtocol, 'openai_chat_completions' | 'openai_responses'> =>
  /\/responses\/?$/i.test(new URL(endpoint).pathname)
    ? 'openai_responses'
    : 'openai_chat_completions';
