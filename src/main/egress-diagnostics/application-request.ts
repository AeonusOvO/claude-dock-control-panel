import { performance } from 'node:perf_hooks';
import type { Session } from 'electron';
import type {
  EgressDiagnosticIssueCode,
  EgressEndpointId,
  EgressRateLimitMetadata,
} from '../../shared/contracts/egress-diagnostics';
import {
  createElectronSessionFetch,
  type ElectronProxyCredentialResolver,
  type ElectronRequestFactory,
} from '../network/electron-request';
import { normalizeEgressAddress } from './address';
import {
  getEgressEndpoint,
  isEgressEndpointId,
  type EgressEndpointDefinition,
} from './provider-registry';

const DEFAULT_DEADLINE_MS = 8_000;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_CREDENTIAL_LENGTH = 4_096;
const MAX_METADATA_HEADER_LENGTH = 128;

export interface EgressApplicationRequestOptions {
  readonly deadlineMs?: number;
  readonly monotonicNow?: () => number;
  readonly now?: () => number;
  readonly requestFactory: ElectronRequestFactory;
  readonly resolveProxyCredentials: ElectronProxyCredentialResolver;
  readonly session: Session;
}

interface EgressRequestBase {
  readonly signal?: AbortSignal;
}

export type EgressApplicationRequestInput =
  | (EgressRequestBase & {
      readonly endpointId: 'public-address-v4' | 'public-address-v6';
    })
  | (EgressRequestBase & {
      readonly credential: string;
      readonly endpointId: 'ipinfo-max-v4' | 'ipinfo-max-v6';
    })
  | (EgressRequestBase & {
      readonly address: string;
      readonly credential: string;
      readonly endpointId: 'abuseipdb-check';
      readonly maxAgeInDays: number;
    });

export interface EgressApplicationResponse {
  readonly body: Uint8Array;
  readonly contentType: string;
  readonly endpointId: EgressEndpointId;
  readonly rateLimit: EgressRateLimitMetadata;
  readonly status: number;
}

export type EgressApplicationRequest = (
  input: EgressApplicationRequestInput,
) => Promise<EgressApplicationResponse>;

type ElectronSessionFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

const ERROR_MESSAGES: Readonly<Partial<Record<EgressDiagnosticIssueCode, string>>> = Object.freeze({
  'body-too-large': 'The provider response exceeded its decoded-byte limit.',
  cancelled: 'The egress diagnostic request was cancelled.',
  'content-type-mismatch': 'The provider returned an unexpected content type.',
  'deadline-exceeded': 'The egress diagnostic request exceeded its total deadline.',
  'invalid-configuration': 'The main-process provider request configuration is invalid.',
  'malformed-response': 'The provider returned malformed response metadata.',
  'rate-limited': 'The provider rate limit was reached.',
  'redirect-rejected': 'The provider redirect was rejected.',
  'status-mismatch': 'The provider returned an unexpected HTTP status.',
  'transport-failed': 'The Electron application-session request failed.',
});

export class EgressApplicationRequestError extends Error {
  public readonly code: EgressDiagnosticIssueCode;
  public readonly endpointId?: EgressEndpointId;
  public readonly rateLimit: EgressRateLimitMetadata;
  public readonly status?: number;

  public constructor(
    code: EgressDiagnosticIssueCode,
    endpointId?: EgressEndpointId,
    options: { rateLimit?: EgressRateLimitMetadata; status?: number } = {},
  ) {
    super(ERROR_MESSAGES[code] ?? 'The egress diagnostic request failed.');
    this.name = 'EgressApplicationRequestError';
    this.code = code;
    this.endpointId = endpointId;
    this.rateLimit = options.rateLimit ?? {};
    this.status = options.status;
  }
}

interface RequestDeadline {
  readonly assertActive: () => void;
  readonly signal: AbortSignal;
  readonly stop: () => void;
}

const monotonicTimestamp = (clock: () => number): number => {
  try {
    return clock();
  } catch {
    return Number.NaN;
  }
};

