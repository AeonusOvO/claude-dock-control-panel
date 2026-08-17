import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import {
  handleFooterMenuEscape,
  handleFooterMenuArrowKey,
  type FooterMenuPair,
} from '../src/renderer/footer-keyboard';

describe('Footer menu keyboard navigation', () => {
  let dom: JSDOM;
  let document: Document;
  let footerResourceMenu: HTMLElement;
  let footerModelMenu: HTMLElement;
  let footerResource: HTMLButtonElement;
  let footerModel: HTMLButtonElement;
  let menuPairs: FooterMenuPair[];

  beforeEach(() => {
    // Create minimal DOM structure for footer menus with a valid URL to avoid localStorage errors
    dom = new JSDOM(
      `
      <!DOCTYPE html>
      <html>
        <body>
          <button id="footer-resource" aria-expanded="false"></button>
          <div id="footer-resource-menu" role="dialog" hidden>
            <div>静态详情文本</div>
            <button data-resource-preference="auto">自动</button>
            <button data-resource-preference="context">上下文优先</button>
            <button data-resource-preference="quota">额度优先</button>
          </div>
          <button id="footer-model" aria-expanded="false"></button>
          <div id="footer-model-menu" role="menu" hidden>
            <button data-model="opus">Opus</button>
            <button data-model="sonnet">Sonnet</button>
          </div>
        </body>
      </html>
    `,
      { url: 'http://localhost' },
    );
    document = dom.window.document;
    global.document = document as unknown as Document;
    global.window = dom.window as unknown as Window & typeof globalThis;

    footerResourceMenu = document.getElementById('footer-resource-menu')!;
    footerModelMenu = document.getElementById('footer-model-menu')!;
    footerResource = document.getElementById('footer-resource') as HTMLButtonElement;
    footerModel = document.getElementById('footer-model') as HTMLButtonElement;

    menuPairs = [
      { menu: footerResourceMenu, trigger: footerResource },
      { menu: footerModelMenu, trigger: footerModel },
    ];
  });

  afterEach(() => {
    dom.window.close();
  });

  it('should close footer menu on Escape and restore trigger focus', () => {
    // Open the menu
    footerResourceMenu.hidden = false;
    footerResource.setAttribute('aria-expanded', 'true');
    const firstButton = footerResourceMenu.querySelector('button')!;
    firstButton.focus();

    expect(document.activeElement).toBe(firstButton);

    // Call production handler
    const shouldPreventDefault = handleFooterMenuEscape(menuPairs);

    expect(shouldPreventDefault).toBe(true);
    expect(footerResourceMenu.hidden).toBe(true);
    expect(footerResource.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(footerResource);
  });

  it('should not close menu if no menu is open', () => {
    // All menus hidden
    footerResourceMenu.hidden = true;
    footerModelMenu.hidden = true;

    const shouldPreventDefault = handleFooterMenuEscape(menuPairs);

    expect(shouldPreventDefault).toBe(false);
  });

  it('should navigate down through menu items with ArrowDown', () => {
    footerResourceMenu.hidden = false;
    const buttons = Array.from(
      footerResourceMenu.querySelectorAll<HTMLButtonElement>('button:not([disabled])'),
    );
    expect(buttons.length).toBe(3);

    buttons[0]!.focus();
    expect(document.activeElement).toBe(buttons[0]);

    // Call production handler
    const shouldPreventDefault = handleFooterMenuArrowKey(
      menuPairs,
      'ArrowDown',
      document.activeElement,
    );

    expect(shouldPreventDefault).toBe(true);
    expect(document.activeElement).toBe(buttons[1]);
  });

  it('should navigate up through menu items with ArrowUp and wrap around', () => {
    footerResourceMenu.hidden = false;
    const buttons = Array.from(
      footerResourceMenu.querySelectorAll<HTMLButtonElement>('button:not([disabled])'),
    );

    buttons[0]!.focus();
    expect(document.activeElement).toBe(buttons[0]);

    // Call production handler - should wrap to last
    const shouldPreventDefault = handleFooterMenuArrowKey(
      menuPairs,
      'ArrowUp',
      document.activeElement,
    );

    expect(shouldPreventDefault).toBe(true);
    expect(document.activeElement).toBe(buttons[2]);
  });

  it('should not trigger navigation if focus is outside menu', () => {
    footerResourceMenu.hidden = false;

    // Focus is on a different element outside the menu
    footerModel.focus();
    expect(document.activeElement).toBe(footerModel);

    // Call production handler
    const shouldPreventDefault = handleFooterMenuArrowKey(
      menuPairs,
      'ArrowDown',
      document.activeElement,
    );

    expect(shouldPreventDefault).toBe(false);
    expect(document.activeElement).toBe(footerModel);
  });

  it('should skip disabled buttons during navigation', () => {
    // Add a disabled button between existing buttons
    const disabledButton = document.createElement('button');
    disabledButton.textContent = 'Disabled';
    disabledButton.disabled = true;
    footerResourceMenu.insertBefore(disabledButton, footerResourceMenu.children[2]!);

    footerResourceMenu.hidden = false;
    const enabledButtons = Array.from(
      footerResourceMenu.querySelectorAll<HTMLButtonElement>('button:not([disabled])'),
    );
    expect(enabledButtons.length).toBe(3); // Still 3 enabled buttons

    enabledButtons[0]!.focus();

    // Navigate down - should skip the disabled button
    handleFooterMenuArrowKey(menuPairs, 'ArrowDown', document.activeElement);

    expect(document.activeElement).toBe(enabledButtons[1]);
    expect((document.activeElement as HTMLButtonElement).disabled).toBe(false);
  });

  it('should not hijack arrow keys when focus is on a textbox', () => {
    // Add a textbox to the resource menu (simulating custom context window input)
    const textbox = document.createElement('input');
    textbox.type = 'number';
    textbox.id = 'custom-input';
    footerResourceMenu.appendChild(textbox);

    footerResourceMenu.hidden = false;
    textbox.focus();
    expect(document.activeElement).toBe(textbox);

    // Call production handler - should not navigate
    const shouldPreventDefault = handleFooterMenuArrowKey(
      menuPairs,
      'ArrowDown',
      document.activeElement,
    );

    expect(shouldPreventDefault).toBe(false);
    expect(document.activeElement).toBe(textbox); // Focus remains on textbox
  });

  it('should skip buttons inside hidden ancestor containers', () => {
    // Simulate resource menu with hidden context window options
    const hiddenGroup = document.createElement('div');
    hiddenGroup.setAttribute('hidden', '');
    hiddenGroup.id = 'hidden-context-options';

    const hiddenButton1 = document.createElement('button');
    hiddenButton1.textContent = 'Standard';
    const hiddenButton2 = document.createElement('button');
    hiddenButton2.textContent = 'Extended';

    hiddenGroup.appendChild(hiddenButton1);
    hiddenGroup.appendChild(hiddenButton2);

    // Insert hidden group between visible buttons
    const firstButton = footerResourceMenu.querySelector('button')!;
    footerResourceMenu.insertBefore(hiddenGroup, firstButton.nextSibling);

    footerResourceMenu.hidden = false;

    // Focus first visible button
    firstButton.focus();
    expect(document.activeElement).toBe(firstButton);

    // Navigate down - should skip hidden buttons and go directly to next visible button
    const navigated = handleFooterMenuArrowKey(menuPairs, 'ArrowDown', document.activeElement);

    expect(navigated).toBe(true);
    // Should jump over hidden buttons to "上下文优先"
    expect((document.activeElement as HTMLElement).textContent).toBe('上下文优先');
  });

  it('should skip buttons with aria-hidden ancestors', () => {
    const ariaHiddenGroup = document.createElement('div');
    ariaHiddenGroup.setAttribute('aria-hidden', 'true');

    const ariaHiddenButton = document.createElement('button');
    ariaHiddenButton.textContent = 'Hidden Option';
    ariaHiddenGroup.appendChild(ariaHiddenButton);

    // Insert after first button
    const firstButton = footerResourceMenu.querySelector('button')!;
    footerResourceMenu.insertBefore(ariaHiddenGroup, firstButton.nextSibling);

    footerResourceMenu.hidden = false;
    firstButton.focus();

    // Navigate down - should skip aria-hidden button
    const navigated = handleFooterMenuArrowKey(menuPairs, 'ArrowDown', document.activeElement);

    expect(navigated).toBe(true);
    expect((document.activeElement as HTMLElement).textContent).toBe('上下文优先');
  });

  it('should restore focus to trigger button after Escape closes menu', () => {
    // Open model menu
    footerModelMenu.hidden = false;
    footerModel.setAttribute('aria-expanded', 'true');
    const firstModelButton = footerModelMenu.querySelector('button')!;
    firstModelButton.focus();

    expect(document.activeElement).toBe(firstModelButton);

    // Close menu with Escape handler
    const closed = handleFooterMenuEscape(menuPairs);

    expect(closed).toBe(true);
    expect(footerModelMenu.hidden).toBe(true);
    expect(footerModel.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(footerModel); // Focus restored to trigger
  });
});
