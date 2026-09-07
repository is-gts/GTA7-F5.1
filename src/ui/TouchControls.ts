/**
 * On-screen touch controls for phones/tablets: a left virtual joystick (steer while driving, move
 * while on foot), right-side buttons (throttle, brake/reverse, handbrake, enter/exit, horn,
 * camera), a full-canvas drag-to-look area, and a gear button that opens the settings menu.
 *
 * Drives `Input.virtual` (and `Input.pressVirtual` for the edge-triggered buttons) exclusively —
 * no direct calls into `Game` — so it stays a thin, swappable input source alongside keyboard and
 * gamepad, exactly like they are.
 */
import type { Input } from '../core/Input';

export interface JoystickVector {
  x: number;
  y: number;
}

/** True when the current environment reports touch support (`ontouchstart` or `maxTouchPoints`). */
export function isTouchDevice(): boolean {
  if (typeof window === 'undefined') return false;
  const nav = typeof navigator !== 'undefined' ? navigator : undefined;
  return 'ontouchstart' in window || (nav?.maxTouchPoints ?? 0) > 0;
}

/**
 * Map a raw touch drag from a joystick's centre (`dx`, `dy` in CSS pixels) to a -1..1 vector:
 * normalized by `maxRadius`, with a radial deadzone (`deadzone`, a 0..1 fraction of `maxRadius`)
 * below which the output is exactly zero, and the remaining travel rescaled so the vector still
 * reaches unit length exactly at `maxRadius` (matching the visual knob's clamp) instead of the
 * deadzone eating the top of the range too. Pure — no DOM — so it is unit-testable directly.
 */
export function joystickAxes(dx: number, dy: number, maxRadius: number, deadzone: number): JoystickVector {
  if (!(maxRadius > 0)) return { x: 0, y: 0 };
  const dz = Math.max(0, Math.min(0.95, deadzone));
  const rawMag = Math.hypot(dx, dy) / maxRadius;
  if (rawMag < dz) return { x: 0, y: 0 };
  const mag = Math.min(1, (rawMag - dz) / (1 - dz));
  const len = Math.hypot(dx, dy) || 1;
  return { x: (dx / len) * mag, y: (dy / len) * mag };
}

/** Joystick base radius in CSS pixels (must match `.tc-joystick` in style.css: 110px wide / 2). */
const JOYSTICK_RADIUS = 55;
const JOYSTICK_DEADZONE = 0.12;
/** Drag-to-look sensitivity: pixels of finger travel -> the same "pixel" unit `CameraRig`/mouse
 *  look already consumes (see `Input.addLook`), tuned down a little since a touch drag covers more
 *  screen distance than a mouse move for the same intended look angle. */
const LOOK_SENSITIVITY = 0.6;

export class TouchControls {
  readonly root: HTMLElement;
  private readonly joyBase: HTMLElement;
  private readonly joyKnob: HTMLElement;
  private joyTouchId: number | null = null;
  private joyCenter = { x: 0, y: 0 };
  private lookTouchId: number | null = null;
  private lastLook = { x: 0, y: 0 };
  private readonly disposers: (() => void)[] = [];

  constructor(
    private readonly canvas: HTMLCanvasElement,
    container: HTMLElement,
    private readonly input: Input,
    onOpenMenu: () => void,
  ) {
    this.root = document.createElement('div');
    this.root.className = 'touch-controls';
    this.root.innerHTML = `
      <button type="button" class="tc-gear" aria-label="Settings">⚙</button>
      <div class="tc-joystick"><div class="tc-joystick-knob"></div></div>
      <div class="tc-buttons">
        <button type="button" class="tc-btn tc-btn-throttle" aria-label="Throttle">▲</button>
        <button type="button" class="tc-btn tc-btn-brake" aria-label="Brake/Reverse">▼</button>
        <button type="button" class="tc-btn tc-btn-handbrake" aria-label="Handbrake">HB</button>
        <button type="button" class="tc-btn tc-btn-enter" aria-label="Enter/Exit">E</button>
        <button type="button" class="tc-btn tc-btn-horn" aria-label="Horn">H</button>
        <button type="button" class="tc-btn tc-btn-camera" aria-label="Camera">CAM</button>
      </div>`;
    container.appendChild(this.root);

    this.joyBase = this.root.querySelector('.tc-joystick')!;
    this.joyKnob = this.root.querySelector('.tc-joystick-knob')!;

    // A mouse click (as opposed to a tap) leaves the gear button focused, and Chromium keeps
    // dispatching key events at it afterwards — including once the settings menu is closed again.
    // Dropping focus immediately keeps the keyboard aimed at the game.
    const gear = this.root.querySelector<HTMLButtonElement>('.tc-gear')!;
    gear.addEventListener('click', () => {
      gear.blur();
      onOpenMenu();
    });
    this.bindJoystick();
    this.bindHoldButton('.tc-btn-throttle', (down) => (input.virtual.throttle = down ? 1 : 0));
    this.bindHoldButton('.tc-btn-brake', (down) => (input.virtual.brake = down ? 1 : 0));
    this.bindHoldButton('.tc-btn-handbrake', (down) => (input.virtual.handbrake = down));
    this.bindHoldButton('.tc-btn-enter', (down) => {
      if (down) input.pressVirtual('interact');
    });
    this.bindHoldButton('.tc-btn-horn', (down) => {
      if (down) input.pressVirtual('horn');
    });
    this.bindHoldButton('.tc-btn-camera', (down) => {
      if (down) input.pressVirtual('cameraToggle');
    });
    this.bindLookArea();

    // Prevent the page/canvas from scrolling or pinch-zooming under a touch drag.
    canvas.style.touchAction = 'none';
    const preventDefault = (e: TouchEvent) => e.preventDefault();
    canvas.addEventListener('touchstart', preventDefault, { passive: false });
    canvas.addEventListener('touchmove', preventDefault, { passive: false });
    this.disposers.push(() => canvas.removeEventListener('touchstart', preventDefault));
    this.disposers.push(() => canvas.removeEventListener('touchmove', preventDefault));
  }

