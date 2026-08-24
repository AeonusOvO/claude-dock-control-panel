/* eslint-disable max-lines-per-function -- The fetch adapter is one cancellation/cleanup state machine; splitting its event handlers would duplicate mutable transport ownership. */
import type { Readable } from 'node:stream';
import type {
  AuthInfo,
  ClientRequest,
  ClientRequestConstructorOptions,
  IncomingMessage,
  Session,
} from 'electron';
import type {
  ApplicationEndpointRequest,
  ApplicationEndpointResponse,
} from './provider-connectivity-probe';

export type ElectronRequestFactory = (options: ClientRequestConstructorOptions) => ClientRequest;

export interface ElectronProxyCredentials {
  readonly password: string;
  readonly username: string;
}

export interface ElectronProxyCredentialContext {
  readonly authInfo: AuthInfo;
  readonly requestUrl: URL;
  readonly session: Session;
}

export type ElectronProxyCredentialResolver = (
  context: ElectronProxyCredentialContext,
) => ElectronProxyCredentials | undefined;

export interface ElectronRedirectContext {
  readonly currentUrl: URL;
  readonly initialUrl: URL;
  readonly method: string;
  readonly statusCode: number;
  readonly targetUrl: URL;
}

export type ElectronRedirectPolicy = (context: ElectronRedirectContext) => void;

export interface ElectronSessionRequestAdapterOptions {
  readonly authorizeRedirect?: ElectronRedirectPolicy;
  readonly requestFactory: ElectronRequestFactory;
  readonly resolveProxyCredentials: ElectronProxyCredentialResolver;
  readonly session: Session;
}

export interface ElectronApplicationRequestOptions {
  readonly createRedirectFetch?: (authorizeRedirect: ElectronRedirectPolicy) => typeof fetch;
  readonly fetch: (input: string, init?: RequestInit) => Promise<Response>;
}

const DEFAULT_TIMEOUT_MS = 8_000;
const REQUEST_CLEANUP_BUDGET_MS = 5_000;
const MAX_FETCH_REDIRECTS = 20;
const NULL_BODY_STATUSES = new Set([101, 204, 205, 304]);
const normalizedDomain = (value: string): string => value.trim().toLowerCase().replace(/\.$/, '');
const domainAllowsHost = (domain: string, host: string): boolean =>
  host === domain || host.endsWith(`.${domain}`);
const SUPPORTED_REQUEST_INIT_KEYS = new Set([
  'body',
  'cache',
  'credentials',
  'duplex',
  'headers',
  'integrity',
  'keepalive',
  'method',
  'mode',
  'priority',
  'redirect',
  'referrer',
  'referrerPolicy',
  'signal',
  'window',
]);

type ElectronIncomingMessage = IncomingMessage & Pick<Readable, 'pause' | 'resume'>;
type ElectronRequestPriority = NonNullable<ClientRequestConstructorOptions['priority']>;

const abortReason = (signal: AbortSignal): Error =>
  signal.reason instanceof Error
    ? signal.reason
    : new DOMException('This operation was aborted', 'AbortError');

const headersFromRecord = (record: Record<string, string | string[]>): Headers => {
  const headers = new Headers();
  for (const [name, value] of Object.entries(record)) {
    for (const item of Array.isArray(value) ? value : [value]) {
      headers.append(name, item);
    }
  }
  return headers;
};

const headersFromResponse = (response: IncomingMessage): Headers => {
  const rawHeaders = response.rawHeaders ?? [];
  if (rawHeaders.length > 0) {
    const headers = new Headers();
    for (let index = 0; index + 1 < rawHeaders.length; index += 2) {
      headers.append(rawHeaders[index] ?? '', rawHeaders[index + 1] ?? '');
    }
    return headers;
  }
  return headersFromRecord(response.headers);
};

const requestHeaders = (request: Request): Record<string, string> => {
  const headers: Record<string, string> = {};
  request.headers.forEach((value, name) => {
    headers[name] = value;
  });
  if (request.referrer && request.referrer !== 'about:client' && !request.headers.has('referer')) {
    headers.referer = request.referrer;
  }
  return headers;
};