const createDeadline = (
  endpointId: EgressEndpointId,
  deadlineMs: number,
  monotonicNow: () => number,
  externalSignal?: AbortSignal,
): RequestDeadline => {
  const controller = new AbortController();
  const startedAt = monotonicTimestamp(monotonicNow);
  const abortWith = (code: 'cancelled' | 'deadline-exceeded'): void => {
    if (!controller.signal.aborted) {
      controller.abort(new EgressApplicationRequestError(code, endpointId));
    }
  };
  const cancel = (): void => abortWith('cancelled');
  if (externalSignal?.aborted) cancel();
  else externalSignal?.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(() => abortWith('deadline-exceeded'), deadlineMs);
  timer.unref?.();
  const assertActive = (): void => {
    if (controller.signal.aborted) throw abortError(controller.signal, endpointId);
    const current = monotonicTimestamp(monotonicNow);
    if (
      !Number.isFinite(startedAt) ||
      !Number.isFinite(current) ||
      current < startedAt ||
      current - startedAt >= deadlineMs
    ) {
      abortWith('deadline-exceeded');
      throw abortError(controller.signal, endpointId);
    }
  };
  return {
    assertActive,
    signal: controller.signal,
    stop: () => {
      clearTimeout(timer);
      externalSignal?.removeEventListener('abort', cancel);
    },
  };
};

const abortError = (signal: AbortSignal, endpointId: EgressEndpointId): Error =>
  signal.reason instanceof EgressApplicationRequestError
    ? signal.reason
    : new EgressApplicationRequestError('cancelled', endpointId);

const raceAbort = async <T>(
  operation: Promise<T>,
  signal: AbortSignal,
  endpointId: EgressEndpointId,
): Promise<T> => {
  if (signal.aborted) throw abortError(signal, endpointId);
  let onAbort: (() => void) | undefined;
  const cancelled = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(abortError(signal, endpointId));
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([operation, cancelled]);
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
};

const validateCredential = (credential: unknown, endpointId: EgressEndpointId): string => {
  if (
    typeof credential !== 'string' ||
    credential.length === 0 ||
    credential.length > MAX_CREDENTIAL_LENGTH ||
    /[\r\n]/.test(credential)
  ) {
    throw new EgressApplicationRequestError('invalid-configuration', endpointId);
  }
  return credential;
};

const fixedTarget = (
  input: EgressApplicationRequestInput,
  definition: EgressEndpointDefinition,
): { headers: Headers; target: URL } => {
  const target = new URL(definition.url);
  if (
    target.protocol !== 'https:' ||
    target.username !== '' ||
    target.password !== '' ||
    target.origin === 'null'
  ) {
    throw new EgressApplicationRequestError('invalid-configuration', input.endpointId);
  }
  const headers = new Headers({ accept: 'application/json' });
  try {
    if (input.endpointId === 'ipinfo-max-v4' || input.endpointId === 'ipinfo-max-v6') {
      headers.set(
        'authorization',
        `Bearer ${validateCredential(input.credential, input.endpointId)}`,
      );
    } else if (input.endpointId === 'abuseipdb-check') {
      headers.set('key', validateCredential(input.credential, input.endpointId));
      const address = normalizeEgressAddress(input.address).address;
      if (
        !Number.isInteger(input.maxAgeInDays) ||
        input.maxAgeInDays < 1 ||
        input.maxAgeInDays > 365
      ) {
        throw new EgressApplicationRequestError('invalid-configuration', input.endpointId);
      }
      target.searchParams.set('ipAddress', address);
      target.searchParams.set('maxAgeInDays', String(input.maxAgeInDays));
    }
  } catch (error) {
    if (error instanceof EgressApplicationRequestError) throw error;
    throw new EgressApplicationRequestError('invalid-configuration', input.endpointId);
  }
  return { headers, target };
};

const boundedHeader = (headers: Headers, name: string): string | undefined => {
  const value = headers.get(name)?.trim();
  return value && value.length <= MAX_METADATA_HEADER_LENGTH ? value : undefined;
};

