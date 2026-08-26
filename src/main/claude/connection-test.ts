import type { ClaudeConnectionTestResult, ClaudeConnectionTestStage } from '../../shared/contracts';
import { createFailureReporter } from '../infra/logger';
import type { NormalizedClaudeConfig } from './configuration';

const MAX_RESPONSE_BYTES = 64 * 1024;
const reportConnectionFailure = createFailureReporter('claude-connection');

export const claudeMessagesEndpoint = (baseUrl: string): string => {
  const parsed = new URL(baseUrl);
  const pathname = parsed.pathname.replace(/\/+$/, '');
  parsed.pathname = /\/v1\/messages$/i.test(pathname)
    ? pathname
    : `${pathname}/v1/messages`.replace(/\/{2,}/g, '/');
  return parsed.toString();
};

const stage = (
  id: ClaudeConnectionTestStage['id'],
  label: string,
  status: ClaudeConnectionTestStage['status'],
  detail: string,
): ClaudeConnectionTestStage => ({ detail, id, label, status });

const safeServerMessage = (raw: string, credential?: string): string | undefined => {
  if (!raw) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as {
      error?: { message?: unknown };
      message?: unknown;
    };
    const candidate =
      typeof parsed.error?.message === 'string'
        ? parsed.error.message
        : typeof parsed.message === 'string'
          ? parsed.message
          : undefined;
    if (!candidate) {
      return undefined;
    }
    const scrubbed = credential ? candidate.replaceAll(credential, '[已隐藏]') : candidate;
    return scrubbed.replace(/\s+/g, ' ').slice(0, 180);
  } catch {
    return undefined;
  }
};

