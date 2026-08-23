export interface NetworkPreflightTarget {
  readonly process: 'application';
  readonly url: string;
}

export const captureNetworkPreflightTarget = (
  target: NetworkPreflightTarget | undefined,
): Readonly<NetworkPreflightTarget> | undefined =>
  target
    ? Object.freeze({
        process: target.process,
        url: new URL(target.url).toString(),
      })
    : undefined;

export const networkPreflightTargetKey = (
  target: NetworkPreflightTarget | undefined,
): readonly ['application', string] | null => (target ? [target.process, target.url] : null);
