import { describe, expect, it } from 'vitest';
import {
  ENV_REGEN_THRESHOLD_DEG,
  TIME_UPDATE_MIN_GAME_HOURS,
  TimeOfDay,
  angleBetweenDeg,
  daylightFactor,
  hoursDelta,
  moonDirection,
  nightFactor,
  sunAngles,
  sunDirection,
  wrapHours,
} from '../src/game/TimeOfDay';

function len(v: { x: number; y: number; z: number }): number {
  return Math.hypot(v.x, v.y, v.z);
}

describe('wrapHours', () => {
  it('wraps into [0, 24)', () => {
    expect(wrapHours(25)).toBeCloseTo(1, 10);
    expect(wrapHours(-1)).toBeCloseTo(23, 10);
    expect(wrapHours(0)).toBe(0);
    expect(wrapHours(48.5)).toBeCloseTo(0.5, 10);
    expect(wrapHours(-25)).toBeCloseTo(23, 10);
  });
});

describe('hoursDelta', () => {
  it('handles the midnight wrap as a short forward step, not a huge backward one', () => {
    expect(hoursDelta(23.9, 0.1)).toBeCloseTo(0.2, 10);
    expect(hoursDelta(0.1, 23.9)).toBeCloseTo(-0.2, 10);
  });
  it('matches plain subtraction away from the wrap', () => {
    expect(hoursDelta(10, 10.5)).toBeCloseTo(0.5, 10);
    expect(hoursDelta(10.5, 10)).toBeCloseTo(-0.5, 10);
  });
});

describe('sunAngles / daylightFactor', () => {
  it('peaks near solar noon and bottoms out near midnight', () => {
    const noon = sunAngles(12);
    const midnight = sunAngles(0);
    expect(noon.elevationDeg).toBeGreaterThan(60);
    expect(midnight.elevationDeg).toBeLessThan(-60);
  });

  it('daylight factor is ~1 at noon and ~0 at midnight', () => {
    expect(daylightFactor(12)).toBeGreaterThan(0.99);
    expect(daylightFactor(0)).toBeLessThan(0.01);
    expect(nightFactor(12)).toBeLessThan(0.01);
    expect(nightFactor(0)).toBeGreaterThan(0.99);
  });

  it('ramps monotonically through sunrise (06:00) and sunset (18:00)', () => {
    let prev = daylightFactor(3);
    for (let h = 3.25; h <= 9; h += 0.25) {
      const d = daylightFactor(h);
      expect(d).toBeGreaterThanOrEqual(prev - 1e-9);
      prev = d;
    }
    // Sunset: daylight should now be monotonically decreasing.
    prev = daylightFactor(15);
    for (let h = 15.25; h <= 21; h += 0.25) {
      const d = daylightFactor(h);
      expect(d).toBeLessThanOrEqual(prev + 1e-9);
      prev = d;
    }
  });

  it('stays within [0, 1] across a full day', () => {
    for (let h = 0; h < 24; h += 0.1) {
      const d = daylightFactor(h);
      expect(d).toBeGreaterThanOrEqual(0);
      expect(d).toBeLessThanOrEqual(1);
    }
  });
});

describe('sunDirection / moonDirection', () => {
  it('are unit vectors for every hour', () => {
    for (let h = 0; h < 24; h += 1.3) {
      expect(len(sunDirection(h))).toBeCloseTo(1, 5);
      expect(len(moonDirection(h))).toBeCloseTo(1, 5);
    }
  });

  it('points roughly opposite the sun horizontally', () => {
    const morningSun = sunDirection(9); // elevation/azimuth both away from the x=0 noon special case
    const morningMoon = moonDirection(9);
    expect(Math.sign(morningMoon.x)).toBe(-Math.sign(morningSun.x));
    expect(Math.sign(morningMoon.z)).toBe(-Math.sign(morningSun.z));
  });

  it('is clamped to at least y=0.35 even when the sun is high (steep antipode)', () => {
    // At noon the sun is near its highest elevation, so its antipode points steeply down — the
    // moon direction should be clamped upward rather than following the antipode all the way down.
    const noonMoon = moonDirection(12);
    expect(noonMoon.y).toBeGreaterThanOrEqual(0.35 - 1e-9);
  });
});

