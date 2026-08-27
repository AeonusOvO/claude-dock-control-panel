/*
 * SCROLL CHAINING.
 *
 * Chromium latches a wheel burst to the scroller where it began. When that scroller reaches an
 * edge, the browser can strand the rest of the burst instead of handing its unused delta to an
 * ancestor. This module owns vertical wheel deltas for the document, queues them for the next
 * animation frame, measures every candidate before writing anything, and allocates each delta from
 * child to parent until it is consumed or meets a deliberate containment boundary.
 */
import { easeOutCubic, SCROLL_DURATION_MS } from './motion';

/** Pixels assumed per line when a wheel reports `DOM_DELTA_LINE`. */
const LINE_DELTA_PX = 16;
/** Smallest adaptive idle threshold, for high-frequency trackpads. */
const MIN_GESTURE_IDLE_MS = 64;
/** First-pair allowance before a device cadence has been observed. */
const INITIAL_GESTURE_IDLE_MS = 140;
/** Longest allowance for a deliberately slow mouse-wheel cadence. */
const MAX_GESTURE_IDLE_MS = 320;
/** One frame of scheduling slack beyond the observed wheel cadence. */
const GESTURE_FRAME_GRACE_MS = 16;
/** Fraction of a new interval admitted into the cadence estimate. */
const CADENCE_SAMPLE_WEIGHT = 0.3;
/** Numeric noise smaller than this is treated as zero after subtraction. */
const DELTA_EPSILON = 0.000_001;
/** Tiny overflow differences are not useful scroll containers. */
const SCROLL_RANGE_EPSILON = 1;
/** Bound optional smoke-test diagnostics without growing for the process lifetime. */
const MAX_HANDLER_SAMPLES = 512;

const SCROLLABLE_OVERFLOW = new Set(['auto', 'scroll', 'overlay']);

export interface ScrollProbe {
  /** True when the element can currently receive a write safely. */
  readonly isConnected: boolean;
  /** True when the element is a scroll container with content overflowing it. */
  readonly canScrollY: boolean;
  /** A dialog, modal, popover, or other top-layer root ends the outward walk. */
  readonly isTopLayer: boolean;
  /** `scrollHeight - clientHeight`. */
  readonly maxScroll: number;
  readonly scrollTop: number;
  /** `overscroll-behavior-y: contain | none` seals residual delta inside this element. */
  readonly trapsChaining: boolean;
}

export type ProbeReader = (element: Element) => ScrollProbe;

export interface ScrollAllocation {
  /** Signed pixels consumed by this element. */
  readonly consumed: number;
  /** Position in the child-first chain. */
  readonly index: number;
  readonly target: Element;
  readonly to: number;
}

export interface ScrollAllocationResult {
  readonly allocations: readonly ScrollAllocation[];
  readonly consumed: number;
  /** Signed delta left after all reachable capacity or a containment boundary. */
  readonly residual: number;
  readonly stoppedBy?: Element;
}

const clamp = (value: number, minimum: number, maximum: number): number =>
  Math.min(maximum, Math.max(minimum, value));

const normalizedResidual = (value: number): number =>
  Math.abs(value) <= DELTA_EPSILON ? 0 : value;

/**
 * Allocates one signed pixel delta through a child-first chain.
 *
 * The function performs no writes. Callers can read all probes first, invoke this repeatedly against
 * virtual `scrollTop` values, then commit the final positions in a separate write phase. Conservation
 * is explicit: `consumed + residual === delta`, apart from sub-micro-pixel floating-point noise.
 */
