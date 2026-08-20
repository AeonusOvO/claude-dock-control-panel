import type { ClaudeRouterProviderProtocol } from '../contracts';

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
      (/^\/\/\[([^\]]+)\]/.exec(value)?.[1] ?? value.slice(2).split(/[/:]/, 1)[0])?.toLowerCase() ??
      '';
    return `${LOOPBACK_HOSTS.has(hostname) ? 'http' : 'https'}:${value}`;
  }

  const withoutLeadingSlash = value.replace(/^\/(?!\/)/, '');
  const hostname =
    (
      /^\[([^\]]+)\]/.exec(withoutLeadingSlash)?.[1] ?? withoutLeadingSlash.split(/[/:]/, 1)[0]
    )?.toLowerCase() ?? '';
  const scheme = LOOPBACK_HOSTS.has(hostname) || /^\[?::1\]?$/i.test(hostname) ? 'http' : 'https';
  return `${scheme}://${withoutLeadingSlash}`;
};

interface ParsedConnectionAddress {
  /** Path with duplicate and trailing slashes removed; an empty string for the site root. */
  path: string;
  url: URL;
}

/**
 * Accepts the address forms people normally paste into a settings field and validates them once,
 * without yet deciding whether the caller wants a base URL or a complete protocol endpoint. The
 * main process calls the same parser again, so renderer convenience never becomes the boundary.
 */
const parseConnectionAddress = (value: string): ParsedConnectionAddress => {
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

  return { path: parsed.pathname.replace(/\/{2,}/g, '/').replace(/\/+$/, ''), url: parsed };
};

const addressWithPath = (url: URL, path: string): string => {
  url.pathname = path.replace(/\/{2,}/g, '/') || '/';
  const normalized = url.toString();
  return normalized.endsWith('/') ? normalized.slice(0, -1) : normalized;
};

/**
 * Returns the complete protocol endpoint. Used where a full request URL is genuinely required —
 * the local Router's provider entries and the connectivity probe — never for `ANTHROPIC_BASE_URL`.
 */
export const completeConnectionEndpoint = (
  value: string,
  protocol: ConfigurableEndpointProtocol,
): string => {
  const { path, url } = parseConnectionAddress(value);
  const selectedEndpoint =
    protocol === 'anthropic'
      ? /\/v1\/messages$/i.test(path)
      : /\/(?:v1\/)?(?:chat\/completions|responses)$/i.test(path);
  if (selectedEndpoint) {
    url.pathname = path;
    return url.toString();
  }

  const basePath = path.replace(KNOWN_ENDPOINT_SUFFIX, '').replace(/\/+$/, '');
  const completed =
    protocol === 'anthropic'
      ? /\/v1$/i.test(basePath)
        ? `${basePath}/messages`
        : `${basePath}/v1/messages`
      : /\/v1$/i.test(basePath)
        ? `${basePath}/chat/completions`
        : `${basePath}/v1/chat/completions`;
  url.pathname = completed.replace(/\/{2,}/g, '/');
  return url.toString();
};

/**
 * `ANTHROPIC_BASE_URL` as Claude Code actually consumes it: the CLI appends `/v1/messages` on its
 * own, so every path segment the relay published has to survive verbatim — a relay documented as
 * `https://host/v1` must stay `https://host/v1`, exactly like it would in any other client. Only a
 * complete Messages endpoint pasted into the field is reduced back to the base it belongs to.
 */
export const normalizeConnectionBaseUrl = (value: string): string => {
  const { path, url } = parseConnectionAddress(value);
  if (/\/(?:v1\/)?(?:chat\/completions|responses)$/i.test(path)) {
    throw new Error(
      '这是 OpenAI 接口地址，不能直接用于 Claude Code；请在自定义中转站中选择 OpenAI 协议。',
    );
  }
  return addressWithPath(url, path.replace(/\/v1\/messages$/i, ''));
};

/** Returns the standard model-catalog endpoint belonging to an OpenAI-compatible base or request URL. */
export const openAiModelsEndpoint = (value: string): string => {
  const { path, url } = parseConnectionAddress(value);
  const basePath = path
    .replace(/\/(?:v1\/)?(?:chat\/completions|responses|models)$/i, '')
    .replace(/\/+$/, '');
  url.pathname = (/\/v1$/i.test(basePath) ? `${basePath}/models` : `${basePath}/v1/models`).replace(
    /\/{2,}/g,
    '/',
  );
  return url.toString();
};

export const routerProtocolForOpenAiEndpoint = (
  endpoint: string,
): Extract<ClaudeRouterProviderProtocol, 'openai_chat_completions' | 'openai_responses'> =>
  /\/responses\/?$/i.test(new URL(endpoint).pathname)
    ? 'openai_responses'
    : 'openai_chat_completions';
