import { describe, expect, it } from 'vitest';
import type { WorkspaceResult } from '../../src/shared/contracts';
import { settle, withTerminalRenderer } from '../helpers/renderer-interaction-fixture';
import { terminalWorkspace } from '../helpers/renderer-terminal-fixture';
import type { RendererHarness } from '../helpers/renderer-harness';

interface DropSpec {
  directory?: boolean;
  directoryMetadata?: boolean;
  name: string;
  path: string;
}

const dispatchTransfer = (
  harness: RendererHarness,
  targetSelector: string,
  specs: readonly DropSpec[],
  type: 'dragenter' | 'drop',
): void => {
  const files = specs.map(
    ({ name }) => new harness.dom.window.File(['dropped fixture'], name, { type: 'text/plain' }),
  );
  const items = files.map((file, index) => {
    const spec = specs[index];
    return {
      getAsFile: () => file,
      kind: 'file' as const,
      ...(spec?.directoryMetadata === false
        ? {}
        : { webkitGetAsEntry: () => ({ isDirectory: spec?.directory === true }) }),
    };
  });
  const event = new harness.dom.window.Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'dataTransfer', {
    configurable: true,
    value: { files, items },
  });
  harness.query(targetSelector).dispatchEvent(event);
};

const dispatchDrop = (
  harness: RendererHarness,
  targetSelector: string,
  specs: readonly DropSpec[],
): void => {
  dispatchTransfer(harness, targetSelector, specs, 'drop');
};

const closeDropConfirmation = async (
  harness: RendererHarness,
  returnValue: 'cancel' | 'confirm',
  suppress = false,
): Promise<void> => {
  const dialog = harness.query<HTMLDialogElement>('#confirmation-dialog');
  expect(dialog.open).toBe(true);
  const checkbox = harness.query<HTMLInputElement>('#confirmation-dialog-suppress');
  expect(checkbox.hidden).toBe(false);
  checkbox.checked = suppress;
  dialog.close(returnValue);
  await settle(harness);
};

const droppedPathMap = (specs: readonly DropSpec[]): Map<string, string> =>
  new Map(specs.map(({ name, path }) => [name, path]));

