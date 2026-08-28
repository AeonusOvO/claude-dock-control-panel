import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { SubscriptionProvider } from '../../shared/claude/subscriptions';
import { subscriptionEndpoints, type SubscriptionCredential } from './catalog';
import {
  authJson,
  hasControlCharacters,
  expiresAt,
  openAuthorization,
  record,
  requiredText,
  SubscriptionError,
  waitForPoll,
  type AuthContext,
} from './http';

const OAUTH = 'https://zcode.z.ai/api/v1';
const KEY_NAME = 'claudedock-subscription';
const jsonPost = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

const envelope = async (
  ctx: Pick<AuthContext, 'fetch' | 'signal' | 'network'>,
  url: string,
  init: RequestInit = {},
): Promise<Record<string, unknown>> => {
  const result = await authJson(ctx, url, init);
  if (
    result.status !== 200 ||
    ![0, 200, '0', '200'].includes(result.body.code as number | string)
  ) {
    throw new SubscriptionError('GLM 授权服务暂不可用，请稍后重试。');
  }
  return result.body;
};

/** Own the bound socket from start to finish; bad callbacks never consume the valid one. */
const authorizeChina = async (ctx: AuthContext): Promise<string> => {
  const state = randomBytes(32).toString('hex');
  let accepted = false;
  let resolveCode: (value: string) => void = () => undefined;
  let rejectCode: (error: unknown) => void = () => undefined;
  const result = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });
  // Rejection is observed before opening the browser, including immediate cancellation.
  void result.catch(() => undefined);
  const server = createServer(
    { requestTimeout: 5000, headersTimeout: 5000, maxHeaderSize: 8192 },
    (request, response) => {
      const address = server.address();
      const host = address && typeof address !== 'string' ? `127.0.0.1:${address.port}` : '';
      response.setHeader('Cache-Control', 'no-store');
      response.setHeader('Content-Type', 'text/plain; charset=utf-8');
      response.setHeader('Referrer-Policy', 'no-referrer');
      response.setHeader('Content-Security-Policy', "default-src 'none'");
      let url: URL;
      try {
        url = new URL(request.url ?? '/', `http://${host || '127.0.0.1'}`);
      } catch {
        response.writeHead(400).end('无效的授权地址。');
        return;
      }
      if (
        request.method !== 'GET' ||
        request.headers.host !== host ||
        url.origin !== `http://${host}` ||
        url.pathname !== '/callback' ||
        accepted ||
        ctx.signal.aborted ||
        url.searchParams.get('state') !== state
      ) {
        response.writeHead(400).end('无效或已过期的授权。');
        return;
      }
      const code = url.searchParams.get('authCode') ?? url.searchParams.get('code');
      if (!code || code.length > 4096 || hasControlCharacters(code)) {
        response.writeHead(400).end('未收到授权。');
        return;
      }
      accepted = true;
      response.end('已收到授权，可以关闭此页。');
      resolveCode(code);
    },
  );
  server.on('error', () => rejectCode(new SubscriptionError('无法启动本机授权回调，请重试。')));
  const abort = (): void => {
    rejectCode(ctx.signal.reason);
    server.closeAllConnections();
    server.close();
  };
  ctx.signal.addEventListener('abort', abort, { once: true });
  try {
    ctx.signal.throwIfAborted();
    const listening = once(server, 'listening', { signal: ctx.signal });
    void listening.catch(() => undefined);
    server.listen({ port: 0, host: '127.0.0.1', signal: ctx.signal });
    await listening;
    ctx.signal.throwIfAborted();
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new SubscriptionError('无法启动本机授权回调。');
    const redirect = `http://127.0.0.1:${address.port}/callback`;
    const url = new URL('https://bigmodel.cn/login');
    url.search = new URLSearchParams({ redirect, appId: 'zcode', state }).toString();
    await openAuthorization(ctx, url.toString(), ['https://bigmodel.cn']);
    const code = await result;
    ctx.signal.throwIfAborted();
    const payload = record(
      (
        await envelope(
          ctx,
          `${OAUTH}/oauth/token`,
          jsonPost({ provider: 'bigmodel', code, redirect_uri: redirect, state }),
        )
      ).data,
    );
    const bigmodel = record(payload.bigmodel);
    return requiredText(bigmodel.access_token ?? bigmodel.accessToken ?? payload.access_token);
  } finally {
    ctx.signal.removeEventListener('abort', abort);
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
};

const authorizeGlobal = async (ctx: AuthContext): Promise<string> => {
  const initialToken = randomBytes(32).toString('hex');
  const init = jsonPost({ provider: 'zai' });
  init.headers = { ...init.headers, Authorization: `Bearer ${initialToken}` };
  const flow = record((await envelope(ctx, `${OAUTH}/oauth/cli/init`, init)).data);
  const id = requiredText(flow.flow_id, 256);
  const token = requiredText(flow.poll_token ?? initialToken);
  const deadline = Math.min(
    Date.now() + 600_000,
    flow.expires_at ? expiresAt(flow.expires_at) : Infinity,
  );
  let interval = Math.max(2000, Math.min(30_000, Number(flow.poll_interval_sec ?? 2) * 1000));
  if (!Number.isFinite(interval)) interval = 2000;
  await openAuthorization(ctx, flow.authorize_url, [
    'https://chat.z.ai',
    'https://z.ai',
    'https://zcode.z.ai',
  ]);
  while (true) {
    await waitForPoll(interval, deadline, ctx.signal);
    const poll = record(
      (
        await envelope(ctx, `${OAUTH}/oauth/cli/poll/${encodeURIComponent(id)}`, {
          headers: { Authorization: `Bearer ${token}` },
        })
      ).data,
    );
    if (poll.status === 'pending') continue;
    if (poll.status !== 'ready') throw new SubscriptionError('GLM 授权未完成，请重新登录。', 401);
    return requiredText(record(poll.zai).access_token);
  }
};

