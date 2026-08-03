import {
  app,
  protocol,
  session,
  webContents,
  type Event as ElectronEvent,
  type OnBeforeRequestListenerDetails,
  type OnCompletedListenerDetails,
  type OnErrorOccurredListenerDetails,
  type WebContents,
  type WebContentsWillFrameNavigateEventParams,
  type WebFrameMain,
} from 'electron';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type {
  ArtifactCreateResult,
  ArtifactNetworkLogEntry,
  ArtifactNetworkState,
} from '../shared/contracts';

const ARTIFACT_SCHEME = 'claudedock-artifact';
const MAX_ARTIFACT_HTML_BYTES = 2 * 1024 * 1024;
const MAX_NETWORK_LOG_ENTRIES = 500;
const ARTIFACT_ID_PATTERN = /^artifact-[0-9a-f-]{36}$/;

interface ArtifactRecord {
  artifactId: string;
  createdAt: number;
  html: string;
}

interface PendingNetworkRequest {
  artifactId: string;
  method: string;
  startedAt: number;
  url: string;
}

interface StoredArtifactSettings {
  allowNetwork: boolean;
  version: 1;
}

type NetworkLogListener = (entry: ArtifactNetworkLogEntry) => void;

const libraryFiles: Record<string, string[]> = {
  'd3.min.js': ['d3', 'dist', 'd3.min.js'],
  'katex.min.css': ['katex', 'dist', 'katex.min.css'],
  'katex.min.js': ['katex', 'dist', 'katex.min.js'],
  'mermaid.min.js': ['mermaid', 'dist', 'mermaid.min.js'],
  'plotly.min.js': ['plotly.js-dist-min', 'plotly.min.js'],
};

const contentTypeFor = (fileName: string): string => {
  if (fileName.endsWith('.css')) {
    return 'text/css; charset=utf-8';
  }
  if (fileName.endsWith('.js')) {
    return 'text/javascript; charset=utf-8';
  }
  if (fileName.endsWith('.woff2')) {
    return 'font/woff2';
  }
  if (fileName.endsWith('.woff')) {
    return 'font/woff';
  }
  if (fileName.endsWith('.ttf')) {
    return 'font/ttf';
  }
  return 'application/octet-stream';
};

const response = (
  body: BodyInit | null,
  status: number,
  contentType: string,
  additionalHeaders: Record<string, string> = {},
): Response =>
  new Response(body, {
    headers: {
      'Cache-Control': 'no-store',
      'Content-Type': contentType,
      'Cross-Origin-Resource-Policy': 'cross-origin',
      ...additionalHeaders,
    },
    status,
  });

const artifactIdFromUrl = (value: string | undefined): string | undefined => {
  if (!value) {
    return undefined;
  }
  try {
    const parsed = new URL(value);
    return parsed.protocol === `${ARTIFACT_SCHEME}:` && ARTIFACT_ID_PATTERN.test(parsed.hostname)
      ? parsed.hostname
      : undefined;
  } catch {
    return undefined;
  }
};

const headerValue = (
  headers: Record<string, string[] | undefined> | undefined,
  name: string,
): string | undefined => {
  if (!headers) {
    return undefined;
  }
  const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase());
  return entry?.[1]?.[0];
};

const byteLengthFromHeaders = (
  headers: Record<string, string[] | undefined> | undefined,
): number | undefined => {
  const value = headerValue(headers, 'content-length');
  if (!value || !/^\d+$/.test(value)) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
};

