export interface NetworkPreflightTarget {
  readonly process: 'application' | 'claude-cli';
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
): readonly [NetworkPreflightTarget['process'], string] | null =>
  target ? [target.process, target.url] : null;

export const sameNetworkPreflightTarget = (
  left: NetworkPreflightTarget | undefined,
  right: NetworkPreflightTarget | undefined,
): boolean => left?.process === right?.process && left?.url === right?.url;