const chooseDefault = (
  items: unknown,
  id: string,
  name: string,
  defaultName: string,
): Record<string, unknown> => {
  if (!Array.isArray(items)) throw new SubscriptionError('GLM 账号没有可用的默认项目。');
  const values = items.map(record).filter((entry) => typeof entry[id] === 'string' && entry[id]);
  const defaults = values.filter((entry) => entry[name] === defaultName);
  if (defaults.length === 1) return defaults[0]!;
  if (values.length === 1) return values[0]!;
  throw new SubscriptionError('GLM 账号包含多个项目，请在高级设置中使用套餐密钥。');
};

/** The Anthropic endpoint can charge a never-subscribed account; require a real plan first. */
const assertCodingPlan = async (
  provider: SubscriptionProvider,
  key: string,
  ctx: AuthContext,
): Promise<void> => {
  const origin = new URL(subscriptionEndpoints[provider].baseUrl).origin;
  const result = await authJson(ctx, `${origin}/api/monitor/usage/quota/limit`, {
    headers: { Authorization: key, Accept: 'application/json' },
  });
  const limits = record(result.body.data).limits;
  if (
    result.status !== 200 ||
    result.body.success === false ||
    ![0, 200, '0', '200'].includes(result.body.code as number | string) ||
    !Array.isArray(limits)
  ) {
    throw new SubscriptionError('无法确认 GLM 编程套餐，请检查套餐状态后重试。', 402);
  }
  const windows = limits.map(record).filter((entry) => entry.type === 'TOKENS_LIMIT');
  if (
    !windows.length ||
    windows.some(
      (entry) =>
        typeof entry.percentage !== 'number' ||
        !Number.isFinite(entry.percentage) ||
        entry.percentage < 0 ||
        entry.percentage > 100,
    )
  ) {
    throw new SubscriptionError('未检测到有效的 GLM 编程套餐。', 402);
  }
  if (windows.some((entry) => Number(entry.percentage) >= 100))
    throw new SubscriptionError('GLM 编程套餐额度已用尽，请稍后重试。', 429);
};

/** Same browser-consented business flow as ZCode; never uses its CAPTCHA-gated mint endpoint. */
export const authorizeGlm = async (
  provider: SubscriptionProvider,
  ctx: AuthContext,
): Promise<SubscriptionCredential> => {
  const china = provider === 'glm-subscription-cn';
  const accountToken = china ? await authorizeChina(ctx) : await authorizeGlobal(ctx);
  const base = china ? 'https://bigmodel.cn' : 'https://api.z.ai';
  const businessToken = china
    ? accountToken
    : requiredText(
        record(
          (await envelope(ctx, `${base}/api/auth/z/login`, jsonPost({ token: accountToken }))).data,
        ).access_token,
      );
  const headers = {
    Authorization: china ? businessToken : `Bearer ${businessToken}`,
    'Content-Type': 'application/json',
  };
  const customer = record(
    (await envelope(ctx, `${base}/api/biz/customer/getCustomerInfo`, { headers })).data,
  );
  const org = chooseDefault(
    customer.organizations,
    'organizationId',
    'organizationName',
    '默认机构',
  );
  const project = chooseDefault(org.projects, 'projectId', 'projectName', '默认项目');
  const keyUrl = `${base}/api/biz/v1/organization/${encodeURIComponent(requiredText(org.organizationId, 256))}/projects/${encodeURIComponent(requiredText(project.projectId, 256))}/api_keys`;
  const listKeys = async (): Promise<Record<string, unknown>[]> => {
    const result = (await envelope(ctx, keyUrl, { headers })).data;
    if (!Array.isArray(result)) throw new SubscriptionError('GLM 套餐凭据暂不可用。');
    return result.map(record).filter((entry) => entry.name === KEY_NAME);
  };
  let matches = await listKeys();
  if (!matches.length) {
    ctx.signal.throwIfAborted();
    // A persistent key is created only after explicit browser consent. Never retry this POST.
    await envelope(ctx, keyUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: KEY_NAME }),
    });
    matches = await listKeys();
  }
  if (matches.length !== 1)
    throw new SubscriptionError('GLM 套餐凭据不唯一，请在控制台检查后重试。');
  const keyId = requiredText(matches[0]!.apiKey, 512);
  const copied = record(
    (await envelope(ctx, `${keyUrl}/copy/${encodeURIComponent(keyId)}`, { headers })).data,
  );
  const secret = requiredText(copied.secretKey);
  const key = `${keyId}.${secret}`;
  await assertCodingPlan(provider, key, ctx);
  ctx.signal.throwIfAborted();
  return { provider, accessToken: key, expiresAt: Number.MAX_SAFE_INTEGER };
};
