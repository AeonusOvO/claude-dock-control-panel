import { randomBytes, randomUUID } from 'node:crypto';
import { createServer, type Server, type Socket } from 'node:net';
import type { ClaudePermissionDecision, ClaudePermissionRequestView } from '../shared/contracts';

const MAX_MESSAGE_BYTES = 64 * 1024;
const REQUEST_TIMEOUT_MS = 600_000;

interface PermissionWireRequest {
  launchGeneration: number;
  sessionId: string;
  suggestions?: unknown[];
  token: string;
  toolName: string;
}

interface QueuedRequest {
  expiresAt: number;
  rawSuggestions: unknown[];
  request: ClaudePermissionRequestView;
  socket: Socket;
  timeout: NodeJS.Timeout;
}

interface PermissionEndpoint {
  active?: QueuedRequest;
  launchGeneration: number;
  pipeName: string;
  queue: QueuedRequest[];
  server: Server;
  sessionId: string;
  token: string;
}

export interface ClaudePermissionEndpointView {
  pipeName: string;
  token: string;
}

const validWireRequest = (value: unknown): value is PermissionWireRequest => {
  if (!value || typeof value !== 'object') return false;
  const request = value as Partial<PermissionWireRequest>;
  return (
    typeof request.token === 'string' &&
    typeof request.sessionId === 'string' &&
    Number.isInteger(request.launchGeneration) &&
    typeof request.toolName === 'string' &&
    request.toolName.length > 0 &&
    request.toolName.length <= 120 &&
    (request.suggestions === undefined || Array.isArray(request.suggestions))
  );
};

const hookResponse = (
  decision: Exclude<ClaudePermissionDecision, { behavior: 'fallback' }>,
  suggestion?: unknown,
): string => {
  const hookDecision =
    decision.behavior === 'allow'
      ? {
          behavior: 'allow',
          ...(suggestion === undefined ? {} : { updatedPermissions: [suggestion] }),
        }
      : {
          behavior: 'deny',
          message: decision.message?.slice(0, 300) || '用户拒绝了这次权限请求。',
        };
  return JSON.stringify({
    hookSpecificOutput: {
      decision: hookDecision,
      hookEventName: 'PermissionRequest',
    },
  });
};

export class ClaudePermissionBridge {
  private readonly endpoints = new Map<string, PermissionEndpoint>();
  private readonly pending = new Map<string, QueuedRequest>();

  public constructor(
    private readonly onRequest: (request: ClaudePermissionRequestView) => boolean | void,
    private readonly ownsLaunch: (sessionId: string, launchGeneration: number) => boolean,
  ) {}

  public createEndpoint(sessionId: string, launchGeneration: number): ClaudePermissionEndpointView {
    this.closeSession(sessionId);
    const token = randomBytes(32).toString('base64url');
    const pipeName = `claudedock-permission-${process.pid}-${randomUUID()}`;
    const endpoint: PermissionEndpoint = {
      launchGeneration,
      pipeName,
      queue: [],
      server: createServer(),
      sessionId,
      token,
    };
    endpoint.server.on('connection', (socket) => this.receive(endpoint, socket));
    endpoint.server.on('error', () => this.closeEndpoint(endpoint));
    endpoint.server.listen(`\\\\.\\pipe\\${pipeName}`);
    endpoint.server.unref();
    this.endpoints.set(sessionId, endpoint);
    return { pipeName, token };
  }

  public respond(requestId: string, decision: ClaudePermissionDecision): boolean {
    const queued = this.pending.get(requestId);
    if (!queued) return false;
    const endpoint = this.endpoints.get(queued.request.sessionId);
    if (!endpoint || endpoint.active !== queued) return false;
    if (
      decision.behavior === 'fallback' ||
      !this.ownsLaunch(endpoint.sessionId, endpoint.launchGeneration)
    ) {
      this.finish(endpoint, queued);
      return true;
    }
    let suggestion: unknown;
    if (decision.behavior === 'allow' && decision.suggestionId) {
      const index = queued.request.suggestions.findIndex(
        (candidate) => candidate.id === decision.suggestionId,
      );
      if (index < 0) return false;
      suggestion = queued.rawSuggestions[index];
    }
    queued.socket.end(`${hookResponse(decision, suggestion)}\n`);
    this.finish(endpoint, queued, false);
    return true;
  }

  public closeLaunch(sessionId: string, launchGeneration: number): void {
    const endpoint = this.endpoints.get(sessionId);
    if (endpoint?.launchGeneration === launchGeneration) this.closeEndpoint(endpoint);
  }

