import { describe, expect, it } from 'vitest';
import { Random } from '../src/world/Random';
import {
  MIN_STATE_DURATION,
  RAIN_VISUAL_FALL_RATE,
  RAIN_VISUAL_RISE_RATE,
  WETNESS_DRY_RATE,
  WETNESS_RISE_RATE,
  createWeatherState,
  isWeatherStateName,
  setWeatherState,
  stepWeather,
  type WeatherState,
} from '../src/world/Weather';

describe('createWeatherState', () => {
  it('defaults to clear, dry, with no rain visual', () => {
    const s = createWeatherState();
    expect(s.state).toBe('clear');
    expect(s.wetness).toBe(0);
    expect(s.rainVisual).toBe(0);
    expect(s.timer).toBe(MIN_STATE_DURATION.clear);
  });

  it('starting in rain has a full initial rain-visual (streaks visible immediately)', () => {
    const s = createWeatherState('rain');
    expect(s.state).toBe('rain');
    expect(s.rainVisual).toBe(1);
    expect(s.timer).toBe(MIN_STATE_DURATION.rain);
  });
});

describe('stepWeather: wetness dynamics', () => {
  it('rises while raining, at the documented rate, clamped to 1', () => {
    // `timer` held far above the test window so no auto-transition can interrupt the accumulation
    // being measured here (that's covered separately below).
    let s: WeatherState = { state: 'rain', wetness: 0, rainVisual: 1, timer: 1e6 };
    const rng = new Random(1);
    for (let i = 0; i < 60 * 5; i++) s = stepWeather(s, 1 / 60, rng); // 5 simulated seconds
    expect(s.wetness).toBeCloseTo(5 * WETNESS_RISE_RATE, 2);
    expect(s.wetness).toBeLessThanOrEqual(1);

    // Long enough continuous rain saturates wetness at 1, never exceeding it.
    let s2: WeatherState = { state: 'rain', wetness: 0, rainVisual: 1, timer: 1e6 };
    const rng2 = new Random(2);
    for (let i = 0; i < 60 * 60; i++) s2 = stepWeather(s2, 1 / 60, rng2); // 60 s: 60/18 > 1
    expect(s2.wetness).toBe(1);
  });

  it('dries out once it stops raining, never going negative', () => {
    let s: WeatherState = { state: 'clear', wetness: 1, rainVisual: 0, timer: 1e6 };
    const rng = new Random(3);
    for (let i = 0; i < 60 * 10; i++) s = stepWeather(s, 1 / 60, rng); // 10 s of drying
    expect(s.wetness).toBeCloseTo(Math.max(0, 1 - 10 * WETNESS_DRY_RATE), 2);
    expect(s.wetness).toBeGreaterThanOrEqual(0);

    let s2: WeatherState = { state: 'overcast', wetness: 1, rainVisual: 0, timer: 1e6 };
    const rng2 = new Random(4);
    for (let i = 0; i < 60 * 200; i++) s2 = stepWeather(s2, 1 / 60, rng2); // long enough to fully dry
    expect(s2.wetness).toBe(0);
  });

  it('a no-op / non-positive dt changes nothing (idempotent guard)', () => {
    const s = createWeatherState('rain');
    const rng = new Random(5);
    expect(stepWeather(s, 0, rng)).toEqual(s);
    expect(stepWeather(s, -1, rng)).toEqual(s);
  });
});

describe('stepWeather: rainVisual fast-follow', () => {
  it('ramps up quickly while raining and back down quickly once it stops, decoupled from wetness', () => {
    let s = createWeatherState('clear');
    const rng = new Random(6);
    s = { ...s, state: 'rain', timer: MIN_STATE_DURATION.rain }; // force into rain without going through setWeatherState
    for (let i = 0; i < 60; i++) s = stepWeather(s, 1 / 60, rng); // 1 s
    expect(s.rainVisual).toBeCloseTo(RAIN_VISUAL_RISE_RATE * 1, 2);
    for (let i = 0; i < 60 * 5; i++) s = stepWeather(s, 1 / 60, rng); // plenty more: saturates at 1
    expect(s.rainVisual).toBe(1);

    // Stop raining: rainVisual eases back to 0 while wetness (drying much slower) stays high.
    s = { ...s, state: 'clear', timer: MIN_STATE_DURATION.clear };
    const wetnessAtStop = s.wetness;
    for (let i = 0; i < 60 * 4; i++) s = stepWeather(s, 1 / 60, rng); // 4 s: > 1/RAIN_VISUAL_FALL_RATE
    expect(s.rainVisual).toBe(0);
    expect(s.wetness).toBeGreaterThan(wetnessAtStop - 4 * WETNESS_DRY_RATE - 0.01);
    expect(s.wetness).toBeLessThan(wetnessAtStop);
  });
});

