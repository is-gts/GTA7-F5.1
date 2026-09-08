/**
 * Input abstraction. Raw device state (keyboard / pointer / gamepad / injected touch)
 * is mapped into a small set of analog/digital actions consumed by gameplay systems.
 *
 * Systems never read the DOM directly; they read `input.state`, which is refreshed once
 * per frame via `input.poll()`.
 */
export interface InputState {
  /** -1..1 (left/right). */
  steer: number;
  /** 0..1 */
  throttle: number;
  /** 0..1 */
  brake: number;
  handbrake: boolean;
  /** On-foot movement, -1..1 each axis (x = strafe, y = forward). */
  moveX: number;
  moveY: number;
  sprint: boolean;
  jump: boolean;
  /** Edge-triggered actions (true only on the frame they were pressed). */
  interactPressed: boolean;
  cameraTogglePressed: boolean;
  pausePressed: boolean;
  hornPressed: boolean;
  /** Camera orbit deltas (pixels or normalized), consumed each frame. */
  lookDX: number;
  lookDY: number;
  lookBack: boolean;
  /** 1-4 when a quality hotkey was pressed this frame, else 0. */
  qualityPressed: number;
  /** Edge-triggered: `M` was pressed this frame (audio mute toggle). */
  mutePressed: boolean;
}

export function createEmptyInputState(): InputState {
  return {
    steer: 0,
    throttle: 0,
    brake: 0,
    handbrake: false,
    moveX: 0,
    moveY: 0,
    sprint: false,
    jump: false,
    interactPressed: false,
    cameraTogglePressed: false,
    pausePressed: false,
    hornPressed: false,
    lookDX: 0,
    lookDY: 0,
    lookBack: false,
    qualityPressed: 0,
    mutePressed: false,
  };
}

/** Virtual controls that touch UI or automation can drive (values persist until changed). */
export interface VirtualInput {
  steer: number;
  throttle: number;
  brake: number;
  handbrake: boolean;
  moveX: number;
  moveY: number;
  sprint: boolean;
}

const KEY_BINDINGS = {
  forward: ['KeyW', 'ArrowUp'],
  back: ['KeyS', 'ArrowDown'],
  left: ['KeyA', 'ArrowLeft'],
  right: ['KeyD', 'ArrowRight'],
  handbrake: ['Space'],
  sprint: ['ShiftLeft', 'ShiftRight'],
  interact: ['KeyE', 'KeyF', 'Enter'],
  cameraToggle: ['KeyV'],
  pause: ['Escape', 'KeyP'],
  horn: ['KeyH'],
  lookBack: ['KeyC'],
  mute: ['KeyM'],
  quality1: ['Digit1'],
  quality2: ['Digit2'],
  quality3: ['Digit3'],
  quality4: ['Digit4'],
} as const;

type Action = keyof typeof KEY_BINDINGS;

/** Matches any element inside a settings menu that is currently open (`Menu.close()` sets
 *  `root.hidden`, which reflects to the `hidden` attribute). See `Input.isUiTarget`. */
const OPEN_MENU_SELECTOR = '.settings-menu:not([hidden])';

export class Input {
  readonly state: InputState = createEmptyInputState();
  readonly virtual: VirtualInput = {
    steer: 0,
    throttle: 0,
    brake: 0,
    handbrake: false,
    moveX: 0,
    moveY: 0,
    sprint: false,
  };

  private readonly keys = new Set<string>();
  private readonly pressedThisFrame = new Set<string>();
  private pendingLookDX = 0;
  private pendingLookDY = 0;
  private pointerLocked = false;
  private target: EventTarget | null = null;
  private readonly keyToActions = new Map<string, Action[]>();
  /** Smoothed analog steer from digital keys so keyboard driving is not twitchy. */
  private keySteer = 0;
  /** One-shot edge-triggered actions queued by touch UI buttons (see `TouchControls`), consumed by
   *  the next `poll()` alongside the equivalent keyboard/gamepad edge. */
  private readonly virtualPress = new Set<'interact' | 'cameraToggle' | 'horn'>();

  constructor() {
    for (const [action, codes] of Object.entries(KEY_BINDINGS) as [Action, readonly string[]][]) {
      for (const code of codes) {
        const list = this.keyToActions.get(code) ?? [];
        list.push(action);
        this.keyToActions.set(code, list);
      }
    }
  }

