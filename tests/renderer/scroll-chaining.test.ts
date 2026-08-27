import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it } from 'vitest';
import { SCROLL_DURATION_MS } from '../../src/renderer/platform/motion';
import {
  advanceGestureTiming,
  allocateScrollDelta,
  gestureIdleThreshold,
  installScrollChaining,
  type ProbeReader,
  type ScrollProbe,
} from '../../src/renderer/platform/scroll-chaining';

/*
 * jsdom has no layout engine, so allocation tests inject geometry. The Electron smoke test covers
 * real layout, trusted wheel input, compositor latching, and the one-frame handoff in Chromium.
 */

const DOWN = 120;
const UP = -120;

interface FakeSpec {
  readonly connected?: boolean;
  readonly maxScroll?: number;
  readonly scroller?: boolean;
  readonly scrollTop?: number;
  readonly topLayer?: boolean;
  readonly traps?: boolean;
}

const chainOf = (
  ...specs: readonly FakeSpec[]
): { chain: Element[]; read: ProbeReader; probes: ScrollProbe[] } => {
  const probes = specs.map((spec): ScrollProbe => ({
    canScrollY: spec.scroller ?? true,
    isConnected: spec.connected ?? true,
    isTopLayer: spec.topLayer ?? false,
    maxScroll: spec.maxScroll ?? 1_000,
    scrollTop: spec.scrollTop ?? 0,
    trapsChaining: spec.traps ?? false,
  }));
  const chain = specs.map(() => ({}) as Element);
  return { chain, probes, read: (element) => probes[chain.indexOf(element)]! };
};

const expectConserved = (delta: number, result: ReturnType<typeof allocateScrollDelta>): void => {
  expect(result.allocations.reduce((sum, allocation) => sum + allocation.consumed, 0)).toBeCloseTo(
    result.consumed,
    8,
  );
  expect(result.consumed + result.residual).toBeCloseTo(delta, 8);
};

