/**
 * Wanted-level state machine: pure data + pure transition functions (no three.js, no timers), so
 * the whole thing is unit-testable and deterministic. `Game` drives it from gameplay events
 * (`pedestrianHit`, `vehicleCrash`, `policeContact`) and a per-tick `stepWanted` decay call.
 *
 * `heat` is a 0..100 scalar; `level` (0..5, the GTA-style star count) is derived from it via
 * `LEVEL_THRESHOLDS`. Heat only rises from discrete events, and holds exactly where it is for
 * `LOSE_TIME` seconds of no police within contact range, then drops straight to zero ("they lose
 * you") — matching the spec ("no police within 120 m for 20 s -> they lose you") literally: the
 * lose-them clock is a fixed 20 s wait, independent of the level it started at, not a per-second
 * drain whose rate would (wrongly) make a low level vanish almost immediately. Any fresh contact or
 * event resets the clock, so the level only ever falls once a full, uninterrupted `LOSE_TIME` has
 * passed.
 */

/** Heat needed to reach wanted level `i` (index = level). */
export const LEVEL_THRESHOLDS = [0, 20, 40, 60, 80, 100] as const;
export const MAX_LEVEL = LEVEL_THRESHOLDS.length - 1;
export const HEAT_MAX: number = LEVEL_THRESHOLDS[MAX_LEVEL]!;

/** Seconds without any police within `POLICE_CONTACT_RANGE` before the wanted level is fully lost. */
export const LOSE_TIME = 20;
/** Distance (m) within which a police car counts as "in contact" for the lose-them timer. */
export const POLICE_CONTACT_RANGE = 120;

export const HEAT_PEDESTRIAN_HIT = 20;
export const HEAT_VEHICLE_CRASH = 15;
export const HEAT_POLICE_CONTACT = 35;

export type WantedEventKind = 'pedestrianHit' | 'vehicleCrash' | 'policeContact';

/**
 * Per-kind debounce (s): one physical incident often produces several events in consecutive ticks
 * (a car that bounces off a police car resolves as two or three collisions above the impulse
 * threshold; a knockdown can be reported by more than one contact). Without this, a single bump
 * could jump the level from 1 to 5 in a fraction of a second. Contact still resets the lose-them
 * clock while the debounce is running — only the heat is not counted twice.
 */
export const EVENT_COOLDOWN: Record<WantedEventKind, number> = {
  pedestrianHit: 0.5,
  vehicleCrash: 1,
  policeContact: 1.5,
};

export interface WantedState {
  /** 0..100 */
  heat: number;
  /** 0..5, derived from `heat`. */
  level: number;
  /** Seconds since a police car was last within `POLICE_CONTACT_RANGE`. */
  secondsSincePoliceContact: number;
  /** Seconds left before each event kind may add heat again (see `EVENT_COOLDOWN`). */
  cooldown: Record<WantedEventKind, number>;
}

export function createWantedState(): WantedState {
  return { heat: 0, level: 0, secondsSincePoliceContact: 0, cooldown: { pedestrianHit: 0, vehicleCrash: 0, policeContact: 0 } };
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** The wanted level (0..5) that `heat` (0..100) maps to. */
export function levelForHeat(heat: number): number {
  let level = 0;
  for (let i = 1; i <= MAX_LEVEL; i++) {
    if (heat >= LEVEL_THRESHOLDS[i]!) level = i;
  }
  return level;
}

function heatForEvent(kind: WantedEventKind): number {
  switch (kind) {
    case 'pedestrianHit':
      return HEAT_PEDESTRIAN_HIT;
    case 'vehicleCrash':
      return HEAT_VEHICLE_CRASH;
    case 'policeContact':
      return HEAT_POLICE_CONTACT;
  }
}

/**
 * Apply a gameplay event: adds heat (clamped at `HEAT_MAX`) and counts as fresh police contact
 * (getting into trouble in front of the law resets the "they lose you" clock). Repeats of the same
 * kind within `EVENT_COOLDOWN` add no further heat — see the comment there.
 */
export function addWantedHeat(state: WantedState, kind: WantedEventKind): WantedState {
  if (state.cooldown[kind] > 0) {
    if (state.secondsSincePoliceContact === 0) return state;
    return { ...state, secondsSincePoliceContact: 0, cooldown: { ...state.cooldown } };
  }
  const heat = clamp(state.heat + heatForEvent(kind), 0, HEAT_MAX);
  return {
    heat,
    level: levelForHeat(heat),
    secondsSincePoliceContact: 0,
    cooldown: { ...state.cooldown, [kind]: EVENT_COOLDOWN[kind] },
  };
}

/** Tick the per-kind event debounce down by `dt`; returns the same object when nothing changes. */
function stepCooldown(state: WantedState, dt: number): WantedState {
  const c = state.cooldown;
  if (c.pedestrianHit <= 0 && c.vehicleCrash <= 0 && c.policeContact <= 0) return state;
  return {
    ...state,
    cooldown: {
      pedestrianHit: Math.max(0, c.pedestrianHit - dt),
      vehicleCrash: Math.max(0, c.vehicleCrash - dt),
      policeContact: Math.max(0, c.policeContact - dt),
    },
  };
}

/**
 * Advance `dt` seconds. `policeNearby` is whether any police car is currently within
 * `POLICE_CONTACT_RANGE` of the player — while true the "lose them" clock stays at zero and heat
 * neither grows nor decays. Once it goes false the clock counts up while heat (and so level) stay
 * exactly where they were; only once the clock reaches `LOSE_TIME` does heat drop straight to zero.
 * This makes the wait the same `LOSE_TIME` seconds regardless of the level it started at (a single
 * star is lost no sooner than five), matching the spec's "no police within 120 m for 20 s".
 */
export function stepWanted(state: WantedState, dt: number, policeNearby: boolean): WantedState {
  const s = stepCooldown(state, dt);
  if (s.level === 0 && s.heat === 0 && s.secondsSincePoliceContact === 0) return s;
  if (policeNearby) {
    if (s.secondsSincePoliceContact === 0) return s;
    return { ...s, secondsSincePoliceContact: 0 };
  }
  const seconds = s.secondsSincePoliceContact + dt;
  if (seconds >= LOSE_TIME) return { heat: 0, level: 0, secondsSincePoliceContact: seconds, cooldown: s.cooldown };
  return { ...s, secondsSincePoliceContact: seconds };
}

/**
 * Number of police cars that should be actively pursuing at a given wanted level, clamped by the
 * quality preset's `maxPolice` (every simulation cost gets a preset knob — see `src/core/Quality.ts`).
 */
export function policeCountForLevel(level: number, maxPolice = MAX_LEVEL): number {
  return clamp(Math.round(level), 0, Math.min(MAX_LEVEL, Math.max(0, Math.round(maxPolice))));
}