  attach(target: EventTarget, pointerLockElement?: HTMLElement): void {
    this.detach();
    this.target = target;
    target.addEventListener('keydown', this.onKeyDown as EventListener);
    target.addEventListener('keyup', this.onKeyUp as EventListener);
    target.addEventListener('blur', this.onBlur as EventListener);
    if (pointerLockElement) {
      pointerLockElement.addEventListener('click', () => {
        if (!this.pointerLocked && typeof pointerLockElement.requestPointerLock === 'function') {
          try {
            const p = pointerLockElement.requestPointerLock() as unknown;
            if (p && typeof (p as Promise<void>).catch === 'function') (p as Promise<void>).catch(() => {});
          } catch {
            /* pointer lock unsupported: ignore */
          }
        }
      });
      document.addEventListener('pointerlockchange', () => {
        this.pointerLocked = document.pointerLockElement === pointerLockElement;
      });
      document.addEventListener('mousemove', this.onMouseMove);
    }
  }

  detach(): void {
    if (!this.target) return;
    this.target.removeEventListener('keydown', this.onKeyDown as EventListener);
    this.target.removeEventListener('keyup', this.onKeyUp as EventListener);
    this.target.removeEventListener('blur', this.onBlur as EventListener);
    document.removeEventListener('mousemove', this.onMouseMove);
    this.target = null;
  }

  /** Programmatic key injection (tests / automation). */
  setKey(code: string, down: boolean): void {
    if (down) {
      if (!this.keys.has(code)) this.pressedThisFrame.add(code);
      this.keys.add(code);
    } else {
      this.keys.delete(code);
    }
  }

  isDown(action: Action): boolean {
    for (const code of KEY_BINDINGS[action]) if (this.keys.has(code)) return true;
    return false;
  }

  private wasPressed(action: Action): boolean {
    for (const code of KEY_BINDINGS[action]) if (this.pressedThisFrame.has(code)) return true;
    return false;
  }

  addLook(dx: number, dy: number): void {
    this.pendingLookDX += dx;
    this.pendingLookDY += dy;
  }

  /** Queue a one-frame edge-triggered press for a touch UI button (`interact`/`cameraToggle`/`horn`
   *  only — the other actions are already level-driven via `virtual`). Consumed by the next `poll()`. */
  pressVirtual(action: 'interact' | 'cameraToggle' | 'horn'): void {
    this.virtualPress.add(action);
  }

  /** Drop every held key (and the smoothed steer that follows them). Used on window blur and when
   *  the settings menu opens, so a key held at that moment is not still "down" on resume. */
  clearKeys(): void {
    this.keys.clear();
    this.pressedThisFrame.clear();
    this.keySteer = 0;
  }

  /** Exit pointer lock if currently held (used when the settings menu opens). No-op otherwise. */
  releasePointerLock(): void {
    if (!this.pointerLocked) return;
    try {
      document.exitPointerLock?.();
    } catch {
      /* ignore */
    }
  }

  /**
   * Compose the per-frame InputState from keyboard, gamepad and virtual inputs.
   * @param frameDelta seconds since last poll (for steer smoothing)
   */
  poll(frameDelta: number): InputState {
    const s = this.state;
    const gp = this.readGamepad();

    const fwd = this.isDown('forward') ? 1 : 0;
    const back = this.isDown('back') ? 1 : 0;
    const left = this.isDown('left') ? 1 : 0;
    const right = this.isDown('right') ? 1 : 0;

    // Digital steer smoothing: ramps to full lock in ~0.25s, returns to centre faster.
    const targetSteer = right - left;
    const rate = targetSteer === 0 ? 10 : 4;
    const step = rate * Math.max(frameDelta, 0);
    if (this.keySteer < targetSteer) this.keySteer = Math.min(targetSteer, this.keySteer + step);
    else if (this.keySteer > targetSteer) this.keySteer = Math.max(targetSteer, this.keySteer - step);

    s.steer = clamp(this.keySteer + gp.steer + this.virtual.steer, -1, 1);
    s.throttle = clamp(Math.max(fwd, gp.throttle, this.virtual.throttle), 0, 1);
    s.brake = clamp(Math.max(back, gp.brake, this.virtual.brake), 0, 1);
    s.handbrake = this.isDown('handbrake') || gp.handbrake || this.virtual.handbrake;

    s.moveX = clamp(right - left + gp.steer + this.virtual.moveX, -1, 1);
    s.moveY = clamp(fwd - back + gp.moveY + this.virtual.moveY, -1, 1);
    s.sprint = this.isDown('sprint') || gp.sprint || this.virtual.sprint;
    s.jump = this.isDown('handbrake');

    s.interactPressed = this.wasPressed('interact') || gp.interactPressed || this.virtualPress.has('interact');
    s.cameraTogglePressed = this.wasPressed('cameraToggle') || this.virtualPress.has('cameraToggle');
    s.pausePressed = this.wasPressed('pause') || gp.pausePressed;
    s.hornPressed = this.wasPressed('horn') || this.virtualPress.has('horn');
    s.mutePressed = this.wasPressed('mute');
    s.lookBack = this.isDown('lookBack');
    s.qualityPressed = this.wasPressed('quality1') ? 1 : this.wasPressed('quality2') ? 2 : this.wasPressed('quality3') ? 3 : this.wasPressed('quality4') ? 4 : 0;

    s.lookDX = this.pendingLookDX + gp.lookDX;
    s.lookDY = this.pendingLookDY + gp.lookDY;
    this.pendingLookDX = 0;
    this.pendingLookDY = 0;
    this.pressedThisFrame.clear();
    this.virtualPress.clear();
    return s;
  }

