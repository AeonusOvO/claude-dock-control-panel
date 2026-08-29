// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import type { TerminalElements } from '../../src/renderer/features/terminal/elements';
import { createTerminalIoMaskActions } from '../../src/renderer/features/terminal/terminal-io-mask';
import type { TerminalIoDependencies } from '../../src/renderer/features/terminal/terminal-io-dependencies';
import { createTerminalState, type TerminalView } from '../../src/renderer/features/terminal/state';
import type { WorkspaceState } from '../../src/shared/contracts';

const workspace: WorkspaceState = {
  activeSessionId: 'session-a',
  projects: [],
  sessions: [],
};

const createView = (): TerminalView => {
  const container = document.createElement('div');
  const terminal = {
    buffer: {
      active: {
        baseY: 0,
        getLine: () => undefined,
        length: 0,
      },
    },
    rows: 24,
  };
  return { container, terminal } as unknown as TerminalView;
};

describe('terminal mask ownership', () => {
  it('keeps nested lease labels isolated and restores the older label on release', () => {
    const state = createTerminalState();
    const terminalStage = document.createElement('main');
    const dependencies = {
      focusComposer: vi.fn(() => true),
      getWorkspaceState: () => workspace,
    } as unknown as TerminalIoDependencies;
    state.terminalViews.set('session-a', createView());
    const { beginTerminalMask } = createTerminalIoMaskActions(
      state,
      { terminalStage } as TerminalElements,
      dependencies,
    );

    const first = beginTerminalMask('session-a', '第一阶段');
    const second = beginTerminalMask('session-a', '第二阶段');
    const label = () => terminalStage.querySelector('.terminal-mask__label')?.textContent;

    expect(label()).toBe('第二阶段');
    first.setLabel?.('第一阶段更新');
    expect(label()).toBe('第二阶段');
    second.setLabel?.('第二阶段更新');
    expect(label()).toBe('第二阶段更新');

    second();
    expect(label()).toBe('第一阶段更新');
    first();
    expect(terminalStage.querySelector('.terminal-mask')).toBeNull();
  });
});