export const readLimitedResponseText = async (
  response: Response,
  maximumBytes = MAX_RESPONSE_BYTES,
): Promise<string> => {
  const reader = response.body?.getReader();
  if (!reader) {
    return '';
  }

  const decoder = new TextDecoder();
  let bytesRead = 0;
  let text = '';
  try {
    while (bytesRead < maximumBytes) {
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }
      const remaining = maximumBytes - bytesRead;
      const accepted = chunk.value.subarray(0, remaining);
      text += decoder.decode(accepted, { stream: true });
      bytesRead += accepted.byteLength;
      if (accepted.byteLength < chunk.value.byteLength || bytesRead >= maximumBytes) {
        await reader.cancel().catch(() => undefined);
        break;
      }
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
};

const preflightConnectionTest = (
  config: NormalizedClaudeConfig,
  effectiveCredential: string | undefined,
  testedAt: number,
): ClaudeConnectionTestResult | undefined => {
  if (config.authMode === 'existing') {
    const message = '现有 Claude 登录不能通过独立接口请求验证；请启动会话并在 /status 中确认。';
    return {
      ...reportConnectionFailure('user-input', message, { authMode: config.authMode }),
      authMode: config.authMode,
      failureKind: 'unknown',
      ok: false,
      stages: [
        stage('endpoint', '接口地址', 'skipped', '官方登录使用 Claude Code 自己的会话认证。'),
        stage('authentication', '身份认证', 'skipped', '不会读取或复用你的 Claude 登录令牌。'),
        stage('model', '模型响应', 'skipped', '启动 Claude 会话后验证。'),
      ],
      testedAt,
      tone: 'warning',
    };
  }
  if ((config.authMode === 'apiKey' || config.authMode === 'authToken') && !effectiveCredential) {
    const message = '缺少接口凭据，请填写新密钥或先保存密钥。';
    return {
      ...reportConnectionFailure('user-input', message, { authMode: config.authMode }),
      authMode: config.authMode,
      failureKind: 'authentication',
      ok: false,
      stages: [
        stage('endpoint', '接口地址', 'skipped', '尚未发送请求。'),
        stage('authentication', '身份认证', 'failed', '没有可用于测试的凭据。'),
        stage('model', '模型响应', 'skipped', '认证通过后才能验证。'),
      ],
      testedAt,
      tone: 'error',
    };
  }
  if (config.provider === 'anthropic' && config.model === 'default') {
    const message = '官方接入使用“默认”时由 Claude Code 选择模型，请通过项目旁的 + 新建对话验证。';
    return {
      ...reportConnectionFailure('user-input', message, { model: config.model }),
      authMode: config.authMode,
      failureKind: 'unknown',
      ok: false,
      stages: [
        stage('endpoint', '接口地址', 'passed', '使用 Anthropic 官方默认端点。'),
        stage('authentication', '身份认证', 'skipped', '不会为了诊断猜测官方模型标识。'),
        stage('model', '模型响应', 'skipped', '启动 Claude 会话后验证。'),
      ],
      testedAt,
      tone: 'warning',
    };
  }
  return undefined;
};

interface ConnectionRequestSuccess {
  response: Response;
  startedAt: number;
}

interface ConnectionRequestFailure {
  failure: ClaudeConnectionTestResult;
}

const requestClaudeConnection = async (
  config: NormalizedClaudeConfig,
  endpoint: string,
  headers: Record<string, string>,
  testedAt: number,
  externalSignal?: AbortSignal,
): Promise<ConnectionRequestFailure | ConnectionRequestSuccess> => {
  const startedAt = Date.now();
  try {
    const timeoutSignal = AbortSignal.timeout(15_000);
    const response = await fetch(endpoint, {
      body: JSON.stringify({
        max_tokens: 1,
        messages: [{ content: '.', role: 'user' }],
        model: config.model,
      }),
      headers,
      method: 'POST',
      redirect: 'manual',
      signal: externalSignal ? AbortSignal.any([externalSignal, timeoutSignal]) : timeoutSignal,
    });
    return { response, startedAt };
  } catch (error) {
    if (externalSignal?.aborted) {
      throw externalSignal.reason instanceof Error
        ? externalSignal.reason
        : new Error('接入测试已取消。');
    }
    const detail =
      error instanceof Error && error.name === 'TimeoutError'
        ? '15 秒内没有收到响应。'
        : '无法建立网络连接，请检查地址、服务状态和代理。';
    return {
      failure: {
        ...reportConnectionFailure('external-service', detail, error),
        authMode: config.authMode,
        failureKind:
          error instanceof Error && error.name === 'TimeoutError' ? 'timeout' : 'network',
        latencyMs: Date.now() - startedAt,
        ok: false,
        stages: [
          stage('endpoint', '接口地址', 'failed', detail),
          stage('authentication', '身份认证', 'skipped', '接口尚未连通。'),
          stage('model', '模型响应', 'skipped', '接口尚未连通。'),
        ],
        testedAt,
        tone: 'error',
      },
    };
  }
};

const successfulConnectionResult = (
  config: NormalizedClaudeConfig,
  response: Response,
  raw: string,
  latencyMs: number,
  testedAt: number,
): ClaudeConnectionTestResult => {
  let validMessage: boolean;
  let observedProtocol: ClaudeConnectionTestResult['observedProtocol'] = 'unknown';
  try {
    const parsed = JSON.parse(raw) as {
      choices?: unknown;
      content?: unknown;
      id?: unknown;
      object?: unknown;
    };
    validMessage =
      typeof parsed.id === 'string' && parsed.id.trim().length > 0 && Array.isArray(parsed.content);
    observedProtocol = validMessage
      ? 'anthropic'
      : Array.isArray(parsed.choices) ||
          (typeof parsed.object === 'string' && parsed.object.startsWith('chat.completion'))
        ? 'openai'
        : 'unknown';
  } catch {
    validMessage = false;
  }
  if (validMessage) {
    return {
      authMode: config.authMode,
      httpStatus: response.status,
      latencyMs,
      message: '端点、认证和模型响应全部通过，可以保存并启动 Claude Code。',
      observedProtocol: 'anthropic',
      ok: true,
      stages: [
        stage('endpoint', '接口地址', 'passed', `${response.status} · /v1/messages 可访问`),
        stage('authentication', '身份认证', 'passed', '网关接受了当前认证方式。'),
        stage('model', '模型响应', 'passed', `模型 ${config.model} 返回 Anthropic 消息格式。`),
      ],
      testedAt,
      tone: 'success',
    };
  }
  const message = '接口返回成功状态，但响应不是标准 Anthropic 消息格式。';
  return {
    ...reportConnectionFailure('external-service', message, {
      observedProtocol,
      status: response.status,
    }),
    authMode: config.authMode,
    failureKind: 'response-shape',
    httpStatus: response.status,
    latencyMs,
    observedProtocol,
    ok: false,
    stages: [
      stage('endpoint', '接口地址', 'passed', `${response.status} · 已收到响应`),
      stage('authentication', '身份认证', 'passed', '请求未被拒绝。'),
      stage(
        'model',
        '模型响应',
        'failed',
        observedProtocol === 'openai'
          ? '检测到 OpenAI 响应格式，需要协议转换。'
          : '缺少非空消息标识或 content 数组。',
      ),
    ],
    testedAt,
    tone: 'error',
  };
};

const failedConnectionResult = (
  config: NormalizedClaudeConfig,
  response: Response,
  serverMessage: string | undefined,
  latencyMs: number,
  testedAt: number,
): ClaudeConnectionTestResult => {
  if (response.status === 401 || response.status === 403) {
    const message = '接口已找到，但密钥或认证方式不正确。';
    return {
      ...reportConnectionFailure('user-input', message, {
        serverMessage,
        status: response.status,
      }),
      authMode: config.authMode,
      failureKind: 'authentication',
      httpStatus: response.status,
      latencyMs,
      ok: false,
      stages: [
        stage('endpoint', '接口地址', 'passed', `${response.status} · 网关已响应`),
        stage(
          'authentication',
          '身份认证',
          'failed',
          '持有者令牌对应 Authorization；接口密钥对应 x-api-key。请切换后重试。',
        ),
        stage('model', '模型响应', 'skipped', '认证未通过。'),
      ],
      testedAt,
      tone: 'error',
    };
  }
  if (response.status === 400 || response.status === 422) {
    const message = '端点与认证基本可用，但当前模型名或请求兼容性仍需处理。';
    return {
      ...reportConnectionFailure('user-input', message, {
        model: config.model,
        serverMessage,
        status: response.status,
      }),
      authMode: config.authMode,
      failureKind: 'model',
      httpStatus: response.status,
      latencyMs,
      ok: false,
      stages: [
        stage('endpoint', '接口地址', 'passed', `${response.status} · /v1/messages 已响应`),
        stage('authentication', '身份认证', 'passed', '请求没有被认证层拒绝。'),
        stage(
          'model',
          '模型响应',
          'warning',
          serverMessage ?? `网关未接受模型 ${config.model} 或请求字段。`,
        ),
      ],
      testedAt,
      tone: 'warning',
    };
  }
  const message =
    response.status === 404
      ? '没有找到 /v1/messages；这通常是把 OpenAI 地址直接当成 Claude 地址。'
      : `网关返回 HTTP ${response.status}，尚未完成接入。`;
  return {
    ...reportConnectionFailure(
      response.status >= 500 ? 'external-service' : 'user-input',
      message,
      { serverMessage, status: response.status },
    ),
    authMode: config.authMode,
    failureKind: response.status === 404 ? 'not-found' : 'unknown',
    httpStatus: response.status,
    latencyMs,
    ok: false,
    stages: [
      stage(
        'endpoint',
        '接口地址',
        'failed',
        serverMessage ?? `HTTP ${response.status} · ${response.statusText || '请求失败'}`,
      ),
      stage('authentication', '身份认证', 'skipped', '先修正接口地址或服务状态。'),
      stage('model', '模型响应', 'skipped', '接口未通过。'),
    ],
    testedAt,
    tone: 'error',
  };
};

export const testClaudeConnection = async (
  config: NormalizedClaudeConfig,
  credential?: string,
  signal?: AbortSignal,
): Promise<ClaudeConnectionTestResult> => {
  const testedAt = Date.now();
  const effectiveCredential = credential || (config.preset === 'ollama' ? 'ollama' : undefined);
  const preflight = preflightConnectionTest(config, effectiveCredential, testedAt);
  if (preflight) {
    return preflight;
  }

  const baseUrl = config.provider === 'anthropic' ? 'https://api.anthropic.com' : config.baseUrl;
  const endpoint = claudeMessagesEndpoint(baseUrl);
  const headers: Record<string, string> = {
    'anthropic-version': '2023-06-01',
    'content-type': 'application/json',
  };
  if (config.authMode === 'apiKey' && effectiveCredential) {
    headers['x-api-key'] = effectiveCredential;
  } else if (config.authMode === 'authToken' && effectiveCredential) {
    headers.authorization = `Bearer ${effectiveCredential}`;
  }

  const request = await requestClaudeConnection(config, endpoint, headers, testedAt, signal);
  if ('failure' in request) {
    return request.failure;
  }
  const raw = await readLimitedResponseText(request.response);
  const latencyMs = Date.now() - request.startedAt;
  if (request.response.ok) {
    return successfulConnectionResult(config, request.response, raw, latencyMs, testedAt);
  }
  return failedConnectionResult(
    config,
    request.response,
    safeServerMessage(raw, effectiveCredential),
    latencyMs,
    testedAt,
  );
};