describe('stepWeather: minimum state duration', () => {
  it('never transitions while `timer > 0`, regardless of RNG (the RNG roll is never even taken)', () => {
    // A Random instance whose very first draw would be a "transition succeeds" roll under a
    // deliberately huge per-second chance — if the code ever called rng.chance() while timer > 0,
    // this would immediately flip state; timer > 0 must suppress the roll entirely.
    let s: WeatherState = { state: 'clear', wetness: 0, rainVisual: 0, timer: 5 };
    const rng = new Random(42);
    for (let i = 0; i < 60 * 4; i++) {
      s = stepWeather(s, 1 / 60, rng); // 4 s < 5 s timer
      expect(s.state).toBe('clear');
    }
    expect(s.timer).toBeCloseTo(1, 2);
  });
});

describe('stepWeather: transitions eventually happen and only along adjacent edges', () => {
  it('transitions occur over a long enough window, always clear<->overcast<->rain (never clear<->rain directly)', () => {
    let s = createWeatherState('clear');
    const rng = new Random(777);
    const seen = new Set<string>();
    let prev = s.state;
    let transitions = 0;
    for (let i = 0; i < 60 * 2000; i++) {
      s = stepWeather(s, 1 / 60, rng);
      if (s.state !== prev) {
        transitions++;
        const edge = [prev, s.state].sort().join('-');
        seen.add(edge);
        // never a direct clear<->rain jump
        expect(edge).not.toBe('clear-rain');
        prev = s.state;
      }
    }
    // Expected ~22 rolls to succeed over 2000s at 1/90 per second; astronomically unlikely to be 0.
    expect(transitions).toBeGreaterThan(0);
    for (const edge of seen) expect(['clear-overcast', 'overcast-rain']).toContain(edge);
  });
});

describe('setWeatherState (menu / ?weather= URL forcing)', () => {
  it('is a no-op when already in the requested state', () => {
    const s = createWeatherState('overcast');
    expect(setWeatherState(s, 'overcast')).toBe(s);
  });

  it('switches state, resets the transition timer to the new state minimum, and preserves wetness/rainVisual', () => {
    const s: WeatherState = { state: 'clear', wetness: 0.4, rainVisual: 0, timer: 1 };
    const forced = setWeatherState(s, 'rain');
    expect(forced.state).toBe('rain');
    expect(forced.wetness).toBe(0.4); // starts climbing from wherever it was, not reset to 0
    expect(forced.rainVisual).toBe(0); // eases in via stepWeather, not popped to 1
    expect(forced.timer).toBe(MIN_STATE_DURATION.rain);
  });

  it('forced state does not transition away during a short window regardless of RNG', () => {
    let s = setWeatherState(createWeatherState('clear'), 'rain');
    const rng = new Random(9001);
    for (let i = 0; i < 60 * 20; i++) s = stepWeather(s, 1 / 60, rng); // 20 s < 40 s min duration
    expect(s.state).toBe('rain');
    expect(s.wetness).toBeGreaterThan(0.5); // also exercises the "reaches wetness > 0.5" e2e path
  });
});

describe('isWeatherStateName', () => {
  it('accepts the three known states and rejects everything else', () => {
    expect(isWeatherStateName('clear')).toBe(true);
    expect(isWeatherStateName('overcast')).toBe(true);
    expect(isWeatherStateName('rain')).toBe(true);
    expect(isWeatherStateName('storm')).toBe(false);
    expect(isWeatherStateName(undefined)).toBe(false);
    expect(isWeatherStateName(1)).toBe(false);
  });
});
