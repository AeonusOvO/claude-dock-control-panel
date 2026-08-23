import { FitAddon } from '@xterm/addon-fit';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebglAddon } from '@xterm/addon-webgl';
import { Terminal, type ITerminalOptions } from '@xterm/xterm';
import { TERMINAL_THEMES } from '../../../shared/ui/terminal-themes';
import type { TerminalStatus } from '../../../shared/contracts';
import { TerminalOutputPump } from '../../platform/terminal-output-pump';
import type { TerminalElements } from './elements';
import type { TerminalIo } from './terminal-io';
import { BUNDLED_CONPTY_BUILD, type TerminalState, type TerminalView } from './state';
import type { TerminalViewsDependencies } from './terminal-views-dependencies';
import type { TerminalViewPermissionActions } from './terminal-views-permission';

export interface TerminalViewCreateActions {
  createTerminalView: (status: TerminalStatus, active: boolean) => TerminalView;
}

export const createTerminalViewActions = (
  state: TerminalState,
  elements: TerminalElements,
  dependencies: TerminalViewsDependencies,
  io: TerminalIo,
  permissionActions: TerminalViewPermissionActions,
): TerminalViewCreateActions => {
  const buildTerminalOptions = (): ITerminalOptions => ({
    allowProposedApi: true,
    convertEol: false,
    cursorBlink: true,
    cursorStyle: 'bar',
    fontFamily: '"Cascadia Mono", "SFMono-Regular", Consolas, monospace',
    fontSize: 14,
    letterSpacing: 0,
    lineHeight: 1.28,
    minimumContrastRatio: 4.5,
    scrollback: 10_000,
    theme: { ...TERMINAL_THEMES[dependencies.getActiveTheme()].palette },
    windowsPty: {
      backend: 'conpty' as const,
      buildNumber: Math.max(dependencies.getWindowsBuildNumber() ?? 0, BUNDLED_CONPTY_BUILD),
    },
  });

  const createTerminalView = (status: TerminalStatus, active: boolean): TerminalView => {
    const sessionId = status.id;
    const ptyGeneration = status.ptyGeneration;
    const container = document.createElement('div');
    container.className = active ? 'project-terminal project-terminal--active' : 'project-terminal';
    container.dataset.sessionId = sessionId;
    elements.terminalStage.prepend(container);

    const terminal = new Terminal(buildTerminalOptions());
    const fitAddon = new FitAddon();
    const unicode11Addon = new Unicode11Addon();
    terminal.loadAddon(fitAddon);
    terminal.loadAddon(unicode11Addon);
    terminal.unicode.activeVersion = '11';
    terminal.open(container);

    /*
     * The GPU renderer is what removes the visible lag on large output. It is attached after `open()`
     * (it needs a canvas) and disposed on context loss so the DOM renderer takes over instead of the
     * terminal going blank — a lost WebGL context is normal after a driver reset or GPU switch.
     */
    try {
      const webglAddon = new WebglAddon();
      webglAddon.onContextLoss(() => {
        webglAddon.dispose();
      });
      terminal.loadAddon(webglAddon);
    } catch {
      // No WebGL (remote session, blocklisted driver): the default DOM renderer still works.
    }

    const view: TerminalView = {
      appliedResizeRevision: 0,
      container,
      fitAddon,
      outputPump: new TerminalOutputPump({
        cancelFrame: (handle) => window.cancelAnimationFrame(handle),
        isCurrent: () => io.ownsTerminalGeneration(sessionId, ptyGeneration, view),
        onAppliedRevision: () => {
          permissionActions.reportTerminalPermissionMode(sessionId, view);
          permissionActions.answerReadyPermissionModeProbes(sessionId, view);
        },
        scheduleFrame: (callback) => window.requestAnimationFrame(callback),
        write: (data, callback) => terminal.write(data, callback),
      }),
      permissionModeProbes: [],
      ptyGeneration,
      resizeRevision: 0,
      terminal,
    };

    terminal.onData((data) => {
      io.writeToTerminalGeneration(sessionId, ptyGeneration, view, data);
    });

    terminal.attachCustomKeyEventHandler((event) => {
      if (!io.ownsTerminalGeneration(sessionId, ptyGeneration, view)) {
        return false;
      }
      if (event.isComposing || event.keyCode === 229) {
        return true;
      }
      if (event.type !== 'keydown') {
        return true;
      }

      if (event.ctrlKey && !event.shiftKey && event.code === 'KeyL') {
        terminal.clear();
        return false;
      }
      if (event.ctrlKey && !event.shiftKey && event.code === 'KeyA') {
        // Without this, Ctrl+A reaches PSReadLine as "move to line start" and never selects output.
        terminal.selectAll();
        return false;
      }
      if (event.ctrlKey && !event.shiftKey && event.code === 'KeyC' && terminal.hasSelection()) {
        void window.controlPanel.writeClipboardText(terminal.getSelection());
        return false;
      }
      if (event.ctrlKey && !event.shiftKey && event.code === 'KeyV') {
        void io.pasteIntoTerminalGeneration(sessionId, ptyGeneration, view);
        return false;
      }
      if (event.shiftKey && !event.ctrlKey && event.code === 'Enter') {
        io.writeToTerminalGeneration(sessionId, ptyGeneration, view, '\x0a');
        return false;
      }

      return true;
    });
    container.addEventListener('contextmenu', io.showTerminalContextMenu);

    state.terminalViews.set(sessionId, view);
    return view;
  };

  return { createTerminalView };
};
