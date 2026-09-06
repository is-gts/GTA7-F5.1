import { describe, expect, it } from 'vitest';
import { Engine } from '../src/core/Engine';
import { EventBus } from '../src/core/EventBus';

describe('Engine', () => {
  it('runs fixed updates according to elapsed time and renders once per tick', () => {
    const engine = new Engine({ fixedDelta: 1 / 60 });
    let updates = 0;
    let renders = 0;
    let lastAlpha = -1;
    engine.addSystem({
      update: (dt) => {
        expect(dt).toBeCloseTo(1 / 60);
        updates++;
      },
      render: (alpha) => {
        renders++;
        lastAlpha = alpha;
      },
    });
    engine.tick(0); // establishes time base
    engine.tick(1 / 60); // exactly one step
    expect(updates).toBe(1);
    expect(renders).toBe(2);
    engine.tick(1 / 60 + 0.5 / 60); // half a step accumulated
    expect(updates).toBe(1);
    expect(lastAlpha).toBeCloseTo(0.5, 5);
    engine.tick(1 / 60 + 0.5 / 60 + 3 / 60); // 3 more steps
    expect(updates).toBe(4);
  });

  it('clamps huge frame deltas and caps sub-steps (no spiral of death)', () => {
    const engine = new Engine({ fixedDelta: 1 / 60, maxFrameDelta: 0.1, maxSubSteps: 4 });
    let updates = 0;
    engine.addSystem({ update: () => updates++ });
    engine.tick(0);
    const steps = engine.tick(10); // 10 s jump -> clamped to 0.1 s -> 6 steps, capped to 4
    expect(steps).toBe(4);
    expect(updates).toBe(4);
    // After cap the accumulator is dropped, so the next small tick does not burst.
    const steps2 = engine.tick(10 + 0.001);
    expect(steps2).toBe(0);
  });

  it('stepOnce advances exactly one update', () => {
    const engine = new Engine();
    let updates = 0;
    engine.addSystem({ update: () => updates++ });
    engine.stepOnce();
    engine.stepOnce();
    expect(updates).toBe(2);
    expect(engine.stats.updates).toBe(2);
    expect(engine.stats.simTime).toBeCloseTo(2 / 60);
  });

  it('removes systems', () => {
    const engine = new Engine();
    let updates = 0;
    const off = engine.addSystem({ update: () => updates++ });
    engine.stepOnce();
    off();
    engine.stepOnce();
    expect(updates).toBe(1);
  });
});

describe('EventBus', () => {
  it('dispatches, supports once and unsubscribe during dispatch', () => {
    const bus = new EventBus<{ hit: number; done: void }>();
    const seen: number[] = [];
    const off = bus.on('hit', (v) => {
      seen.push(v);
      off();
    });
    bus.once('hit', (v) => seen.push(v * 10));
    bus.emit('hit', 1);
    bus.emit('hit', 2);
    expect(seen).toEqual([1, 10]);
  });
});
