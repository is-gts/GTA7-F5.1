/**
 * Pure day/night clock and sun/moon direction helpers.
 *
 * No three.js, no `Math.random()`, no `Date.now()` — a `TimeOfDay` instance advances by whatever
 * `dt` it is fed, so headless `Game.simulate()` and unit tests get bit-identical results to the
 * real render loop for the same sequence of steps.
 */

export const DEFAULT_SECONDS_PER_GAME_HOUR = 90;

/** Wrap an hour value into [0, 24). */
export function wrapHours(hours: number): number {
  const m = hours % 24;
  return m < 0 ? m + 24 : m;
}

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface SunAngles {
  /** Degrees above the horizon; negative once the sun has set. */
  elevationDeg: number;
  /** Degrees, 0 = +Z axis, 90 = +X axis (matches `Lighting`/`SkyDome`'s convention). */
  azimuthDeg: number;
}

/**
 * Sun elevation/azimuth for an hour of the day (0..24). Sunrise ~06:00, solar noon ~12:00 (peak
 * elevation), sunset ~18:00; azimuth sweeps a full turn once every 24 h.
 */
export function sunAngles(hours: number): SunAngles {
  const t = (wrapHours(hours) - 6) / 12; // 0 at 06:00, 1 at 18:00
  return { elevationDeg: Math.sin(t * Math.PI) * 65, azimuthDeg: 90 + t * 180 };
}

function smoothstep(x: number, lo: number, hi: number): number {
  const t = Math.max(0, Math.min(1, (x - lo) / (hi - lo)));
  return t * t * (3 - 2 * t);
}

/** 0 at night, 1 in full daylight; ramps smoothly through sunrise/sunset (elevation -6°..10°). */
export function daylightFactor(hours: number): number {
  return smoothstep(sunAngles(hours).elevationDeg, -6, 10);
}

/** `1 - daylightFactor(hours)`, so night-only effects need only one call. */
export function nightFactor(hours: number): number {
  return 1 - daylightFactor(hours);
}

function angleToDirection(elevationDeg: number, azimuthDeg: number): Vec3 {
  const el = (elevationDeg * Math.PI) / 180;
  const az = (azimuthDeg * Math.PI) / 180;
  return { x: Math.cos(el) * Math.sin(az), y: Math.sin(el), z: Math.cos(el) * Math.cos(az) };
}

/** Unit vector toward the sun (matches `Lighting.sunDirection`/`SkyDome.sunDirection`). */
export function sunDirection(hours: number): Vec3 {
  const { elevationDeg, azimuthDeg } = sunAngles(hours);
  return angleToDirection(elevationDeg, azimuthDeg);
}

/**
 * Unit vector toward the moon: the sun's antipode, held at least ~20° above the horizon (y >=
 * 0.35) so night surfaces stay lit from a plausible-looking direction instead of straight down
 * once the sun is deep below the opposite horizon.
 */
export function moonDirection(hours: number): Vec3 {
  const d = sunDirection(hours);
  const x = -d.x;
  const y = Math.max(0.35, -d.y);
  const z = -d.z;
  const len = Math.hypot(x, y, z) || 1;
  return { x: x / len, y: y / len, z: z / len };
}

/**
 * Shortest signed distance in hours from `a` to `b`, taking the 24 h wrap into account (e.g.
 * `hoursDelta(23.9, 0.1)` is `+0.2`, not `-23.8`). Used to throttle how often `Game` recomputes
 * time-of-day lighting without a false "no time has passed" reading right at midnight.
 */
export function hoursDelta(a: number, b: number): number {
  let d = wrapHours(b) - wrapHours(a);
  if (d > 12) d -= 24;
  else if (d < -12) d += 24;
  return d;
}

/** Angle in degrees between two unit vectors. */
export function angleBetweenDeg(a: Vec3, b: Vec3): number {
  const dot = Math.max(-1, Math.min(1, a.x * b.x + a.y * b.y + a.z * b.z));
  return (Math.acos(dot) * 180) / Math.PI;
}

/**
 * Regenerate the sky PMREM environment only once the sun has moved at least this many degrees
 * since the last regeneration. Empirically this yields ~37 regenerations over a full 24 h game day
 * regardless of `secondsPerGameHour` (see the "stays well under the daily regeneration budget" test
 * in `tests/timeOfDay.test.ts`) — comfortably under a 40/day budget — while a literal few-degree
 * threshold would regenerate well over 100 times a day for negligible visual gain.
 */
export const ENV_REGEN_THRESHOLD_DEG = 10;

/** Minimum game-time between `Game`'s sun/fog/hemisphere/light recomputation (0.5 game-minutes). */
export const TIME_UPDATE_MIN_GAME_HOURS = 0.5 / 60;

/**
 * Deterministic wall clock in game-hours (0..24), advancing at `secondsPerGameHour` real seconds
 * per in-game hour (default 90 s/h — a full day every 36 real minutes). `advance()` is the only
 * thing that changes `hours`; everything else here is a pure read.
 */
export class TimeOfDay {
  hours: number;
  secondsPerGameHour: number;
  paused = false;

  constructor(initialHours = 12, secondsPerGameHour = DEFAULT_SECONDS_PER_GAME_HOUR) {
    this.hours = wrapHours(initialHours);
    this.secondsPerGameHour = Math.max(0.01, secondsPerGameHour);
  }

  /** Advance the clock by `dt` real seconds (a no-op while `paused`). Returns the new hour value. */
  advance(dt: number): number {
    if (!this.paused && dt > 0) this.hours = wrapHours(this.hours + dt / this.secondsPerGameHour);
    return this.hours;
  }

  /** Jump directly to an hour of day (wraps into [0, 24)). */
  set(hours: number): void {
    this.hours = wrapHours(hours);
  }

  get sunAngles(): SunAngles {
    return sunAngles(this.hours);
  }

  get daylightFactor(): number {
    return daylightFactor(this.hours);
  }

  get nightFactor(): number {
    return nightFactor(this.hours);
  }

  sunDirection(): Vec3 {
    return sunDirection(this.hours);
  }

  moonDirection(): Vec3 {
    return moonDirection(this.hours);
  }
}
