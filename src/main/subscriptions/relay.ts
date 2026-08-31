import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { subscriptionEndpoints, subscriptionHeaders, type SubscriptionCredential } from './catalog';
import { readBoundedJson, record, SubscriptionError, type AuthContext } from './http';
import { refreshSubscription } from './oauth';
import { SubscriptionVault, type SubscriptionSlot } from './vault';
import {
  isSubscriptionBaseUrl,
  isSubscriptionProvider,
  type SubscriptionProvider,
} from '../../shared/claude/subscriptions';
import { sanitizeAccountIdentity } from '../../shared/claude/account-identity';
import { subscriptionAccountIdentity } from './account';

export interface SubscriptionNetwork {
  fetch: typeof fetch;
  network: NonNullable<AuthContext['network']>;
}

const replyError = (response: ServerResponse, status: number): void => {
  if (response.headersSent) {
    response.destroy();
    return;
  }
  const message =
    status === 401
      ? '订阅授权已失效，请重新登录。'
      : status === 402 || status === 429
        ? '订阅额度不足或请求过于频繁，请稍后重试。'
        : '订阅服务暂不可用，请重试。';
  response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message } }));
};

export class SubscriptionRelay {
  private readonly slots = new Map<string, SubscriptionSlot>();
  private readonly persisted = new Set<string>();
  private readonly refreshes = new Map<string, Promise<SubscriptionCredential>>();
  private readonly rejected = new Set<string>();
  private readonly lifetime = new AbortController();
  private server: Server | undefined;
  private starting: Promise<void> | undefined;
  private port = 0;
  private loaded = false;
  private requests = 0;

  public constructor(
    private readonly vault: SubscriptionVault,
    private readonly authNetwork: SubscriptionNetwork,
    private readonly inferenceNetwork: SubscriptionNetwork,
    private readonly refresh: typeof refreshSubscription = refreshSubscription,
  ) {}

  public ensureRunning(): Promise<void> {
    if (this.lifetime.signal.aborted)
      return Promise.reject(new SubscriptionError('应用正在退出。'));
    if (this.server?.listening) return Promise.resolve();
    if (this.starting) return this.starting;
    const pending = this.start();
    this.starting = pending;
    void pending
      .finally(() => {
        if (this.starting === pending) this.starting = undefined;
      })
      .catch(() => undefined);
    return pending;
  }

  private async start(): Promise<void> {
    const stored = this.vault.load();
    if (!this.loaded) {
      for (const slot of stored.slots) {
        this.slots.set(slot.id, slot);
        this.persisted.add(slot.id);
      }
      this.loaded = true;
    }
    const ports = stored.port
      ? [stored.port]
      : Array.from({ length: 21 }, (_, index) => 18520 + index);
    for (const port of ports) {
      this.lifetime.signal.throwIfAborted();
      const server = createServer(
        { requestTimeout: 60_000, headersTimeout: 15_000, maxHeaderSize: 16_384 },
        (req, res) => {
          void this.handle(req, res).catch(() => replyError(res, 502));
        },
      );
      try {
        await new Promise<void>((resolve, reject) => {
          server.once('error', reject);
          server.listen(port, '127.0.0.1', () => {
            server.removeListener('error', reject);
            resolve();
          });
        });
      } catch (error) {
        server.close();
        if (record(error).code === 'EADDRINUSE' && !stored.port) continue;
        throw new SubscriptionError('订阅后台端口不可用，请关闭冲突程序后重试。');
      }
      try {
        this.lifetime.signal.throwIfAborted();
        if (!stored.port) this.vault.setPort(port);
        this.port = port;
        this.server = server;
        server.on('error', () => {
          server.closeAllConnections();
          server.close();
        });
        return;
      } catch (error) {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        throw error;
      }
    }
    throw new SubscriptionError('没有可用的订阅后台端口。');
  }

  public addCandidate(credential: SubscriptionCredential): SubscriptionSlot {
    this.lifetime.signal.throwIfAborted();
    if (!this.server?.listening) throw new SubscriptionError('订阅后台尚未就绪。');
    if (this.slots.size >= 128)
      throw new SubscriptionError('已保存的订阅账号过多，请先清理不再使用的账号。');
    const slot = {
      id: randomBytes(16).toString('hex'),
      clientKey: randomBytes(32).toString('hex'),
      credential: structuredClone(credential),
    };
    this.slots.set(slot.id, slot);
    return structuredClone(slot);
  }

  public baseUrl(id: string): string {
    return `http://127.0.0.1:${this.port}/s/${id}`;
  }

