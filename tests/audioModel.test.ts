import { describe, expect, it } from 'vitest';
import {
  CRASH_MAX_IMPULSE,
  CRASH_MIN_IMPULSE,
  GEAR_DOWNSHIFT_HYSTERESIS,
  GEAR_TOP_SPEEDS,
  IDLE_RPM,
  MAX_RPM,
  SCREECH_HANDBRAKE_FLOOR,
  SCREECH_MAX,
  SCREECH_THRESHOLD,
  SIREN_HIGH_HZ,
  SIREN_LOW_HZ,
  SIREN_PERIOD_S,
  crashAmplitude,
  distanceAttenuation,
  gearForSpeed,
  rpmFromSpeed,
  screechGain,
  sirenFrequency,
} from '../src/audio/AudioModel';

describe('rpmFromSpeed / gearForSpeed (engine sound RPM mapping)', () => {
  it('idles at rest with no throttle', () => {
    const { rpm, gear } = rpmFromSpeed(0, 0);
    expect(rpm).toBeCloseTo(IDLE_RPM, 5);
    expect(gear).toBe(0);
  });

  it('blips the RPM up from idle when the throttle is pressed at a standstill', () => {
    const idle = rpmFromSpeed(0, 0).rpm;
    const blipped = rpmFromSpeed(0, 1).rpm;
    expect(blipped).toBeGreaterThan(idle);
    expect(blipped).toBeLessThanOrEqual(MAX_RPM);
  });

  it('is monotonically non-decreasing in speed within a single gear', () => {
    const top = GEAR_TOP_SPEEDS[0]!;
    let last = -Infinity;
    for (let s = 0.5; s < top; s += 0.5) {
      const { rpm, gear } = rpmFromSpeed(s, 0.5);
      expect(gear).toBe(0);
      expect(rpm).toBeGreaterThanOrEqual(last);
      last = rpm;
    }
  });

  it('shifts gear at each threshold and drops RPM back down at the shift (a real per-gear sawtooth)', () => {
    for (let g = 0; g < GEAR_TOP_SPEEDS.length - 1; g++) {
      const top = GEAR_TOP_SPEEDS[g]!;
      const justBelow = rpmFromSpeed(top - 0.05, 0.5);
      const justAbove = rpmFromSpeed(top + 0.05, 0.5);
      expect(justBelow.gear).toBe(g);
      expect(justAbove.gear).toBe(g + 1);
      // Near the top of a gear's range the RPM is close to redline; just after the shift it drops.
      expect(justAbove.rpm).toBeLessThan(justBelow.rpm);
    }
  });

  it('treats negative (reverse) speed the same as its magnitude', () => {
    expect(rpmFromSpeed(-5, 0.3)).toEqual(rpmFromSpeed(5, 0.3));
  });

  it('never exceeds [IDLE_RPM (well, its floor at rest), MAX_RPM]', () => {
    for (const s of [0, 1, 5, 10, 20, 30, 40, 60, 200]) {
      for (const t of [0, 0.25, 0.5, 1]) {
        const { rpm } = rpmFromSpeed(s, t);
        expect(rpm).toBeGreaterThanOrEqual(0);
        expect(rpm).toBeLessThanOrEqual(MAX_RPM);
      }
    }
  });

  it('gearForSpeed matches the boundaries used by rpmFromSpeed', () => {
    expect(gearForSpeed(0)).toBe(0);
    expect(gearForSpeed(GEAR_TOP_SPEEDS[0]! - 0.01)).toBe(0);
    expect(gearForSpeed(GEAR_TOP_SPEEDS[0]! + 0.01)).toBe(1);
    expect(gearForSpeed(1e6)).toBe(GEAR_TOP_SPEEDS.length - 1);
  });
});