  public closeSession(sessionId: string): void {
    const endpoint = this.endpoints.get(sessionId);
    if (endpoint) this.closeEndpoint(endpoint);
  }

  public shutdown(): void {
    for (const endpoint of [...this.endpoints.values()]) this.closeEndpoint(endpoint);
  }

  public fallbackPending(): void {
    for (const endpoint of this.endpoints.values()) {
      const requests = [...endpoint.queue, ...(endpoint.active ? [endpoint.active] : [])];
      endpoint.queue.length = 0;
      endpoint.active = undefined;
      for (const queued of requests) {
        clearTimeout(queued.timeout);
        this.pending.delete(queued.request.requestId);
        queued.socket.end();
      }
    }
  }

  private receive(endpoint: PermissionEndpoint, socket: Socket): void {
    socket.setEncoding('utf8');
    let buffer = '';
    const reject = (): void => {
      socket.end();
    };
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer, 'utf8') > MAX_MESSAGE_BYTES) {
        reject();
        return;
      }
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      socket.removeAllListeners('data');
      let parsed: unknown;
      try {
        parsed = JSON.parse(buffer.slice(0, newline));
      } catch {
        reject();
        return;
      }
      if (
        !validWireRequest(parsed) ||
        parsed.token !== endpoint.token ||
        parsed.sessionId !== endpoint.sessionId ||
        parsed.launchGeneration !== endpoint.launchGeneration ||
        this.endpoints.get(endpoint.sessionId) !== endpoint ||
        !this.ownsLaunch(endpoint.sessionId, endpoint.launchGeneration)
      ) {
        reject();
        return;
      }
      const rawSuggestions = (parsed.suggestions ?? []).slice(0, 20);
      const requestId = randomUUID();
      const expiresAt = Date.now() + REQUEST_TIMEOUT_MS;
      const request: ClaudePermissionRequestView = {
        description: `${parsed.toolName} 正在请求权限；具体工具输入保留在 Claude 原生终端中。`,
        expiresAt,
        requestId,
        sessionId: endpoint.sessionId,
        suggestions: rawSuggestions.map((_, index) => ({
          id: `${requestId}:${index}`,
          label: `保存 Claude 建议的权限范围 ${index + 1}`,
        })),
        toolName: parsed.toolName,
      };
      const queued = {
        expiresAt,
        rawSuggestions,
        request,
        socket,
        timeout: setTimeout(() => this.expire(endpoint, requestId), REQUEST_TIMEOUT_MS),
      };
      queued.timeout.unref();
      endpoint.queue.push(queued);
      this.dispatch(endpoint);
    });
    socket.on('error', () => {
      const active = endpoint.active;
      if (active?.socket === socket) this.finish(endpoint, active);
    });
  }

  private dispatch(endpoint: PermissionEndpoint): void {
    if (endpoint.active || this.endpoints.get(endpoint.sessionId) !== endpoint) return;
    const queued = endpoint.queue.shift();
    if (!queued) return;
    if (queued.expiresAt <= Date.now()) {
      clearTimeout(queued.timeout);
      queued.socket.end();
      this.dispatch(endpoint);
      return;
    }
    endpoint.active = queued;
    this.pending.set(queued.request.requestId, queued);
    if (this.onRequest(queued.request) === false) this.finish(endpoint, queued);
  }

  private expire(endpoint: PermissionEndpoint, requestId: string): void {
    const active = this.pending.get(requestId);
    if (active) {
      this.finish(endpoint, active);
      return;
    }
    const index = endpoint.queue.findIndex((queued) => queued.request.requestId === requestId);
    if (index >= 0) {
      const [queued] = endpoint.queue.splice(index, 1);
      queued?.socket.end();
    }
  }

  private finish(endpoint: PermissionEndpoint, queued: QueuedRequest, closeSocket = true): void {
    clearTimeout(queued.timeout);
    this.pending.delete(queued.request.requestId);
    if (closeSocket) queued.socket.end();
    if (endpoint.active === queued) endpoint.active = undefined;
    this.dispatch(endpoint);
  }

  private closeEndpoint(endpoint: PermissionEndpoint): void {
    if (this.endpoints.get(endpoint.sessionId) === endpoint) {
      this.endpoints.delete(endpoint.sessionId);
    }
    const requests = [...endpoint.queue, ...(endpoint.active ? [endpoint.active] : [])];
    endpoint.queue.length = 0;
    endpoint.active = undefined;
    for (const queued of requests) {
      clearTimeout(queued.timeout);
      this.pending.delete(queued.request.requestId);
      queued.socket.end();
    }
    endpoint.server.close();
  }
}
