export interface SessionSettingsController {
  dispose: () => void;
  isOverflowing: () => boolean;
  isOpen: () => boolean;
  refreshLayout: () => void;
  setOpen: (open: boolean) => void;
  toggle: () => void;
}

export const sessionSettingsOverflowForWidths = (
  availableWidth: number,
  requiredWidth: number,
): boolean => availableWidth > 0 && requiredWidth > availableWidth + 1;

export interface SessionSettingsElements {
  readonly document: Document;
  readonly ownedPopups?: readonly HTMLElement[];
  readonly region: HTMLElement;
  readonly trigger: HTMLButtonElement;
  readonly window: Pick<Window, 'addEventListener' | 'removeEventListener'>;
}

const controllers = new WeakMap<HTMLButtonElement, SessionSettingsController>();

const focusableSettings = (region: HTMLElement): HTMLButtonElement[] =>
  Array.from(region.querySelectorAll<HTMLButtonElement>('button:not([disabled])'));

const isNode = (target: EventTarget | null): target is Node =>
  target !== null && typeof (target as Partial<Node>).nodeType === 'number';

/**
 * Installs the disclosure behavior for the four existing session controls.
 *
 * Actual footer content decides whether the controlled region is inline or a popup. This accounts
 * for sidebars, drawers, localization and zoom instead of guessing from the viewport width.
 */
