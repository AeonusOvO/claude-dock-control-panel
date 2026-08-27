import net, { type Socket } from 'node:net';
import {
  parseOpenAiModelIds,
  ProviderModelDiscoveryError,
} from '../network/provider-model-discovery';
import type {
  ManagedGatewayExactProcess,
  ManagedGatewayProcessIdentity,
} from './managed-chatgpt-process-identity';

const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_HEADER_BYTES = 64 * 1024;
const PROCESS_IDENTITY_STEP_TIMEOUT_MS = 3_000;

interface ManagedGatewayOwnedModelReaderOptions {
  connect?: (port: number) => Socket;
  processIdentity: Pick<ManagedGatewayProcessIdentity, 'matches' | 'ownsEstablishedConnection'>;
}

const remainingTime = (deadline: number): number => Math.max(0, deadline - Date.now());

const processIdentityStepTimeout = (deadline: number): number =>
  Math.max(1, Math.min(PROCESS_IDENTITY_STEP_TIMEOUT_MS, remainingTime(deadline)));

const bounded = <T>(operation: Promise<T>, deadline: number): Promise<T> => {
  const remaining = remainingTime(deadline);
  if (remaining <= 0) {
    return Promise.reject(new ProviderModelDiscoveryError('本机托管网关模型检查超时。'));
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };
    const timer = setTimeout(
      () => finish(() => reject(new ProviderModelDiscoveryError('本机托管网关模型检查超时。'))),
      remaining,
    );
    timer.unref();
    void operation.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error)),
    );
  });
};

const waitForConnection = (socket: Socket, deadline: number): Promise<void> =>
  bounded(
    new Promise((resolve, reject) => {
      const cleanup = (): void => {
        socket.off('connect', connected);
        socket.off('error', failed);
      };
      const connected = (): void => {
        cleanup();
        resolve();
      };
      const failed = (error: Error): void => {
        cleanup();
        reject(error);
      };
      socket.once('connect', connected);
      socket.once('error', failed);
    }),
    deadline,
  );

const readResponse = (socket: Socket, deadline: number): Promise<Buffer> =>
  bounded(
    new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      const cleanup = (): void => {
        socket.off('data', data);
        socket.off('end', ended);
        socket.off('close', closed);
        socket.off('error', failed);
      };
      const finish = (error?: Error): void => {
        cleanup();
        if (error) reject(error);
        else resolve(Buffer.concat(chunks, size));
      };
      const data = (chunk: Buffer): void => {
        size += chunk.length;
        if (size > MAX_RESPONSE_BYTES + MAX_HEADER_BYTES) {
          socket.destroy();
          finish(new ProviderModelDiscoveryError('模型列表超过安全大小上限。'));
          return;
        }
        chunks.push(Buffer.from(chunk));
      };
      const ended = (): void => finish();
      const closed = (hadError: boolean): void => {
        if (!hadError) finish();
      };
      const failed = (error: Error): void => finish(error);
      socket.on('data', data);
      socket.once('end', ended);
      socket.once('close', closed);
      socket.once('error', failed);
    }),
    deadline,
  );

const decodeChunked = (body: Buffer): Buffer => {
  const chunks: Buffer[] = [];
  let offset = 0;
  let size = 0;
  while (offset < body.length) {
    const lineEnd = body.indexOf('\r\n', offset, 'ascii');
    if (lineEnd < 0 || lineEnd - offset > 32) {
      throw new ProviderModelDiscoveryError('模型接口返回了无效 HTTP 数据。');
    }
    const sizeText = body.toString('ascii', offset, lineEnd).split(';', 1)[0] ?? '';
    if (!/^[0-9a-f]+$/i.test(sizeText)) {
      throw new ProviderModelDiscoveryError('模型接口返回了无效 HTTP 数据。');
    }
    const chunkSize = Number.parseInt(sizeText, 16);
    offset = lineEnd + 2;
    if (chunkSize === 0) return Buffer.concat(chunks, size);
    if (!Number.isSafeInteger(chunkSize) || chunkSize > MAX_RESPONSE_BYTES - size) {
      throw new ProviderModelDiscoveryError('模型列表超过安全大小上限。');
    }
    const chunkEnd = offset + chunkSize;
    if (chunkEnd + 2 > body.length || body.toString('ascii', chunkEnd, chunkEnd + 2) !== '\r\n') {
      throw new ProviderModelDiscoveryError('模型接口返回了无效 HTTP 数据。');
    }
    chunks.push(body.subarray(offset, chunkEnd));
    size += chunkSize;
    offset = chunkEnd + 2;
  }
  throw new ProviderModelDiscoveryError('模型接口返回了不完整 HTTP 数据。');
};

