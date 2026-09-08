/**
 * Pure DSP-parameter logic for procedural audio (`AudioEngine.ts` turns these numbers into an
 * actual WebAudio node graph). Kept free of WebAudio/DOM, same split the rest of the simulation
 * uses (see `docs/ARCHITECTURE.md`): parameter mapping is a plain function of state, so it is
 * unit-testable without a browser, and deterministic given the same inputs.
 */

/** Clamp to [lo, hi]. Written as `v >= lo ? ... : lo` (rather than `v < lo ? lo : ...`) so a NaN —
 *  which compares false against everything — falls out as `lo` instead of propagating: every value
 *  these functions produce is fed to a WebAudio `AudioParam`, which *throws* on a non-finite value,
 *  and one such throw would silently freeze every audio parameter for the rest of the session. */
function clamp(v: number, lo: number, hi: number): number {
  return v >= lo ? (v > hi ? hi : v) : lo;
}
function clamp01(v: number): number {
  return clamp(v, 0, 1);
}

// --- engine RPM / gear -----------------------------------------------------------------------

/** Normalized engine RPM (0..1) at idle, even at a standstill with no throttle. */
export const IDLE_RPM = 0.18;
/** Normalized engine RPM (0..1) at redline. */
export const MAX_RPM = 1;
/** Upper road speed (m/s) of each gear (shared by every vehicle type — this drives the *engine
 *  sound*, not the physics; `VehiclePhysics.ts`'s per-type spec is a separate, unrelated model).
 *  The last entry is unbounded (top gear). */
export const GEAR_TOP_SPEEDS: readonly number[] = [7, 14, 23, 34, Infinity];
/** Assumed width (m/s) of the unbounded top gear, for shaping its RPM sweep. */
const TOP_GEAR_SPAN = 40;

/** How far (m/s) below the threshold that put us *into* a gear the road speed must fall before the
 *  model shifts back down. Without it a speed hovering on a shift point (cruising at exactly 7 m/s)
 *  flips gear every frame, and since each gear restarts at idle that swings the RPM — and so the
 *  engine pitch — between ~0.18 and ~1.0 sixty times a second: a very audible warble. Upshifts stay
 *  immediate; only the downshift is damped, which is also how a real gearbox behaves. */
export const GEAR_DOWNSHIFT_HYSTERESIS = 1.2;

/**
 * Which gear (0-indexed) a given (unsigned) speed falls into. Pass the gear returned by the
 * previous call as `previousGear` to get hysteretic (chatter-free) shifting; the default of `-1`
 * means "no history", i.e. the plain threshold mapping.
 */
export function gearForSpeed(speed: number, gearTopSpeeds: readonly number[] = GEAR_TOP_SPEEDS, previousGear = -1): number {
  const s = Math.abs(speed);
  let gear = gearTopSpeeds.length - 1;
  for (let g = 0; g < gearTopSpeeds.length - 1; g++) {
    if (s < gearTopSpeeds[g]!) {
      gear = g;
      break;
    }
  }
  // Hold the gear we were already in until the speed drops a margin below that gear's own entry
  // threshold. A previous gear more than one step away (a respawn/teleport) is simply ignored.
  if (previousGear > gear && previousGear < gearTopSpeeds.length && s > gearTopSpeeds[previousGear - 1]! - GEAR_DOWNSHIFT_HYSTERESIS) {
    return previousGear;
  }
  return gear;
}

/**
 * Normalized engine RPM (0..1) and current gear from road speed and throttle: monotonically rising
 * with speed within a gear (idle at the bottom of the gear's speed range, redline at the top),
 * dropping back down at every upshift — a real engine's per-gear rev sawtooth — plus a small
 * throttle-driven "blip" near a standstill, so tapping the gas while parked still sounds like
 * something is happening instead of a flat idle drone. Feed the previously returned `gear` back in
 * as `previousGear` (as `AudioEngine` does, per voice) for hysteretic, chatter-free shifting.
 */
