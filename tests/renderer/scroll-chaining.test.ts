import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
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
  it('batches same-frame deltas once and supports repeated install/dispose', () => {
    const dom = new JSDOM('<!doctype html><div id="inner"></div>', {
      pretendToBeVisual: true,
      url: 'http://localhost/',
    });
    const targetWindow = dom.window as unknown as Window & typeof globalThis;
    const inner = dom.window.document.getElementById('inner')!;
    const frames: FrameRequestCallback[] = [];
    const read: ProbeReader = (element) => ({
      canScrollY: element === inner,
      isConnected: element.isConnected,
      isTopLayer: false,
      maxScroll: element === inner ? 1_000 : 0,
      scrollTop: element.scrollTop,
      trapsChaining: false,
    });
    const options = {
      cancelAnimationFrame: () => undefined,
      readProbe: read,
      requestAnimationFrame: (callback: FrameRequestCallback) => {
        frames.push(callback);
        return frames.length;
      },
    };

    const dispose = installScrollChaining(targetWindow, options);
    expect(installScrollChaining(targetWindow, options)).toBe(dispose);

    const first = new dom.window.WheelEvent('wheel', {
      bubbles: true,
      cancelable: true,
      deltaY: 120,
    });
    const second = new dom.window.WheelEvent('wheel', {
      bubbles: true,
      cancelable: true,
      deltaY: 120,
    });
    inner.dispatchEvent(first);
    inner.dispatchEvent(second);

    expect(first.defaultPrevented).toBe(true);
    expect(second.defaultPrevented).toBe(true);
    expect(frames).toHaveLength(1);
    frames.shift()!(0);
    expect(inner.scrollTop).toBe(240);

    dispose();
    dispose();
    const afterDispose = new dom.window.WheelEvent('wheel', {
      bubbles: true,
      cancelable: true,
      deltaY: 120,
    });
    inner.dispatchEvent(afterDispose);
    expect(afterDispose.defaultPrevented).toBe(false);
    expect(frames).toHaveLength(0);

    const disposeAgain = installScrollChaining(targetWindow, options);
    expect(disposeAgain).not.toBe(dispose);
    const afterReinstall = new dom.window.WheelEvent('wheel', {
      bubbles: true,
      cancelable: true,
      deltaY: 120,
    });
    inner.dispatchEvent(afterReinstall);
    expect(frames).toHaveLength(1);
    frames.shift()!(0);
    expect(inner.scrollTop).toBe(360);

    disposeAgain();
    dom.window.close();
  });
});