  get isPointerLocked(): boolean {
    return this.pointerLocked;
  }

  // --- gamepad -------------------------------------------------------------
  private prevGamepadButtons: boolean[] = [];

  private readGamepad(): {
    steer: number;
    throttle: number;
    brake: number;
    handbrake: boolean;
    moveY: number;
    sprint: boolean;
    interactPressed: boolean;
    pausePressed: boolean;
    lookDX: number;
    lookDY: number;
  } {
    const none = {
      steer: 0,
      throttle: 0,
      brake: 0,
      handbrake: false,
      moveY: 0,
      sprint: false,
      interactPressed: false,
      pausePressed: false,
      lookDX: 0,
      lookDY: 0,
    };
    if (typeof navigator === 'undefined' || typeof navigator.getGamepads !== 'function') return none;
    let pad: Gamepad | null = null;
    try {
      for (const p of navigator.getGamepads()) if (p && p.connected) { pad = p; break; }
    } catch {
      return none;
    }
    if (!pad) return none;
    const axis = (i: number) => deadzone(pad.axes[i] ?? 0, 0.15);
    const btn = (i: number) => pad.buttons[i]?.value ?? 0;
    const pressed = (i: number) => (pad.buttons[i]?.pressed ?? false);
    const edge = (i: number) => {
      const now = pressed(i);
      const was = this.prevGamepadButtons[i] ?? false;
      this.prevGamepadButtons[i] = now;
      return now && !was;
    };
    return {
      steer: axis(0),
      throttle: btn(7),
      brake: btn(6),
      handbrake: pressed(0),
      moveY: -axis(1),
      sprint: pressed(10),
      interactPressed: edge(3),
      pausePressed: edge(9),
      lookDX: axis(2) * 8,
      lookDY: axis(3) * 8,
    };
  }

  // --- DOM handlers --------------------------------------------------------
  /**
   * True when a keydown originates from a control inside an **open** settings menu — those events
   * belong to the focused slider/select/checkbox/button (arrow keys nudge a range, Space toggles a
   * checkbox, Enter activates a button) and must be left to the browser rather than being consumed
   * as gameplay input.
   *
   * The match is deliberately anchored to `.settings-menu:not([hidden])` rather than to the
   * element's tag name: Chromium keeps dispatching key events at the last focused element even
   * after it has been hidden (`Menu.close()` sets `root.hidden`, and `document.activeElement`
   * reports `<body>` while `e.target` is still the button that was clicked). A tag-based check
   * therefore swallowed every gameplay key after the player closed the menu with the mouse, until
   * they happened to click the canvas. Anything outside an open menu — the touch overlay's gear
   * button included — is ordinary gameplay input.
   */
  private isUiTarget(target: EventTarget | null): boolean {
    // Duck-typed rather than `instanceof HTMLElement` so this stays unit-testable with a plain
    // mock in the (jsdom-less) node test environment; any real DOM element satisfies this too.
    const el = target as { closest?: (selector: string) => unknown } | null;
    if (!el || typeof el.closest !== 'function') return false;
    return !!el.closest(OPEN_MENU_SELECTOR);
  }
  private readonly onKeyDown = (e: KeyboardEvent) => {
    if (e.repeat) return;
    // Escape/P stay live even inside the menu so it can always be closed from a focused control.
    const isPauseKey = (KEY_BINDINGS.pause as readonly string[]).includes(e.code);
    if (!isPauseKey && this.isUiTarget(e.target)) return;
    if (this.keyToActions.has(e.code)) e.preventDefault();
    this.setKey(e.code, true);
  };
  /** Key releases are never filtered by target: a key pressed on the canvas and released while a
   *  menu control has focus must still clear, or the car keeps accelerating with nothing held.
   *  (Clearing a key is harmless for form controls, and keyup is never `preventDefault`ed.) */
  private readonly onKeyUp = (e: KeyboardEvent) => {
    this.setKey(e.code, false);
  };
  private readonly onBlur = () => {
    this.clearKeys();
  };
  private readonly onMouseMove = (e: MouseEvent) => {
    if (!this.pointerLocked) return;
    this.addLook(e.movementX, e.movementY);
  };
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function deadzone(v: number, dz: number): number {
  const a = Math.abs(v);
  if (a < dz) return 0;
  return Math.sign(v) * ((a - dz) / (1 - dz));
}
