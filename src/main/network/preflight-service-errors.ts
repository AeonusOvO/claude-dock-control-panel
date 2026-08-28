export class NetworkPreflightSupersededError extends Error {
  public constructor(
    public readonly startedGeneration: number,
    public readonly currentGeneration: number,
    public readonly startedRunId?: number,
    public readonly currentRunId?: number,
    cause?: unknown,
  ) {
    super(
      '网络预检已被更新的检查或配置取代，本次结果已作废。',
      cause === undefined ? undefined : { cause },
    );
    this.name = 'NetworkPreflightSupersededError';
  }
}

export class NetworkPreflightLeaseContextError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'NetworkPreflightLeaseContextError';
  }
}