const bootstrapScript = String.raw`
(() => {
  'use strict';
  const isRecord = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  window.addEventListener('message', (event) => {
    if (event.source !== window.parent || !isRecord(event.data)) return;
    const message = event.data;
    if (message.jsonrpc !== '2.0' || message.method !== 'claudedock/theme' || !isRecord(message.params)) {
      return;
    }
    const variables = message.params.variables;
    if (!isRecord(variables)) return;
    for (const [name, value] of Object.entries(variables)) {
      if (/^--[a-z0-9-]{1,80}$/.test(name) && typeof value === 'string' && value.length <= 256) {
        document.documentElement.style.setProperty(name, value);
      }
    }
    document.documentElement.dataset.appearance =
      message.params.appearance === 'dark' ? 'dark' : 'light';
  });
  const ready = () => {
    window.parent.postMessage({
      jsonrpc: '2.0',
      method: 'artifact/ready',
      params: { height: Math.ceil(document.documentElement.scrollHeight) }
    }, '*');
  };
  new ResizeObserver(() => {
    window.parent.postMessage({
      jsonrpc: '2.0',
      method: 'artifact/resize',
      params: { height: Math.ceil(document.documentElement.scrollHeight) }
    }, '*');
  }).observe(document.documentElement);
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', ready, { once: true });
  } else {
    ready();
  }
})();
`;

const artifactDocument = (html: string, artifactId: string): string => {
  const baseAndBootstrap = `<base href="${ARTIFACT_SCHEME}://${artifactId}/"><script>${bootstrapScript}</script>`;
  if (/<html(?:\s|>)/iu.test(html)) {
    if (/<head(?:\s|>)/iu.test(html)) {
      return html.replace(/<head([^>]*)>/iu, `<head$1>${baseAndBootstrap}`);
    }
    return html.replace(/<html([^>]*)>/iu, `<html$1><head>${baseAndBootstrap}</head>`);
  }
  return `<!doctype html><html><head><meta charset="utf-8">${baseAndBootstrap}<meta name="viewport" content="width=device-width,initial-scale=1"></head><body>${html}</body></html>`;
};

export const registerArtifactScheme = (): void => {
  protocol.registerSchemesAsPrivileged([
    {
      privileges: {
        bypassCSP: false,
        corsEnabled: true,
        secure: true,
        standard: true,
        supportFetchAPI: true,
      },
      scheme: ARTIFACT_SCHEME,
    },
  ]);
};

export class ArtifactService {
  private readonly artifacts = new Map<string, ArtifactRecord>();
  /**
   * A FrameTreeNode id survives cross-process navigations for the lifetime of the iframe. URL-only
   * attribution does not: once an artifact navigates away, Electron reports the new external URL.
   */
  private readonly artifactFrames = new Map<string, string>();
  private allowNetwork = true;
  private readonly logs: ArtifactNetworkLogEntry[] = [];
  private readonly pendingRequests = new Map<string, PendingNetworkRequest>();
  private readonly guardedWebContents = new WeakSet<WebContents>();
  private navigationLogSequence = 0;
  private navigationGuardInstalled = false;
  private protocolInstalled = false;
  private webRequestInstalled = false;

  public constructor(
    private readonly userDataDirectory: string,
    private readonly onNetworkLog: NetworkLogListener,
  ) {
    this.allowNetwork = this.loadSettings();
  }

  public create(html: string): ArtifactCreateResult {
    if (
      typeof html !== 'string' ||
      !html.trim() ||
      Buffer.byteLength(html, 'utf8') > MAX_ARTIFACT_HTML_BYTES
    ) {
      throw new Error('Artifact 内容为空或超过 2 MiB 安全上限。');
    }
    const id = `artifact-${randomUUID()}`;
    const record: ArtifactRecord = {
      artifactId: id,
      createdAt: Date.now(),
      html,
    };
    this.artifacts.set(id, record);
    return {
      artifactId: id,
      url: `${ARTIFACT_SCHEME}://${id}/index.html`,
    };
  }

  public destroy(id: string): boolean {
    if (!ARTIFACT_ID_PATTERN.test(id)) {
      throw new Error('Artifact 标识无效。');
    }
    const deleted = this.artifacts.delete(id);
    for (const [requestId, pending] of this.pendingRequests) {
      if (pending.artifactId === id) {
        this.pendingRequests.delete(requestId);
      }
    }
    for (const [frameId, artifactId] of this.artifactFrames) {
      if (artifactId === id) {
        this.artifactFrames.delete(frameId);
      }
    }
    return deleted;
  }