const unsignedInteger = (value: string | undefined, maximum: number): number | undefined => {
  if (!value || !/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed <= maximum ? parsed : undefined;
};

const rateLimitMetadata = (headers: Headers, now: number): EgressRateLimitMetadata => {
  const maximumRetrySeconds = 365 * 24 * 60 * 60;
  const retryAfter = boundedHeader(headers, 'retry-after');
  const retrySeconds = unsignedInteger(retryAfter, maximumRetrySeconds);
  const retryDate = retrySeconds === undefined && retryAfter ? Date.parse(retryAfter) : Number.NaN;
  const retryDateSeconds = Number.isFinite(retryDate)
    ? Math.max(0, Math.ceil((retryDate - now) / 1_000))
    : undefined;
  const resetSeconds = unsignedInteger(
    boundedHeader(headers, 'x-ratelimit-reset'),
    Math.floor(8_640_000_000_000_000 / 1_000),
  );
  return {
    limit: unsignedInteger(boundedHeader(headers, 'x-ratelimit-limit'), 1_000_000_000),
    remaining: unsignedInteger(boundedHeader(headers, 'x-ratelimit-remaining'), 1_000_000_000),
    resetAt: resetSeconds === undefined ? undefined : resetSeconds * 1_000,
    retryAfterSeconds:
      retrySeconds ??
      (retryDateSeconds !== undefined && retryDateSeconds <= maximumRetrySeconds
        ? retryDateSeconds
        : undefined),
  };
};

const cancelResponse = (response: Response): void => {
  if (response.body && !response.body.locked) {
    void response.body.cancel().catch(() => undefined);
  }
};

const assertResponseActive = (response: Response, deadline: RequestDeadline): void => {
  try {
    deadline.assertActive();
  } catch (error) {
    cancelResponse(response);
    throw error;
  }
};

const responseMediaType = (response: Response): string =>
  (response.headers.get('content-type') ?? '').split(';', 1)[0]?.trim().toLowerCase() ?? '';

const readBoundedBody = async (
  response: Response,
  maximumBytes: number,
  deadline: RequestDeadline,
  endpointId: EgressEndpointId,
): Promise<Uint8Array> => {
  assertResponseActive(response, deadline);
  if (!response.body) {
    throw new EgressApplicationRequestError('malformed-response', endpointId);
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      deadline.assertActive();
      const chunk = await raceAbort(reader.read(), deadline.signal, endpointId);
      deadline.assertActive();
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > maximumBytes) {
        void reader.cancel().catch(() => undefined);
        throw new EgressApplicationRequestError('body-too-large', endpointId);
      }
      chunks.push(chunk.value);
    }
  } catch (error) {
    void reader.cancel().catch(() => undefined);
    if (error instanceof EgressApplicationRequestError) throw error;
    if (deadline.signal.aborted) throw abortError(deadline.signal, endpointId);
    throw new EgressApplicationRequestError('transport-failed', endpointId);
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  deadline.assertActive();
  return body;
};

const redirectTarget = (
  response: Response,
  current: URL,
  definition: EgressEndpointDefinition,
  redirectCount: number,
): URL => {
  cancelResponse(response);
  const location = response.headers.get('location');
  if (
    !location ||
    definition.credentialKind !== 'none' ||
    redirectCount >= definition.maxRedirects
  ) {
    throw new EgressApplicationRequestError('redirect-rejected', definition.id);
  }
  let target: URL;
  try {
    target = new URL(location, current);
  } catch {
    throw new EgressApplicationRequestError('redirect-rejected', definition.id);
  }
  if (
    target.protocol !== 'https:' ||
    target.username !== '' ||
    target.password !== '' ||
    target.origin !== current.origin
  ) {
    throw new EgressApplicationRequestError('redirect-rejected', definition.id);
  }
  return target;
};

