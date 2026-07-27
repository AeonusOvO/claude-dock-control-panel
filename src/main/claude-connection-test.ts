import type { ClaudeConnectionTestResult, ClaudeConnectionTestStage } from '../shared/contracts';
import type { NormalizedClaudeConfig } from './claude-configuration';

const MAX_RESPONSE_BYTES = 64 * 1024;

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

export const testClaudeConnection = async (
  config: NormalizedClaudeConfig,
  credential?: string,
): Promise<ClaudeConnectionTestResult> => {
  const testedAt = Date.now();
  if (config.authMode === 'existing') {
    return {
      message: '现有 Claude 登录不能通过独立接口请求验证；请启动会话并在 /status 中确认。',
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
  if ((config.authMode === 'apiKey' || config.authMode === 'authToken') && !credential) {
    return {
      message: '缺少接口凭据，请填写新密钥或先保存密钥。',
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
    return {
      message: '官方接入使用“默认”时由 Claude Code 选择模型，请直接启动安全会话验证。',
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

  const baseUrl = config.provider === 'anthropic' ? 'https://api.anthropic.com' : config.baseUrl;
  const endpoint = claudeMessagesEndpoint(baseUrl);
  const headers: Record<string, string> = {
    'anthropic-version': '2023-06-01',
    'content-type': 'application/json',
  };
  if (config.authMode === 'apiKey' && credential) {
    headers['x-api-key'] = credential;
  } else if (config.authMode === 'authToken' && credential) {
    headers.authorization = `Bearer ${credential}`;
  }

  const startedAt = Date.now();
  let response: Response;
  try {
    response = await fetch(endpoint, {
      body: JSON.stringify({
        max_tokens: 1,
        messages: [{ content: '.', role: 'user' }],
        model: config.model,
      }),
      headers,
      method: 'POST',
      redirect: 'manual',
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    const detail =
      error instanceof Error && error.name === 'TimeoutError'
        ? '15 秒内没有收到响应。'
        : '无法建立网络连接，请检查地址、服务状态和代理。';
    return {
      latencyMs: Date.now() - startedAt,
      message: detail,
      ok: false,
      stages: [
        stage('endpoint', '接口地址', 'failed', detail),
        stage('authentication', '身份认证', 'skipped', '接口尚未连通。'),
        stage('model', '模型响应', 'skipped', '接口尚未连通。'),
      ],
      testedAt,
      tone: 'error',
    };
  }

  const raw = await readLimitedResponseText(response);
  const serverMessage = safeServerMessage(raw, credential);
  const latencyMs = Date.now() - startedAt;
  if (response.ok) {
    let validMessage: boolean;
    try {
      const parsed = JSON.parse(raw) as { content?: unknown; id?: unknown };
      validMessage =
        typeof parsed.id === 'string' &&
        parsed.id.startsWith('msg_') &&
        Array.isArray(parsed.content);
    } catch {
      validMessage = false;
    }
    if (validMessage) {
      return {
        latencyMs,
        message: '端点、认证和模型响应全部通过，可以保存并启动 Claude Code。',
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
    return {
      latencyMs,
      message: '接口返回成功状态，但响应不是标准 Anthropic 消息格式。',
      ok: false,
      stages: [
        stage('endpoint', '接口地址', 'passed', `${response.status} · 已收到响应`),
        stage('authentication', '身份认证', 'passed', '请求未被拒绝。'),
        stage('model', '模型响应', 'failed', '缺少以 msg_ 开头的标识或 content 数组。'),
      ],
      testedAt,
      tone: 'error',
    };
  }

  if (response.status === 401 || response.status === 403) {
    return {
      latencyMs,
      message: '接口已找到，但密钥或认证方式不正确。',
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
    return {
      latencyMs,
      message: '端点与认证基本可用，但当前模型名或请求兼容性仍需处理。',
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

  return {
    latencyMs,
    message:
      response.status === 404
        ? '没有找到 /v1/messages；这通常是把 OpenAI 地址直接当成 Claude 地址。'
        : `网关返回 HTTP ${response.status}，尚未完成接入。`,
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
