import type { ClientRequest, ClientRequestConstructorOptions } from 'electron';
import type {
  ApplicationEndpointRequest,
  ApplicationEndpointResponse,
} from './provider-connectivity-probe';

type ElectronRequestFactory = (options: ClientRequestConstructorOptions) => ClientRequest;

const DEFAULT_TIMEOUT_MS = 8_000;
const MAX_REDIRECTS = 8;

const firstHeader = (value: string | string[] | undefined): string =>
  Array.isArray(value) ? (value[0] ?? '') : (value ?? '');

export const createElectronApplicationRequest = (
  requestFactory: ElectronRequestFactory,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): ApplicationEndpointRequest => {
  return (url): Promise<ApplicationEndpointResponse> =>
    new Promise((resolve, reject) => {
      const redirects: ApplicationEndpointResponse['redirects'] = [];
      let currentUrl = url;
      let settled = false;
      let request: ClientRequest;

      const finish = (result: ApplicationEndpointResponse): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };
      const fail = (error: Error): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        reject(error);
      };

      try {
        request = requestFactory({
          cache: 'no-store',
          credentials: 'omit',
          method: 'HEAD',
          redirect: 'manual',
          url,
        });
      } catch (error) {
        reject(error);
        return;
      }

      const timer = setTimeout(() => {
        fail(new Error('连接超时。'));
        request.abort();
      }, timeoutMs);
      timer.unref();

      request.on('redirect', (statusCode, _method, redirectUrl) => {
        try {
          const target = new URL(redirectUrl, currentUrl);
          if (target.protocol !== 'https:') {
            fail(new Error(`检测到非 HTTPS 重定向：${target.hostname}`));
            request.abort();
            return;
          }
          redirects.push({ host: target.hostname, statusCode });
          if (redirects.length > MAX_REDIRECTS) {
            fail(new Error(`重定向次数超过 ${MAX_REDIRECTS} 次上限。`));
            request.abort();
            return;
          }
          currentUrl = target.href;
          request.followRedirect();
        } catch (error) {
          fail(error instanceof Error ? error : new Error(String(error)));
          request.abort();
        }
      });
      request.on('response', (response) => {
        finish({
          contentType: firstHeader(response.headers['content-type']),
          redirects,
          status: response.statusCode,
        });
      });
      request.on('error', (error) => {
        fail(error);
      });
      request.end();
    });
};
