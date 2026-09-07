import { describe, expect, it } from 'vitest';
import { Input } from '../src/core/Input';

describe('Input', () => {
  it('maps keys to analog driving actions with steer smoothing', () => {
    const input = new Input();
    input.setKey('KeyW', true);
    input.setKey('KeyD', true);
    const s1 = input.poll(1 / 60);
    expect(s1.throttle).toBe(1);
    expect(s1.brake).toBe(0);
    expect(s1.steer).toBeGreaterThan(0);
    expect(s1.steer).toBeLessThan(1); // ramps up over time
    for (let i = 0; i < 60; i++) input.poll(1 / 60);
    expect(input.state.steer).toBe(1);
    input.setKey('KeyD', false);
    for (let i = 0; i < 30; i++) input.poll(1 / 60);
    expect(input.state.steer).toBe(0);
    expect(input.state.moveY).toBe(1);
    input.setKey('KeyW', false);
    input.setKey('ArrowDown', true);
    input.poll(1 / 60);
    expect(input.state.brake).toBe(1);
    expect(input.state.moveY).toBe(-1);
  });

  it('edge-triggers interact/pause/quality once per press', () => {
    const input = new Input();
    input.setKey('KeyE', true);
    expect(input.poll(1 / 60).interactPressed).toBe(true);
    expect(input.poll(1 / 60).interactPressed).toBe(false);
    input.setKey('KeyE', true); // still held: no new edge
    expect(input.poll(1 / 60).interactPressed).toBe(false);
    input.setKey('KeyE', false);
    input.setKey('KeyE', true);
    expect(input.poll(1 / 60).interactPressed).toBe(true);
    input.setKey('Digit3', true);
    expect(input.poll(1 / 60).qualityPressed).toBe(3);
    expect(input.poll(1 / 60).qualityPressed).toBe(0);
    input.setKey('Escape', true);
    expect(input.poll(1 / 60).pausePressed).toBe(true);
  });

  it('accumulates look deltas until polled and honours virtual inputs', () => {
    const input = new Input();
    input.addLook(3, -2);
    input.addLook(1, 1);
    const s = input.poll(1 / 60);
    expect(s.lookDX).toBe(4);
    expect(s.lookDY).toBe(-1);
    expect(input.poll(1 / 60).lookDX).toBe(0);
    input.virtual.throttle = 0.5;
    input.virtual.steer = -0.25;
    input.virtual.handbrake = true;
    const v = input.poll(1 / 60);
    expect(v.throttle).toBe(0.5);
    expect(v.steer).toBe(-0.25);
    expect(v.handbrake).toBe(true);
  });

  it('only ignores gameplay keys aimed at a control inside an OPEN menu, and never filters key releases', () => {
    // No jsdom in this project's unit test environment (see vitest.config.ts: environment 'node'),
    // so this exercises Input's duck-typed target check with plain mock EventTargets rather than
    // real DOM elements — e2e/menu.spec.ts covers the real-browser behaviour end to end.
    const input = new Input();
    const listeners = new Map<string, (e: unknown) => void>();
    const fakeWindow = {
      addEventListener: (type: string, fn: (e: unknown) => void) => listeners.set(type, fn),
      removeEventListener: (type: string) => listeners.delete(type),
    };
    input.attach(fakeWindow as unknown as EventTarget);

    /** `closest()` matches only the "open menu" selector, i.e. `.settings-menu` without `hidden`. */
    const inOpenMenu = (tagName: string) => ({ tagName, closest: (sel: string) => (sel === '.settings-menu:not([hidden])' ? {} : null) });
    /** Same element after `Menu.close()` set `root.hidden`: `:not([hidden])` no longer matches. */
    const inClosedMenu = (tagName: string) => ({ tagName, closest: () => null });
    const menuSelect = inOpenMenu('SELECT');
    const canvas = { tagName: 'CANVAS', closest: () => null };
    const fire = (code: string, target: unknown, type: 'keydown' | 'keyup' = 'keydown') =>
      listeners.get(type)!({ code, repeat: false, target, preventDefault: () => {} });

    // ArrowRight/Space originating from a focused <select> inside the open menu must not be
    // swallowed into gameplay key state (they need to keep operating the control natively).
    fire('ArrowRight', menuSelect);
    fire('Space', menuSelect);
    expect(input.isDown('right')).toBe(false);
    let s = input.poll(1 / 60);
    expect(s.steer).toBe(0);

    // Escape (the pause toggle) must still register even while a menu control has focus, so the
    // menu can still be closed from a focused slider/select.
    fire('Escape', menuSelect);
    s = input.poll(1 / 60);
    expect(s.pausePressed).toBe(true);

    // The same key dispatched outside the menu (e.g. at the canvas) behaves normally.
    fire('ArrowRight', canvas);
    expect(input.isDown('right')).toBe(true);
    fire('ArrowRight', canvas, 'keyup');
    expect(input.isDown('right')).toBe(false);

    // Regression: Chromium keeps dispatching key events at the button the player clicked to close
    // the menu, long after `Menu.close()` hid it (document.activeElement reads <body>, but
    // e.target is still that button). Those keys are ordinary gameplay input — a tag-name-based
    // check would swallow every WASD press until the player clicked the canvas again.
    fire('KeyW', inClosedMenu('BUTTON'));
    expect(input.isDown('forward')).toBe(true);
    fire('KeyW', inClosedMenu('BUTTON'), 'keyup');
    expect(input.isDown('forward')).toBe(false);
    // Same for the touch overlay's gear button, which is never inside the menu at all.
    fire('KeyW', { tagName: 'BUTTON', closest: () => null });
    expect(input.isDown('forward')).toBe(true);
    fire('KeyW', { tagName: 'BUTTON', closest: () => null }, 'keyup');
    expect(input.isDown('forward')).toBe(false);

    // Key releases are never filtered by target: pressing W on the canvas, then releasing it while
    // a menu control has focus, must still clear the key (otherwise the car keeps accelerating).
    fire('KeyW', canvas);
    expect(input.isDown('forward')).toBe(true);
    fire('KeyW', menuSelect, 'keyup');
    expect(input.isDown('forward')).toBe(false);

    // clearKeys() (called when the menu opens) drops everything held and re-centres the steer.
    fire('KeyD', canvas);
    for (let i = 0; i < 30; i++) input.poll(1 / 60);
    expect(input.state.steer).toBeGreaterThan(0);
    input.clearKeys();
    expect(input.isDown('right')).toBe(false);
    expect(input.poll(1 / 60).steer).toBe(0);
    // (No input.detach() here: it unconditionally touches the global `document`, which this node
    // test environment doesn't have — the fake target above is enough to exercise onKeyDown/Up.)
  });
});