export const installSessionSettings = ({
  document: targetDocument,
  ownedPopups = [],
  region,
  trigger,
  window: targetWindow,
}: SessionSettingsElements): SessionSettingsController => {
  const existing = controllers.get(trigger);
  if (existing) return existing;

  let disposed = false;
  const footer = region.parentElement;
  const core = footer?.querySelector<HTMLElement>('.terminal-footer__core');
  const status = footer?.querySelector<HTMLElement>('#footer-status');
  let overflowing = false;

  const numericStyle = (value: string): number => Number.parseFloat(value) || 0;
  const naturalGroupWidth = (group: HTMLElement): number => {
    const children = Array.from(group.children, (child) => child as HTMLElement).filter(
      (child) => child !== trigger,
    );
    const gap = numericStyle(targetDocument.defaultView?.getComputedStyle(group).columnGap ?? '0');
    return (
      children.reduce(
        (total, child) => total + Math.max(child.scrollWidth, child.getBoundingClientRect().width),
        0,
      ) +
      Math.max(0, children.length - 1) * gap
    );
  };

  const refreshLayout = (): void => {
    if (disposed || !footer || !core || !status) return;
    const initialized = footer.dataset.sessionSettingsOverflow !== undefined;
    // Measure the complete inline footer, even when the current rendered state is the popup. The
    // attribute is restored before the browser can paint, so this does not flash the wide layout.
    delete footer.dataset.sessionSettingsOverflow;
    const footerStyle = targetDocument.defaultView?.getComputedStyle(footer);
    const availableWidth =
      footer.clientWidth -
      numericStyle(footerStyle?.paddingLeft ?? '0') -
      numericStyle(footerStyle?.paddingRight ?? '0');
    const footerGap = numericStyle(footerStyle?.columnGap ?? '0');
    const requiredWidth =
      naturalGroupWidth(core) +
      naturalGroupWidth(region) +
      Math.max(status.scrollWidth, status.getBoundingClientRect().width) +
      footerGap * 2;
    const next = sessionSettingsOverflowForWidths(availableWidth, requiredWidth);
    if (next === overflowing && initialized) {
      footer.dataset.sessionSettingsOverflow = String(next);
      return;
    }
    overflowing = next;
    footer.dataset.sessionSettingsOverflow = String(next);
    trigger.setAttribute('aria-hidden', String(!next));
    trigger.tabIndex = next ? 0 : -1;
    if (!next) setOpen(false);
  };

  const isOpen = (): boolean => region.dataset.open === 'true';

  const setOpen = (open: boolean): void => {
    if (disposed) return;
    region.dataset.open = String(open);
    trigger.setAttribute('aria-expanded', String(open));
    trigger.title = open ? '收起会话设置' : '展开会话设置';
  };

  const toggle = (): void => {
    setOpen(!isOpen());
  };

  const popupIsOpen = (): boolean => ownedPopups.some((popup) => !popup.hidden);

  const focusSetting = (index: number): void => {
    const settings = focusableSettings(region);
    if (settings.length === 0) return;
    settings[(index + settings.length) % settings.length]!.focus();
  };

  const onTriggerClick = (event: MouseEvent): void => {
    toggle();
    if (isOpen() && event.detail === 0) focusSetting(0);
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;

    if (event.target === trigger) {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setOpen(true);
        focusSetting(0);
      } else if (event.key === 'Escape' && isOpen()) {
        event.preventDefault();
        setOpen(false);
        trigger.focus();
      }
      return;
    }

    if (!isNode(event.target) || !region.contains(event.target)) return;
    if (event.key === 'Escape') {
      // The first Escape belongs to an option menu opened by one of the four setting triggers. The
      // footer-menu handler closes that menu and restores focus; a second Escape closes this region.
      if (popupIsOpen()) return;
      event.preventDefault();
      setOpen(false);
      trigger.focus();
      return;
    }
    if (popupIsOpen()) return;

    const settings = focusableSettings(region);
    const currentIndex = settings.indexOf(targetDocument.activeElement as HTMLButtonElement);
    if (currentIndex < 0) return;

    if (event.key === 'ArrowDown' || event.key === 'ArrowRight') {
      event.preventDefault();
      focusSetting(currentIndex + 1);
    } else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') {
      event.preventDefault();
      focusSetting(currentIndex - 1);
    } else if (event.key === 'Home') {
      event.preventDefault();
      focusSetting(0);
    } else if (event.key === 'End') {
      event.preventDefault();
      focusSetting(settings.length - 1);
    }
  };

  const onPointerDown = (event: PointerEvent): void => {
    const target = event.target;
    if (!isNode(target)) return;
    if (trigger.contains(target) || region.contains(target)) return;
    if (ownedPopups.some((popup) => popup.contains(target))) return;
    setOpen(false);
  };

  const onWindowBlur = (): void => {
    setOpen(false);
  };

  const dispose = (): void => {
    if (disposed) return;
    trigger.removeEventListener('click', onTriggerClick);
    targetDocument.removeEventListener('keydown', onKeyDown);
    targetDocument.removeEventListener('pointerdown', onPointerDown);
    targetWindow.removeEventListener('blur', onWindowBlur);
    targetWindow.removeEventListener('resize', refreshLayout);
    targetWindow.removeEventListener('beforeunload', dispose);
    region.dataset.open = 'false';
    trigger.setAttribute('aria-expanded', 'false');
    resizeObserver?.disconnect();
    mutationObserver?.disconnect();
    disposed = true;
    if (controllers.get(trigger)?.dispose === dispose) controllers.delete(trigger);
  };

  const view = targetDocument.defaultView;
  const ResizeObserverConstructor = view?.ResizeObserver;
  const resizeObserver = ResizeObserverConstructor
    ? new ResizeObserverConstructor(refreshLayout)
    : undefined;
  resizeObserver?.observe(footer ?? region);
  if (core) resizeObserver?.observe(core);
  resizeObserver?.observe(region);
  if (status) resizeObserver?.observe(status);
  const MutationObserverConstructor = view?.MutationObserver;
  const mutationObserver = MutationObserverConstructor
    ? new MutationObserverConstructor(refreshLayout)
    : undefined;
  mutationObserver?.observe(region, { characterData: true, childList: true, subtree: true });
  if (core)
    mutationObserver?.observe(core, { characterData: true, childList: true, subtree: true });
  if (status)
    mutationObserver?.observe(status, { characterData: true, childList: true, subtree: true });

  const controller: SessionSettingsController = {
    dispose,
    isOverflowing: () => overflowing,
    isOpen,
    refreshLayout,
    setOpen,
    toggle,
  };
  controllers.set(trigger, controller);
  trigger.addEventListener('click', onTriggerClick);
  targetDocument.addEventListener('keydown', onKeyDown);
  targetDocument.addEventListener('pointerdown', onPointerDown);
  targetWindow.addEventListener('blur', onWindowBlur);
  targetWindow.addEventListener('resize', refreshLayout);
  targetWindow.addEventListener('beforeunload', dispose, { once: true });
  setOpen(isOpen());
  refreshLayout();
  return controller;
};
