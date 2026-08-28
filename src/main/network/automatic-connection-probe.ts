import type {
  AutomaticConnectionAuth,
  AutomaticConnectionProtocol,
} from '../../shared/router/automatic-connection';

export const automaticConnectionHeaders = (
  authMode: AutomaticConnectionAuth,
  credential?: string,
): Record<string, string> => ({
  'content-type': 'application/json',
  'anthropic-version': '2023-06-01',
  'user-agent': 'ClaudeDock/connection-check',
  ...(credential && authMode === 'apiKey' ? { 'x-api-key': credential } : {}),
  ...(credential && authMode === 'bearer' ? { authorization: `Bearer ${credential}` } : {}),
});

export const readConnectionJson = async (response: Response, limit: number): Promise<unknown> => {
  const declared = Number(response.headers.get('content-length') ?? 0);
  const reader = response.body?.getReader();
  if (!reader) throw new Error('接口未返回数据。');
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    if (Number.isFinite(declared) && declared > limit) throw new Error('接口响应过大。');
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > limit) throw new Error('接口响应过大。');
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks, length).toString('utf8')) as unknown;
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
};

export const connectionProbeBody = (
  protocol: AutomaticConnectionProtocol,
  model: string,
): Record<string, unknown> =>
  protocol === 'openai-responses'
    ? { input: '.', max_output_tokens: 16, model, store: false, stream: false }
    : { max_tokens: 1, messages: [{ content: '.', role: 'user' }], model, stream: false };

const recordValue = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

export const connectionResponseMatches = (
  protocol: AutomaticConnectionProtocol,
  value: unknown,
): boolean => {
  const record = recordValue(value);
  if (!record || record.error) return false;
  if (protocol === 'anthropic') {
    return (
      typeof record.id === 'string' && Boolean(record.id.trim()) && Array.isArray(record.content)
    );
  }
  if (protocol === 'openai-responses') {
    return (
      typeof record.id === 'string' &&
      record.object === 'response' &&
      ['completed', 'incomplete'].includes(String(record.status)) &&
      Array.isArray(record.output)
    );
  }
  const first = Array.isArray(record.choices) ? recordValue(record.choices[0]) : undefined;
  return Boolean(first && recordValue(first.message));
};

/** A few APIs reject the old token parameter or impose a small minimum. Never retry unbounded. */
export const adjustedConnectionProbeBody = (
  protocol: AutomaticConnectionProtocol,
  body: Record<string, unknown>,
  error: unknown,
): Record<string, unknown> | undefined => {
  const nested = recordValue(recordValue(error)?.error);
  const message = typeof nested?.message === 'string' ? nested.message : '';
  if (protocol === 'openai' && /max_completion_tokens/i.test(message) && 'max_tokens' in body) {
    const rest = { ...body };
    delete rest.max_tokens;
    return { ...rest, max_completion_tokens: 16 };
  }
  const minimum =
    /(?:minimum|at least|greater than or equal to|min(?:imum)? value)\D{0,20}(\d+)/i.exec(message);
  const tokens = minimum ? Number(minimum[1]) : 0;
  const field = protocol === 'openai-responses' ? 'max_output_tokens' : 'max_tokens';
  return message.includes(field) && tokens > Number(body[field] ?? 0) && tokens <= 64
    ? { ...body, [field]: tokens }
    : undefined;
};