describe('scroll delta allocation', () => {
  it('conserves a downward delta while transferring its residual through two layers', () => {
    const { chain, read } = chainOf(
      { maxScroll: 100, scrollTop: 80 },
      { maxScroll: 1_000, scrollTop: 200 },
    );

    const result = allocateScrollDelta(chain, DOWN, read);

    expect(result.allocations.map(({ consumed, index, to }) => ({ consumed, index, to }))).toEqual([
      { consumed: 20, index: 0, to: 100 },
      { consumed: 100, index: 1, to: 300 },
    ]);
    expect(result.residual).toBe(0);
    expectConserved(DOWN, result);
  });

  it('conserves an upward delta while transferring its residual through two layers', () => {
    const { chain, read } = chainOf(
      { maxScroll: 100, scrollTop: 20 },
      { maxScroll: 1_000, scrollTop: 500 },
    );

    const result = allocateScrollDelta(chain, UP, read);

    expect(result.allocations.map(({ consumed, index, to }) => ({ consumed, index, to }))).toEqual([
      { consumed: -20, index: 0, to: 0 },
      { consumed: -100, index: 1, to: 400 },
    ]);
    expect(result.residual).toBe(0);
    expectConserved(UP, result);
  });

  it('walks three or more layers in one allocation in both directions', () => {
    const down = chainOf(
      { maxScroll: 50, scrollTop: 25 },
      { maxScroll: 100, scrollTop: 50 },
      { maxScroll: 200, scrollTop: 100 },
      { maxScroll: 1_000, scrollTop: 0 },
    );
    const downResult = allocateScrollDelta(down.chain, 300, down.read);
    expect(downResult.allocations.map(({ consumed }) => consumed)).toEqual([25, 50, 100, 125]);
    expectConserved(300, downResult);

    const up = chainOf(
      { maxScroll: 50, scrollTop: 25 },
      { maxScroll: 100, scrollTop: 50 },
      { maxScroll: 200, scrollTop: 100 },
      { maxScroll: 1_000, scrollTop: 800 },
    );
    const upResult = allocateScrollDelta(up.chain, -300, up.read);
    expect(upResult.allocations.map(({ consumed }) => consumed)).toEqual([-25, -50, -100, -125]);
    expectConserved(-300, upResult);
  });

  it('returns only the genuinely unconsumed residual at the outer edge', () => {
    const { chain, read } = chainOf(
      { maxScroll: 100, scrollTop: 90 },
      { maxScroll: 200, scrollTop: 180 },
    );
    const result = allocateScrollDelta(chain, 50, read);

    expect(result.consumed).toBe(30);
    expect(result.residual).toBe(20);
    expectConserved(50, result);
  });

  it('skips ordinary disconnected nodes without throwing and transfers to a live ancestor', () => {
    const { chain, read } = chainOf(
      { connected: false, maxScroll: 100, scrollTop: 20 },
      { maxScroll: 500, scrollTop: 100 },
    );
    const result = allocateScrollDelta(chain, DOWN, read);

    expect(result.allocations).toHaveLength(1);
    expect(result.allocations[0]).toMatchObject({ consumed: 120, index: 1, to: 220 });
    expectConserved(DOWN, result);
  });

  it('preserves a disconnected top-layer boundary instead of penetrating the background', () => {
    const { chain, read } = chainOf(
      { connected: false, scroller: false, topLayer: true },
      { maxScroll: 1_000, scrollTop: 0 },
    );
    const result = allocateScrollDelta(chain, DOWN, read);

    expect(result.allocations).toEqual([]);
    expect(result.residual).toBe(DOWN);
    expect(result.stoppedBy).toBe(chain[0]);
    expectConserved(DOWN, result);
  });

  it('lets a top-layer scroller consume capacity but blocks its residual from the shell', () => {
    const { chain, read } = chainOf(
      { maxScroll: 100, scrollTop: 70 },
      { maxScroll: 200, scrollTop: 180, topLayer: true },
      { maxScroll: 1_000, scrollTop: 0 },
    );
    const result = allocateScrollDelta(chain, DOWN, read);

    expect(result.allocations.map(({ consumed, index }) => ({ consumed, index }))).toEqual([
      { consumed: 30, index: 0 },
      { consumed: 20, index: 1 },
    ]);
    expect(result.residual).toBe(70);
    expect(result.stoppedBy).toBe(chain[1]);
    expectConserved(DOWN, result);
  });

  it('honours overscroll containment after consuming the sealed scroller capacity', () => {
    const { chain, read } = chainOf(
      { maxScroll: 100, scrollTop: 70, traps: true },
      { maxScroll: 1_000, scrollTop: 0 },
    );
    const result = allocateScrollDelta(chain, DOWN, read);

    expect(result.allocations[0]).toMatchObject({ consumed: 30, index: 0, to: 100 });
    expect(result.residual).toBe(90);
    expect(result.stoppedBy).toBe(chain[0]);
    expectConserved(DOWN, result);
  });

  it('starts from a latched layer without allowing a fresh child to steal the burst', () => {
    const { chain, read } = chainOf(
      { maxScroll: 1_000, scrollTop: 0 },
      { maxScroll: 1_000, scrollTop: 100 },
    );
    const result = allocateScrollDelta(chain, DOWN, read, 1);

    expect(result.allocations).toHaveLength(1);
    expect(result.allocations[0]).toMatchObject({ consumed: 120, index: 1, to: 220 });
  });
});

describe('adaptive gesture boundaries', () => {
  it('learns fast and slow device cadences instead of applying one 200ms timeout', () => {
    const fastStart = advanceGestureTiming(undefined, 0, 1).timing;
    const fastPair = advanceGestureTiming(fastStart, 20, 1);
    expect(fastPair.continued).toBe(true);
    expect(gestureIdleThreshold(fastPair.timing)).toBeLessThan(200);
    expect(advanceGestureTiming(fastPair.timing, 170, 1).continued).toBe(false);

    const slowStart = advanceGestureTiming(undefined, 1_000, 1).timing;
    const slowPair = advanceGestureTiming(slowStart, 1_120, 1);
    expect(slowPair.continued).toBe(true);
    expect(gestureIdleThreshold(slowPair.timing)).toBeGreaterThan(200);
    expect(advanceGestureTiming(slowPair.timing, 1_370, 1).continued).toBe(true);
  });

  it('starts a fresh burst immediately when direction reverses', () => {
    const down = advanceGestureTiming(undefined, 10, 1).timing;
    const continuedDown = advanceGestureTiming(down, 30, 1).timing;
    const reversed = advanceGestureTiming(continuedDown, 31, -1);

    expect(reversed.continued).toBe(false);
    expect(reversed.timing).toEqual({ direction: -1, lastAt: 31 });
  });
});