describe('Claude Code file and folder drops', () => {
  it('describes file drags in the overlay before the drop is committed', async () => {
    await withTerminalRenderer({}, async (harness) => {
      dispatchTransfer(
        harness,
        '#terminal-shell',
        [{ name: 'notes.md', path: 'D:\\workspace\\notes.md' }],
        'dragenter',
      );

      expect(harness.query('#drop-overlay').classList.contains('drop-overlay--visible')).toBe(true);
      expect(harness.query('#drop-overlay strong').textContent).toBe('松开以插入文件路径');
      expect(harness.query('#drop-overlay span').textContent).toContain('追加到当前 Claude Code');

      harness.document.dispatchEvent(new harness.dom.window.Event('dragleave'));
      expect(harness.query('#drop-overlay').classList.contains('drop-overlay--visible')).toBe(
        false,
      );
    });
  });

  it('rejects a drop when the host omits directory metadata', async () => {
    const file = {
      directoryMetadata: false,
      name: 'opaque.md',
      path: 'D:\\workspace\\opaque.md',
    };

    await withTerminalRenderer(
      { getDroppedPath: (dropped) => (dropped.name === file.name ? file.path : '') },
      async (harness) => {
        dispatchDrop(harness, '#terminal-shell', [file]);
        await harness.flush();

        expect(harness.query<HTMLDialogElement>('#confirmation-dialog').open).toBe(false);
        expect(harness.query('#toast').textContent).toContain('无法判断文件夹类型');
        expect(harness.query<HTMLTextAreaElement>('#composer-input').value).toBe('');
        expect(harness.method('writeTerminal')).not.toHaveBeenCalled();
      },
    );
  });

  it.each(['#terminal-shell', '#composer-input', '#footer-speed', '#claude-workbench'] as const)(
    'appends quoted paths without submitting when dropped on %s',
    async (target) => {
      const specs = [
        {
          name: "it's a report.md",
          path: "D:\\repo\\folder with space\\it's a report.md",
        },
        {
          name: '设计"稿.md',
          path: 'D:\\资料\\设计"稿.md',
        },
        {
          name: '报告.md',
          path: 'D:\\repo\\报告.md',
        },
      ];
      const paths = droppedPathMap(specs);

      await withTerminalRenderer(
        { getDroppedPath: (file) => paths.get(file.name) ?? '' },
        async (harness) => {
          const composer = harness.query<HTMLTextAreaElement>('#composer-input');
          composer.value = '请检查';
          composer.dispatchEvent(new harness.dom.window.Event('input', { bubbles: true }));
          harness.clearCalls();

          dispatchDrop(harness, target, specs);
          expect(harness.query<HTMLDialogElement>('#confirmation-dialog').open).toBe(true);
          expect(harness.query('#confirmation-dialog-message').textContent).toContain(
            '确认后只会修改提示词草稿',
          );
          expect(harness.query('#confirmation-dialog-message').textContent).toContain('设计"稿.md');
          await closeDropConfirmation(harness, 'confirm');

          expect(composer.value).toBe(
            "请检查 'D:\\repo\\folder with space\\it''s a report.md' 'D:\\资料\\设计\"稿.md' 'D:\\repo\\报告.md'",
          );
          expect(composer.selectionStart).toBe(composer.value.length);
          expect(harness.document.activeElement).toBe(composer);
          expect(harness.method('writeTerminal')).not.toHaveBeenCalled();
          expect(harness.query<HTMLFormElement>('#terminal-composer').checkValidity()).toBe(true);
        },
      );
    },
  );

  it('keeps folder drops on the existing add-project path and waits for confirmation', async () => {
    const folder = {
      directory: true,
      name: 'project-folder',
      path: 'D:\\workspace\\project-folder',
    };
    const paths = droppedPathMap([folder]);
    const workspace = terminalWorkspace();

    await withTerminalRenderer(
      {
        addProject: async (): Promise<WorkspaceResult> => ({
          ok: true,
          reused: true,
          state: workspace,
        }),
        getDroppedPath: (file) => paths.get(file.name) ?? '',
      },
      async (harness) => {
        harness.clearCalls();
        dispatchDrop(harness, '#claude-workbench', [folder]);
        expect(harness.method('addProject')).not.toHaveBeenCalled();
        await closeDropConfirmation(harness, 'confirm');

        expect(harness.method('addProject')).toHaveBeenCalledWith(folder.path);
        expect(harness.query<HTMLTextAreaElement>('#composer-input').value).toBe('');
        expect(harness.method('writeTerminal')).not.toHaveBeenCalled();
      },
    );
  });

  it('does not change the suppression setting when a drop is cancelled', async () => {
    const file = {
      name: 'cancelled.md',
      path: 'D:\\workspace\\cancelled.md',
    };
    const paths = droppedPathMap([file]);

    await withTerminalRenderer(
      { getDroppedPath: (dropped) => paths.get(dropped.name) ?? '' },
      async (harness) => {
        const composer = harness.query<HTMLTextAreaElement>('#composer-input');
        composer.value = '保留草稿';
        composer.dispatchEvent(new harness.dom.window.Event('input', { bubbles: true }));
        harness.clearCalls();

        dispatchDrop(harness, '#footer-speed', [file]);
        await closeDropConfirmation(harness, 'cancel', true);

        expect(composer.value).toBe('保留草稿');
        expect(harness.method('setAdvancedSettings')).not.toHaveBeenCalled();
        expect(harness.method('writeTerminal')).not.toHaveBeenCalled();
      },
    );
  });

  it('persists suppression only after confirmation and then skips later prompts', async () => {
    const first = { name: 'first.md', path: 'D:\\workspace\\first.md' };
    const second = { name: 'second.md', path: 'D:\\workspace\\second.md' };
    const paths = droppedPathMap([first, second]);

    await withTerminalRenderer(
      { getDroppedPath: (file) => paths.get(file.name) ?? '' },
      async (harness) => {
        const composer = harness.query<HTMLTextAreaElement>('#composer-input');
        dispatchDrop(harness, '#composer-input', [first]);
        await closeDropConfirmation(harness, 'confirm', true);

        expect(harness.method('setAdvancedSettings')).toHaveBeenCalledWith(
          expect.objectContaining({ confirmFileDrops: false }),
        );
        expect(composer.value).toContain("'D:\\workspace\\first.md'");

        harness.clearCalls();
        dispatchDrop(harness, '#workbench-trigger', [second]);
        await harness.flush();

        expect(harness.query<HTMLDialogElement>('#confirmation-dialog').open).toBe(false);
        expect(composer.value).toContain("'D:\\workspace\\second.md'");
        expect(harness.method('setAdvancedSettings')).not.toHaveBeenCalled();
      },
    );
  });

  it('does not persist suppression when a native path cannot be resolved', async () => {
    const file = { name: 'opaque.md', path: '' };

    await withTerminalRenderer({ getDroppedPath: () => '' }, async (harness) => {
      dispatchDrop(harness, '#terminal-shell', [file]);
      await closeDropConfirmation(harness, 'confirm', true);

      expect(harness.query('#toast').textContent).toContain('无法读取一个或多个拖入文件的路径');
      expect(harness.method('setAdvancedSettings')).not.toHaveBeenCalled();
    });
  });

  it('rejects mixed folders and files without opening a confirmation dialog', async () => {
    const specs = [
      { directory: true, name: 'folder', path: 'D:\\workspace\\folder' },
      { name: 'file.md', path: 'D:\\workspace\\file.md' },
    ];

    await withTerminalRenderer(
      { getDroppedPath: (file) => droppedPathMap(specs).get(file.name) ?? '' },
      async (harness) => {
        harness.clearCalls();
        dispatchDrop(harness, '#terminal-shell', specs);
        await harness.flush();

        expect(harness.query<HTMLDialogElement>('#confirmation-dialog').open).toBe(false);
        expect(harness.query('#toast').textContent).toContain('混合拖放未执行');
        expect(harness.method('addProject')).not.toHaveBeenCalled();
        expect(harness.method('writeTerminal')).not.toHaveBeenCalled();
      },
    );
  });
});
