export const FAILURE_KINDS = ['user-input', 'environment', 'external-service', 'internal'] as const;

export type FailureKind = (typeof FAILURE_KINDS)[number];

export interface Failure {
  code: string;
  detail: string;
  kind: FailureKind;
  message: string;
}

export interface FailureMetadata {
  code?: string;
  detail?: string;
  kind?: FailureKind;
}

export const isFailureKind = (value: unknown): value is FailureKind =>
  typeof value === 'string' && FAILURE_KINDS.includes(value as FailureKind);

export const isFailure = (value: unknown): value is Failure => {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<Failure>;
  return (
    typeof candidate.code === 'string' &&
    candidate.code.length > 0 &&
    typeof candidate.detail === 'string' &&
    isFailureKind(candidate.kind) &&
    typeof candidate.message === 'string' &&
    candidate.message.length > 0
  );
};

export const failureDisplayMessage = (failure: Pick<Failure, 'code' | 'message'>): string =>
  `${failure.message}（诊断码：${failure.code}）`;