export const allocateScrollDelta = (
  chain: readonly Element[],
  delta: number,
  read: ProbeReader,
  startIndex = 0,
): ScrollAllocationResult => {
  if (!Number.isFinite(delta) || delta === 0) {
    return { allocations: [], consumed: 0, residual: delta };
  }

  const allocations: ScrollAllocation[] = [];
  let residual = delta;
  const firstIndex = clamp(Math.trunc(startIndex), 0, chain.length);

  for (let index = firstIndex; index < chain.length; index += 1) {
    const target = chain[index]!;
    const probe = read(target);

    if (probe.isConnected && probe.canScrollY) {
      const current = clamp(probe.scrollTop, 0, Math.max(0, probe.maxScroll));
      const capacity = delta > 0 ? Math.max(0, probe.maxScroll - current) : Math.max(0, current);
      const magnitude = Math.min(Math.abs(residual), capacity);

      if (magnitude > DELTA_EPSILON) {
        const consumed = Math.sign(delta) * magnitude;
        const to = clamp(current + consumed, 0, probe.maxScroll);
        allocations.push({ consumed, index, target, to });
        residual = normalizedResidual(residual - consumed);
        if (residual === 0) break;
      }

      if (probe.trapsChaining || probe.isTopLayer) {
        return {
          allocations,
          consumed: normalizedResidual(delta - residual),
          residual,
          stoppedBy: target,
        };
      }
    } else if (probe.isTopLayer) {
      // Preserve a top-layer boundary even if its node was detached before this frame was measured.
      return {
        allocations,
        consumed: normalizedResidual(delta - residual),
        residual,
        stoppedBy: target,
      };
    }
  }

  return {
    allocations,
    consumed: normalizedResidual(delta - residual),
    residual,
  };
};

export interface GestureTiming {
  /** Exponential moving average of intervals inside this burst. */
  readonly cadenceMs?: number;
  readonly direction: -1 | 1;
  readonly lastAt: number;
}

export interface GestureTimingUpdate {
  readonly continued: boolean;
  readonly timing: GestureTiming;
}

/** The current adaptive idle allowance. Exported so burst-boundary behavior is deterministic in tests. */
export const gestureIdleThreshold = (timing: GestureTiming): number => {
  if (timing.cadenceMs === undefined) return INITIAL_GESTURE_IDLE_MS;
  return clamp(
    timing.cadenceMs * 2.5 + GESTURE_FRAME_GRACE_MS,
    MIN_GESTURE_IDLE_MS,
    MAX_GESTURE_IDLE_MS,
  );
};

/**
 * Updates a wheel burst clock. Reversing direction always starts a new burst. Same-direction timing
 * learns the actual device cadence, so neither a fast trackpad nor a slow notched wheel is forced
 * through one blanket timeout.
 */
export const advanceGestureTiming = (
  previous: GestureTiming | undefined,
  at: number,
  direction: -1 | 1,
): GestureTimingUpdate => {
  const safeAt = Number.isFinite(at) ? at : (previous?.lastAt ?? 0);
  if (!previous || previous.direction !== direction || safeAt < previous.lastAt) {
    return { continued: false, timing: { direction, lastAt: safeAt } };
  }

  const interval = safeAt - previous.lastAt;
  const continued = interval <= gestureIdleThreshold(previous);
  if (!continued) {
    return { continued: false, timing: { direction, lastAt: safeAt } };
  }

  const cadenceMs =
    previous.cadenceMs === undefined
      ? interval
      : previous.cadenceMs * (1 - CADENCE_SAMPLE_WEIGHT) + interval * CADENCE_SAMPLE_WEIGHT;
  return { continued: true, timing: { cadenceMs, direction, lastAt: safeAt } };
};

const isTopLayerElement = (element: Element): boolean => {
  // Treat every open dialog as a containment root. `:modal` is more exact, but an open non-modal
  // dialog must still never donate a stale wheel delta to the shell if it is detached before flush.
  if (element.localName === 'dialog' && (element as HTMLDialogElement).open) return true;
  try {
    return element.matches(':modal, :popover-open');
  } catch {
    // Older jsdom builds do not parse the top-layer pseudo-classes; Electron does.
    return false;
  }
};

const disconnectedProbe = (isTopLayer = false): ScrollProbe => ({
  canScrollY: false,
  isConnected: false,
  isTopLayer,
  maxScroll: 0,
  scrollTop: 0,
  trapsChaining: false,
});