  /** Validates the immutable provider, listener port, and committed slot behind a saved config. */
  public committedSlotIdForConnection(provider: unknown, baseUrl: string): string {
    if (!isSubscriptionProvider(provider) || !isSubscriptionBaseUrl(baseUrl)) {
      throw new SubscriptionError('订阅接入地址无效。');
    }
    const url = new URL(baseUrl);
    const slotId = url.pathname.slice('/s/'.length);
    const slot = this.slots.get(slotId);
    if (
      !slot ||
      !this.persisted.has(slotId) ||
      Number(url.port) !== this.port ||
      slot.credential.provider !== provider
    ) {
      throw new SubscriptionError('订阅接入地址与服务商不匹配。');
    }
    return slotId;
  }

  public persist(id: string): void {
    this.lifetime.signal.throwIfAborted();
    const slot = this.slots.get(id);
    if (!slot) throw new SubscriptionError('订阅授权已过期。');
    this.vault.put(slot);
    this.persisted.add(id);
  }

  public discard(id: string): void {
    if (!this.persisted.has(id)) this.slots.delete(id);
  }

  /** Read only the committed binding; no network request, listener startup or credential IPC. */
  public getAccountIdentity(provider: unknown, baseUrl: string): string | undefined {
    if (!isSubscriptionProvider(provider) || !isSubscriptionBaseUrl(baseUrl)) return undefined;
    try {
      const url = new URL(baseUrl);
      const stored = this.vault.load();
      if (Number(url.port) !== stored.port) return undefined;
      const slot = stored.slots.find((entry) => entry.id === url.pathname.slice(3));
      if (slot?.credential.provider !== provider) return undefined;
      return (
        sanitizeAccountIdentity(slot.credential.accountIdentity) ??
        subscriptionAccountIdentity({ access_token: slot.credential.accessToken }, [
          slot.credential.refreshToken,
        ])
      );
    } catch {
      // Display metadata may be unavailable; launching still validates the vault and fails closed.
      return undefined;
    }
  }

  private credential(id: string, rejectedToken?: string): Promise<SubscriptionCredential> {
    const slot = this.slots.get(id);
    if (!slot || this.rejected.has(id))
      return Promise.reject(new SubscriptionError('订阅授权已失效，请重新登录。', 401));
    const previous = slot.credential;
    if (
      previous.expiresAt > Date.now() + 60_000 &&
      (!rejectedToken || rejectedToken !== previous.accessToken)
    )
      return Promise.resolve(previous);
    if (previous.provider.startsWith('glm-'))
      return Promise.reject(new SubscriptionError('订阅授权已失效，请重新登录。', 401));
    const current = this.refreshes.get(id);
    if (current) return current;
    // A request's cancellation cannot abort the one shared rotating-token refresh for other sessions.
    const pending = this.refresh(previous, { ...this.authNetwork, signal: this.lifetime.signal })
      .then((fresh) => {
        this.lifetime.signal.throwIfAborted();
        if (this.slots.get(id) !== slot || fresh.provider !== previous.provider)
          throw new SubscriptionError('订阅授权已变化，请重试。');
        const updated = { ...slot, credential: fresh };
        if (this.persisted.has(id)) this.vault.put(updated);
        this.slots.set(id, updated);
        return fresh;
      })
      .catch((error: unknown) => {
        if (error instanceof SubscriptionError && error.status === 401) this.rejected.add(id);
        throw error;
      })
      .finally(() => {
        if (this.refreshes.get(id) === pending) this.refreshes.delete(id);
      });
    this.refreshes.set(id, pending);
    return pending;
  }