  public getState(): ArtifactNetworkState {
    return {
      allowed: this.allowNetwork,
      entries: this.logs.map((entry) => ({ ...entry })),
    };
  }

  public install(): void {
    if (!this.protocolInstalled) {
      this.protocolInstalled = true;
      protocol.handle(ARTIFACT_SCHEME, (request) => this.handleProtocolRequest(request));
    }
    this.installNavigationGuard();
    this.installWebRequestAudit();
  }

  public setNetworkAllowed(allowed: boolean): ArtifactNetworkState {
    if (typeof allowed !== 'boolean') {
      throw new TypeError('Artifact 联网设置必须是布尔值。');
    }
    try {
      // Commit to memory only after the durable write succeeds. A write/rename failure therefore
      // cannot leave the UI reporting a policy which will silently revert after restart.
      this.saveSettings(allowed);
      this.allowNetwork = allowed;
    } catch (error) {
      this.reportSettingsFailure('保存', error);
      throw error;
    }
    return this.getState();
  }

  private appendLog(entry: ArtifactNetworkLogEntry): void {
    this.logs.push(entry);
    if (this.logs.length > MAX_NETWORK_LOG_ENTRIES) {
      this.logs.splice(0, this.logs.length - MAX_NETWORK_LOG_ENTRIES);
    }
    this.onNetworkLog({ ...entry });
  }

  private artifactIdForFrame(
    contentsId: number | undefined,
    frame: WebFrameMain | null | undefined,
  ): string | undefined {
    if (contentsId === undefined || !frame) {
      return undefined;
    }
    let current: WebFrameMain | null = frame;
    const visited = new Set<number>();
    while (current && !visited.has(current.frameTreeNodeId)) {
      visited.add(current.frameTreeNodeId);
      const frameId = this.frameIdentity(contentsId, current);
      const mapped = this.artifactFrames.get(frameId);
      if (mapped) {
        return mapped;
      }
      const fromUrl = artifactIdFromUrl(current.url);
      if (fromUrl && this.artifacts.has(fromUrl)) {
        this.artifactFrames.set(frameId, fromUrl);
        return fromUrl;
      }
      current = current.parent;
    }
    return undefined;
  }

  private artifactIdForRequest(
    details:
      OnBeforeRequestListenerDetails | OnCompletedListenerDetails | OnErrorOccurredListenerDetails,
  ): string | undefined {
    const contentsId = details.webContentsId ?? details.webContents?.id;
    const artifactId =
      this.artifactIdForFrame(contentsId, details.frame) ??
      artifactIdFromUrl(details.frame?.url) ??
      artifactIdFromUrl('referrer' in details ? details.referrer : undefined);
    if (artifactId && this.artifacts.has(artifactId) && contentsId !== undefined && details.frame) {
      // Propagate ownership to child frames as well. Their own URL/referrer may later change, but
      // their stable FrameTreeNode identity still keeps subsequent requests inside the audit.
      this.artifactFrames.set(this.frameIdentity(contentsId, details.frame), artifactId);
    }
    return artifactId;
  }

  private bindArtifactFrame(
    contents: WebContents,
    frame: WebFrameMain | null | undefined,
    artifactId: string,
  ): void {
    if (frame && this.artifacts.has(artifactId)) {
      this.artifactFrames.set(this.frameIdentity(contents.id, frame), artifactId);
    }
  }

  private frameIdentity(contentsId: number, frame: Pick<WebFrameMain, 'frameTreeNodeId'>): string {
    return `${contentsId}:${frame.frameTreeNodeId}`;
  }

  private installNavigationGuard(): void {
    if (this.navigationGuardInstalled) {
      return;
    }
    this.navigationGuardInstalled = true;
    app.on('web-contents-created', this.onWebContentsCreated);
    for (const contents of webContents.getAllWebContents()) {
      this.guardWebContents(contents);
    }
  }

  private readonly onWebContentsCreated = (_event: ElectronEvent, contents: WebContents): void => {
    this.guardWebContents(contents);
  };

