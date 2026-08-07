import { openAiModelsEndpoint } from '../shared/connection-endpoint';

const MAX_MODEL_RESPONSE_BYTES = 1024 * 1024;
const MAX_MODELS = 500;

interface OpenAiModelEnvelope {
  data?: unknown;
}

const readBoundedResponse = async (response: Response): Promise<Buffer> => {
  if (!response.body) {
    return Buffer.alloc(0);
  }
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      return Buffer.concat(chunks, size);
    }
    size += value.byteLength;
    if (size > MAX_MODEL_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error('模型列表超过安全大小上限。');
    }
    chunks.push(Buffer.from(value));
  }
};

export const parseOpenAiModelIds = (value: unknown): string[] => {
  if (!value || typeof value !== 'object') {
    throw new Error('模型接口返回了无效数据。');
  }
  const data = (value as OpenAiModelEnvelope).data;
  if (!Array.isArray(data)) {
    throw new Error('模型接口没有返回模型列表。');
  }
  const models = [
    ...new Set(
      data
        .map((entry) =>
          entry && typeof entry === 'object' && typeof (entry as { id?: unknown }).id === 'string'
            ? (entry as { id: string }).id.trim()
            : '',
        )
        .filter((model) => /^[-A-Za-z0-9._:/@[\]]{1,200}$/.test(model)),
    ),
  ].slice(0, MAX_MODELS);
  if (models.length === 0) {
    throw new Error('模型接口当前没有可用模型。');
  }
  return models;
};

export const discoverOpenAiModels = async (
  baseUrl: string,
  credential: string | undefined,
  fetchImplementation: typeof fetch = fetch,
  timeoutMs = 15_000,
): Promise<string[]> => {
  const response = await fetchImplementation(openAiModelsEndpoint(baseUrl), {
    headers: credential?.trim() ? { Authorization: `Bearer ${credential.trim()}` } : undefined,
    redirect: 'error',
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    throw new Error(
      response.status === 401 || response.status === 403
        ? '模型接口拒绝了当前密钥，请检查密钥是否属于这个服务商。'
        : `模型接口返回 HTTP ${response.status}。`,
    );
  }
  const declared = Number(response.headers.get('content-length') ?? 0);
  if (Number.isFinite(declared) && declared > MAX_MODEL_RESPONSE_BYTES) {
    throw new Error('模型列表超过安全大小上限。');
  }
  const bytes = await readBoundedResponse(response);
  try {
    return parseOpenAiModelIds(JSON.parse(bytes.toString('utf8')) as unknown);
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error('模型接口没有返回有效 JSON。', { cause: error });
    }
    throw error;
  }
};
