import type {
  ClaudeRouterManagementState,
  RouterKernelState,
  RouterOperationProgress,
} from '../../../shared/contracts';

export interface RouterState {
  lastRouterOperationProgress: RouterOperationProgress | undefined;
  routerKernelState: RouterKernelState | undefined;
  routerManagementState: ClaudeRouterManagementState | undefined;
  routerOperationInProgress: boolean;
  routerRefreshInProgress: boolean;
}

export const createRouterState = (): RouterState => ({
  lastRouterOperationProgress: undefined,
  routerKernelState: undefined,
  routerManagementState: undefined,
  routerOperationInProgress: false,
  routerRefreshInProgress: false,
});