const parseHttpResponse = (response: Buffer, credential: string): string[] => {
  const headerEnd = response.indexOf('\r\n\r\n', 0, 'ascii');
  if (headerEnd < 0 || headerEnd > MAX_HEADER_BYTES) {
    throw new ProviderModelDiscoveryError('模型接口返回了无效 HTTP 数据。');
  }
  const headerLines = response.toString('latin1', 0, headerEnd).split('\r\n');
  const status = /^HTTP\/1\.[01] (\d{3})(?: |$)/.exec(headerLines.shift() ?? '');
  if (!status) throw new ProviderModelDiscoveryError('模型接口返回了无效 HTTP 数据。');
  if (status[1] !== '200') {
    throw new ProviderModelDiscoveryError(`模型接口返回 HTTP ${status[1]}。`);
  }
  const headers = new Map<string, string>();
  for (const line of headerLines) {
    const separator = line.indexOf(':');
    if (separator <= 0 || /^[ \t]/.test(line)) {
      throw new ProviderModelDiscoveryError('模型接口返回了无效 HTTP 数据。');
    }
    const name = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (headers.has(name)) {
      headers.set(name, `${headers.get(name)},${value}`);
    } else {
      headers.set(name, value);
    }
  }
  let body = response.subarray(headerEnd + 4);
  const transferEncoding = headers.get('transfer-encoding')?.toLowerCase();
  if (transferEncoding) {
    if (transferEncoding !== 'chunked') {
      throw new ProviderModelDiscoveryError('模型接口返回了不支持的 HTTP 编码。');
    }
    body = decodeChunked(body);
  } else if (headers.has('content-length')) {
    const declared = headers.get('content-length') ?? '';
    if (!/^\d+$/.test(declared)) {
      throw new ProviderModelDiscoveryError('模型接口返回了无效 HTTP 数据。');
    }
    const length = Number(declared);
    if (length > MAX_RESPONSE_BYTES) {
      throw new ProviderModelDiscoveryError('模型列表超过安全大小上限。');
    }
    if (body.length !== length) {
      throw new ProviderModelDiscoveryError('模型接口返回了不完整 HTTP 数据。');
    }
  }
  if (body.length > MAX_RESPONSE_BYTES) {
    throw new ProviderModelDiscoveryError('模型列表超过安全大小上限。');
  }
  let payload: unknown;
  try {
    payload = JSON.parse(body.toString('utf8')) as unknown;
  } catch {
    throw new ProviderModelDiscoveryError('模型接口没有返回有效 JSON。');
  }
  const models = parseOpenAiModelIds(payload).filter((model) => !model.includes(credential));
  if (models.length === 0) {
    throw new ProviderModelDiscoveryError('模型接口当前没有可用模型。');
  }
  return models;
};

/**
 * Opens an empty loopback connection, proves the server-side tuple belongs to the exact managed
 * process, and only then sends the durable bearer over that same established socket.
 */
export class ManagedGatewayOwnedModelReader {
  private readonly connect: (port: number) => Socket;

  public constructor(private readonly options: ManagedGatewayOwnedModelReaderOptions) {
    this.connect = options.connect ?? ((port) => net.createConnection({ host: '127.0.0.1', port }));
  }

  public async read(
    process: ManagedGatewayExactProcess,
    credential: string,
    timeoutMs: number,
  ): Promise<string[]> {
    const normalizedCredential = credential.trim();
    if (!normalizedCredential || timeoutMs <= 0) {
      throw new ProviderModelDiscoveryError('托管网关模型检查参数无效。');
    }
    const deadline = Date.now() + timeoutMs;
    const socket = this.connect(process.port);
    let socketFailure: Error | undefined;
    // Ownership verification awaits a Windows helper between connect and response listeners.
    // Keep an error owner across that gap (and post-response verification) so ECONNRESET cannot
    // become an uncaught main-process exception. Never write a bearer after the socket failed.
    socket.on('error', (error) => {
      socketFailure = error;
    });
    socket.setNoDelay(true);
    try {
      await waitForConnection(socket, deadline);
      if (
        socket.localAddress !== '127.0.0.1' ||
        socket.remoteAddress !== '127.0.0.1' ||
        !socket.localPort ||
        socket.remotePort !== process.port
      ) {
        throw new ProviderModelDiscoveryError('本机模型连接身份无效。');
      }
      const ownsConnection = await bounded(
        this.options.processIdentity.ownsEstablishedConnection(
          { clientPort: socket.localPort, process },
          processIdentityStepTimeout(deadline),
        ),
        deadline,
      );
      if (!ownsConnection) {
        throw new ProviderModelDiscoveryError('本机模型连接不属于托管网关进程。');
      }
      if (socketFailure || socket.destroyed || !socket.writable) {
        throw new ProviderModelDiscoveryError('本机模型连接在身份检查期间已经断开。');
      }
      const request = [
        'GET /v1/models HTTP/1.1',
        `Host: 127.0.0.1:${process.port}`,
        `Authorization: Bearer ${normalizedCredential}`,
        'Accept: application/json',
        'Connection: close',
        '',
        '',
      ].join('\r\n');
      const responsePending = readResponse(socket, deadline);
      socket.end(request, 'utf8');
      const response = await responsePending;
      const identity = await bounded(
        this.options.processIdentity.matches(process, processIdentityStepTimeout(deadline)),
        deadline,
      );
      if (identity === 'inaccessible') {
        throw new ProviderModelDiscoveryError(
          '模型接口已响应，但未能在时限内复核托管网关进程身份。',
        );
      }
      if (identity !== 'match') {
        throw new ProviderModelDiscoveryError('模型接口响应后托管网关进程身份已经失效。');
      }
      return parseHttpResponse(response, normalizedCredential);
    } catch (error) {
      if (error instanceof ProviderModelDiscoveryError) throw error;
      throw new ProviderModelDiscoveryError('无法读取本机托管网关模型列表。');
    } finally {
      socket.destroy();
    }
  }
}