describe('gear hysteresis (chatter-free shifting)', () => {
  const SHIFT = GEAR_TOP_SPEEDS[0]!; // 0 -> 1 threshold

  it('upshifts immediately when the threshold is crossed', () => {
    expect(gearForSpeed(SHIFT + 0.01, GEAR_TOP_SPEEDS, 0)).toBe(1);
  });

  it('holds the gear it is in until the speed falls a margin below that gear\'s entry threshold', () => {
    // Just under the shift point, but still inside the hysteresis band: stay in gear 1.
    expect(gearForSpeed(SHIFT - 0.01, GEAR_TOP_SPEEDS, 1)).toBe(1);
    expect(gearForSpeed(SHIFT - GEAR_DOWNSHIFT_HYSTERESIS + 0.01, GEAR_TOP_SPEEDS, 1)).toBe(1);
    // Past the band: downshift.
    expect(gearForSpeed(SHIFT - GEAR_DOWNSHIFT_HYSTERESIS - 0.01, GEAR_TOP_SPEEDS, 1)).toBe(0);
    // Without a previous gear (the default) the plain threshold mapping is unchanged.
    expect(gearForSpeed(SHIFT - 0.01)).toBe(0);
  });

  it('does not chatter when the speed dithers across a shift point (the whole point of the margin)', () => {
    // Without hysteresis this alternates gear 0 / gear 1 — and therefore RPM ~0.97 / ~0.18 — on
    // every single tick, which is an audible engine-pitch warble.
    let gear = -1;
    const gears: number[] = [];
    const rpms: number[] = [];
    for (let i = 0; i < 20; i++) {
      const r = rpmFromSpeed(i % 2 === 0 ? SHIFT - 0.01 : SHIFT + 0.01, 0.5, GEAR_TOP_SPEEDS, gear);
      gear = r.gear;
      gears.push(r.gear);
      rpms.push(r.rpm);
    }
    // Exactly one shift over the whole sequence (the first upshift), then it stays put.
    let shifts = 0;
    for (let i = 1; i < gears.length; i++) if (gears[i] !== gears[i - 1]) shifts++;
    expect(shifts).toBe(1);
    // ...and after that first shift the RPM barely moves tick to tick.
    for (let i = 2; i < rpms.length; i++) expect(Math.abs(rpms[i]! - rpms[i - 1]!)).toBeLessThan(0.02);
  });

  it('ignores a previous gear more than one step away (respawn / teleport)', () => {
    expect(gearForSpeed(1, GEAR_TOP_SPEEDS, 4)).toBe(0);
  });
});

describe('non-finite inputs (WebAudio AudioParams throw on NaN/Infinity)', () => {
  it('never produces a non-finite value out of any mapping', () => {
    for (const bad of [NaN, Infinity, -Infinity]) {
      const { rpm, gear } = rpmFromSpeed(bad, bad);
      expect(Number.isFinite(rpm)).toBe(true);
      expect(rpm).toBeGreaterThanOrEqual(0);
      expect(rpm).toBeLessThanOrEqual(1);
      expect(Number.isInteger(gear)).toBe(true);
      expect(Number.isFinite(screechGain(bad, false))).toBe(true);
      expect(Number.isFinite(screechGain(bad, true))).toBe(true);
      expect(Number.isFinite(crashAmplitude(bad))).toBe(true);
      expect(Number.isFinite(sirenFrequency(bad))).toBe(true);
      expect(Number.isFinite(distanceAttenuation(bad, 90))).toBe(true);
      expect(Number.isFinite(distanceAttenuation(10, bad))).toBe(true);
    }
    // A NaN distance/lateral speed reads as "silent", not "full blast".
    expect(distanceAttenuation(NaN, 90)).toBe(0);
    expect(screechGain(NaN, false)).toBe(0);
    expect(rpmFromSpeed(NaN, NaN).rpm).toBeCloseTo(IDLE_RPM, 5);
  });
});

describe('crashAmplitude (crash-sound mapping)', () => {
  it('is silent at/below the minimum impulse', () => {
    expect(crashAmplitude(0)).toBe(0);
    expect(crashAmplitude(CRASH_MIN_IMPULSE)).toBe(0);
    expect(crashAmplitude(CRASH_MIN_IMPULSE - 1)).toBe(0);
  });

  it('rises monotonically between the min and max impulse', () => {
    let last = 0;
    for (let i = CRASH_MIN_IMPULSE; i <= CRASH_MAX_IMPULSE; i += 1) {
      const a = crashAmplitude(i);
      expect(a).toBeGreaterThanOrEqual(last);
      last = a;
    }
  });

  it('saturates to 1 at/above the max impulse', () => {
    expect(crashAmplitude(CRASH_MAX_IMPULSE)).toBeCloseTo(1, 5);
    expect(crashAmplitude(CRASH_MAX_IMPULSE * 10)).toBe(1);
  });

  it('is bounded to [0, 1] for arbitrary input', () => {
    for (const i of [-100, -1, 0, 5, 12, 24, 1000]) {
      const a = crashAmplitude(i);
      expect(a).toBeGreaterThanOrEqual(0);
      expect(a).toBeLessThanOrEqual(1);
    }
  });
});