describe('angleBetweenDeg', () => {
  it('is 0 for identical vectors and 180 for opposite ones', () => {
    expect(angleBetweenDeg({ x: 1, y: 0, z: 0 }, { x: 1, y: 0, z: 0 })).toBeCloseTo(0, 5);
    expect(angleBetweenDeg({ x: 1, y: 0, z: 0 }, { x: -1, y: 0, z: 0 })).toBeCloseTo(180, 5);
    expect(angleBetweenDeg({ x: 1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 })).toBeCloseTo(90, 5);
  });
});

describe('TimeOfDay', () => {
  it('starts at the requested hour, wrapped into [0, 24)', () => {
    expect(new TimeOfDay(30).hours).toBeCloseTo(6, 10);
    expect(new TimeOfDay(-2).hours).toBeCloseTo(22, 10);
  });

  it('advances monotonically (mod 24) at the configured rate', () => {
    const t = new TimeOfDay(10, 60); // 60 s per game hour
    const before = t.hours;
    t.advance(30); // half a game hour
    expect(t.hours).toBeCloseTo(before + 0.5, 6);
    t.advance(30);
    expect(t.hours).toBeCloseTo(before + 1, 6);
  });

  it('wraps around midnight while advancing', () => {
    const t = new TimeOfDay(23, 60);
    t.advance(120); // 2 game hours
    expect(t.hours).toBeCloseTo(1, 6);
  });

  it('does not advance while paused', () => {
    const t = new TimeOfDay(10, 60);
    t.paused = true;
    t.advance(1000);
    expect(t.hours).toBe(10);
    t.paused = false;
    t.advance(60);
    expect(t.hours).toBeCloseTo(11, 6);
  });

  it('exposes the same daylight/moon helpers as instance accessors', () => {
    const t = new TimeOfDay(12);
    expect(t.daylightFactor).toBeCloseTo(daylightFactor(12), 10);
    expect(t.nightFactor).toBeCloseTo(nightFactor(12), 10);
    expect(t.sunAngles.elevationDeg).toBeCloseTo(sunAngles(12).elevationDeg, 10);
    const d = t.sunDirection();
    const expected = sunDirection(12);
    expect(d.x).toBeCloseTo(expected.x, 10);
  });

  it('set() jumps directly to an hour, wrapped', () => {
    const t = new TimeOfDay(5);
    t.set(26);
    expect(t.hours).toBeCloseTo(2, 10);
  });
});

describe('PMREM regeneration budget (ENV_REGEN_THRESHOLD_DEG)', () => {
  /**
   * Mirrors `Game.updateClock`/`applyTimeOfDay`'s throttle: a `TimeOfDay` clock is fed fixed 1/60 s
   * ticks, lighting is recomputed at most every `TIME_UPDATE_MIN_GAME_HOURS`, and the sky PMREM is
   * only regenerated once the sun direction has moved more than `ENV_REGEN_THRESHOLD_DEG` since the
   * last regeneration. This should stay comfortably under a 40-regeneration daily budget regardless
   * of how fast the clock runs (a literal few-degree threshold would regenerate 100+ times a day).
   */
  function countRegensOverOneDay(secondsPerGameHour: number): number {
    const clock = new TimeOfDay(0, secondsPerGameHour);
    let lastApplied = clock.hours;
    let lastEnvDir = sunDirection(clock.hours);
    let regens = 1; // the forced regeneration at construction
    const dt = 1 / 60;
    const totalSteps = Math.ceil((24 * secondsPerGameHour) / dt);
    for (let i = 0; i < totalSteps; i++) {
      clock.advance(dt);
      if (Math.abs(hoursDelta(lastApplied, clock.hours)) < TIME_UPDATE_MIN_GAME_HOURS) continue;
      lastApplied = clock.hours;
      const dir = sunDirection(clock.hours);
      if (angleBetweenDeg(lastEnvDir, dir) > ENV_REGEN_THRESHOLD_DEG) {
        regens++;
        lastEnvDir = dir;
      }
    }
    return regens;
  }

  it('stays well under a 40-regeneration daily budget', () => {
    const regensDefault = countRegensOverOneDay(90);
    expect(regensDefault).toBeGreaterThan(0);
    expect(regensDefault).toBeLessThan(40);
    // Independent of how fast the clock runs (fast-forwarded "dayspeed" testing included).
    const regensFast = countRegensOverOneDay(10);
    expect(regensFast).toBeLessThan(40);
  });
});