  public async discoverModels(
    id: string,
    signal: AbortSignal,
    expectedProvider?: SubscriptionProvider,
  ): Promise<string[]> {
    const credential = await this.credential(id);
    if (expectedProvider !== undefined && credential.provider !== expectedProvider) {
      throw new SubscriptionError('订阅接入地址与服务商不匹配。');
    }
    const endpoint = subscriptionEndpoints[credential.provider];
    const url = `${endpoint.baseUrl}/v1/models`;
    return this.inferenceNetwork.network(
      url,
      async () => {
        const combined = AbortSignal.any([
          signal,
          this.lifetime.signal,
          AbortSignal.timeout(20_000),
        ]);
        const response = await this.inferenceNetwork.fetch(url, {
          headers: subscriptionHeaders(credential),
          credentials: 'omit',
          redirect: 'error',
          signal: combined,
        });
        if ([404, 405, 501].includes(response.status)) {
          await response.body?.cancel();
          return [...endpoint.models];
        }
        if (!response.ok) {
          await response.body?.cancel();
          throw new SubscriptionError('无法读取订阅模型，请检查套餐状态。', response.status);
        }
        const body = await readBoundedJson(response, combined);
        const models = Array.isArray(body.data)
          ? body.data
              .map((entry) => record(entry).id)
              .filter(
                (id): id is string =>
                  typeof id === 'string' && /^[a-zA-Z0-9._:/@[\]~-]{1,200}$/.test(id),
              )
          : [];
        if (!models.length) throw new SubscriptionError('订阅没有返回可用模型。');
        return [...new Set(models)].slice(0, 256);
      },
      signal,
    );
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const incoming = new URL(request.url ?? '/', `http://127.0.0.1:${this.port}`);
    const match = /^\/s\/([a-f0-9]{32})(\/v1\/(?:messages(?:\/count_tokens)?|models))$/.exec(
      incoming.pathname,
    );
    const modelsRequest = match?.[2] === '/v1/models' && request.method === 'GET';
    const slot = match ? this.slots.get(match[1]!) : undefined;
    const supplied = request.headers.authorization?.replace(/^Bearer /, '') ?? '';
    if (
      (!modelsRequest && request.method !== 'POST') ||
      (match?.[2] === '/v1/models' && !modelsRequest) ||
      incoming.origin !== `http://127.0.0.1:${this.port}` ||
      (incoming.search !== '' && incoming.search !== '?beta=true') ||
      request.headers.host !== `127.0.0.1:${this.port}` ||
      request.headers.origin ||
      !slot ||
      !/^[a-f0-9]{64}$/.test(supplied) ||
      !timingSafeEqual(Buffer.from(supplied), Buffer.from(slot.clientKey))
    ) {
      replyError(response, 401);
      return;
    }
    if (this.requests >= 32 || this.lifetime.signal.aborted) {
      replyError(response, 503);
      return;
    }
    this.requests += 1;
    const disconnected = new AbortController();
    const abort = (): void => {
      if (!response.writableFinished) disconnected.abort();
    };
    response.once('close', abort);
    request.once('aborted', abort);
    const signal = AbortSignal.any([
      disconnected.signal,
      this.lifetime.signal,
      AbortSignal.timeout(10 * 60_000),
    ]);
    try {
      if (modelsRequest) {
        const models = await this.discoverModels(slot.id, signal);
        response.writeHead(200, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
        });
        response.end(
          JSON.stringify({
            data: models.map((id) => ({ id, type: 'model', display_name: id })),
            has_more: false,
          }),
        );
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of request) {
        signal.throwIfAborted();
        const bytes = Buffer.from(chunk as Buffer);
        size += bytes.length;
        if (size > 32 * 1024 * 1024) {
          replyError(response, 413);
          return;
        }
        chunks.push(bytes);
      }
      const body = Buffer.concat(chunks);
      const url = `${subscriptionEndpoints[slot.credential.provider].baseUrl}${match![2]}${incoming.search}`;
      await this.inferenceNetwork.network(
        url,
        async () => {
          let credential = await this.credential(slot.id);
          const send = (): Promise<Response> => {
            signal.throwIfAborted();
            const headers: Record<string, string> = {
              ...subscriptionHeaders(credential),
              'Content-Type': 'application/json',
              Accept: 'application/json, text/event-stream',
            };
            const beta = request.headers['anthropic-beta'];
            if (typeof beta === 'string' && beta.length <= 2048 && /^[a-zA-Z0-9, _-]+$/.test(beta))
              headers['anthropic-beta'] = beta;
            return this.inferenceNetwork.fetch(url, {
              method: 'POST',
              body,
              headers,
              credentials: 'omit',
              redirect: 'error',
              signal,
            });
          };
          let upstream = await send();
          if (upstream.status === 401 && !credential.provider.startsWith('glm-')) {
            await upstream.body?.cancel();
            credential = await this.credential(slot.id, credential.accessToken);
            upstream = await send();
          }
          if (!upstream.ok) {
            await upstream.body?.cancel();
            if (upstream.status === 401) this.rejected.add(slot.id);
            replyError(
              response,
              [400, 401, 402, 403, 404, 429].includes(upstream.status) ? upstream.status : 502,
            );
            return;
          }
          const type = upstream.headers.get('content-type') ?? '';
          if (
            !upstream.body ||
            (!type.includes('application/json') && !type.includes('text/event-stream'))
          ) {
            await upstream.body?.cancel();
            replyError(response, 502);
            return;
          }
          response.writeHead(upstream.status, {
            'Content-Type': type.includes('text/event-stream')
              ? 'text/event-stream'
              : 'application/json',
            'Cache-Control': 'no-store',
          });
          await pipeline(
            Readable.fromWeb(upstream.body as import('node:stream/web').ReadableStream<Uint8Array>),
            response,
            { signal },
          );
        },
        signal,
      );
    } catch (error) {
      replyError(response, error instanceof SubscriptionError ? error.status : 502);
    } finally {
      this.requests -= 1;
      response.removeListener('close', abort);
      request.removeListener('aborted', abort);
    }
  }

  public shutdown(): void {
    this.lifetime.abort();
    this.server?.closeAllConnections();
    this.server?.close();
  }

  public async shutdownForQuit(): Promise<void> {
    this.shutdown();
    await this.starting?.catch(() => undefined);
    await Promise.allSettled(this.refreshes.values());
  }
}