  private guardWebContents(contents: WebContents): void {
    if (this.guardedWebContents.has(contents) || contents.isDestroyed()) {
      return;
    }
    this.guardedWebContents.add(contents);
    contents.on('will-frame-navigate', (details) => {
      this.guardFrameNavigation(contents, details);
    });
    contents.once('destroyed', () => {
      const prefix = `${contents.id}:`;
      for (const frameId of this.artifactFrames.keys()) {
        if (frameId.startsWith(prefix)) {
          this.artifactFrames.delete(frameId);
        }
      }
    });
  }

  private guardFrameNavigation(
    contents: WebContents,
    details: ElectronEvent<WebContentsWillFrameNavigateEventParams>,
  ): void {
    const destinationArtifactId = artifactIdFromUrl(details.url);
    const artifactId =
      this.artifactIdForFrame(contents.id, details.frame) ??
      this.artifactIdForFrame(contents.id, details.initiator);
    if (!artifactId) {
      if (destinationArtifactId && this.artifacts.has(destinationArtifactId)) {
        this.bindArtifactFrame(contents, details.frame, destinationArtifactId);
      }
      return;
    }
    if (destinationArtifactId === artifactId || details.url === 'about:blank') {
      return;
    }

    // This is the last cancellable browser-process boundary before a sandboxed artifact replaces
    // its document. Keeping the decision in the main process prevents script in the iframe from
    // bypassing it by changing location, submitting a form, or clicking a link.
    details.preventDefault();
    this.navigationLogSequence += 1;
    this.appendLog({
      artifactId,
      blocked: true,
      completedAt: Date.now(),
      error: 'Artifact iframe 不允许导航到其隔离文档之外。',
      id: `navigation:${contents.id}:${details.frame?.frameTreeNodeId ?? 'unknown'}:${this.navigationLogSequence}`,
      method: 'NAVIGATE',
      startedAt: Date.now(),
      url: details.url,
    });
  }

  private async handleProtocolRequest(request: Request): Promise<Response> {
    let parsed: URL;
    try {
      parsed = new URL(request.url);
    } catch {
      return response('Bad request', 400, 'text/plain; charset=utf-8');
    }

    if (parsed.hostname === 'libs') {
      return this.libraryResponse(parsed.pathname);
    }
    if (!ARTIFACT_ID_PATTERN.test(parsed.hostname)) {
      return response('Not found', 404, 'text/plain; charset=utf-8');
    }
    if (parsed.pathname !== '/index.html' && !parsed.pathname.startsWith('/libs/')) {
      return response('Not found', 404, 'text/plain; charset=utf-8');
    }
    const artifact = this.artifacts.get(parsed.hostname);
    if (!artifact) {
      return response('Artifact is no longer available', 410, 'text/plain; charset=utf-8');
    }
    if (parsed.pathname.startsWith('/libs/')) {
      return this.libraryResponse(parsed.pathname.slice('/libs'.length));
    }
    const connectSource = this.allowNetwork ? 'https: http:' : "'none'";
    const policy = [
      "default-src 'none'",
      `connect-src ${connectSource}`,
      'font-src claudedock-artifact: data:',
      `img-src claudedock-artifact: data: blob: ${this.allowNetwork ? 'https: http:' : ''}`,
      `media-src claudedock-artifact: data: blob: ${this.allowNetwork ? 'https: http:' : ''}`,
      `script-src claudedock-artifact: 'unsafe-inline' 'unsafe-eval' ${this.allowNetwork ? 'https: http:' : ''}`,
      `style-src claudedock-artifact: 'unsafe-inline' ${this.allowNetwork ? 'https: http:' : ''}`,
      'worker-src blob:',
      "object-src 'none'",
      'base-uri claudedock-artifact:',
      "form-action 'none'",
    ].join('; ');
    return response(
      artifactDocument(artifact.html, artifact.artifactId),
      200,
      'text/html; charset=utf-8',
      {
        'Content-Security-Policy': policy,
      },
    );
  }

