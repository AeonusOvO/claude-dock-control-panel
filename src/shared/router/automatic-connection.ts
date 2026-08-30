import { normalizeConnectionAddress } from './connection-endpoint';

export type AutomaticConnectionProtocol = 'anthropic' | 'openai' | 'openai-responses';
export type AutomaticConnectionAuth = 'apiKey' | 'bearer' | 'none';

export interface ConnectionCandidate {
  endpoint: string;
  modelsEndpoint: string;
  protocol: AutomaticConnectionProtocol;
}

const OPERATION_SUFFIX = /\/(messages|chat\/completions|responses|models)$/i;
const operations: Record<AutomaticConnectionProtocol, string> = {
  anthropic: 'messages',
  openai: 'chat/completions',
  'openai-responses': 'responses',
};

/** Candidates never leave the supplied origin or remove an arbitrary tenant/proxy prefix. */
export const automaticConnectionCandidates = (
  address: string,
  preferred: AutomaticConnectionProtocol = 'anthropic',
  allowedProtocols?: readonly AutomaticConnectionProtocol[],
): ConnectionCandidate[] => {
  const url = new URL(normalizeConnectionAddress(address));
  const path = url.pathname.replace(/\/+$/, '');
  const explicit = OPERATION_SUFFIX.exec(path)?.[1]?.toLowerCase();
  const protocol =
    explicit === 'responses'
      ? 'openai-responses'
      : explicit === 'chat/completions'
        ? 'openai'
        : explicit === 'messages'
          ? 'anthropic'
          : preferred;
  const prefix = path.replace(OPERATION_SUFFIX, '');
  const roots =
    explicit || /\/v\d+$/i.test(prefix) ? [prefix, `${prefix}/v1`] : [`${prefix}/v1`, prefix];
  const protocols = [
    ...new Set<AutomaticConnectionProtocol>([
      protocol,
      preferred,
      ...(allowedProtocols ?? ['anthropic', 'openai', 'openai-responses']),
    ]),
  ].filter((candidateProtocol) =>
    allowedProtocols ? allowedProtocols.includes(candidateProtocol) : true,
  );
  return roots.flatMap((root) =>
    protocols.map((candidateProtocol) => ({
      endpoint: `${url.origin}${root}/${operations[candidateProtocol]}`,
      modelsEndpoint: `${url.origin}${root}/models`,
      protocol: candidateProtocol,
    })),
  );
};

/** Only equivalent API paths may reuse a saved key; changing a host or tenant requires a new key. */
export const connectionCredentialScope = (address: string): string => {
  const url = new URL(normalizeConnectionAddress(address));
  const path = url.pathname.replace(/\/+$/, '').replace(OPERATION_SUFFIX, '').replace(/\/v1$/i, '');
  return `${url.origin}${path}`;
};

export const sameConnectionCredentialScope = (left: string, right: string): boolean => {
  try {
    return connectionCredentialScope(left) === connectionCredentialScope(right);
  } catch {
    return false;
  }
};

export const isLocalConnection = (address: string): boolean =>
  ['localhost', '127.0.0.1', '[::1]'].includes(
    new URL(normalizeConnectionAddress(address)).hostname,
  );