const responseWithUrl = (
  body: BodyInit | null,
  init: ResponseInit,
  url: string,
  redirected: boolean,
): Response => {
  const response = new Response(body, init);
  Object.defineProperties(response, {
    redirected: { configurable: true, enumerable: true, value: redirected },
    url: { configurable: true, enumerable: true, value: url },
  });
  return response;
};

const assertSupportedRequest = (input: RequestInfo | URL, init?: RequestInit): Request => {
  if (init) {
    for (const key of Object.keys(init)) {
      if (!SUPPORTED_REQUEST_INIT_KEYS.has(key)) {
        throw new TypeError(`Electron 请求适配器不支持 RequestInit.${key}，已取消请求。`);
      }
    }
  }
  const request = new Request(input, init);
  if (request.integrity) {
    throw new TypeError('Electron 请求适配器无法安全执行 Subresource Integrity，已取消请求。');
  }
  if (request.mode === 'navigate' || request.mode === 'no-cors') {
    throw new TypeError(`Electron 请求适配器无法安全表示 ${request.mode} 模式，已取消请求。`);
  }
  const target = new URL(request.url);
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    throw new TypeError(`Electron 请求适配器不支持 ${target.protocol} 请求。`);
  }
  return request;
};

const requestPriority = (init?: RequestInit): ElectronRequestPriority | undefined => {
  const value: unknown = (init as (RequestInit & { priority?: unknown }) | undefined)?.priority;
  if (value === undefined || value === 'auto') return undefined;
  if (value === 'high') return 'highest';
  if (value === 'low') return 'low';
  throw new TypeError(`Electron 请求适配器不支持 RequestInit.priority=${String(value)}。`);
};

const clientRequestOptions = (
  request: Request,
  initialUrl: URL,
  init: RequestInit | undefined,
  session: Session,
): ClientRequestConstructorOptions => ({
  cache: request.cache,
  credentials: request.credentials,
  headers: requestHeaders(request),
  method: request.method,
  origin: request.credentials === 'same-origin' ? initialUrl.origin : undefined,
  priority: requestPriority(init),
  redirect: 'manual',
  referrerPolicy: request.referrerPolicy,
  session,
  url: request.url,
});

