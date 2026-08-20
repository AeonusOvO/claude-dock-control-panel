import { type IpcDomainContribution, runIpcDomainContributions } from '../infra/contributions';

export type IpcContribution<Dependencies extends object> = IpcDomainContribution<Dependencies>;

export const registerIpcContributions = runIpcDomainContributions;

export type IpcDependenciesOf<Contribution> =
  Contribution extends IpcContribution<infer Dependencies> ? Dependencies : never;

export type UnionToIntersection<Union> = (
  Union extends unknown ? (value: Union) => void : never
) extends (value: infer Intersection) => void
  ? Intersection
  : never;
