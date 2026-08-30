export const HIGH_RISK_OPTION_MESSAGE = '此为高危选项，未经完整检测或验证，谨慎选择';

const TOOLTIP_ID = 'high-risk-option-tooltip';
const VIEWPORT_EDGE = 12;
const TOOLTIP_GAP = 10;

type TooltipPlacement = 'above' | 'below' | 'left' | 'right';

interface PointerPosition {
  x: number;
  y: number;
}

interface TriggerState {
  focused: boolean;
  hovered: boolean;
  pointer?: PointerPosition;
}

interface TooltipCandidate {
  left: number;
  placement: TooltipPlacement;
  top: number;
}

const clamp = (value: number, minimum: number, maximum: number): number =>
  Math.min(Math.max(value, minimum), Math.max(minimum, maximum));

const viewportSize = (): { height: number; width: number } => ({
  height: Math.max(1, window.innerHeight || document.documentElement.clientHeight),
  width: Math.max(1, window.innerWidth || document.documentElement.clientWidth),
});

const intersects = (
  left: number,
  top: number,
  width: number,
  height: number,
  rect: DOMRect,
): boolean =>
  left < rect.right && left + width > rect.left && top < rect.bottom && top + height > rect.top;

const hasOpenDialog = (): boolean => Boolean(document.querySelector('dialog[open]'));

/**
 * Installs the two high-risk option hints as one viewport-bound tooltip. A single node avoids a
 * pair of independently clipped popovers and lets the pointer position follow the active trigger.
 */
