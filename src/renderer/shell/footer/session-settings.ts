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
  readonly window: Pick<Window, 'addEventListener' | 'removeEventListener'> &
    Partial<Pick<Window, 'cancelAnimationFrame' | 'requestAnimationFrame'>>;
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
/* eslint-disable max-lines-per-function -- Disclosure, measurement, and observer cleanup share one DOM lifecycle. */
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
  const initialOverflowAttribute = footer?.dataset.sessionSettingsOverflow;
  let overflowing = initialOverflowAttribute === 'true';
  let layoutInitialized =
    initialOverflowAttribute === 'true' || initialOverflowAttribute === 'false';
  let refreshFrame: number | undefined;
  let fallbackRefreshQueued = false;

  const view = targetDocument.defaultView;
  const requestFrame =
    typeof targetWindow.requestAnimationFrame === 'function'
      ? targetWindow.requestAnimationFrame.bind(targetWindow)
      : undefined;
  const cancelFrame =
    typeof targetWindow.cancelAnimationFrame === 'function'
      ? targetWindow.cancelAnimationFrame.bind(targetWindow)
      : undefined;

  const numericStyle = (value: string): number => Number.parseFloat(value) || 0;
  const elementWidth = (element: HTMLElement): number =>
    Math.max(element.scrollWidth, element.getBoundingClientRect().width);
  const naturalGroupWidth = (group: HTMLElement, fallbackGroup?: HTMLElement): number => {
    const children = Array.from(group.children, (child) => child as HTMLElement).filter(
      (child) => child !== trigger,
    );
    const fallbackChildren = fallbackGroup
      ? Array.from(fallbackGroup.children, (child) => child as HTMLElement).filter(
          (child) => child !== trigger,
        )
      : [];
    const gap = numericStyle(targetDocument.defaultView?.getComputedStyle(group).columnGap ?? '0');
    return (
      children.reduce((total, child, index) => {
        const measured = elementWidth(child);
        const fallback = fallbackChildren[index];
        return total + (measured > 0 || !fallback ? measured : elementWidth(fallback));
      }, 0) +
      Math.max(0, children.length - 1) * gap
    );
  };

  // Keep a layout-only copy in the document. The visible footer must never be switched to the
  // inline layout just to measure it, because that intermediate style is what causes the popup to
  // flash during resize.
  const measurementHost = targetDocument.createElement('div');
  const measurementFooter = footer?.cloneNode(true) as HTMLElement | undefined;
  if (measurementFooter) {
    measurementHost.setAttribute('aria-hidden', 'true');
    measurementHost.style.contain = 'layout style';
    measurementHost.style.height = '0';
    measurementHost.style.left = '-100000px';
    measurementHost.style.overflow = 'visible';
    measurementHost.style.pointerEvents = 'none';
    measurementHost.style.position = 'fixed';
    measurementHost.style.top = '0';
    measurementHost.style.visibility = 'hidden';
    measurementHost.style.width = '0';
    measurementHost.append(measurementFooter);
    (targetDocument.body ?? targetDocument.documentElement).append(measurementHost);
  }

  const measurementElements = ():
    | {
        core: HTMLElement;
        region: HTMLElement;
        status: HTMLElement;
      }
    | undefined => {
    if (!footer || !measurementFooter || !core || !status) return undefined;
    measurementFooter.className = footer.className;
    measurementFooter.innerHTML = footer.innerHTML;
    measurementFooter.dataset.sessionSettingsOverflow = 'false';
    measurementFooter.style.boxSizing = 'border-box';
    measurementFooter.style.width = `${Math.max(0, footer.clientWidth)}px`;
    const measuredCore = measurementFooter.querySelector<HTMLElement>('.terminal-footer__core');
    const measuredRegion = measurementFooter.querySelector<HTMLElement>(
      '.terminal-footer__secondary',
    );
    const measuredStatus = measurementFooter.querySelector<HTMLElement>('#footer-status');
    if (!measuredCore || !measuredRegion || !measuredStatus) return undefined;
    return { core: measuredCore, region: measuredRegion, status: measuredStatus };
  };

  const isOpen = (): boolean => region.dataset.open === 'true';

  const setOpen = (open: boolean): void => {
    if (disposed) return;
    region.dataset.open = String(open);
    trigger.setAttribute('aria-expanded', String(open));
    trigger.title = open ? '收起会话设置' : '展开会话设置';
  };

  const updateTriggerAccessibility = (next: boolean): void => {
    trigger.setAttribute('aria-hidden', String(!next));
    trigger.tabIndex = next ? 0 : -1;
  };

  const applyOverflowState = (next: boolean): void => {
    if (layoutInitialized && next === overflowing) return;
    const wasOverflowing = overflowing;
    overflowing = next;
    layoutInitialized = true;
    if (footer) footer.dataset.sessionSettingsOverflow = String(next);
    updateTriggerAccessibility(next);
    if (wasOverflowing && !next && isOpen()) setOpen(false);
  };

  const refreshLayout = (): void => {
    if (disposed || !footer || !core || !status) return;
    const measured = measurementElements();
    const footerStyle = targetDocument.defaultView?.getComputedStyle(footer);
    const availableWidth =
      footer.clientWidth -
      numericStyle(footerStyle?.paddingLeft ?? '0') -
      numericStyle(footerStyle?.paddingRight ?? '0');
    const footerGap = numericStyle(footerStyle?.columnGap ?? '0');
    const requiredWidth = measured
      ? naturalGroupWidth(measured.core, core) +
        naturalGroupWidth(measured.region, region) +
        Math.max(elementWidth(measured.status), elementWidth(status)) +
        footerGap * 2
      : naturalGroupWidth(core) + naturalGroupWidth(region) + elementWidth(status) + footerGap * 2;
    applyOverflowState(sessionSettingsOverflowForWidths(availableWidth, requiredWidth));
  };

  const scheduleRefresh = (): void => {
    if (disposed) return;
    if (requestFrame) {
      if (refreshFrame !== undefined) return;
      refreshFrame = requestFrame(() => {
        refreshFrame = undefined;
        refreshLayout();
      });
      return;
    }
    if (fallbackRefreshQueued) return;
    fallbackRefreshQueued = true;
    Promise.resolve().then(() => {
      fallbackRefreshQueued = false;
      if (!disposed) refreshLayout();
    });
  };

  const cancelScheduledRefresh = (): void => {
    if (refreshFrame !== undefined) {
      cancelFrame?.(refreshFrame);
      refreshFrame = undefined;
    }
    fallbackRefreshQueued = false;
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
    cancelScheduledRefresh();
    disposed = true;
    trigger.removeEventListener('click', onTriggerClick);
    targetDocument.removeEventListener('keydown', onKeyDown);
    targetDocument.removeEventListener('pointerdown', onPointerDown);
    targetWindow.removeEventListener('blur', onWindowBlur);
    targetWindow.removeEventListener('resize', scheduleRefresh);
    targetWindow.removeEventListener('beforeunload', dispose);
    region.dataset.open = 'false';
    trigger.setAttribute('aria-expanded', 'false');
    resizeObserver?.disconnect();
    mutationObserver?.disconnect();
    measurementHost.parentNode?.removeChild(measurementHost);
    if (controllers.get(trigger)?.dispose === dispose) controllers.delete(trigger);
  };

  updateTriggerAccessibility(overflowing);
  const ResizeObserverConstructor = view?.ResizeObserver;
  const resizeObserver = ResizeObserverConstructor
    ? new ResizeObserverConstructor(scheduleRefresh)
    : undefined;
  resizeObserver?.observe(footer ?? region);
  if (core) resizeObserver?.observe(core);
  resizeObserver?.observe(region);
  if (status) resizeObserver?.observe(status);
  const MutationObserverConstructor = view?.MutationObserver;
  const mutationObserver = MutationObserverConstructor
    ? new MutationObserverConstructor(scheduleRefresh)
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
  targetWindow.addEventListener('resize', scheduleRefresh);
  targetWindow.addEventListener('beforeunload', dispose, { once: true });
  setOpen(isOpen());
  refreshLayout();
  return controller;
};