/** Measures a live element without mutating layout. */
const readDomProbe = (element: Element): ScrollProbe => {
  const topLayer = isTopLayerElement(element);
  if (!element.isConnected) return disconnectedProbe(topLayer);

  const view = element.ownerDocument.defaultView;
  if (!view) return disconnectedProbe(topLayer);

  const styles = view.getComputedStyle(element);
  const maxScroll = Math.max(0, element.scrollHeight - element.clientHeight);
  const isViewportScroller = element === element.ownerDocument.scrollingElement;
  const behavior = styles.overscrollBehaviorY;

  return {
    canScrollY:
      (isViewportScroller || SCROLLABLE_OVERFLOW.has(styles.overflowY)) &&
      maxScroll > SCROLL_RANGE_EPSILON,
    isConnected: true,
    isTopLayer: topLayer,
    maxScroll,
    scrollTop: element.scrollTop,
    trapsChaining: behavior === 'contain' || behavior === 'none',
  };
};

const normalizeDelta = (event: WheelEvent, targetWindow: Window): number => {
  if (event.deltaMode === 1) return event.deltaY * LINE_DELTA_PX;
  if (event.deltaMode === 2) return event.deltaY * targetWindow.innerHeight;
  return event.deltaY;
};

interface GestureState {
  readonly boundary?: Element;
  readonly chain: readonly Element[];
  latchIndex: number;
  timing: GestureTiming;
}

interface PendingWheel {
  readonly delta: number;
  readonly gesture: GestureState;
  readonly measured: boolean;
}

interface ScrollMotion {
  readonly from: number;
  readonly startedAt: number;
  readonly to: number;
}

export interface ScrollChainingInstallOptions {
  readonly cancelAnimationFrame?: (handle: number) => void;
  readonly readProbe?: ProbeReader;
  readonly requestAnimationFrame?: (callback: FrameRequestCallback) => number;
}

type RendererWindow = Window & typeof globalThis;

const installations = new WeakMap<Window, () => void>();

const eventChain = (event: WheelEvent, targetWindow: RendererWindow): Element[] => {
  const chain: Element[] = [];
  const seen = new Set<Element>();
  for (const node of event.composedPath()) {
    if (node instanceof targetWindow.Element && !seen.has(node)) {
      seen.add(node);
      chain.push(node);
    }
  }

  const eventTarget = event.target;
  if (eventTarget instanceof targetWindow.Element && !seen.has(eventTarget)) {
    chain.unshift(eventTarget);
    seen.add(eventTarget);
  }

  const viewport = targetWindow.document.scrollingElement;
  if (viewport && !seen.has(viewport)) chain.push(viewport);
  return chain;
};

const percentile95 = (samples: readonly number[]): number => {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((left, right) => left - right);
  return sorted[Math.ceil(sorted.length * 0.95) - 1] ?? 0;
};

const applyScrollFrame = (
  writes: ReadonlyMap<Element, number>,
  appliedTops: WeakMap<Element, number>,
): void => {
  // Keep the non-layout connectivity pass separate from this frame's write-only loop.
  const liveWrites = [...writes].filter(([candidate]) => candidate.isConnected);
  for (const [candidate, scrollTop] of liveWrites) {
    try {
      // Scroll events arrive asynchronously; allow DOM rounding when recognizing our own writes.
      appliedTops.set(candidate, scrollTop);
      candidate.scrollTop = scrollTop;
    } catch {
      // A node can be adopted or detached between phases; dropping that stale write is safe.
    }
  }
};

/**
 * Installs one idempotent document-wide wheel controller and returns its idempotent disposer.
 * Reinstalling on the same Window returns the existing disposer instead of adding another listener.
 */