export const installHighRiskTooltips = (): (() => void) => {
  const triggers = Array.from(document.querySelectorAll<HTMLElement>('[data-high-risk-target]'));
  if (triggers.length === 0) {
    return () => undefined;
  }

  const tooltip = document.createElement('div');
  tooltip.className = 'high-risk-tooltip';
  tooltip.dataset.placement = 'below';
  tooltip.dataset.state = 'hidden';
  tooltip.id = TOOLTIP_ID;
  tooltip.setAttribute('aria-hidden', 'true');
  tooltip.setAttribute('role', 'tooltip');
  tooltip.textContent = HIGH_RISK_OPTION_MESSAGE;
  document.body.append(tooltip);

  const states = new Map<HTMLElement, TriggerState>(
    triggers.map((trigger) => [trigger, { focused: false, hovered: false }]),
  );
  let activeTrigger: HTMLElement | undefined;
  let animationFrame: number | undefined;
  let disposed = false;

  const schedulePosition = (): void => {
    if (animationFrame !== undefined) return;
    animationFrame = window.requestAnimationFrame(() => {
      animationFrame = undefined;
      positionTooltip();
    });
  };

  const positionTooltip = (): void => {
    if (disposed || !activeTrigger || hasOpenDialog()) {
      if (hasOpenDialog()) hideTooltip();
      return;
    }

    const triggerRect = activeTrigger.getBoundingClientRect();
    const viewport = viewportSize();
    const tooltipRect = tooltip.getBoundingClientRect();
    const width = Math.max(1, tooltipRect.width);
    const height = Math.max(1, tooltipRect.height);
    const state = states.get(activeTrigger);
    const pointer = state?.pointer;
    const anchorX = pointer?.x ?? triggerRect.left + triggerRect.width / 2;
    const anchorY = pointer?.y ?? triggerRect.bottom;
    const centeredLeft = anchorX - width / 2;
    const avoidRects = [triggerRect];
    const workbench = document.querySelector<HTMLElement>('.claude-workbench--open');
    if (workbench) avoidRects.push(workbench.getBoundingClientRect());

    const candidates: TooltipCandidate[] = [
      {
        left: centeredLeft,
        placement: 'below',
        top: Math.max(anchorY + TOOLTIP_GAP, triggerRect.bottom + TOOLTIP_GAP),
      },
      {
        left: centeredLeft,
        placement: 'above',
        top: Math.min(anchorY - height - TOOLTIP_GAP, triggerRect.top - height - TOOLTIP_GAP),
      },
      {
        left: triggerRect.right + TOOLTIP_GAP,
        placement: 'right',
        top: triggerRect.top + (triggerRect.height - height) / 2,
      },
      {
        left: triggerRect.left - width - TOOLTIP_GAP,
        placement: 'left',
        top: triggerRect.top + (triggerRect.height - height) / 2,
      },
    ];
    const selected =
      candidates.find(({ left, top }) => {
        const boundedLeft = clamp(left, VIEWPORT_EDGE, viewport.width - width - VIEWPORT_EDGE);
        const boundedTop = clamp(top, VIEWPORT_EDGE, viewport.height - height - VIEWPORT_EDGE);
        return !avoidRects.some((rect) => intersects(boundedLeft, boundedTop, width, height, rect));
      }) ?? candidates[0]!;

    tooltip.dataset.placement = selected.placement;
    tooltip.style.left = `${clamp(
      selected.left,
      VIEWPORT_EDGE,
      viewport.width - width - VIEWPORT_EDGE,
    )}px`;
    tooltip.style.top = `${clamp(
      selected.top,
      VIEWPORT_EDGE,
      viewport.height - height - VIEWPORT_EDGE,
    )}px`;
  };

  const hideTooltip = (): void => {
    activeTrigger = undefined;
    tooltip.dataset.state = 'hidden';
    if (tooltip.getAttribute('aria-hidden') !== 'true') {
      tooltip.setAttribute('aria-hidden', 'true');
    }
  };

  const showTooltip = (trigger: HTMLElement): void => {
    if (hasOpenDialog()) {
      hideTooltip();
      return;
    }
    activeTrigger = trigger;
    tooltip.dataset.state = 'visible';
    tooltip.setAttribute('aria-hidden', 'false');
    schedulePosition();
  };

  const maybeHideTooltip = (trigger: HTMLElement): void => {
    const state = states.get(trigger);
    if (activeTrigger === trigger && !state?.focused && !state?.hovered) {
      hideTooltip();
    }
  };

  const listeners: Array<{
    event: string;
    handler: EventListener;
    target: HTMLElement;
  }> = [];
  const bind = (trigger: HTMLElement, event: string, handler: EventListener): void => {
    trigger.addEventListener(event, handler);
    listeners.push({ event, handler, target: trigger });
  };

  for (const trigger of triggers) {
    const state = states.get(trigger)!;
    bind(trigger, 'pointerenter', ((event: PointerEvent) => {
      state.hovered = true;
      state.pointer = { x: event.clientX, y: event.clientY };
      showTooltip(trigger);
    }) as EventListener);
    bind(trigger, 'pointermove', ((event: PointerEvent) => {
      state.hovered = true;
      state.pointer = { x: event.clientX, y: event.clientY };
      showTooltip(trigger);
    }) as EventListener);
    bind(trigger, 'pointerleave', (() => {
      state.hovered = false;
      maybeHideTooltip(trigger);
    }) as EventListener);
    bind(trigger, 'focusin', (() => {
      state.focused = true;
      state.pointer = undefined;
      showTooltip(trigger);
    }) as EventListener);
    bind(trigger, 'focusout', ((event: FocusEvent) => {
      if (event.relatedTarget instanceof Node && trigger.contains(event.relatedTarget)) return;
      state.focused = false;
      maybeHideTooltip(trigger);
    }) as EventListener);
  }

  const onEscape = (event: KeyboardEvent): void => {
    if (event.key === 'Escape' && activeTrigger) hideTooltip();
  };
  const onViewportChange = (): void => {
    if (activeTrigger) schedulePosition();
  };
  document.addEventListener('keydown', onEscape);
  window.addEventListener('resize', onViewportChange);
  window.addEventListener('scroll', onViewportChange, true);
  const observer =
    typeof MutationObserver === 'function'
      ? new MutationObserver(() => {
          if (hasOpenDialog()) hideTooltip();
          else if (activeTrigger) schedulePosition();
        })
      : undefined;
  observer?.observe(document.body, {
    attributeFilter: ['aria-hidden', 'class', 'open'],
    attributes: true,
    childList: true,
    subtree: true,
  });

  return () => {
    disposed = true;
    if (animationFrame !== undefined) window.cancelAnimationFrame(animationFrame);
    observer?.disconnect();
    document.removeEventListener('keydown', onEscape);
    window.removeEventListener('resize', onViewportChange);
    window.removeEventListener('scroll', onViewportChange, true);
    for (const { event, handler, target } of listeners) target.removeEventListener(event, handler);
    tooltip.remove();
  };
};
