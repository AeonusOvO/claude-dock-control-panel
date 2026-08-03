/**
 * THE STANDARD COMPONENT KIT
 *
 * Native form controls are painted by the OS, not by us: a `<select>` drops a Win32 listbox in
 * Segoe UI on a white background, which ignores every theme token and looks like a different
 * application. This module replaces the *presentation* of those controls while keeping the native
 * element as the single source of truth for value, validation and `change` events.
 *
 * That split is deliberate. Roughly a dozen call sites already read `select.value`, assign to it,
 * populate `<option>`s dynamically and listen for `change`; rewriting them all into a bespoke widget
 * would risk regressions across the whole app for a purely visual goal. Instead the native element
 * stays in the DOM (visually hidden, still focusable by assistive tech) and drives a themed listbox
 * rendered from the same tokens as the rest of the shell — so a theme switch restyles it for free.
 *
 * Checkboxes and radios need no JS at all: `appearance: none` plus token-driven CSS is enough, so
 * they are handled entirely in the stylesheet.
 */

/** The listbox currently open, if any. Only one may be open at a time. */
let openController: SelectController | undefined;

interface SelectController {
  close: () => void;
  readonly listbox: HTMLElement;
  /** The wrapper holding both the native element and the visual trigger. */
  readonly shell: HTMLElement;
  readonly trigger: HTMLButtonElement;
}

/**
 * Upper bound for the exit animation, used only as the safety net for a dropped `animationend` —
 * the real duration is the theme's `--dur-exit`, which JS never needs to read.
 */
const EXIT_FALLBACK_MS = 600;

const REDUCED_MOTION = (): boolean => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * The element the popup must be parented to so it is actually visible.
 *
 * A modal `<dialog>` is promoted to the browser's top layer, which sits above every `z-index` on the
 * page, and everything outside it is made inert — so a popup on `body` is both painted underneath the
 * dialog and unreachable by the pointer. Neither a higher `z-index` nor the popover API escapes that
 * (inert wins over the top layer for hit-testing), so the popup has to live *inside* the dialog. Any
 * other trigger keeps `body`, where the popup escapes scroll containers and clipping as before.
 */
const popupHost = (trigger: HTMLElement): HTMLElement => {
  const dialog = trigger.closest('dialog');
  return dialog?.hasAttribute('open') ? dialog : document.body;
};

/** Closes any open listbox. Safe to call when nothing is open. */
export const closeOpenSelect = (): void => {
  openController?.close();
};

/**
 * Positions the listbox against its trigger, flipping above when there is not enough room below.
 * The popup is `position: fixed`, so it escapes the scroll containers and dialogs it lives inside.
 */
const positionListbox = (trigger: HTMLElement, listbox: HTMLElement): void => {
  // Measure with the constraint cleared, otherwise a previous open's clamp sticks.
  listbox.style.maxHeight = '';
  const triggerRect = trigger.getBoundingClientRect();
  const gap = 6;
  const margin = 8;
  const spaceBelow = window.innerHeight - triggerRect.bottom - gap - margin;
  const spaceAbove = triggerRect.top - gap - margin;
  const natural = listbox.scrollHeight;
  const flipUp = spaceBelow < Math.min(natural, 200) && spaceAbove > spaceBelow;
  const available = Math.max(96, flipUp ? spaceAbove : spaceBelow);
  const height = Math.min(natural, available);

  listbox.style.maxHeight = `${height}px`;
  listbox.style.minWidth = `${triggerRect.width}px`;
  listbox.style.top = flipUp
    ? `${Math.max(margin, triggerRect.top - height - gap)}px`
    : `${triggerRect.bottom + gap}px`;
  listbox.dataset.placement = flipUp ? 'above' : 'below';

  const width = listbox.getBoundingClientRect().width;
  listbox.style.left = `${Math.max(margin, Math.min(triggerRect.left, window.innerWidth - width - margin))}px`;
};

/**
 * Gives one `<select>` a themed presentation. Idempotent: calling it twice on the same element is a
 * no-op, so callers may re-run it after repopulating options.
 */
