/**
 * Pure weather state machine: `clear | overcast | rain`, a `wetness` scalar (0..1, rises during
 * rain and dries afterwards) driving wet-road materials/SSR, and a faster-following `rainVisual`
 * scalar (0..1, tracks "is it actually raining right now") driving the rain particle system —
 * decoupled from `wetness` so puddles keep glistening for a while after the rain itself stops.
 *
 * No three.js, no `Math.random()` — transitions are driven by the caller's own `Random` instance
 * (see `world/Random.ts`), so `Game.simulate()` and unit tests get bit-identical results for the
 * same seed/dt sequence, exactly like `TimeOfDay`.
 */
import type { Random } from './Random';

export type WeatherStateName = 'clear' | 'overcast' | 'rain';

export interface WeatherState {
  state: WeatherStateName;
  /** Surface wetness (roads/puddles), 0..1: rises during rain, dries otherwise. */
  wetness: number;
  /** Rain particle/streak intensity, 0..1: fast-follows `state === 'rain'`. */
  rainVisual: number;
  /** Seconds remaining before another transition roll is allowed. */
  timer: number;
}

/** Wetness reaches 1 after ~18 s of continuous rain. */
export const WETNESS_RISE_RATE = 1 / 18;
/** Wetness dries fully in ~70 s once it stops raining. */
export const WETNESS_DRY_RATE = 1 / 70;
/** `rainVisual` reaches its target in ~2 s (rise) / ~3 s (fall) — quick enough to read as "it just
 *  started/stopped raining" without popping instantly. */
export const RAIN_VISUAL_RISE_RATE = 1 / 2;
export const RAIN_VISUAL_FALL_RATE = 1 / 3;

/** Minimum time (s) a state holds before it is even eligible to transition away — long enough that
 *  a short e2e/test window forcing a state (`?weather=rain`, `setWeather('rain', ...)`) never flips
 *  again mid-scene regardless of RNG. */
export const MIN_STATE_DURATION: Record<WeatherStateName, number> = {
  clear: 45,
  overcast: 30,
  rain: 40,
};

/** Chance per second, once past the minimum duration, that a transition roll succeeds. */
const TRANSITION_CHANCE_PER_SEC = 1 / 90;

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function approach(current: number, target: number, rate: number, dt: number): number {
  const delta = rate * dt;
  if (current < target) return Math.min(target, current + delta);
  if (current > target) return Math.max(target, current - delta);
  return current;
}

/** The only state graph edges: `clear <-> overcast <-> rain` (no direct clear<->rain jump), which
 *  keeps the sky/fog transition always passing through the intermediate "getting cloudy" look. */
function nextState(current: WeatherStateName, rng: Random): WeatherStateName {
  if (current === 'clear') return 'overcast';
  if (current === 'rain') return 'overcast';
  return rng.chance(0.55) ? 'rain' : 'clear';
}

export function createWeatherState(state: WeatherStateName = 'clear'): WeatherState {
  return { state, wetness: 0, rainVisual: state === 'rain' ? 1 : 0, timer: MIN_STATE_DURATION[state] };
}

/**
 * Advance the weather by `dt` seconds: wetness rises/dries, `rainVisual` fast-follows whether it is
 * currently raining, and (once `timer` has elapsed) a per-second dice roll may move to an adjacent
 * state. Deterministic given the same `rng` sequence.
 */
export function stepWeather(state: WeatherState, dt: number, rng: Random): WeatherState {
  if (!(dt > 0)) return state;
  let { state: name, wetness, rainVisual, timer } = state;
  timer = Math.max(0, timer - dt);
  wetness = clamp01(wetness + dt * (name === 'rain' ? WETNESS_RISE_RATE : -WETNESS_DRY_RATE));
  rainVisual = approach(rainVisual, name === 'rain' ? 1 : 0, name === 'rain' ? RAIN_VISUAL_RISE_RATE : RAIN_VISUAL_FALL_RATE, dt);
  if (timer <= 0 && rng.chance(dt * TRANSITION_CHANCE_PER_SEC)) {
    name = nextState(name, rng);
    timer = MIN_STATE_DURATION[name];
  }
  return { state: name, wetness, rainVisual, timer };
}

/**
 * Force the weather to `name` immediately (settings menu / `?weather=` URL param): keeps the
 * existing `wetness`/`rainVisual` (so switching to rain from a dry day starts wetness climbing from
 * wherever it was, and switching away eases `rainVisual` back down rather than popping) and resets
 * the transition timer so the forced state holds for at least `MIN_STATE_DURATION[name]`.
 */
export function setWeatherState(state: WeatherState, name: WeatherStateName): WeatherState {
  if (state.state === name) return state;
  return { state: name, wetness: state.wetness, rainVisual: state.rainVisual, timer: MIN_STATE_DURATION[name] };
}

export function isWeatherStateName(v: unknown): v is WeatherStateName {
  return v === 'clear' || v === 'overcast' || v === 'rain';
}