export function rpmFromSpeed(
  speed: number,
  throttle: number,
  gearTopSpeeds: readonly number[] = GEAR_TOP_SPEEDS,
  previousGear = -1,
): { rpm: number; gear: number } {
  const s = Math.abs(speed);
  const gear = gearForSpeed(s, gearTopSpeeds, previousGear);
  const lo = gear === 0 ? 0 : gearTopSpeeds[gear - 1]!;
  const hi = gearTopSpeeds[gear]!;
  const span = Math.max(1, Math.min(hi, lo + TOP_GEAR_SPAN) - lo);
  const within = clamp01((s - lo) / span);
  const blip = s < 0.5 ? clamp01(throttle) * 0.15 : 0;
  return { rpm: clamp01(IDLE_RPM + within * (MAX_RPM - IDLE_RPM) + blip), gear };
}

// --- crash amplitude ---------------------------------------------------------------------------

/** Collision impulse (m/s of closing speed removed) below which a crash makes no sound (a gentle
 *  kerb nudge shouldn't thud). */
export const CRASH_MIN_IMPULSE = 2;
/** Impulse at/above which the crash sound is at full amplitude. */
export const CRASH_MAX_IMPULSE = 24;

/** Crash-sound amplitude (0..1) from a collision impulse (see `VehicleEntity.lastCollision` /
 *  `CollisionEvent.impulse`, and `resolveVehicleVehicle`'s returned impulse): silent below a small
 *  bump, rising linearly, saturating at a hard hit. */
export function crashAmplitude(impulse: number): number {
  if (!(impulse > CRASH_MIN_IMPULSE)) return 0;
  return clamp01((impulse - CRASH_MIN_IMPULSE) / (CRASH_MAX_IMPULSE - CRASH_MIN_IMPULSE));
}

// --- tyre screech --------------------------------------------------------------------------

/** Lateral (sideways) speed (m/s) below which no screech plays. */
export const SCREECH_THRESHOLD = 3;
/** Lateral speed at/above which the screech is at full gain. */
export const SCREECH_MAX = 9;
/** Minimum screech gain while the handbrake is held, even before much lateral speed has built up
 *  (a handbrake turn should chirp immediately). */
export const SCREECH_HANDBRAKE_FLOOR = 0.35;

/** Tyre-screech gain (0..1) from lateral speed and the handbrake. */
export function screechGain(lateralSpeed: number, handbrake: boolean): number {
  const lat = Math.abs(lateralSpeed);
  const base = lat <= SCREECH_THRESHOLD ? 0 : clamp01((lat - SCREECH_THRESHOLD) / (SCREECH_MAX - SCREECH_THRESHOLD));
  return handbrake ? Math.max(base, SCREECH_HANDBRAKE_FLOOR) : base;
}

// --- police siren --------------------------------------------------------------------------

/** Siren's low tone (Hz). */
export const SIREN_LOW_HZ = 500;
/** Siren's high tone (Hz). */
export const SIREN_HIGH_HZ = 850;
/** Full low-high cycle length (s). */
export const SIREN_PERIOD_S = 0.7;

/**
 * Alternating two-tone siren frequency (Hz) at simulation time `t` (seconds): half a period on the
 * low tone, half on the high one — a classic "wail" schedule. Pure function of `t`, so it is driven
 * by the simulation's own clock (`Engine.stats.simTime`) rather than wall time, the same way
 * `Rain`/`MissionMarkers` key their animation off `simTime` instead of real frame deltas.
 */
export function sirenFrequency(t: number): number {
  const phase = ((t % SIREN_PERIOD_S) + SIREN_PERIOD_S) % SIREN_PERIOD_S;
  return phase < SIREN_PERIOD_S / 2 ? SIREN_LOW_HZ : SIREN_HIGH_HZ;
}

// --- distance attenuation ------------------------------------------------------------------

/** Linear distance attenuation: 1 at distance 0, falling to 0 at (or beyond) `maxDistance`,
 *  clamped to [0,1]. Used instead of a `PannerNode` (optional per the task spec) for the siren and
 *  traffic engine voices — cheap, deterministic, and easy to reason about. */
export function distanceAttenuation(distance: number, maxDistance: number): number {
  if (!(maxDistance > 0)) return 0;
  return clamp01(1 - Math.max(0, distance) / maxDistance);
}
