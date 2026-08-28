import {
  automaticConnectionCandidates,
  isLocalConnection,
  type AutomaticConnectionAuth,
  type AutomaticConnectionProtocol,
  type ConnectionCandidate,
} from '../../shared/router/automatic-connection';
import { normalizeConnectionAddress } from '../../shared/router/connection-endpoint';
import { parseOpenAiModelIds } from './provider-model-discovery';
import {
  adjustedConnectionProbeBody,
  automaticConnectionHeaders,
  connectionProbeBody,
  connectionResponseMatches,
  readConnectionJson,
} from './automatic-connection-probe';

export interface AutomaticConnectionInput {
  address: string;
  credential?: string;
  modelHints?: string[];
  modelsAddress?: string;
  preferredAuth?: AutomaticConnectionAuth;
  preferredProtocol?: AutomaticConnectionProtocol;
  /** Claude's OpenAI converter only supports Bearer authentication. */
  openAiApiKey?: boolean;
  /** Claude Code always appends /v1/messages itself. */
  claudeCompatible?: boolean;
}

export interface AutomaticConnectionResult {
  authMode: AutomaticConnectionAuth;
  endpoint: string;
  latencyMs: number;
  model: string;
  protocol: AutomaticConnectionProtocol;
  requestCount: number;
  testedAt: number;
}

export class AutomaticConnectionAccessError extends Error {}

const MAX_GENERATION_REQUESTS = 12;
const MAX_CATALOG_REQUESTS = 6;
const MAX_MODEL_CANDIDATES = 3;
const TOTAL_TIMEOUT_MS = 60_000;
const NON_CHAT_MODEL =
  /(?:embed|rerank|whisper|tts|dall-e|image|moderation|transcri|realtime|video)/i;

const authModes = (
  input: AutomaticConnectionInput,
  protocol?: AutomaticConnectionProtocol,
): AutomaticConnectionAuth[] => {
  if (!input.credential) return ['none'];
  if (protocol && protocol !== 'anthropic' && !input.openAiApiKey) return ['bearer'];
  return [
    ...new Set<AutomaticConnectionAuth>([
      input.preferredAuth === 'apiKey' ? 'apiKey' : 'bearer',
      'apiKey',
      'bearer',
    ]),
  ];
};

const usableModels = (models: string[], credential?: string): string[] => [
  ...new Set(
    models
      .map((model) => model.replace(/\[(?:1m|2m)\]$/i, '').trim())
      .filter(
        (model) =>
          /^[-A-Za-z0-9._:/@~[\]]{1,200}$/.test(model) &&
          !NON_CHAT_MODEL.test(model) &&
          (!credential || !model.includes(credential)),
      ),
  ),
];

interface ProbeContext {
  fetch: typeof fetch;
  input: AutomaticConnectionInput;
  signal: AbortSignal;
}

const discoverModels = async (
  context: ProbeContext,
  candidates: ConnectionCandidate[],
): Promise<string[]> => {
  const { input, signal } = context;
  const endpoints = [
    ...new Set([
      ...(input.modelsAddress ? [normalizeConnectionAddress(input.modelsAddress)] : []),
      ...candidates.map((candidate) => candidate.modelsEndpoint),
    ]),
  ];
  const origin = new URL(normalizeConnectionAddress(input.address)).origin;
  if (endpoints.some((endpoint) => new URL(endpoint).origin !== origin)) {
    throw new Error('模型发现地址必须与接口属于同一站点。');
  }
  let count = 0;
  for (const endpoint of endpoints) {
    for (const auth of authModes(input)) {
      if (++count > MAX_CATALOG_REQUESTS) return [];
      signal.throwIfAborted();
      try {
        const response = await context.fetch(endpoint, {
          headers: automaticConnectionHeaders(auth, input.credential),
          redirect: 'error',
          signal: AbortSignal.any([signal, AbortSignal.timeout(4_000)]),
        });
        if (!response.ok) {
          await response.body?.cancel();
          if (response.status === 429)
            throw new AutomaticConnectionAccessError('请求过于频繁，请稍后再试。');
          continue;
        }
        const models = usableModels(
          parseOpenAiModelIds(await readConnectionJson(response, 1024 * 1024)),
          input.credential,
        );
        if (models.length > 0) return models;
      } catch (error) {
        if (error instanceof AutomaticConnectionAccessError || signal.aborted) throw error;
      }
    }
  }
  return [];
};

interface ProbeAttempt {
  body?: Record<string, unknown>;
  candidate: ConnectionCandidate;
  authMode: AutomaticConnectionAuth;
  model: string;
}

