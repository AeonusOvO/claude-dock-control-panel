import { describe, expect, it, vi } from 'vitest';
import { settle, withTerminalRenderer } from '../helpers/renderer-interaction-fixture';
import { terminalStatus, terminalWorkspace } from '../helpers/renderer-terminal-fixture';

describe('terminal paste ownership', () => {
  it('routes Ctrl+V through one generation-fenced xterm paste', async () => {
    await withTerminalRenderer(
      { readClipboardText: async () => 'first\nsecond' },
      async (harness, control) => {
        const terminal = control.terminals[0]!;
        const handler = terminal.customKeyHandlers[0]!;
        const event = new harness.dom.window.KeyboardEvent('keydown', {
          bubbles: true,
          cancelable: true,
          code: 'KeyV',
          ctrlKey: true,
        });
        const stopPropagation = vi.spyOn(event, 'stopPropagation');
        const stopImmediatePropagation = vi.spyOn(event, 'stopImmediatePropagation');

        expect(handler(event as unknown as KeyboardEvent)).toBe(false);
        await settle(harness);

        expect(event.defaultPrevented).toBe(true);
        expect(stopPropagation).toHaveBeenCalledOnce();
        expect(stopImmediatePropagation).toHaveBeenCalledOnce();
        expect(harness.method('readClipboardText')).toHaveBeenCalledOnce();
        expect(terminal.pasteCalls).toEqual(['first\nsecond']);
        expect(harness.method('writeTerminal')).toHaveBeenCalledTimes(1);
        expect(harness.method('writeTerminal')).toHaveBeenCalledWith(
          'session-1',
          1,
          'first\rsecond',
        );

        const repeated = new harness.dom.window.KeyboardEvent('keydown', {
          bubbles: true,
          cancelable: true,
          code: 'KeyV',
          ctrlKey: true,
          repeat: true,
        });
        expect(handler(repeated as unknown as KeyboardEvent)).toBe(false);
        await settle(harness);
        expect(repeated.defaultPrevented).toBe(true);
        expect(harness.method('readClipboardText')).toHaveBeenCalledOnce();
        expect(harness.method('writeTerminal')).toHaveBeenCalledTimes(1);
      },
    );
  });

  it('leaves AltGr, Ctrl+Alt, Ctrl+Shift, Ctrl+Meta and Meta V chords to xterm', async () => {
    await withTerminalRenderer({}, async (harness, control) => {
      const handler = control.terminals[0]!.customKeyHandlers[0]!;
      const modifiedEvents = [
        new harness.dom.window.KeyboardEvent('keydown', {
          altKey: true,
          bubbles: true,
          cancelable: true,
          code: 'KeyV',
          ctrlKey: true,
        }),
        new harness.dom.window.KeyboardEvent('keydown', {
          bubbles: true,
          cancelable: true,
          code: 'KeyV',
          ctrlKey: true,
          shiftKey: true,
        }),
        new harness.dom.window.KeyboardEvent('keydown', {
          bubbles: true,
          cancelable: true,
          code: 'KeyV',
          ctrlKey: true,
          metaKey: true,
        }),
        new harness.dom.window.KeyboardEvent('keydown', {
          bubbles: true,
          cancelable: true,
          code: 'KeyV',
          metaKey: true,
        }),
      ];
      const altGraphEvent = new harness.dom.window.KeyboardEvent('keydown', {
        bubbles: true,
        cancelable: true,
        code: 'KeyV',
        ctrlKey: true,
      });
      vi.spyOn(altGraphEvent, 'getModifierState').mockImplementation(
        (modifier) => modifier === 'AltGraph',
      );
      modifiedEvents.push(altGraphEvent);

      for (const event of modifiedEvents) {
        expect(handler(event as unknown as KeyboardEvent)).toBe(true);
        expect(event.defaultPrevented).toBe(false);
      }
      await settle(harness);

      expect(harness.method('readClipboardText')).not.toHaveBeenCalled();
      expect(harness.method('writeTerminal')).not.toHaveBeenCalled();
    });
  });

  it('owns right-click and keeps its delayed menu paste valid after hiding the clicked menu', async () => {
    let resolveClipboard: ((text: string) => void) | undefined;
    const clipboard = new Promise<string>((resolve) => {
      resolveClipboard = resolve;
    });
    await withTerminalRenderer({ readClipboardText: () => clipboard }, async (harness, control) => {
      const terminal = control.terminals[0]!;
      terminal.bracketedPasteMode = true;
      const container = harness.query<HTMLElement>('.project-terminal--active');
      const target = harness.document.createElement('div');
      const xtermMouseDown = vi.fn();
      const xtermContextMenu = vi.fn();
      target.addEventListener('mousedown', xtermMouseDown);
      target.addEventListener('contextmenu', xtermContextMenu);
      container.append(target);
      const mouseDown = new harness.dom.window.MouseEvent('mousedown', {
        bubbles: true,
        button: 2,
        cancelable: true,
      });
      const event = new harness.dom.window.MouseEvent('contextmenu', {
        bubbles: true,
        button: 2,
        cancelable: true,
        clientX: 40,
        clientY: 80,
      });

      target.dispatchEvent(mouseDown);
      target.dispatchEvent(event);

      expect(mouseDown.defaultPrevented).toBe(true);
      expect(event.defaultPrevented).toBe(true);
      expect(xtermMouseDown).not.toHaveBeenCalled();
      expect(xtermContextMenu).not.toHaveBeenCalled();
      expect(harness.method('writeTerminal')).not.toHaveBeenCalled();
      expect(harness.query('#terminal-context-menu').hidden).toBe(false);

      harness.click('[data-terminal-context-action="paste"]');
      expect(harness.query('#terminal-context-menu').hidden).toBe(true);
      resolveClipboard?.('first\r\nsecond');
      await settle(harness);

      expect(terminal.pasteCalls).toEqual(['first\r\nsecond']);
      expect(harness.method('writeTerminal')).toHaveBeenCalledTimes(1);
      const escape = String.fromCharCode(27);
      expect(harness.method('writeTerminal')).toHaveBeenCalledWith(
        'session-1',
        1,
        `${escape}[200~first\rsecond${escape}[201~`,
      );
      expect(harness.query('#terminal-context-menu').hidden).toBe(true);
    });
  });

  it('drops a delayed menu paste when another context-menu target replaces its owner', async () => {
    let resolveClipboard: ((text: string) => void) | undefined;
    const clipboard = new Promise<string>((resolve) => {
      resolveClipboard = resolve;
    });
    await withTerminalRenderer({ readClipboardText: () => clipboard }, async (harness, control) => {
      const firstStatus = terminalStatus();
      const secondStatus = terminalStatus(1, {
        cwd: 'D:\\Other',
        id: 'session-2',
        title: 'Other',
      });
      const workspace = terminalWorkspace(firstStatus);
      workspace.sessions.push(secondStatus);
      workspace.projects[0]!.sessionIds.push(secondStatus.id);
      harness.emit('onWorkspaceState', workspace);
      await settle(harness);

      const firstContainer = harness.query<HTMLElement>(
        '.project-terminal[data-session-id="session-1"]',
      );
      const secondContainer = harness.query<HTMLElement>(
        '.project-terminal[data-session-id="session-2"]',
      );
      firstContainer.dispatchEvent(
        new harness.dom.window.MouseEvent('contextmenu', {
          bubbles: true,
          button: 2,
          cancelable: true,
        }),
      );
      harness.click('[data-terminal-context-action="paste"]');
      expect(harness.query('#terminal-context-menu').hidden).toBe(true);

      secondContainer.dispatchEvent(
        new harness.dom.window.MouseEvent('contextmenu', {
          bubbles: true,
          button: 2,
          cancelable: true,
        }),
      );
      expect(harness.query('#terminal-context-menu').hidden).toBe(false);
      resolveClipboard?.('stale');
      await settle(harness);

      expect(harness.method('readClipboardText')).toHaveBeenCalledOnce();
      expect(control.terminals).toHaveLength(2);
      expect(control.terminals[0]!.pasteCalls).toEqual([]);
      expect(control.terminals[1]!.pasteCalls).toEqual([]);
      expect(harness.method('writeTerminal')).not.toHaveBeenCalled();
    });
  });

  it('drops delayed paste work and stale context-menu targets after PTY replacement', async () => {
    let resolveClipboard: ((text: string) => void) | undefined;
    const clipboard = new Promise<string>((resolve) => {
      resolveClipboard = resolve;
    });
    await withTerminalRenderer({ readClipboardText: () => clipboard }, async (harness, control) => {
      const first = control.terminals[0]!;
      const handler = first.customKeyHandlers[0]!;
      const keyEvent = new harness.dom.window.KeyboardEvent('keydown', {
        bubbles: true,
        cancelable: true,
        code: 'KeyV',
        ctrlKey: true,
      });
      expect(handler(keyEvent as unknown as KeyboardEvent)).toBe(false);

      const container = harness.query<HTMLElement>('.project-terminal--active');
      container.dispatchEvent(
        new harness.dom.window.MouseEvent('contextmenu', {
          bubbles: true,
          button: 2,
          cancelable: true,
        }),
      );
      harness.emit('onWorkspaceState', terminalWorkspace(terminalStatus(2)));
      await settle(harness);
      expect(harness.query('#terminal-context-menu').hidden).toBe(true);
      const detachedMouseDown = new harness.dom.window.MouseEvent('mousedown', {
        bubbles: true,
        button: 2,
        cancelable: true,
      });
      const detachedContextMenu = new harness.dom.window.MouseEvent('contextmenu', {
        bubbles: true,
        button: 2,
        cancelable: true,
      });
      container.dispatchEvent(detachedMouseDown);
      container.dispatchEvent(detachedContextMenu);
      expect(detachedMouseDown.defaultPrevented).toBe(false);
      expect(detachedContextMenu.defaultPrevented).toBe(false);
      expect(harness.query('#terminal-context-menu').hidden).toBe(true);
      harness.click('[data-terminal-context-action="paste"]');
      resolveClipboard?.('stale');
      await settle(harness);

      expect(harness.method('readClipboardText')).toHaveBeenCalledOnce();
      expect(first.pasteCalls).toEqual([]);
      expect(first.focused).toBe(false);
      expect(harness.method('writeTerminal')).not.toHaveBeenCalled();
    });
  });
});