const validateFinalResponse = (
  response: Response,
  current: URL,
  definition: EgressEndpointDefinition,
  now: number,
): { contentType: string; rateLimit: EgressRateLimitMetadata } => {
  const rateLimit = rateLimitMetadata(response.headers, now);
  if (response.redirected || response.url !== current.href) {
    cancelResponse(response);
    throw new EgressApplicationRequestError('malformed-response', definition.id, {
      rateLimit,
      status: response.status,
    });
  }
  if (response.status !== 200) {
    cancelResponse(response);
    throw new EgressApplicationRequestError(
      response.status === 429 ? 'rate-limited' : 'status-mismatch',
      definition.id,
      { rateLimit, status: response.status },
    );
  }
  const contentType = responseMediaType(response);
  if (!definition.expectedMediaTypes.includes(contentType)) {
    cancelResponse(response);
    throw new EgressApplicationRequestError('content-type-mismatch', definition.id, {
      rateLimit,
      status: response.status,
    });
  }
  return { contentType, rateLimit };
};

const requestEndpoint = async (
  electronFetch: ElectronSessionFetch,
  input: EgressApplicationRequestInput,
  deadlineMs: number,
  monotonicNow: () => number,
  now: () => number,
): Promise<EgressApplicationResponse> => {
  const definition = getEgressEndpoint(input.endpointId);
  const configured = fixedTarget(input, definition);
  const deadline = createDeadline(input.endpointId, deadlineMs, monotonicNow, input.signal);
  let current = configured.target;
  let redirectCount = 0;
  try {
    while (true) {
      deadline.assertActive();
      let response: Response;
      try {
        response = await raceAbort(
          electronFetch(current, {
            cache: 'no-store',
            credentials: 'omit',
            headers: configured.headers,
            method: 'GET',
            redirect: 'manual',
            signal: deadline.signal,
          }),
          deadline.signal,
          input.endpointId,
        );
      } catch (error) {
        if (error instanceof EgressApplicationRequestError) throw error;
        if (deadline.signal.aborted) throw abortError(deadline.signal, input.endpointId);
        if (error instanceof TypeError && error.message === 'Invalid redirect URL') {
          throw new EgressApplicationRequestError('redirect-rejected', input.endpointId);
        }
        throw new EgressApplicationRequestError('transport-failed', input.endpointId);
      }
      assertResponseActive(response, deadline);
      if (REDIRECT_STATUSES.has(response.status)) {
        current = redirectTarget(response, current, definition, redirectCount);
        redirectCount += 1;
        deadline.assertActive();
        continue;
      }
      const validated = validateFinalResponse(response, current, definition, now());
      assertResponseActive(response, deadline);
      const body = await readBoundedBody(
        response,
        definition.maxDecodedBytes,
        deadline,
        input.endpointId,
      );
      deadline.assertActive();
      return {
        body,
        contentType: validated.contentType,
        endpointId: input.endpointId,
        rateLimit: validated.rateLimit,
        status: response.status,
      };
    }
  } finally {
    deadline.stop();
  }
};

export const createEgressApplicationRequest = (
  options: EgressApplicationRequestOptions,
): EgressApplicationRequest => {
  const deadlineMs = options.deadlineMs ?? DEFAULT_DEADLINE_MS;
  if (!Number.isFinite(deadlineMs) || deadlineMs <= 0 || deadlineMs > 60_000) {
    throw new TypeError('The egress diagnostic deadline is invalid.');
  }
  const electronFetch = createElectronSessionFetch({
    requestFactory: options.requestFactory,
    resolveProxyCredentials: options.resolveProxyCredentials,
    session: options.session,
  });
  return async (input) => {
    const candidate: unknown = input;
    const endpointId =
      typeof candidate === 'object' && candidate !== null
        ? (candidate as { readonly endpointId?: unknown }).endpointId
        : undefined;
    if (!isEgressEndpointId(endpointId)) {
      throw new EgressApplicationRequestError('invalid-configuration');
    }
    return requestEndpoint(
      electronFetch,
      candidate as EgressApplicationRequestInput,
      deadlineMs,
      options.monotonicNow ?? (() => performance.now()),
      options.now ?? Date.now,
    );
  };
};