export const enhanceSelect = (select: HTMLSelectElement): void => {
  if (select.dataset.enhanced === 'true') {
    return;
  }
  select.dataset.enhanced = 'true';
  select.classList.add('select-native');

  const shell = document.createElement('div');
  shell.className = 'select';
  const trigger = document.createElement('button');
  trigger.className = 'select__trigger';
  trigger.type = 'button';
  trigger.setAttribute('aria-haspopup', 'listbox');
  trigger.setAttribute('aria-expanded', 'false');
  // The native select keeps the accessible name and remains the focus target for screen readers, so
  // the visual trigger is hidden from the tree to avoid announcing the control twice.
  trigger.setAttribute('aria-hidden', 'true');
  trigger.tabIndex = -1;

  const label = document.createElement('span');
  label.className = 'select__label';
  const chevron = document.createElement('span');
  chevron.className = 'select__chevron';
  chevron.setAttribute('aria-hidden', 'true');
  chevron.innerHTML = '<svg viewBox="0 0 24 24"><path d="m6 9 6 6 6-6" /></svg>';
  trigger.append(label, chevron);

  const listbox = document.createElement('div');
  listbox.className = 'select__listbox';
  listbox.setAttribute('role', 'listbox');
  listbox.hidden = true;
  /*
   * Rows are `<button>`s, so pressing one would take focus off the native select and fire its `blur`
   * — closing the popup before the row's own `click` could commit. Refusing the focus shift keeps the
   * select the focus owner for the whole interaction, which is also what the focus ring assumes.
   */
  listbox.addEventListener('mousedown', (event) => {
    event.preventDefault();
  });

  select.replaceWith(shell);
  shell.append(select, trigger);

  /** Mirrors the native element's current option text and disabled state onto the trigger. */
  const syncTrigger = (): void => {
    const selected = select.selectedOptions[0];
    label.textContent = selected?.textContent?.trim() ?? '';
    label.dataset.placeholder = String(!selected);
    trigger.disabled = select.disabled;
    shell.dataset.disabled = String(select.disabled);
  };

  let activeIndex = -1;
  /** Pending exit-animation timer, so a reopen mid-close cancels the teardown instead of racing it. */
  let exitTimer: number | undefined;

  const optionButtons = (): HTMLButtonElement[] =>
    Array.from(listbox.querySelectorAll<HTMLButtonElement>('button:not([disabled])'));

  const setActive = (index: number, scroll = true): void => {
    const buttons = optionButtons();
    if (buttons.length === 0) {
      return;
    }
    activeIndex = (index + buttons.length) % buttons.length;
    for (const [position, button] of buttons.entries()) {
      button.dataset.active = String(position === activeIndex);
    }
    const active = buttons[activeIndex];
    if (active && scroll) {
      active.scrollIntoView({ block: 'nearest' });
    }
  };

  const commit = (value: string): void => {
    close();
    if (select.value === value) {
      return;
    }
    select.value = value;
    syncTrigger();
    // The native element is the source of truth, so existing listeners must see a real change.
    select.dispatchEvent(new Event('change', { bubbles: true }));
    select.dispatchEvent(new Event('input', { bubbles: true }));
  };

  /** Rebuilds the popup rows from the live `<option>` list. */
  const renderOptions = (): void => {
    const rows = Array.from(select.options).map((option) => {
      const row = document.createElement('button');
      row.type = 'button';
      row.setAttribute('role', 'option');
      row.dataset.value = option.value;
      row.disabled = option.disabled;
      row.setAttribute('aria-selected', String(option.selected));
      row.dataset.selected = String(option.selected);
      row.textContent = option.textContent?.trim() ?? option.value;
      row.addEventListener('click', () => {
        commit(option.value);
      });
      row.addEventListener('mousemove', () => {
        const index = optionButtons().indexOf(row);
        if (index >= 0 && index !== activeIndex) {
          setActive(index, false);
        }
      });
      return row;
    });
    listbox.replaceChildren(...rows);
  };

  /**
   * Hides the popup. The listbox plays a closing animation on its way out rather than vanishing, so
   * dismissing a dropdown reads as the reverse of opening it; `hidden` is only applied once that
   * animation has finished. State that other code observes — `data-open`, `aria-expanded`, the
   * controller registration — is cleared immediately, so a close is synchronous as far as callers and
   * the reopen path are concerned.
   */
  function close(): void {
    if (listbox.hidden || listbox.dataset.closing === 'true') {
      return;
    }
    listbox.dataset.open = 'false';
    trigger.setAttribute('aria-expanded', 'false');
    shell.dataset.open = 'false';
    activeIndex = -1;
    if (openController?.listbox === listbox) {
      openController = undefined;
    }

    const finish = (): void => {
      // A reopen during the exit clears the flag; finishing then would hide a popup that is open.
      if (listbox.dataset.closing !== 'true') {
        return;
      }
      delete listbox.dataset.closing;
      listbox.hidden = true;
      window.clearTimeout(exitTimer);
      exitTimer = undefined;
    };

    if (REDUCED_MOTION()) {
      listbox.hidden = true;
      return;
    }

    listbox.dataset.closing = 'true';
    listbox.addEventListener('animationend', finish, { once: true });
    // An interrupted or never-fired animation must not leave the popup stranded on screen.
    exitTimer = window.setTimeout(finish, EXIT_FALLBACK_MS);
  }

  const open = (focusSelected: boolean): void => {
    if (select.disabled) {
      return;
    }
    closeOpenSelect();
    // Cancel any exit in flight on this listbox so the entrance restarts from a clean state.
    delete listbox.dataset.closing;
    window.clearTimeout(exitTimer);
    exitTimer = undefined;
    renderOptions();
    /*
     * Re-parented on every open, not once at construction: a select inside a dialog needs its popup
     * in the dialog's top-layer subtree, and `enhanceSelect` runs long before any dialog is open. The
     * host is therefore resolved from the trigger's live position each time.
     */
    popupHost(trigger).append(listbox);
    listbox.hidden = false;
    listbox.dataset.open = 'true';
    trigger.setAttribute('aria-expanded', 'true');
    shell.dataset.open = 'true';
    positionListbox(trigger, listbox);
    openController = { close, listbox, shell, trigger };
    if (focusSelected) {
      const selectedIndex = optionButtons().findIndex(
        (button) => button.dataset.value === select.value,
      );
      setActive(selectedIndex >= 0 ? selectedIndex : 0);
    }
  };

  /** True while the popup is on screen, including the frames it spends animating out. */
  const isOpen = (): boolean => listbox.dataset.open === 'true';

  const toggle = (): void => {
    if (isOpen()) {
      close();
    } else {
      open(true);
    }
  };

  /*
   * The whole shell is the click target, not just the visual trigger. The native `<select>` covers
   * the shell so it can keep focus, which means it — not the trigger — is what the pointer actually
   * lands on; binding to the trigger alone left the control looking pressable but doing nothing on
   * the majority of its surface.
   */
  shell.addEventListener('mousedown', (event) => {
    if (event.button !== 0) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    // Keep the native element as the focus owner so the focus ring lands on the shell.
    select.focus({ preventScroll: true });
    toggle();
  });

  // Chromium still opens its own popup on a native select's click, so that default is suppressed too.
  select.addEventListener('click', (event) => {
    event.preventDefault();
  });

  /*
   * Keyboard handling lives on the native select, because that is what actually holds focus. When
   * the popup is closed we let the browser's own behaviour through for Home/End and type-ahead; when
   * it is open we drive the highlighted row ourselves.
   */
  select.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      if (isOpen()) {
        event.preventDefault();
        event.stopPropagation();
        close();
      }
      return;
    }

    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      if (!isOpen()) {
        open(true);
        return;
      }
      const active = optionButtons()[activeIndex];
      if (active?.dataset.value !== undefined) {
        commit(active.dataset.value);
      } else {
        close();
      }
      return;
    }

    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!isOpen()) {
        open(true);
        return;
      }
      setActive(activeIndex + (event.key === 'ArrowDown' ? 1 : -1));
      return;
    }

    if (event.key === 'Tab' && isOpen()) {
      close();
    }
  });

  select.addEventListener('blur', close);
  select.addEventListener('change', syncTrigger);
  // Programmatic `select.value = …` fires no event, and several call sites do exactly that while
  // repopulating options, so the trigger and rows are rebuilt from the live DOM instead.
  new MutationObserver(() => {
    syncTrigger();
    if (isOpen()) {
      renderOptions();
      positionListbox(trigger, listbox);
    }
  }).observe(select, {
    attributeFilter: ['disabled', 'value'],
    attributes: true,
    childList: true,
    subtree: true,
  });

  syncTrigger();
};