  private bindJoystick(): void {
    const base = this.joyBase;
    const onStart = (e: TouchEvent): void => {
      const t = e.changedTouches[0];
      if (!t || this.joyTouchId !== null) return;
      e.preventDefault();
      this.joyTouchId = t.identifier;
      const r = base.getBoundingClientRect();
      this.joyCenter = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      this.updateJoystick(t.clientX, t.clientY);
    };
    const onMove = (e: TouchEvent): void => {
      if (this.joyTouchId === null) return;
      for (let i = 0; i < e.changedTouches.length; i++) {
        const t = e.changedTouches[i]!;
        if (t.identifier === this.joyTouchId) {
          e.preventDefault();
          this.updateJoystick(t.clientX, t.clientY);
        }
      }
    };
    const onEnd = (e: TouchEvent): void => {
      for (let i = 0; i < e.changedTouches.length; i++) {
        if (e.changedTouches[i]!.identifier === this.joyTouchId) {
          this.joyTouchId = null;
          this.resetJoystick();
        }
      }
    };
    base.addEventListener('touchstart', onStart, { passive: false });
    base.addEventListener('touchmove', onMove, { passive: false });
    base.addEventListener('touchend', onEnd, { passive: false });
    base.addEventListener('touchcancel', onEnd, { passive: false });
    this.disposers.push(() => base.removeEventListener('touchstart', onStart));
    this.disposers.push(() => base.removeEventListener('touchmove', onMove));
    this.disposers.push(() => base.removeEventListener('touchend', onEnd));
    this.disposers.push(() => base.removeEventListener('touchcancel', onEnd));
  }

  private updateJoystick(clientX: number, clientY: number): void {
    const dx = clientX - this.joyCenter.x;
    const dy = clientY - this.joyCenter.y;
    const v = joystickAxes(dx, dy, JOYSTICK_RADIUS, JOYSTICK_DEADZONE);
    // Drives both driving (steer) and on-foot (moveX/moveY) — only one is read at a time depending
    // on `Game.mode`, so setting both unconditionally is harmless and needs no mode awareness here.
    this.input.virtual.steer = v.x;
    this.input.virtual.moveX = v.x;
    this.input.virtual.moveY = -v.y; // screen-down (positive y) is backward
    this.joyKnob.style.transform = `translate(${v.x * JOYSTICK_RADIUS}px, ${v.y * JOYSTICK_RADIUS}px)`;
  }

  private resetJoystick(): void {
    this.input.virtual.steer = 0;
    this.input.virtual.moveX = 0;
    this.input.virtual.moveY = 0;
    this.joyKnob.style.transform = 'translate(0px, 0px)';
  }

  private bindHoldButton(selector: string, cb: (down: boolean) => void): void {
    const el = this.root.querySelector<HTMLElement>(selector)!;
    const start = (e: Event): void => {
      e.preventDefault();
      el.classList.add('active');
      cb(true);
    };
    const end = (e: Event): void => {
      e.preventDefault();
      el.classList.remove('active');
      cb(false);
    };
    el.addEventListener('touchstart', start, { passive: false });
    el.addEventListener('touchend', end, { passive: false });
    el.addEventListener('touchcancel', end, { passive: false });
    this.disposers.push(() => el.removeEventListener('touchstart', start));
    this.disposers.push(() => el.removeEventListener('touchend', end));
    this.disposers.push(() => el.removeEventListener('touchcancel', end));
  }

  /** Any touch that starts directly on the canvas (i.e. not on the joystick/buttons, which sit
   *  above it and capture their own touches first) drags the camera look. */
  private bindLookArea(): void {
    const canvas = this.canvas;
    const onStart = (e: TouchEvent): void => {
      const t = e.changedTouches[0];
      if (!t || this.lookTouchId !== null) return;
      this.lookTouchId = t.identifier;
      this.lastLook = { x: t.clientX, y: t.clientY };
    };
    const onMove = (e: TouchEvent): void => {
      if (this.lookTouchId === null) return;
      for (let i = 0; i < e.changedTouches.length; i++) {
        const t = e.changedTouches[i]!;
        if (t.identifier === this.lookTouchId) {
          const dx = t.clientX - this.lastLook.x;
          const dy = t.clientY - this.lastLook.y;
          this.lastLook = { x: t.clientX, y: t.clientY };
          this.input.addLook(dx * LOOK_SENSITIVITY, dy * LOOK_SENSITIVITY);
        }
      }
    };
    const onEnd = (e: TouchEvent): void => {
      for (let i = 0; i < e.changedTouches.length; i++) {
        if (e.changedTouches[i]!.identifier === this.lookTouchId) this.lookTouchId = null;
      }
    };
    canvas.addEventListener('touchstart', onStart, { passive: false });
    canvas.addEventListener('touchmove', onMove, { passive: false });
    canvas.addEventListener('touchend', onEnd, { passive: false });
    canvas.addEventListener('touchcancel', onEnd, { passive: false });
    this.disposers.push(() => canvas.removeEventListener('touchstart', onStart));
    this.disposers.push(() => canvas.removeEventListener('touchmove', onMove));
    this.disposers.push(() => canvas.removeEventListener('touchend', onEnd));
    this.disposers.push(() => canvas.removeEventListener('touchcancel', onEnd));
  }

  dispose(): void {
    for (const d of this.disposers) d();
    this.disposers.length = 0;
    this.root.remove();
  }
}