  private installWebRequestAudit(): void {
    if (this.webRequestInstalled) {
      return;
    }
    this.webRequestInstalled = true;
    const webRequest = session.defaultSession.webRequest;
    webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
      const artifactId = this.artifactIdForRequest(details);
      if (!artifactId || details.url.startsWith(`${ARTIFACT_SCHEME}:`)) {
        callback({});
        return;
      }
      const pending: PendingNetworkRequest = {
        artifactId,
        method: details.method,
        startedAt: Date.now(),
        url: details.url,
      };
      const requestId = String(details.id);
      if (!this.allowNetwork) {
        this.appendLog({
          ...pending,
          blocked: true,
          completedAt: Date.now(),
          error: '已由“允许 artifact 联网”开关拦截',
          id: requestId,
        });
        callback({ cancel: true });
        return;
      }
      this.pendingRequests.set(requestId, pending);
      callback({});
    });
    webRequest.onCompleted({ urls: ['<all_urls>'] }, (details) => {
      const requestId = String(details.id);
      const pending = this.pendingRequests.get(requestId);
      if (!pending) {
        return;
      }
      this.pendingRequests.delete(requestId);
      this.appendLog({
        ...pending,
        blocked: false,
        completedAt: Date.now(),
        id: requestId,
        responseBytes: byteLengthFromHeaders(details.responseHeaders),
        status: details.statusCode,
      });
    });
    webRequest.onErrorOccurred({ urls: ['<all_urls>'] }, (details) => {
      const requestId = String(details.id);
      const pending = this.pendingRequests.get(requestId);
      if (!pending) {
        return;
      }
      this.pendingRequests.delete(requestId);
      this.appendLog({
        ...pending,
        blocked: false,
        completedAt: Date.now(),
        error: details.error,
        id: requestId,
      });
    });
  }

  private libraryResponse(requestPath: string): Response {
    const relative = decodeURIComponent(requestPath).replace(/^\/+/, '');
    let segments = libraryFiles[relative];
    if (!segments && relative.startsWith('fonts/')) {
      const fontName = relative.slice('fonts/'.length);
      if (/^KaTeX_[A-Za-z0-9_-]+\.(?:woff2?|ttf)$/u.test(fontName)) {
        segments = ['katex', 'dist', 'fonts', fontName];
      }
    }
    if (!segments) {
      return response('Library not found', 404, 'text/plain; charset=utf-8');
    }
    const filePath = path.join(app.getAppPath(), 'node_modules', ...segments);
    if (!existsSync(filePath)) {
      return response('Library is not packaged', 404, 'text/plain; charset=utf-8');
    }
    return response(readFileSync(filePath), 200, contentTypeFor(relative), {
      'Cache-Control': 'public, max-age=31536000, immutable',
    });
  }

  private loadSettings(): boolean {
    const filePath = this.settingsPath();
    try {
      const value = JSON.parse(readFileSync(filePath, 'utf8')) as Partial<StoredArtifactSettings>;
      if (value.version !== 1 || typeof value.allowNetwork !== 'boolean') {
        throw new Error('设置文件结构或版本无效。');
      }
      return value.allowNetwork;
    } catch (error) {
      if ((error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') {
        return true;
      }
      this.reportSettingsFailure('读取', error);
      return false;
    }
  }

  private reportSettingsFailure(operation: '保存' | '读取', error: unknown): void {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(
      `[ArtifactService] Artifact 联网设置${operation}失败；已保持或切换到安全策略。`,
      detail,
    );
  }

  private saveSettings(allowNetwork: boolean): void {
    const filePath = this.settingsPath();
    const temporaryPath = `${filePath}.tmp`;
    mkdirSync(path.dirname(filePath), { recursive: true });
    try {
      writeFileSync(temporaryPath, `${JSON.stringify({ allowNetwork, version: 1 }, null, 2)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
      });
      renameSync(temporaryPath, filePath);
    } catch (error) {
      try {
        unlinkSync(temporaryPath);
      } catch {
        // The temporary file may not have been created yet.
      }
      throw error;
    }
  }

  private settingsPath(): string {
    return path.join(this.userDataDirectory, 'claude', 'artifact-settings.json');
  }
}