/** Enhances every `<select>` in the document that has not been enhanced yet. */
export const enhanceAllSelects = (root: ParentNode = document): void => {
  for (const select of root.querySelectorAll<HTMLSelectElement>('select')) {
    enhanceSelect(select);
  }
};

/**
 * Keeps the popup glued to its trigger, or dismisses it when the trigger has gone away. A dialog or
 * panel can be closed while a listbox is open, and the popup lives on `body` rather than inside that
 * container — so without this it would be left floating over unrelated content.
 */
const repositionOrClose = (controller: SelectController): void => {
  const rect = controller.trigger.getBoundingClientRect();
  const detached = !controller.trigger.isConnected || (rect.width === 0 && rect.height === 0);
  if (detached) {
    controller.close();
    return;
  }
  positionListbox(controller.trigger, controller.listbox);
};

/**
 * Dismisses an open listbox on the interactions that should close it. Scroll and resize reposition
 * rather than close, so a listbox opened inside a scrolling panel tracks its trigger.
 */
export const installSelectDismissHandlers = (): void => {
  document.addEventListener(
    'pointerdown',
    (event) => {
      const controller = openController;
      if (!controller) {
        return;
      }
      const target = event.target as Node;
      // The native select sits over the trigger, so the shell is what a press actually hits.
      if (!controller.listbox.contains(target) && !controller.shell.contains(target)) {
        controller.close();
      }
    },
    true,
  );

  window.addEventListener(
    'scroll',
    () => {
      const controller = openController;
      if (controller) {
        repositionOrClose(controller);
      }
    },
    true,
  );

  window.addEventListener('resize', () => {
    const controller = openController;
    if (controller) {
      repositionOrClose(controller);
    }
  });

  window.addEventListener('blur', closeOpenSelect);
};