export const installScrollChaining = (
  targetWindow: RendererWindow = window,
  options: ScrollChainingInstallOptions = {},
): (() => void) => {
  const existing = installations.get(targetWindow);
  if (existing) return existing;

  const targetDocument = targetWindow.document;
  const readProbe = options.readProbe ?? readDomProbe;
  const requestFrame =
    options.requestAnimationFrame ?? targetWindow.requestAnimationFrame.bind(targetWindow);
  const cancelFrame =
    options.cancelAnimationFrame ?? targetWindow.cancelAnimationFrame.bind(targetWindow);
  const pending: PendingWheel[] = [];
  const motions = new Map<Element, ScrollMotion>();
  const appliedTops = new WeakMap<Element, number>();
  const reducedMotion = targetWindow.matchMedia?.('(prefers-reduced-motion: reduce)');
  const handlerSamples: number[] = [];
  let activeGesture: GestureState | undefined;
  let frameHandle: number | undefined;
  let disposed = false;

  const scheduleFrame = (): void => {
    if (frameHandle !== undefined || disposed) return;
    frameHandle = requestFrame(flushFrame);
  };

  function flushFrame(timestamp: number): void {
    frameHandle = undefined;
    if (disposed || (pending.length === 0 && motions.size === 0)) return;

    const batch = pending.splice(0);
    const candidates = new Set(motions.keys());
    for (const item of batch) {
      for (const candidate of item.gesture.chain) candidates.add(candidate);
    }

    // READ PHASE. Geometry and computed style are collected before any scrollTop assignment.
    const probes = new Map<Element, ScrollProbe>();
    for (const candidate of candidates) {
      try {
        probes.set(candidate, readProbe(candidate));
      } catch {
        probes.set(candidate, disconnectedProbe());
      }
    }

    // A scrollbar drag, keyboard action, state restoration or layout clamp owns its new position.
    // Never pull it back toward an old animated target, or retain the old parent latch afterwards.
    for (const [candidate, probe] of probes) {
      const lastApplied = appliedTops.get(candidate);
      const externallyMoved =
        lastApplied !== undefined && Math.abs(probe.scrollTop - lastApplied) > 1;
      if (externallyMoved || !probe.isConnected || !probe.canScrollY) {
        motions.delete(candidate);
        appliedTops.delete(candidate);
        if (externallyMoved) {
          for (const { gesture } of batch) {
            if (gesture.chain.includes(candidate)) gesture.latchIndex = 0;
          }
        }
      }
    }

    // COMPUTE PHASE. Allocate against logical destinations, not the intermediate painted position.
    // Otherwise fast wheel input loses pixels on every frame while the previous notch is easing.
    const virtualTops = new Map<Element, number>();
    for (const [candidate, probe] of probes) {
      virtualTops.set(
        candidate,
        clamp(motions.get(candidate)?.to ?? probe.scrollTop, 0, probe.maxScroll),
      );
    }
    const targets = new Map<Element, number>();

    for (const item of batch) {
      const { gesture } = item;
      const result = allocateScrollDelta(
        gesture.chain,
        item.delta,
        (candidate) => {
          const probe = probes.get(candidate) ?? disconnectedProbe(candidate === gesture.boundary);
          return {
            ...probe,
            isTopLayer: probe.isTopLayer || candidate === gesture.boundary,
            scrollTop: virtualTops.get(candidate) ?? probe.scrollTop,
          };
        },
        gesture.latchIndex,
      );

      for (const allocation of result.allocations) {
        virtualTops.set(allocation.target, allocation.to);
        targets.set(allocation.target, allocation.to);
      }
      const lastAllocation = result.allocations.at(-1);
      if (lastAllocation) gesture.latchIndex = lastAllocation.index;
    }

    for (const [candidate, to] of targets) {
      if (motions.get(candidate)?.to === to) continue;
      motions.set(candidate, {
        from: probes.get(candidate)!.scrollTop,
        // A small head start gives immediate first-frame feedback, including parent handoff.
        startedAt: timestamp - 10,
        to,
      });
    }
    const writes = new Map<Element, number>();
    for (const [candidate, motion] of motions) {
      const probe = probes.get(candidate)!;
      const progress = reducedMotion?.matches
        ? 1
        : clamp((timestamp - motion.startedAt) / SCROLL_DURATION_MS, 0, 1);
      const to = clamp(motion.to, 0, probe.maxScroll);
      writes.set(
        candidate,
        clamp(motion.from + (to - motion.from) * easeOutCubic(progress), 0, probe.maxScroll),
      );
      if (progress === 1) motions.delete(candidate);
    }

    // WRITE PHASE. Every target receives at most one final scrollTop assignment for this frame.
    applyScrollFrame(writes, appliedTops);

    if (batch.some((item) => item.measured)) {
      const root = targetDocument.documentElement;
      root.dataset.scrollChainingHandlerP95 = percentile95(handlerSamples).toFixed(3);
      root.dataset.scrollChainingHandoffFrames = '1';
    }

    if (pending.length > 0 || motions.size > 0) scheduleFrame();
  }

  const onWheel = (rawEvent: Event): void => {
    const event = rawEvent as WheelEvent;
    if (event.defaultPrevented || event.ctrlKey || !event.cancelable) return;
    if (Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;

    const metricsEnabled = targetDocument.documentElement.dataset.scrollChainingMetrics === 'true';
    const handlerStartedAt = metricsEnabled ? targetWindow.performance.now() : 0;
    const delta = normalizeDelta(event, targetWindow);
    if (!Number.isFinite(delta) || delta === 0) return;

    const chain = eventChain(event, targetWindow);
    if (chain.length === 0) return;
    const direction = Math.sign(delta) as -1 | 1;
    const timingUpdate = advanceGestureTiming(activeGesture?.timing, event.timeStamp, direction);
    const boundary = chain.find(isTopLayerElement);
    const latchedTarget = activeGesture?.chain[activeGesture.latchIndex];
    if (activeGesture && direction !== activeGesture.timing.direction) {
      // Reversing direction cancels remaining momentum, so the next notch moves immediately back.
      for (const candidate of chain) motions.delete(candidate);
    }
    if (boundary && boundary !== activeGesture?.boundary) {
      for (const candidate of motions.keys()) {
        if (!boundary.contains(candidate)) motions.delete(candidate);
      }
    }
    const continueExisting =
      timingUpdate.continued &&
      activeGesture !== undefined &&
      activeGesture.boundary === boundary &&
      latchedTarget !== undefined &&
      latchedTarget.isConnected &&
      chain.includes(latchedTarget);

    let gesture = activeGesture;
    if (!continueExisting || !gesture) {
      gesture = { boundary, chain, latchIndex: 0, timing: timingUpdate.timing };
    }
    gesture.timing = timingUpdate.timing;
    activeGesture = gesture;

    // Prevent native latching before returning from the cancelable listener. The complete delta is
    // then allocated exactly once next frame and eased toward its destination by this same loop.
    event.preventDefault();
    pending.push({ delta, gesture, measured: metricsEnabled });
    scheduleFrame();

    if (metricsEnabled) {
      handlerSamples.push(targetWindow.performance.now() - handlerStartedAt);
      if (handlerSamples.length > MAX_HANDLER_SAMPLES) handlerSamples.shift();
    }
  };

  const stopMotion = (): void => {
    pending.splice(0);
    motions.clear();
    activeGesture = undefined;
    if (frameHandle !== undefined) cancelFrame(frameHandle);
    frameHandle = undefined;
  };

  const onScroll = (event: Event): void => {
    const target = event.target;
    if (!(target instanceof targetWindow.Element)) return;
    const lastApplied = appliedTops.get(target);
    if (lastApplied !== undefined && Math.abs(target.scrollTop - lastApplied) <= 1) return;
    motions.delete(target);
    appliedTops.delete(target);
    if (activeGesture?.chain.includes(target)) stopMotion();
  };

  const updateMotionPreference = (): void => {
    if (motions.size > 0) scheduleFrame();
  };

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    targetWindow.removeEventListener('wheel', onWheel, false);
    targetWindow.removeEventListener('scroll', onScroll, true);
    targetWindow.removeEventListener('pointerdown', stopMotion, true);
    targetWindow.removeEventListener('keydown', stopMotion, true);
    targetWindow.removeEventListener('beforeunload', dispose, false);
    reducedMotion?.removeEventListener('change', updateMotionPreference);
    stopMotion();
    if (installations.get(targetWindow) === dispose) installations.delete(targetWindow);
  };

  installations.set(targetWindow, dispose);
  targetWindow.addEventListener('wheel', onWheel, { passive: false });
  targetWindow.addEventListener('scroll', onScroll, true);
  targetWindow.addEventListener('pointerdown', stopMotion, true);
  targetWindow.addEventListener('keydown', stopMotion, true);
  targetWindow.addEventListener('beforeunload', dispose, { once: true });
  reducedMotion?.addEventListener('change', updateMotionPreference);
  return dispose;
};
