import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  installSessionSettings,
  sessionSettingsOverflowForWidths,
} from '../../src/renderer/shell/footer/session-settings';
import { rendererStyles } from '../helpers/renderer-css';
import { rendererMarkup } from '../helpers/renderer-harness';

describe('session settings markup and responsive ownership', () => {
  it('replaces the numeric more-status control with one accessible disclosure', () => {
    const dom = new JSDOM(rendererMarkup);
    const trigger = dom.window.document.getElementById('footer-session-settings')!;
    const region = dom.window.document.getElementById('footer-session-settings-region')!;

    expect(trigger.textContent?.replaceAll(/\s+/gu, ' ').trim()).toBe('会话设置');
    expect(trigger.textContent).not.toContain('4');
    expect(trigger.getAttribute('aria-controls')).toBe(region.id);
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(region.getAttribute('role')).toBe('group');
    expect(region.getAttribute('aria-label')).toBe('会话设置');
    expect(region.querySelectorAll(':scope > button')).toHaveLength(4);
    expect(dom.window.document.getElementById('footer-more')).toBeNull();

    dom.window.close();
  });

  it('keeps the wide region inline and uses measured overflow to turn it into a popup', () => {
    expect(rendererStyles).toMatch(
      /\.terminal-footer__core,\s*\.terminal-footer__secondary\s*\{[^}]*display:\s*flex;/su,
    );
    expect(rendererStyles).toMatch(
      /\.terminal-footer__session-settings\s*\{[^}]*display:\s*inline-flex;[^}]*opacity:\s*0;/su,
    );
    expect(rendererStyles).toMatch(
      /\.terminal-footer\[data-session-settings-overflow='true'\] \.terminal-footer__session-settings\s*\{[^}]*opacity:\s*1;/u,
    );
    expect(rendererStyles).toMatch(
      /\.terminal-footer\[data-session-settings-overflow='true'\] \.terminal-footer__secondary\s*\{[^}]*position:\s*absolute;[^}]*visibility:\s*hidden;/u,
    );
    expect(rendererStyles).toMatch(
      /data-session-settings-overflow='true'[\s\S]*?\.terminal-footer__secondary\[data-open='true'\]\s*\{[^}]*visibility:\s*visible;/u,
    );
    expect(sessionSettingsOverflowForWidths(900, 900)).toBe(false);
    expect(sessionSettingsOverflowForWidths(899, 901)).toBe(true);
  });
});