/**
 * Controls that take a ripple. The standard primary-action classes are listed by name so buttons
 * created at runtime get the feedback for free, and `data-ripple` remains the opt-in for anything
 * outside that vocabulary. Mirrored by the matching rule in styles.css.
 */
const RIPPLE_SELECTOR =
  '#composer-send, .button--primary, .chat-send, .dialog-primary, .launch-primary, [data-ripple]';

/**
 * Ripple feedback for the primary action buttons. Interaction should always answer, and a press that
 * only scales can read as a no-op on a large target; the ripple originates at the pointer so the
 * feedback is tied to where the user actually clicked.
 */
export const installPressRipples = (): void => {
  document.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || REDUCED_MOTION()) {
      return;
    }
    const target = (event.target as Element | null)?.closest<HTMLElement>(RIPPLE_SELECTOR);
    if (!target || target.matches(':disabled')) {
      return;
    }
    const rect = target.getBoundingClientRect();
    const ripple = document.createElement('span');
    ripple.className = 'ripple';
    // Cover the furthest corner from the press point so the wave always fills the control.
    const radius = Math.hypot(
      Math.max(event.clientX - rect.left, rect.right - event.clientX),
      Math.max(event.clientY - rect.top, rect.bottom - event.clientY),
    );
    ripple.style.height = `${radius * 2}px`;
    ripple.style.width = `${radius * 2}px`;
    ripple.style.left = `${event.clientX - rect.left - radius}px`;
    ripple.style.top = `${event.clientY - rect.top - radius}px`;
    target.append(ripple);
    ripple.addEventListener('animationend', () => {
      ripple.remove();
    });
    // A dropped animationend must not leak the node.
    window.setTimeout(() => {
      ripple.remove();
    }, 800);
  });
};
