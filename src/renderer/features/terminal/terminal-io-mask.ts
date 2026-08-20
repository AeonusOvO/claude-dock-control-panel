import type { TerminalElements } from './elements';
import type { TerminalIoDependencies } from './terminal-io-dependencies';
import type { TerminalMaskState, TerminalState } from './state';

export interface TerminalIoMaskActions {
  beginTerminalMask: (sessionId: string, label: string) => () => void;
}

export const createTerminalIoMaskActions = (
  state: TerminalState,
  elements: TerminalElements,
  dependencies: TerminalIoDependencies,
): TerminalIoMaskActions => {
  const releaseTerminalMask = (sessionId: string, maskState: TerminalMaskState): void => {
    maskState.depth -= 1;
    if (maskState.depth > 0 || state.terminalMasks.get(sessionId) !== maskState) {
      return;
    }
    state.terminalMasks.delete(sessionId);
    maskState.overlay.remove();
    maskState.view.container.inert = false;
    const restore = maskState.focusBeforeMask;
    if (restore?.isConnected) {
      restore.focus({ preventScroll: true });
    } else if (dependencies.getWorkspaceState().activeSessionId === sessionId) {
      dependencies.focusComposer();
    }
  };

  const copyTerminalCanvasLayers = (source: HTMLElement, target: HTMLElement): boolean => {
    const sourceCanvases = [...source.querySelectorAll<HTMLCanvasElement>('canvas')];
    const targetCanvases = [...target.querySelectorAll<HTMLCanvasElement>('canvas')];
    let copied = 0;
    for (const [index, sourceCanvas] of sourceCanvases.entries()) {
      const targetCanvas = targetCanvases[index];
      if (!targetCanvas) {
        continue;
      }
      targetCanvas.width = sourceCanvas.width;
      targetCanvas.height = sourceCanvas.height;
      try {
        targetCanvas.getContext('2d')?.drawImage(sourceCanvas, 0, 0);
        copied += 1;
      } catch {
        // A GPU driver can reject readback after context loss; the text fallback below stays usable.
      }
    }
    return copied > 0;
  };

  /**
   * Freezes what the user sees while keeping the real xterm alive behind it. Permission-mode changes
   * depend on xterm consuming screen deltas, so pausing the output queue here would deadlock the
   * before/after badge probe. A copied visual layer gives the requested frozen blur without breaking
   * that state machine.
   */
  const beginTerminalMask = (sessionId: string, label: string): (() => void) => {
    const existing = state.terminalMasks.get(sessionId);
    if (existing) {
      existing.depth += 1;
      existing.label.textContent = label;
      let disposed = false;
      return () => {
        if (disposed) {
          return;
        }
        disposed = true;
        releaseTerminalMask(sessionId, existing);
      };
    }

    const view = state.terminalViews.get(sessionId);
    if (!view) {
      return () => undefined;
    }
    const overlay = document.createElement('div');
    overlay.className = 'terminal-mask';
    overlay.tabIndex = -1;
    overlay.setAttribute('role', 'status');
    overlay.setAttribute('aria-live', 'polite');

    const snapshot = view.container.cloneNode(true) as HTMLDivElement;
    snapshot.className = 'terminal-mask__snapshot';
    snapshot.removeAttribute('data-session-id');
    snapshot.setAttribute('aria-hidden', 'true');
    snapshot.inert = true;
    if (!copyTerminalCanvasLayers(view.container, snapshot)) {
      const fallback = document.createElement('pre');
      fallback.className = 'terminal-mask__fallback';
      const buffer = view.terminal.buffer.active;
      const firstRow = Math.max(0, buffer.baseY);
      const rows: string[] = [];
      for (
        let index = firstRow;
        index < Math.min(buffer.length, firstRow + view.terminal.rows);
        index++
      ) {
        rows.push(buffer.getLine(index)?.translateToString(true) ?? '');
      }
      fallback.textContent = rows.join('\n');
      snapshot.replaceChildren(fallback);
    }
    const veil = document.createElement('div');
    veil.className = 'terminal-mask__veil';
    const message = document.createElement('strong');
    message.className = 'terminal-mask__label';
    message.textContent = label;
    veil.append(message);
    overlay.append(snapshot, veil);
    elements.terminalStage.append(overlay);

    const focusBeforeMask =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    view.container.inert = true;
    overlay.focus({ preventScroll: true });
    const maskState: TerminalMaskState = {
      depth: 1,
      focusBeforeMask,
      label: message,
      overlay,
      view,
    };
    state.terminalMasks.set(sessionId, maskState);

    let disposed = false;
    return () => {
      if (disposed) {
        return;
      }
      disposed = true;
      releaseTerminalMask(sessionId, maskState);
    };
  };

  return { beginTerminalMask };
};
