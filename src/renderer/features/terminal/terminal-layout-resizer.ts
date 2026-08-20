import type { TerminalElements } from './elements';
import type { TerminalLayoutDependencies } from './terminal-layout-dependencies';
import type { TerminalViews } from './terminal-views';

export interface TerminalLayoutResizerActions {
  cancelActiveResizes: () => void;
}

export const createTerminalLayoutResizerActions = (
  elements: TerminalElements,
  dependencies: TerminalLayoutDependencies,
  views: TerminalViews,
): TerminalLayoutResizerActions => {
  const clamp = (value: number, minimum: number, maximum: number): number =>
    Math.min(maximum, Math.max(minimum, value));

  const setPanelWidth = (value: number): void => {
    const narrow = window.innerWidth <= 900;
    const minimum = narrow ? 240 : 270;
    const width = clamp(
      value,
      minimum,
      Math.max(minimum, Math.min(560, window.innerWidth - (narrow ? 360 : 520))),
    );
    document.documentElement.style.setProperty('--rail-w', `${width}px`);
    localStorage.setItem('claudedock.panelWidth', String(width));
    views.debounceTerminalFit();
  };

  const setDrawerWidth = (value: number): void => {
    const minimum = window.innerWidth <= 900 ? 320 : 360;
    const width = clamp(value, minimum, Math.max(minimum, Math.min(760, window.innerWidth - 140)));
    document.documentElement.style.setProperty('--drawer-w', `${width}px`);
    localStorage.setItem('claudedock.drawerWidth', String(width));
  };

  const activeResizeCleanups = new Set<() => void>();

  const cancelActiveResizes = (): void => {
    for (const cleanup of [...activeResizeCleanups]) {
      cleanup();
    }
  };

  const installResizer = (
    handle: HTMLElement,
    current: () => number,
    apply: (value: number) => void,
    direction: 1 | -1,
  ): void => {
    handle.addEventListener('pointerdown', (event) => {
      if (!event.isPrimary || event.button !== 0) {
        return;
      }

      // Only one captured resize may exist. This also clears a capture whose pointerup was lost.
      cancelActiveResizes();
      event.preventDefault();
      const startX = event.clientX;
      const startWidth = current();
      const pointerId = event.pointerId;
      let finished = false;
      const move = (moveEvent: PointerEvent): void => {
        if (moveEvent.pointerId !== pointerId) {
          return;
        }
        apply(startWidth + (moveEvent.clientX - startX) * direction);
      };
      const finish = (): void => {
        if (finished) {
          return;
        }
        finished = true;
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', finish);
        handle.removeEventListener('pointercancel', finish);
        handle.removeEventListener('lostpointercapture', finish);
        activeResizeCleanups.delete(finish);
        try {
          if (handle.hasPointerCapture(pointerId)) {
            handle.releasePointerCapture(pointerId);
          }
        } catch {
          // The OS may already have revoked capture while the window was being hidden.
        } finally {
          if (activeResizeCleanups.size === 0) {
            document.body.classList.remove('is-resizing');
            views.debounceTerminalFit();
          }
        }
      };

      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', finish);
      handle.addEventListener('pointercancel', finish);
      handle.addEventListener('lostpointercapture', finish);
      activeResizeCleanups.add(finish);
      document.body.classList.add('is-resizing');
      try {
        handle.setPointerCapture(pointerId);
      } catch {
        finish();
      }
    });
    handle.addEventListener('keydown', (event) => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') {
        return;
      }
      event.preventDefault();
      const delta = event.key === 'ArrowRight' ? 12 : -12;
      apply(current() + delta * direction);
    });
  };

  const storedPanelWidth = Number(localStorage.getItem('claudedock.panelWidth'));
  const storedDrawerWidth = Number(localStorage.getItem('claudedock.drawerWidth'));
  if (Number.isFinite(storedPanelWidth) && storedPanelWidth > 0) {
    setPanelWidth(storedPanelWidth);
  }
  if (Number.isFinite(storedDrawerWidth) && storedDrawerWidth > 0) {
    setDrawerWidth(storedDrawerWidth);
  }
  installResizer(
    elements.panelResizer,
    () => document.querySelector<HTMLElement>('.control-panel')?.offsetWidth ?? 320,
    setPanelWidth,
    1,
  );
  installResizer(
    elements.drawerResizer,
    () => dependencies.getClaudeWorkbench().getBoundingClientRect().width,
    setDrawerWidth,
    -1,
  );
  window.addEventListener('resize', () => {
    setPanelWidth(document.querySelector<HTMLElement>('.control-panel')?.offsetWidth ?? 320);
    setDrawerWidth(dependencies.getClaudeWorkbench().getBoundingClientRect().width || 468);
  });

  return {
    cancelActiveResizes,
  };
};
