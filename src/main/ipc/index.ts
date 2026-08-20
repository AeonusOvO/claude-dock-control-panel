import {
  type IpcDependenciesOf,
  registerIpcContributions,
  type UnionToIntersection,
} from './contribution';
import { MAIN_IPC_CONTRIBUTIONS } from './contributions';

export type MainIpcDependencies = UnionToIntersection<
  IpcDependenciesOf<(typeof MAIN_IPC_CONTRIBUTIONS)[number]>
>;

export const registerIpc = (dependencies: MainIpcDependencies): void => {
  // Order decides which contribution owns a channel if duplicate registration is introduced.
  registerIpcContributions(dependencies, MAIN_IPC_CONTRIBUTIONS);
};
