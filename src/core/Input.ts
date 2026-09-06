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
  quality1: ['Digit1'],
  quality2: ['Digit2'],
  quality3: ['Digit3'],
  quality4: ['Digit4'],
} as const;

type Action = keyof typeof KEY_BINDINGS;

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

    s.interactPressed = this.wasPressed('interact') || gp.interactPressed;
    s.cameraTogglePressed = this.wasPressed('cameraToggle');
    s.pausePressed = this.wasPressed('pause') || gp.pausePressed;
    s.hornPressed = this.wasPressed('horn');
    s.lookBack = this.isDown('lookBack');
    s.qualityPressed = this.wasPressed('quality1') ? 1 : this.wasPressed('quality2') ? 2 : this.wasPressed('quality3') ? 3 : this.wasPressed('quality4') ? 4 : 0;

    s.lookDX = this.pendingLookDX + gp.lookDX;
    s.lookDY = this.pendingLookDY + gp.lookDY;
    this.pendingLookDX = 0;
    this.pendingLookDY = 0;
    this.pressedThisFrame.clear();
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
  private readonly onKeyDown = (e: KeyboardEvent) => {
    if (e.repeat) return;
    if (this.keyToActions.has(e.code)) e.preventDefault();
    this.setKey(e.code, true);
  };
  private readonly onKeyUp = (e: KeyboardEvent) => {
    this.setKey(e.code, false);
  };
  private readonly onBlur = () => {
    this.keys.clear();
    this.keySteer = 0;
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