describe('scroll chaining installation', () => {
  const cleanups: (() => void)[] = [];
  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) cleanup();
  });

  const setup = () => {
    const dom = new JSDOM(
      '<!doctype html><div id="outer"><div id="inner"></div></div><div id="sibling"></div>',
      {
        pretendToBeVisual: true,
        url: 'http://localhost/',
      },
    );
    const targetWindow = dom.window as unknown as Window & typeof globalThis;
    const inner = dom.window.document.getElementById('inner')!;
    const outer = dom.window.document.getElementById('outer')!;
    const sibling = dom.window.document.getElementById('sibling')!;
    const ranges = new Map<Element, number>([
      [inner, 1_000],
      [outer, 1_000],
      [sibling, 1_000],
    ]);
    const frames = new Map<number, FrameRequestCallback>();
    const media = Object.assign(new dom.window.EventTarget(), { matches: false });
    Object.defineProperty(targetWindow, 'matchMedia', { value: () => media });
    const operations: string[] = [];
    let nextFrame = 0;
    let clock = 0;
    for (const element of [inner, outer, sibling]) {
      let top = 0;
      Object.defineProperty(element, 'scrollTop', {
        get: () => top,
        set: (value: number) => {
          operations.push('write');
          top = value;
        },
      });
    }
    const read: ProbeReader = (element) => {
      operations.push('read');
      return {
        canScrollY: (ranges.get(element) ?? 0) > 1,
        isConnected: element.isConnected,
        isTopLayer: false,
        maxScroll: ranges.get(element) ?? 0,
        scrollTop: element.scrollTop,
        trapsChaining: false,
      };
    };
    const options = {
      cancelAnimationFrame: (handle: number) => {
        frames.delete(handle);
      },
      readProbe: read,
      requestAnimationFrame: (callback: FrameRequestCallback) => {
        frames.set(++nextFrame, callback);
        return nextFrame;
      },
    };
    const dispose = installScrollChaining(targetWindow, options);
    const frame = (at: number): void => {
      clock = at;
      const batch = [...frames.values()];
      frames.clear();
      operations.splice(0);
      for (const callback of batch) callback(at);
      // No forced layout interleaved with the frame's writes, even when several scrollers move.
      const firstWrite = operations.indexOf('write');
      if (firstWrite >= 0) expect(operations.slice(firstWrite)).not.toContain('read');
    };
    const wheel = (target: Element, deltaY: number): WheelEvent => {
      const event = new dom.window.WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY });
      Object.defineProperty(event, 'timeStamp', { value: clock });
      target.dispatchEvent(event);
      return event;
    };
    cleanups.push(() => {
      dispose();
      dom.window.close();
    });
    return {
      dispose,
      dom,
      frame,
      frames,
      inner,
      media,
      options,
      outer,
      ranges,
      sibling,
      targetWindow,
      wheel,
    };
  };

  it('batches same-frame deltas, decelerates nonlinearly and supports repeated install/dispose', () => {
    const { dispose, frame, frames, inner, options, targetWindow, wheel } = setup();
    expect(installScrollChaining(targetWindow, options)).toBe(dispose);
    const first = wheel(inner, 120);
    const second = wheel(inner, 120);
    expect(first.defaultPrevented).toBe(true);
    expect(second.defaultPrevented).toBe(true);
    expect(frames.size).toBe(1);
    frame(0);
    const firstTop = inner.scrollTop;
    expect(firstTop).toBeGreaterThan(0);
    expect(firstTop).toBeLessThan(240);
    frame(60);
    const secondTop = inner.scrollTop;
    frame(120);
    const thirdTop = inner.scrollTop;
    frame(SCROLL_DURATION_MS);
    expect(inner.scrollTop).toBe(240);
    expect(secondTop - firstTop).toBeGreaterThan(thirdTop - secondTop);
    expect(thirdTop - secondTop).toBeGreaterThan(240 - thirdTop);
    expect(frames.size).toBe(0);

    dispose();
    dispose();
    const afterDispose = wheel(inner, 120);
    expect(afterDispose.defaultPrevented).toBe(false);
    expect(frames.size).toBe(0);

    const disposeAgain = installScrollChaining(targetWindow, options);
    expect(disposeAgain).not.toBe(dispose);
    wheel(inner, 120);
    frame(200);
    frame(200 + SCROLL_DURATION_MS);
    expect(inner.scrollTop).toBe(360);
    disposeAgain();
  });

  it('conserves rapid retargeted input and starts child and parent motion in the first frame', () => {
    const { frame, inner, outer, ranges, wheel } = setup();
    ranges.set(inner, 100);
    inner.scrollTop = 80;
    wheel(inner, 120);
    frame(0);
    expect(inner.scrollTop).toBeGreaterThan(80);
    expect(outer.scrollTop).toBeGreaterThan(0);
    frame(50);
    wheel(inner, 120);
    frame(60);
    frame(240);
    expect(inner.scrollTop).toBe(100);
    expect(outer.scrollTop).toBe(220);
  });

  it('reverses promptly and does not steal a wheel burst from an unrelated panel', () => {
    const { frame, inner, sibling, wheel } = setup();
    wheel(inner, 240);
    frame(0);
    const beforeReverse = inner.scrollTop;
    wheel(inner, -120);
    frame(30);
    expect(inner.scrollTop).toBeLessThan(beforeReverse);
    wheel(sibling, 120);
    frame(50);
    frame(250);
    expect(inner.scrollTop).toBe(0);
    expect(sibling.scrollTop).toBe(120);
  });

  it('drops a stale parent latch after programmatic scroll restoration between wheel events', () => {
    const { frame, inner, outer, ranges, wheel } = setup();
    ranges.set(inner, 100);
    inner.scrollTop = 80;
    wheel(inner, 120);
    frame(0);
    // No scroll event is required: a same-frame state replacement can precede its native event.
    inner.scrollTop = 0;
    outer.scrollTop = 0;
    wheel(inner, 120);
    frame(40);
    frame(220);
    expect(inner.scrollTop).toBe(100);
    expect(outer.scrollTop).toBe(20);
  });

  it('hands control back immediately to native scrollbar dragging', () => {
    const { dom, frame, frames, inner, wheel } = setup();
    wheel(inner, 240);
    frame(0);
    inner.dispatchEvent(new dom.window.Event('pointerdown', { bubbles: true }));
    inner.scrollTop = 17;
    inner.dispatchEvent(new dom.window.Event('scroll'));
    frame(200);
    expect(inner.scrollTop).toBe(17);
    expect(frames.size).toBe(0);
    wheel(inner, 120);
    frame(210);
    frame(400);
    expect(inner.scrollTop).toBe(137);
  });

  it('finishes ongoing motion immediately when reduced motion is enabled', () => {
    const { dom, frame, frames, inner, media, wheel } = setup();
    wheel(inner, 240);
    frame(0);
    media.matches = true;
    media.dispatchEvent(new dom.window.Event('change'));
    frame(16);
    expect(inner.scrollTop).toBe(240);
    expect(frames.size).toBe(0);
    wheel(inner, 120);
    frame(32);
    expect(inner.scrollTop).toBe(360);
    expect(frames.size).toBe(0);
  });

  it('cancels inherited momentum when native scrolling overrides a nested scroller', () => {
    const { dom, frame, frames, inner, outer, ranges, wheel } = setup();
    ranges.set(inner, 100);
    inner.scrollTop = 80;
    wheel(inner, 240);
    frame(0);
    const parentTop = outer.scrollTop;
    inner.scrollTop = 17;
    inner.dispatchEvent(new dom.window.Event('scroll'));
    frame(200);
    expect(inner.scrollTop).toBe(17);
    expect(outer.scrollTop).toBe(parentTop);
    expect(frames.size).toBe(0);
  });

  it('cancels background momentum when a modal owns the new wheel gesture', () => {
    const { dom, frame, inner, ranges, wheel } = setup();
    wheel(inner, 240);
    frame(0);
    const backgroundTop = inner.scrollTop;
    const dialog = dom.window.document.createElement('dialog');
    dialog.open = true;
    const popup = dom.window.document.createElement('div');
    dialog.append(popup);
    dom.window.document.body.append(dialog);
    ranges.set(popup, 50);
    wheel(popup, 120);
    frame(20);
    frame(200);
    expect(inner.scrollTop).toBe(backgroundTop);
    expect(popup.scrollTop).toBe(50);
  });
});