describe('screechGain (tyre screech mapping)', () => {
  it('is silent below the lateral-speed threshold without the handbrake', () => {
    expect(screechGain(0, false)).toBe(0);
    expect(screechGain(SCREECH_THRESHOLD, false)).toBe(0);
    expect(screechGain(SCREECH_THRESHOLD - 0.5, false)).toBe(0);
  });

  it('rises monotonically with |lateralSpeed| above the threshold', () => {
    let last = 0;
    for (let v = SCREECH_THRESHOLD; v <= SCREECH_MAX; v += 0.5) {
      const g = screechGain(v, false);
      expect(g).toBeGreaterThanOrEqual(last);
      last = g;
    }
    expect(last).toBeCloseTo(1, 5);
  });

  it('is symmetric in the sign of lateral speed', () => {
    expect(screechGain(5, false)).toBe(screechGain(-5, false));
  });

  it('guarantees a floor while the handbrake is held, even at zero lateral speed', () => {
    expect(screechGain(0, true)).toBeGreaterThanOrEqual(SCREECH_HANDBRAKE_FLOOR);
    expect(screechGain(0, false)).toBe(0);
  });

  it('never lets the handbrake floor lower an already-higher natural gain', () => {
    const naturalHigh = screechGain(SCREECH_MAX, false);
    expect(screechGain(SCREECH_MAX, true)).toBe(naturalHigh);
  });
});

describe('sirenFrequency (police siren tone schedule)', () => {
  it('alternates between the low and high tone at the expected half-period boundaries', () => {
    expect(sirenFrequency(0)).toBe(SIREN_LOW_HZ);
    expect(sirenFrequency(SIREN_PERIOD_S / 2 - 0.001)).toBe(SIREN_LOW_HZ);
    expect(sirenFrequency(SIREN_PERIOD_S / 2 + 0.001)).toBe(SIREN_HIGH_HZ);
    expect(sirenFrequency(SIREN_PERIOD_S - 0.001)).toBe(SIREN_HIGH_HZ);
  });

  it('is periodic with period SIREN_PERIOD_S', () => {
    for (const t of [0, 0.1, 0.3, 0.55, 1.2, 5.05]) {
      expect(sirenFrequency(t)).toBe(sirenFrequency(t + SIREN_PERIOD_S));
      expect(sirenFrequency(t)).toBe(sirenFrequency(t + SIREN_PERIOD_S * 4));
    }
  });

  it('only ever returns one of the two tones', () => {
    for (let t = 0; t < 5; t += 0.05) {
      expect([SIREN_LOW_HZ, SIREN_HIGH_HZ]).toContain(sirenFrequency(t));
    }
  });

  it('handles negative time (defensive: simTime should never go backwards, but stay well-defined)', () => {
    expect(() => sirenFrequency(-1)).not.toThrow();
    expect([SIREN_LOW_HZ, SIREN_HIGH_HZ]).toContain(sirenFrequency(-1));
  });
});

describe('distanceAttenuation', () => {
  it('is 1 at zero distance and 0 at/beyond maxDistance', () => {
    expect(distanceAttenuation(0, 100)).toBe(1);
    expect(distanceAttenuation(100, 100)).toBe(0);
    expect(distanceAttenuation(500, 100)).toBe(0);
  });

  it('falls off linearly and monotonically with distance', () => {
    expect(distanceAttenuation(50, 100)).toBeCloseTo(0.5, 5);
    let last = 1;
    for (let d = 0; d <= 100; d += 5) {
      const a = distanceAttenuation(d, 100);
      expect(a).toBeLessThanOrEqual(last);
      last = a;
    }
  });

  it('is a safe no-op (0) for a non-positive maxDistance', () => {
    expect(distanceAttenuation(10, 0)).toBe(0);
    expect(distanceAttenuation(10, -5)).toBe(0);
  });

  it('clamps a negative distance to full attenuation rather than exceeding 1', () => {
    expect(distanceAttenuation(-10, 100)).toBe(1);
  });
});
