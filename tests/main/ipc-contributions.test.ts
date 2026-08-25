import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import {
  type IpcContribution,
  type IpcDependenciesOf,
  registerIpcContributions,
  type UnionToIntersection,
} from '../../src/main/ipc/contribution';
import { MAIN_IPC_CONTRIBUTIONS } from '../../src/main/ipc/contributions';

describe('main IPC contributions', () => {
  it('keeps the established domain registration order in the catalog', () => {
    expect(MAIN_IPC_CONTRIBUTIONS.map((contribution) => contribution.name)).toEqual([
      'registerConversationAttachmentIpc',
      'registerConversationIpc',
      'registerBusyIpc',
      'registerRuntimeIpc',
      'registerClaudeControlsIpc',
      'registerDownloadIpc',
      'registerProxyIpc',
      'registerNetworkIpc',
      'registerAppIpc',
      'registerOnboardingIpc',
      'registerArtifactIpc',
      'registerChatIpc',
      'registerProjectIpc',
      'registerTerminalIpc',
      'registerClaudeStateIpc',
      'registerClaudeExecutionSettingsIpc',
      'registerCodexIpc',
      'registerManagedChatGptIpc',
      'registerRouterIpc',
      'registerClaudeConnectionIpc',
      'registerClaudeLaunchIpc',
      'registerSessionIpc',
      'registerClaudePluginIpc',
      'registerMcpIpc',
      'registerSoftwareIpc',
    ]);
  });

  it('runs the catalog in declaration order with the shared dependencies', () => {
    const calls: string[] = [];
    const first = vi.fn(({ first }: { first: string }) => {
      calls.push(first);
    });
    const second = vi.fn(({ second }: { second: number }) => {
      calls.push(String(second));
    });
    const contributions = [first, second] as const;
    const dependencies = { first: 'first', second: 2 };

    registerIpcContributions(dependencies, contributions);

    expect(calls).toEqual(['first', '2']);
    expect(first).toHaveBeenCalledWith(dependencies);
    expect(second).toHaveBeenCalledWith(dependencies);
  });

  it('derives the dependency intersection from a contribution catalog', () => {
    const contributions = [
      (_dependencies: { first: string }) => undefined,
      (_dependencies: { second: number }) => undefined,
    ] as const satisfies readonly IpcContribution<never>[];
    type Dependencies = UnionToIntersection<IpcDependenciesOf<(typeof contributions)[number]>>;

    expect(contributions).toHaveLength(2);
    expectTypeOf<Dependencies>().toMatchTypeOf<{
      first: string;
      second: number;
    }>();
    expectTypeOf<{ first: string; second: number }>().toMatchTypeOf<Dependencies>();
  });
});