const writeRequestChunk = (
  request: ClientRequest,
  chunk: Buffer,
  signal: AbortSignal,
): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    let settled = false;
    const settle = (error?: Error): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      if (error) reject(error);
      else resolve();
    };
    const onAbort = (): void => settle(abortReason(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
      return;
    }
    try {
      request.write(chunk, undefined, () => settle());
    } catch (error) {
      settle(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    if (signal.aborted) onAbort();
  });

const writeRequestBody = async (
  request: ClientRequest,
  body: ReadableStream<Uint8Array> | null,
  signal: AbortSignal,
  onReader: (reader: ReadableStreamDefaultReader<Uint8Array> | undefined) => void,
): Promise<void> => {
  signal.throwIfAborted();
  if (!body) {
    request.end();
    return;
  }
  request.chunkedEncoding = true;
  const reader = body.getReader();
  onReader(reader);
  try {
    while (true) {
      const chunk = await reader.read();
      signal.throwIfAborted();
      if (chunk.done) break;
      await writeRequestChunk(
        request,
        Buffer.from(chunk.value.buffer, chunk.value.byteOffset, chunk.value.byteLength),
        signal,
      );
    }
    signal.throwIfAborted();
    request.end();
  } finally {
    onReader(undefined);
    reader.releaseLock();
  }
};

/**
 * Fetch-compatible main-process transport backed only by Electron `net.request`.
 *
 * The explicit Session is part of every ClientRequest and proxy credentials are supplied only by
 * that request's `login` listener. Unsupported fetch features fail closed instead of falling back
 * to Session.fetch/net.fetch, which cannot attribute a main-process proxy challenge to a Session.
 */
export const createElectronSessionFetch = ({
  authorizeRedirect,
  requestFactory,
  resolveProxyCredentials,
  session,
}: ElectronSessionRequestAdapterOptions): typeof fetch => {
  const electronFetch: typeof fetch = async (input, init) => {
    const normalized = assertSupportedRequest(input, init);
    if (normalized.signal.aborted) {
      throw abortReason(normalized.signal);
    }

    return new Promise<Response>((resolve, reject) => {
      const initialUrl = new URL(normalized.url);
      const uploadController = new AbortController();
      let currentUrl = initialUrl.href;
      let redirected = false;
      let redirectCount = 0;
      let responseResolved = false;
      let responseBodyClosed = false;
      let responseBodyCancelled = false;
      let responseTerminal = false;
      let uploadTerminal = false;
      let requestClosed = false;
      let cleanupBarrierExpired = false;
      let cleanupTimer: NodeJS.Timeout | undefined;
      let pendingFailure: Error | undefined;
      let pendingResponse: Response | undefined;
      let uploadCancellation: Promise<void> | undefined;
      let requestBodyReader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      let responseController: ReadableStreamDefaultController<Uint8Array> | undefined;
      let detachIncomingListeners = (): void => undefined;
      let request: ClientRequest;
      const cleanupWaiters = new Set<() => void>();

      const settleCleanupWaitersIfReady = (): void => {
        if (!cleanupBarrierExpired && (!requestClosed || !uploadTerminal)) return;
        if (!cleanupBarrierExpired && cleanupTimer) {
          clearTimeout(cleanupTimer);
          cleanupTimer = undefined;
        }
        for (const resolveCleanup of cleanupWaiters) resolveCleanup();
        cleanupWaiters.clear();
      };
      const settlePendingTerminalIfReady = (): void => {
        if (
          (!pendingFailure && !pendingResponse) ||
          responseResolved ||
          (!cleanupBarrierExpired && (!requestClosed || !uploadTerminal))
        ) {
          return;
        }
        responseResolved = true;
        if (cleanupTimer) clearTimeout(cleanupTimer);
        normalized.signal.removeEventListener('abort', onSignalAbort);
        if (pendingFailure) {
          reject(pendingFailure);
        } else {
          resolve(pendingResponse!);
        }
      };
      const startCleanupBarrier = (): void => {
        if (cleanupTimer) return;
        cleanupTimer = setTimeout(() => {
          cleanupBarrierExpired = true;
          if (pendingResponse && !pendingFailure) {
            pendingFailure = new TypeError('Network request cleanup timed out');
            pendingResponse = undefined;
          }
          settlePendingTerminalIfReady();
          settleCleanupWaitersIfReady();
          if (responseTerminal) {
            normalized.signal.removeEventListener('abort', onSignalAbort);
          }
        }, REQUEST_CLEANUP_BUDGET_MS);
        cleanupTimer.unref();
      };
      const waitForTerminalCleanup = (): Promise<void> => {
        if (cleanupBarrierExpired || (requestClosed && uploadTerminal)) {
          return Promise.resolve();
        }
        startCleanupBarrier();
        return new Promise<void>((resolveCleanup) => {
          cleanupWaiters.add(resolveCleanup);
          settleCleanupWaitersIfReady();
        });
      };
      const cleanupAbortListenerIfTerminal = (): void => {
        if (responseTerminal && uploadTerminal && !pendingFailure && !pendingResponse) {
          normalized.signal.removeEventListener('abort', onSignalAbort);
        }
      };
      const markResponseTerminal = (): void => {
        responseTerminal = true;
        cleanupAbortListenerIfTerminal();
      };
      const markUploadTerminal = (): void => {
        uploadTerminal = true;
        cleanupAbortListenerIfTerminal();
        settlePendingTerminalIfReady();
        settleCleanupWaitersIfReady();
      };
      const cancelUpload = (error: Error): void => {
        if (!uploadController.signal.aborted) {
          uploadController.abort(error);
        }
        if (uploadCancellation || uploadTerminal) return;
        try {
          const cancellation = requestBodyReader
            ? requestBodyReader.cancel(error)
            : normalized.body?.cancel(error);
          if (cancellation) {
            uploadCancellation = cancellation.catch(() => undefined);
          }
        } catch {
          // The transport stop reason remains authoritative when producer cancellation fails.
        }
      };
      const fail = (error: Error): void => {
        cancelUpload(error);
        markResponseTerminal();
        if (!responseResolved) {
          if (!pendingFailure) {
            pendingFailure = error;
            pendingResponse = undefined;
            startCleanupBarrier();
          }
          settlePendingTerminalIfReady();
          return;
        }
        if (responseController && !responseBodyClosed && !responseBodyCancelled) {
          responseBodyClosed = true;
          responseController.error(error);
        }
      };
      const abortRequest = (error: Error): void => {
        fail(error);
        try {
          request.abort();
        } catch {
          // The original transport error remains authoritative.
        }
      };
      const onSignalAbort = (): void => {
        abortRequest(abortReason(normalized.signal));
      };

      try {
        request = requestFactory(clientRequestOptions(normalized, initialUrl, init, session));
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
        return;
      }

      const retainLateIncomingErrorSink = (incoming: ElectronIncomingMessage): void => {
        incoming.on('error', () => undefined);
        try {
          incoming.resume();
        } catch {
          // The request abort/close path remains responsible for transport cleanup.
        }
      };

      const onLogin = (
        authInfo: AuthInfo,
        callback: (username?: string, password?: string) => void,
      ): void => {
        if (responseTerminal || normalized.signal.aborted) {
          callback();
          return;
        }
        if (!authInfo.isProxy) {
          callback();
          return;
        }
        let credentials: ElectronProxyCredentials | undefined;
        try {
          credentials = resolveProxyCredentials({
            authInfo,
            requestUrl: new URL(currentUrl),
            session,
          });
        } catch {
          credentials = undefined;
        }
        if (!credentials) {
          callback();
          return;
        }
        callback(credentials.username, credentials.password);
      };
      const onRedirect = (
        statusCode: number,
        method: string,
        redirectUrl: string,
        responseHeaders: Record<string, string[]>,
      ): void => {
        if (responseTerminal || normalized.signal.aborted) return;
        let target: URL;
        try {
          target = new URL(redirectUrl, currentUrl);
        } catch {
          abortRequest(new TypeError('Invalid redirect URL'));
          return;
        }
        if (normalized.mode === 'same-origin' && target.origin !== initialUrl.origin) {
          abortRequest(new TypeError('Cross-origin redirect violates same-origin request mode'));
          return;
        }
        if (normalized.redirect === 'error') {
          abortRequest(new TypeError('Redirect was cancelled'));
          return;
        }
        if (normalized.redirect === 'manual') {
          cancelUpload(new TypeError('Redirect body upload was cancelled'));
          pendingResponse = responseWithUrl(
            null,
            { headers: headersFromRecord(responseHeaders), status: statusCode },
            currentUrl,
            false,
          );
          markResponseTerminal();
          startCleanupBarrier();
          // Electron cancels a manual redirect when followRedirect() is not called. Calling
          // abort() here races that built-in terminal path and can replace the valid 3xx response
          // with "Redirect was cancelled" before the caller has inspected Location. The adapter
          // keeps the already-captured 3xx response authoritative while abort() only accelerates
          // cleanup of the unused redirect request.
          try {
            request.abort();
          } catch (error) {
            fail(error instanceof Error ? error : new Error(String(error)));
          }
          settlePendingTerminalIfReady();
          return;
        }
        redirectCount += 1;
        if (redirectCount > MAX_FETCH_REDIRECTS) {
          abortRequest(new TypeError(`Redirect count exceeded ${MAX_FETCH_REDIRECTS}`));
          return;
        }
        try {
          authorizeRedirect?.({
            currentUrl: new URL(currentUrl),
            initialUrl,
            method,
            statusCode,
            targetUrl: target,
          });
        } catch (error) {
          abortRequest(error instanceof Error ? error : new Error(String(error)));
          return;
        }
        const previousUrl = currentUrl;
        const wasRedirected = redirected;
        redirected = true;
        currentUrl = target.href;
        try {
          request.followRedirect();
        } catch (error) {
          currentUrl = previousUrl;
          redirected = wasRedirected;
          abortRequest(error instanceof Error ? error : new Error(String(error)));
        }
      };
      const onResponse = (message: IncomingMessage): void => {
        const incoming = message as ElectronIncomingMessage;
        if (responseResolved || responseTerminal || normalized.signal.aborted) {
          retainLateIncomingErrorSink(incoming);
          return;
        }
        if (incoming.statusCode < 200 || incoming.statusCode > 599) {
          abortRequest(
            new TypeError(`Electron 请求适配器无法表示 HTTP ${incoming.statusCode} 响应。`),
          );
          return;
        }
        const hasBody =
          normalized.method !== 'HEAD' && !NULL_BODY_STATUSES.has(incoming.statusCode);
        let terminalErrorSinkRetained = false;
        const retainTerminalErrorSink = (): void => {
          if (terminalErrorSinkRetained) return;
          terminalErrorSinkRetained = true;
          incoming.on('error', () => undefined);
        };
        const onData = (chunk: Buffer): void => {
          if (responseBodyClosed || responseBodyCancelled) return;
          responseController?.enqueue(new Uint8Array(chunk));
          if ((responseController?.desiredSize ?? 1) <= 0) incoming.pause();
        };
        const onEnd = (): void => {
          if (responseBodyCancelled) return;
          if (!responseBodyClosed) {
            responseBodyClosed = true;
            responseController?.close();
            markResponseTerminal();
          }
          detachIncomingDataListeners();
        };
        const onIncomingAborted = (): void => {
          detachIncomingDataListeners();
          retainTerminalErrorSink();
          abortRequest(new DOMException('The response was aborted', 'AbortError'));
        };
        const onIncomingError = (error: Error): void => {
          detachIncomingDataListeners();
          retainTerminalErrorSink();
          abortRequest(error);
        };
        const detachIncomingDataListeners = (): void => {
          incoming.removeListener('data', onData);
          incoming.removeListener('end', onEnd);
          incoming.removeListener('aborted', onIncomingAborted);
        };
        detachIncomingListeners = (): void => {
          detachIncomingDataListeners();
          incoming.removeListener('error', onIncomingError);
          if (!responseBodyClosed && !responseBodyCancelled) {
            retainTerminalErrorSink();
          }
          detachIncomingListeners = () => undefined;
        };
        const body = hasBody
          ? new ReadableStream<Uint8Array>({
              cancel: (reason) => {
                if (responseBodyClosed || responseBodyCancelled) return;
                responseBodyCancelled = true;
                const error =
                  reason instanceof Error
                    ? reason
                    : new DOMException('Body cancelled', 'AbortError');
                cancelUpload(error);
                markResponseTerminal();
                detachIncomingDataListeners();
                retainTerminalErrorSink();
                try {
                  request.abort();
                } catch (abortError) {
                  fail(abortError instanceof Error ? abortError : new Error(String(abortError)));
                }
                return waitForTerminalCleanup();
              },
              pull: () => {
                if (!responseBodyClosed && !responseBodyCancelled) incoming.resume();
              },
              start: (controller) => {
                responseController = controller;
              },
            })
          : null;
        incoming.on('data', onData);
        incoming.on('end', onEnd);
        incoming.on('aborted', onIncomingAborted);
        incoming.on('error', onIncomingError);
        if (!uploadTerminal) {
          cancelUpload(
            new DOMException('The response arrived before upload completion', 'AbortError'),
          );
        }
        const fetchResponse = responseWithUrl(
          body,
          {
            headers: headersFromResponse(incoming),
            status: incoming.statusCode,
            statusText: incoming.statusMessage,
          },
          currentUrl,
          redirected,
        );
        if (hasBody) {
          responseResolved = true;
          resolve(fetchResponse);
        } else {
          pendingResponse = fetchResponse;
          responseBodyClosed = true;
          markResponseTerminal();
          startCleanupBarrier();
          incoming.resume();
          settlePendingTerminalIfReady();
        }
      };
      const onRequestError = (error: Error): void => {
        if (pendingResponse && responseTerminal) {
          cancelUpload(error);
          settlePendingTerminalIfReady();
          return;
        }
        fail(error);
      };
      const onRequestAbort = (): void => {
        cancelUpload(new DOMException('The request was aborted', 'AbortError'));
        if (!responseTerminal) {
          fail(new DOMException('The request was aborted', 'AbortError'));
        }
      };
      const detachRequestListeners = (): void => {
        request.removeListener('login', onLogin);
        request.removeListener('redirect', onRedirect);
        request.removeListener('response', onResponse);
        request.removeListener('error', onRequestError);
        request.removeListener('abort', onRequestAbort);
        request.removeListener('close', onRequestClose);
      };
      const onRequestClose = (): void => {
        requestClosed = true;
        detachRequestListeners();
        detachIncomingListeners();
        cancelUpload(new TypeError('Network request closed'));
        if (!responseResolved && !pendingResponse) {
          fail(new TypeError('Network request closed before a response was received'));
        } else if (responseController && !responseBodyClosed && !responseBodyCancelled) {
          fail(new TypeError('Network response closed before the body completed'));
        }
        settlePendingTerminalIfReady();
        settleCleanupWaitersIfReady();
      };

      request.on('login', onLogin);
      request.on('redirect', onRedirect);
      request.on('response', onResponse);
      request.on('error', onRequestError);
      request.on('abort', onRequestAbort);
      request.on('close', onRequestClose);
      normalized.signal.addEventListener('abort', onSignalAbort, { once: true });
      if (normalized.signal.aborted) onSignalAbort();

      void writeRequestBody(request, normalized.body, uploadController.signal, (reader) => {
        requestBodyReader = reader;
      })
        .catch((error: unknown) => {
          if (!responseResolved && !responseTerminal) {
            abortRequest(error instanceof Error ? error : new Error(String(error)));
          }
        })
        .finally(async () => {
          await uploadCancellation;
          markUploadTerminal();
        });
    });
  };
  return electronFetch;
};

/** Metadata-only endpoint request used by preflight, with HTTPS redirect validation. */
export const createElectronApplicationRequest = (
  options: ElectronApplicationRequestOptions,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): ApplicationEndpointRequest => {
  return async (url, signal, redirectAuthority): Promise<ApplicationEndpointResponse> => {
    const controller = new AbortController();
    const onSignalAbort = (): void => controller.abort(signal?.reason);
    if (signal?.aborted) {
      onSignalAbort();
    } else {
      signal?.addEventListener('abort', onSignalAbort, { once: true });
    }
    const timer = setTimeout(() => controller.abort(new Error('连接超时。')), timeoutMs);
    timer.unref();
    try {
      const redirects: ApplicationEndpointResponse['redirects'] = [];
      const allowedDomains = (redirectAuthority?.allowedDomains ?? [])
        .map(normalizedDomain)
        .filter(Boolean);
      const redirectFetch =
        redirectAuthority && options.createRedirectFetch
          ? options.createRedirectFetch(({ statusCode, targetUrl }) => {
              if (targetUrl.protocol !== 'https:') {
                throw new TypeError('Redirect target must use HTTPS');
              }
              const host = normalizedDomain(targetUrl.hostname);
              if (!allowedDomains.some((domain) => domainAllowsHost(domain, host))) {
                throw new TypeError(`Redirect target is not allowed: ${host}`);
              }
              redirects.push({ host, statusCode });
            })
          : undefined;
      const requestInit: RequestInit = {
        cache: 'no-store',
        credentials: 'omit',
        method: 'GET',
        redirect: 'manual',
        signal: controller.signal,
      };
      /*
       * Keep Session.fetch as the primary transport because it is reliable on affected Windows/TUN
       * paths. Only a confirmed manual redirect switches to the bound ClientRequest adapter, where
       * Electron exposes each hop and validation runs synchronously before followRedirect().
       */
      let response: Response;
      try {
        response = await options.fetch(url, requestInit);
      } catch (error) {
        if (!redirectFetch || !/redirect was cancelled/i.test(String(error))) throw error;
        response = await redirectFetch(url, { ...requestInit, redirect: 'follow' });
      }
      if (response.status >= 300 && response.status < 400 && redirectFetch) {
        await response.body?.cancel();
        controller.signal.throwIfAborted();
        response = await redirectFetch(url, { ...requestInit, redirect: 'follow' });
      }
      controller.signal.throwIfAborted();
      await response.body?.cancel();
      controller.signal.throwIfAborted();
      return {
        contentType: response.headers.get('content-type') ?? '',
        redirects,
        status: response.status,
      };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onSignalAbort);
    }
  };
};
