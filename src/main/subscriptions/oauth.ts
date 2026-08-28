import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { SubscriptionProvider } from '../../shared/claude/subscriptions';
import { kimiHeaders, subscriptionEndpoints, type SubscriptionCredential } from './catalog';
import { authorizeGlm } from './zcode';
import { subscriptionAccountIdentity } from './account';
import {
  authJson,
  expiresAt,
  formBody,
  openAuthorization,
  requiredText,
  SubscriptionError,
  waitForPoll,
  type AuthContext,
} from './http';

const KIMI_CLIENT = '17e5f671-d194-4dfb-9706-5516cb48c098';
const MINIMAX_CLIENT = '78257093-7e40-4613-99e0-527b14b39113';
const LOGIN_TIMEOUT = 10 * 60_000;

const parseToken = (
  provider: SubscriptionProvider,
  body: Record<string, unknown>,
  previous?: SubscriptionCredential,
): SubscriptionCredential => {
  if (body.error || (provider.startsWith('minimax-') && body.status !== 'success')) {
    throw new SubscriptionError('授权未成功或已失效，请重新登录。', 401);
  }
  const accessToken = requiredText(body.access_token);
  const refreshToken = requiredText(body.refresh_token ?? previous?.refreshToken);
  const expiry =
    provider === 'kimi-subscription'
      ? expiresAt(body.expires_in, true)
      : expiresAt(body.expired_in);
  if (body.resource_url) {
    const resource = new URL(requiredText(body.resource_url));
    if (
      resource.origin !== new URL(subscriptionEndpoints[provider].baseUrl).origin ||
      resource.username ||
      resource.password
    ) {
      throw new SubscriptionError('授权返回的服务区域不匹配，已停止连接。');
    }
  }
  return {
    provider,
    accessToken,
    refreshToken,
    expiresAt: expiry,
    accountIdentity:
      previous?.accountIdentity ?? subscriptionAccountIdentity(body, [accessToken, refreshToken]),
    ...(previous?.deviceId ? { deviceId: previous.deviceId } : {}),
  };
};

const authorizeKimi = async (ctx: AuthContext): Promise<SubscriptionCredential> => {
  const provider = 'kimi-subscription';
  const deviceId = randomUUID();
  const headers = kimiHeaders(deviceId);
  const base = subscriptionEndpoints[provider].authBase;
  const { body, status } = await authJson(
    ctx,
    `${base}/api/oauth/device_authorization`,
    formBody({ client_id: KIMI_CLIENT }, headers),
  );
  if (status !== 200) throw new SubscriptionError('Kimi 暂时无法授权，请稍后重试。');
  const deviceCode = requiredText(body.device_code);
  const code = requiredText(body.user_code, 128);
  const deadline = Math.min(Date.now() + LOGIN_TIMEOUT, expiresAt(body.expires_in, true));
  let interval = Math.max(5000, Math.min(30_000, Number(body.interval || 5) * 1000));
  if (!Number.isFinite(interval)) interval = 5000;
  ctx.userCode(code);
  await openAuthorization(ctx, body.verification_uri_complete ?? body.verification_uri, [
    base,
    'https://www.kimi.com',
    'https://www.kimi.ai',
  ]);
  while (true) {
    await waitForPoll(interval, deadline, ctx.signal);
    const poll = await authJson(
      ctx,
      `${base}/api/oauth/token`,
      formBody(
        {
          client_id: KIMI_CLIENT,
          device_code: deviceCode,
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        },
        headers,
      ),
    );
    if (poll.body.error === 'authorization_pending' && [200, 400].includes(poll.status)) continue;
    if (poll.body.error === 'slow_down' && [200, 400].includes(poll.status)) {
      interval = Math.min(60_000, interval + 5000);
      continue;
    }
    if (poll.status !== 200) throw new SubscriptionError('Kimi 授权未完成，请重新登录。', 401);
    return { ...parseToken(provider, poll.body), deviceId };
  }
};

const authorizeMiniMax = async (
  provider: SubscriptionProvider,
  ctx: AuthContext,
): Promise<SubscriptionCredential> => {
  const base = subscriptionEndpoints[provider].authBase;
  const verifier = randomBytes(64).toString('base64url');
  const state = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const { body, status } = await authJson(
    ctx,
    `${base}/oauth2/device/code`,
    formBody(
      {
        response_type: 'code',
        client_id: MINIMAX_CLIENT,
        scope: 'group_id profile model.completion',
        code_challenge: challenge,
        code_challenge_method: 'S256',
        state,
      },
      { 'x-request-id': randomUUID() },
    ),
  );
  if (status !== 200 || body.state !== state)
    throw new SubscriptionError('MiniMax 授权校验失败，请重试。');
  const userCode = requiredText(body.user_code, 128);
  const deadline = Math.min(Date.now() + LOGIN_TIMEOUT, expiresAt(body.expired_in));
  const interval = Number.isFinite(Number(body.interval))
    ? Math.max(2000, Math.min(30_000, Number(body.interval)))
    : 2000;
  ctx.userCode(userCode);
  await openAuthorization(ctx, body.verification_uri, [
    base,
    provider === 'minimax-subscription-cn'
      ? 'https://platform.minimaxi.com'
      : 'https://platform.minimax.io',
  ]);
  while (true) {
    await waitForPoll(interval, deadline, ctx.signal);
    const poll = await authJson(
      ctx,
      `${base}/oauth2/token`,
      formBody({
        grant_type: 'urn:ietf:params:oauth:grant-type:user_code',
        client_id: MINIMAX_CLIENT,
        user_code: userCode,
        code_verifier: verifier,
      }),
    );
    if (
      poll.status === 200 &&
      ['pending', 'authorization_pending'].includes(String(poll.body.status))
    )
      continue;
    if (poll.body.error === 'authorization_pending' && [200, 400].includes(poll.status)) continue;
    if (poll.status !== 200) throw new SubscriptionError('MiniMax 授权未完成，请重新登录。', 401);
    return parseToken(provider, poll.body);
  }
};

/** Public device clients, explicit browser consent; no passwords or browser cookies are imported. */
export const authorizeSubscription = (
  provider: SubscriptionProvider,
  ctx: AuthContext,
): Promise<SubscriptionCredential> => {
  if (provider === 'kimi-subscription') return authorizeKimi(ctx);
  if (provider.startsWith('minimax-')) return authorizeMiniMax(provider, ctx);
  return authorizeGlm(provider, ctx);
};

export const refreshSubscription = async (
  credential: SubscriptionCredential,
  ctx: Pick<AuthContext, 'fetch' | 'signal' | 'network'>,
): Promise<SubscriptionCredential> => {
  if (credential.provider.startsWith('glm-')) return credential;
  const kimi = credential.provider === 'kimi-subscription';
  const base = subscriptionEndpoints[credential.provider].authBase;
  const { body, status } = await authJson(
    ctx,
    `${base}${kimi ? '/api/oauth/token' : '/oauth2/token'}`,
    formBody(
      {
        client_id: kimi ? KIMI_CLIENT : MINIMAX_CLIENT,
        grant_type: 'refresh_token',
        refresh_token: requiredText(credential.refreshToken),
      },
      credential.deviceId ? kimiHeaders(credential.deviceId) : {},
    ),
  );
  if (status !== 200)
    throw new SubscriptionError(
      status === 429 ? '授权服务请求过于频繁，请稍后重试。' : '订阅授权已失效，请重新登录。',
      status === 429 ? 429 : status >= 500 ? 502 : 401,
    );
  return parseToken(credential.provider, body, credential);
};