describe('session settings interaction', () => {
  let dom: JSDOM;
  let trigger: HTMLButtonElement;
  let region: HTMLElement;
  let settings: HTMLButtonElement[];
  let modelPopup: HTMLElement;
  let outside: HTMLButtonElement;

  beforeEach(() => {
    dom = new JSDOM(
      `<!doctype html>
      <button id="trigger" aria-controls="region" aria-expanded="false">会话设置</button>
      <div id="region" data-open="false" role="group" aria-label="会话设置">
        <button id="model">模型</button>
        <button id="speed">速度</button>
        <button id="mode">模式</button>
        <button id="effort">思考</button>
      </div>
      <div id="model-popup" hidden><button>模型选项</button></div>
      <button id="outside">外部</button>`,
      { pretendToBeVisual: true, url: 'http://localhost/' },
    );
    trigger = dom.window.document.getElementById('trigger') as HTMLButtonElement;
    region = dom.window.document.getElementById('region')!;
    settings = Array.from(region.querySelectorAll<HTMLButtonElement>('button'));
    modelPopup = dom.window.document.getElementById('model-popup')!;
    outside = dom.window.document.getElementById('outside') as HTMLButtonElement;
  });

  afterEach(() => {
    dom.window.close();
  });

  const install = () =>
    installSessionSettings({
      document: dom.window.document,
      ownedPopups: [modelPopup],
      region,
      trigger,
      window: dom.window,
    });

  it('toggles on every click without consulting matchMedia', () => {
    Object.defineProperty(dom.window, 'matchMedia', {
      configurable: true,
      value: () => {
        throw new Error('responsive authority belongs to CSS');
      },
    });
    const controller = install();

    trigger.click();
    expect(controller.isOpen()).toBe(true);
    expect(region.dataset.open).toBe('true');
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(trigger.title).toBe('收起会话设置');

    trigger.click();
    expect(controller.isOpen()).toBe(false);
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(trigger.title).toBe('展开会话设置');

    controller.dispose();
  });

  it('supports Arrow navigation and Escape with focus returned to the trigger', () => {
    const controller = install();
    trigger.focus();
    trigger.dispatchEvent(
      new dom.window.KeyboardEvent('keydown', { bubbles: true, key: 'ArrowDown' }),
    );

    expect(controller.isOpen()).toBe(true);
    expect(dom.window.document.activeElement).toBe(settings[0]);

    settings[0]!.dispatchEvent(
      new dom.window.KeyboardEvent('keydown', { bubbles: true, key: 'ArrowRight' }),
    );
    expect(dom.window.document.activeElement).toBe(settings[1]);

    settings[1]!.dispatchEvent(
      new dom.window.KeyboardEvent('keydown', { bubbles: true, key: 'End' }),
    );
    expect(dom.window.document.activeElement).toBe(settings[3]);

    settings[3]!.dispatchEvent(
      new dom.window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Escape' }),
    );
    expect(controller.isOpen()).toBe(false);
    expect(dom.window.document.activeElement).toBe(trigger);

    controller.dispose();
  });

  it('dismisses on an outside pointerdown but not inside its owned option popup', () => {
    const controller = install();
    controller.setOpen(true);
    modelPopup.hidden = false;

    modelPopup
      .querySelector('button')!
      .dispatchEvent(new dom.window.MouseEvent('pointerdown', { bubbles: true }));
    expect(controller.isOpen()).toBe(true);

    outside.dispatchEvent(new dom.window.MouseEvent('pointerdown', { bubbles: true }));
    expect(controller.isOpen()).toBe(false);

    controller.dispose();
  });

  it('lets an open child menu consume the first Escape before closing the settings region', () => {
    const controller = install();
    controller.setOpen(true);
    modelPopup.hidden = false;
    settings[0]!.focus();

    settings[0]!.dispatchEvent(
      new dom.window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Escape' }),
    );
    expect(controller.isOpen()).toBe(true);

    modelPopup.hidden = true;
    settings[0]!.dispatchEvent(
      new dom.window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Escape' }),
    );
    expect(controller.isOpen()).toBe(false);
    expect(dom.window.document.activeElement).toBe(trigger);

    controller.dispose();
  });

  it('installs and disposes idempotently without duplicate click handlers', () => {
    const first = install();
    expect(install()).toBe(first);

    trigger.click();
    expect(region.dataset.open).toBe('true');
    first.dispose();
    first.dispose();

    trigger.click();
    expect(region.dataset.open).toBe('false');

    const second = install();
    expect(second).not.toBe(first);
    trigger.click();
    expect(region.dataset.open).toBe('true');

    second.dispose();
  });

  it('enters and exits compact mode from the footer actual available width', () => {
    const measured = new JSDOM(
      `<!doctype html><footer class="terminal-footer">
        <div class="terminal-footer__core"><button>连接</button><button>资源</button></div>
        <div class="terminal-footer__secondary" id="measured-region" data-open="false">
          <button>模型</button><button>速度</button><button>模式</button><button>思考</button>
        </div>
        <div class="terminal-footer__group--status">
          <span id="footer-status">后台待命</span>
          <button id="measured-trigger" aria-expanded="false">会话设置</button>
        </div>
      </footer>`,
      { pretendToBeVisual: true },
    );
    const footer = measured.window.document.querySelector<HTMLElement>('footer')!;
    const measuredRegion = measured.window.document.getElementById('measured-region')!;
    const measuredTrigger = measured.window.document.getElementById(
      'measured-trigger',
    ) as HTMLButtonElement;
    let availableWidth = 500;
    Object.defineProperty(footer, 'clientWidth', { get: () => availableWidth });
    for (const child of measured.window.document.querySelectorAll<HTMLElement>(
      'button, #footer-status',
    )) {
      Object.defineProperty(child, 'scrollWidth', {
        configurable: true,
        value: child === measuredTrigger ? 90 : 50,
      });
    }
    const controller = installSessionSettings({
      document: measured.window.document,
      region: measuredRegion,
      trigger: measuredTrigger,
      window: measured.window,
    });

    expect(controller.isOverflowing()).toBe(false);
    expect(measuredTrigger.getAttribute('aria-hidden')).toBe('true');
    availableWidth = 280;
    controller.refreshLayout();
    expect(controller.isOverflowing()).toBe(true);
    expect(footer.dataset.sessionSettingsOverflow).toBe('true');
    expect(measuredTrigger.tabIndex).toBe(0);

    controller.setOpen(true);
    availableWidth = 600;
    controller.refreshLayout();
    expect(controller.isOverflowing()).toBe(false);
    expect(controller.isOpen()).toBe(false);
    expect(measuredTrigger.tabIndex).toBe(-1);

    controller.dispose();
    measured.window.close();
  });
});
