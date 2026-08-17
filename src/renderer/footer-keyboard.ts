/**
 * Footer menu keyboard navigation utilities.
 * Extracted for testability and consistency.
 */

export interface FooterMenuPair {
  readonly menu: HTMLElement;
  readonly trigger: HTMLButtonElement;
}

/**
 * Finds the currently open footer menu from a list of menu/trigger pairs.
 * Returns undefined if no menu is open.
 */
export const findOpenFooterMenu = (
  pairs: readonly FooterMenuPair[],
): FooterMenuPair | undefined => {
  return pairs.find(({ menu }) => !menu.hidden);
};

/**
 * Closes a footer menu and returns focus to its trigger button.
 */
export const closeFooterMenuAndRestoreFocus = (pair: FooterMenuPair): void => {
  pair.menu.hidden = true;
  pair.trigger.setAttribute('aria-expanded', 'false');
  pair.trigger.focus();
};

/**
 * Handles Escape key press to close any open footer menu.
 * Returns true if a menu was closed (event should be preventDefault-ed).
 */
export const handleFooterMenuEscape = (pairs: readonly FooterMenuPair[]): boolean => {
  const openPair = findOpenFooterMenu(pairs);
  if (openPair) {
    closeFooterMenuAndRestoreFocus(openPair);
    return true;
  }
  return false;
};

/**
 * Checks if an element is truly visible and focusable.
 * Excludes elements that are hidden via:
 * - hidden attribute on the element or ancestor
 * - aria-hidden="true" on the element or ancestor
 * - display: none or visibility: hidden (computed styles)
 */
const isElementVisibleAndFocusable = (element: Element): boolean => {
  // Check for hidden attribute on ancestors
  let current: Element | null = element;
  while (current) {
    if (current.hasAttribute('hidden')) {
      return false;
    }
    if (current.getAttribute('aria-hidden') === 'true') {
      return false;
    }
    current = current.parentElement;
  }

  // Check computed styles (use tagName check to avoid instanceof issues in test environments)
  if (element.tagName && typeof window !== 'undefined' && window.getComputedStyle) {
    try {
      const styles = window.getComputedStyle(element);
      if (styles.display === 'none' || styles.visibility === 'hidden') {
        return false;
      }
    } catch {
      // getComputedStyle may fail in test environments; treat as visible
    }
  }

  return true;
};

/**
 * Handles arrow key navigation within footer menus.
 * Returns true if navigation occurred (event should be preventDefault-ed).
 */
export const handleFooterMenuArrowKey = (
  pairs: readonly FooterMenuPair[],
  key: 'ArrowDown' | 'ArrowUp',
  activeElement: Element | null,
): boolean => {
  // Only navigate if focus is inside an open menu
  const activeMenu = pairs.find(({ menu }) => !menu.hidden && menu.contains(activeElement));
  if (!activeMenu) {
    return false;
  }

  // Ignore arrow keys when focus is on a textbox or other input
  // Check tagName to avoid instanceof issues in test environments
  if (
    activeElement &&
    (activeElement.tagName === 'INPUT' || activeElement.tagName === 'TEXTAREA')
  ) {
    return false;
  }

  // Get all enabled buttons that are also visible and focusable
  const allButtons = Array.from(
    activeMenu.menu.querySelectorAll<HTMLButtonElement>('button:not([disabled])'),
  );
  const buttons = allButtons.filter(isElementVisibleAndFocusable);

  if (buttons.length === 0) {
    return false;
  }

  const currentIndex = buttons.indexOf(activeElement as HTMLButtonElement);
  if (currentIndex < 0) {
    // Focus not on a button; do nothing
    return false;
  }

  const nextIndex =
    key === 'ArrowDown'
      ? (currentIndex + 1) % buttons.length
      : (currentIndex - 1 + buttons.length) % buttons.length;

  buttons[nextIndex]?.focus();
  return true;
};