const probe = async (
  context: ProbeContext,
  attempt: ProbeAttempt,
): Promise<{
  adjustedBody?: Record<string, unknown>;
  matched: boolean;
  status: number;
}> => {
  const { candidate, authMode, model } = attempt;
  const body = attempt.body ?? connectionProbeBody(candidate.protocol, model);
  const response = await context.fetch(candidate.endpoint, {
    body: JSON.stringify(body),
    headers: automaticConnectionHeaders(authMode, context.input.credential),
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.any([context.signal, AbortSignal.timeout(10_000)]),
  });
  if (response.status === 429 || response.status === 402) {
    await response.body?.cancel();
    throw new AutomaticConnectionAccessError(
      response.status === 429 ? '请求过于频繁，请稍后再试。' : '接口额度不足，请检查账户余额。',
    );
  }
  const value = await readConnectionJson(response, 64 * 1024).catch(() => undefined);
  return {
    adjustedBody:
      !attempt.body && [400, 422].includes(response.status)
        ? adjustedConnectionProbeBody(candidate.protocol, body, value)
        : undefined,
    matched: response.ok && connectionResponseMatches(candidate.protocol, value),
    status: response.status,
  };
};

/** Read-only discovery. A successful HTTP status alone never counts as a working connection. */
export const detectAutomaticConnection = async (
  input: AutomaticConnectionInput,
  fetchImplementation: typeof fetch,
  externalSignal?: AbortSignal,
): Promise<AutomaticConnectionResult> => {
  const address = normalizeConnectionAddress(input.address);
  const credential = input.credential?.trim();
  if (credential && (credential.length > 4096 || /[\r\n]/.test(credential)))
    throw new Error('密钥格式无效。');
  if (!credential && !isLocalConnection(address)) throw new Error('请填写密钥。');
  const normalizedInput = { ...input, address, credential };
  const testedAt = Date.now();
  const timeout = AbortSignal.timeout(TOTAL_TIMEOUT_MS);
  const signal = externalSignal ? AbortSignal.any([externalSignal, timeout]) : timeout;
  const context = { fetch: fetchImplementation, input: normalizedInput, signal };
  const candidates = automaticConnectionCandidates(address, input.preferredProtocol).filter(
    (candidate) =>
      !input.claudeCompatible ||
      candidate.protocol !== 'anthropic' ||
      new URL(candidate.endpoint).pathname.endsWith('/v1/messages'),
  );
  let discovered: string[];
  try {
    discovered = await discoverModels(context, candidates);
  } catch (error) {
    externalSignal?.throwIfAborted();
    if (signal.aborted) throw new Error('连接超时，请检查网络后重试。', { cause: error });
    throw error;
  }
  const hints = usableModels(input.modelHints ?? [], credential);
  const models = (
    discovered.length
      ? [...hints.filter((hint) => discovered.includes(hint)), ...discovered]
      : hints
  )
    .filter((model, index, all) => all.indexOf(model) === index)
    .slice(0, MAX_MODEL_CANDIDATES);
  if (!models.length) throw new Error('未能获取模型，请在高级设置中填写模型后重试。');
  let requestCount = 0;
  let authenticationRejected = false;
  const attempts = candidates.flatMap((candidate) =>
    authModes(normalizedInput, candidate.protocol).map((authMode) => ({
      authMode,
      candidate,
      rejected: false,
    })),
  );
  // Try every protocol before spending the remaining budget on another model.
  for (const model of models) {
    for (const attempt of attempts) {
      const { authMode, candidate } = attempt;
      if (attempt.rejected) continue;
      if (requestCount >= MAX_GENERATION_REQUESTS || signal.aborted) break;
      try {
        signal.throwIfAborted();
        requestCount += 1;
        let result = await probe(context, { authMode, candidate, model });
        if (result.adjustedBody && requestCount < MAX_GENERATION_REQUESTS) {
          requestCount += 1;
          result = await probe(context, {
            authMode,
            body: result.adjustedBody,
            candidate,
            model,
          });
        }
        if (result.matched)
          return {
            authMode,
            endpoint: candidate.endpoint,
            latencyMs: Date.now() - testedAt,
            model,
            protocol: candidate.protocol,
            requestCount,
            testedAt,
          };
        authenticationRejected ||= result.status === 401 || result.status === 403;
        attempt.rejected = ![400, 422].includes(result.status);
      } catch (error) {
        if (error instanceof AutomaticConnectionAccessError || externalSignal?.aborted) throw error;
        attempt.rejected = true;
      }
    }
  }
  externalSignal?.throwIfAborted();
  throw new Error(
    signal.aborted
      ? '连接超时，请检查网络后重试。'
      : authenticationRejected
        ? '连接失败，请检查网址和密钥。'
        : '未找到可用连接，请检查网址或打开高级设置。',
  );
};
