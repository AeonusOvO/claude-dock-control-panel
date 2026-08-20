import {
  claudeContextWindowCustomField,
  footerEffort,
  footerEffortMenu,
  footerMode,
  footerModeMenu,
  footerModel,
  footerModelMenu,
  footerMore,
  footerResource,
  footerResourceMenu,
  footerSecondaryStatus,
  footerSpeed,
  footerSpeedMenu,
} from './elements';
import { footerState } from './state';

export interface FooterMenusFrameworkActions {
  hideFooterMenus: () => void;
  setFooterSecondaryOpen: (open: boolean) => void;
  openFooterMenu: (menu: HTMLElement, trigger: HTMLButtonElement) => void;
  buildFooterMenuItem: (
    label: string,
    detail: string,
    selected: boolean,
    onChoose: () => Promise<void>,
    disabled?: boolean,
    triggerButton?: HTMLButtonElement,
  ) => HTMLButtonElement;
  buildFooterRadioMenuItem: (
    label: string,
    detail: string,
    selected: boolean,
    onChoose: () => Promise<void>,
    disabled?: boolean,
    triggerButton?: HTMLButtonElement,
  ) => HTMLButtonElement;
}

export const createFooterMenusFrameworkActions = (): FooterMenusFrameworkActions => {
  const hideFooterMenus = (): void => {
    footerState.claudeContextWindowCustomDraftOpen = false;
    claudeContextWindowCustomField.hidden = footerState.claudeContextWindowMode !== 'custom';
    for (const [menu, trigger] of [
      [footerResourceMenu, footerResource],
      [footerModelMenu, footerModel],
      [footerSpeedMenu, footerSpeed],
      [footerModeMenu, footerMode],
      [footerEffortMenu, footerEffort],
    ] as const) {
      menu.hidden = true;
      trigger.setAttribute('aria-expanded', 'false');
    }
  };

  const setFooterSecondaryOpen = (open: boolean): void => {
    const compact = window.matchMedia('(max-width: 1024px)').matches;
    const next = open && compact;
    footerSecondaryStatus.dataset.open = String(next);
    footerMore.setAttribute('aria-expanded', String(next));
  };

  /**
   * Anchors a footer menu above its button. The footer sits at the very bottom, so the menu always
   * opens upward; both axes are still clamped so a narrow window cannot push it off-screen.
   */
  const openFooterMenu = (menu: HTMLElement, trigger: HTMLButtonElement): void => {
    hideFooterMenus();
    menu.hidden = false;
    trigger.setAttribute('aria-expanded', 'true');
    const triggerRect = trigger.getBoundingClientRect();
    menu.style.left = `${Math.max(8, Math.min(triggerRect.left, window.innerWidth - menu.offsetWidth - 8))}px`;
    menu.style.top = `${Math.max(8, triggerRect.top - menu.offsetHeight - 8)}px`;
    menu.querySelector<HTMLButtonElement>('button:not([disabled])')?.focus();
  };

  const buildFooterMenuItem = (
    label: string,
    detail: string,
    selected: boolean,
    onChoose: () => Promise<void>,
    disabled = false,
    triggerButton?: HTMLButtonElement,
  ): HTMLButtonElement => {
    const item = document.createElement('button');
    item.type = 'button';
    item.role = 'menuitem';
    item.disabled = disabled;
    item.dataset.selected = String(selected);
    const title = document.createElement('strong');
    title.textContent = label;
    const hint = document.createElement('small');
    hint.textContent = detail;
    item.append(title, hint);
    item.addEventListener('click', () => {
      hideFooterMenus();
      void onChoose().finally(() => {
        triggerButton?.focus();
      });
    });
    return item;
  };

  const buildFooterRadioMenuItem = (
    label: string,
    detail: string,
    selected: boolean,
    onChoose: () => Promise<void>,
    disabled = false,
    triggerButton?: HTMLButtonElement,
  ): HTMLButtonElement => {
    const item = buildFooterMenuItem(label, detail, selected, onChoose, disabled, triggerButton);
    item.role = 'menuitemradio';
    item.setAttribute('aria-checked', String(selected));
    return item;
  };

  return {
    hideFooterMenus,
    setFooterSecondaryOpen,
    openFooterMenu,
    buildFooterMenuItem,
    buildFooterRadioMenuItem,
  };
};
