/**
 * Arcade vehicle model on the XZ plane. Deterministic given (state, input, dt).
 *
 * Longitudinal forces (engine, brake, drag, rolling resistance) act along the heading; lateral
 * friction pulls sideways velocity toward zero with a grip limit so the car can slide when
 * pushed hard or when the handbrake is pulled. Yaw uses a kinematic bicycle model driven by
 * the front-wheel steer angle, blended toward the velocity direction while sliding.
 */
import { obbVsAABB, obbVsOBB, type AABB, type MTV, type OBB, type StaticColliderGrid } from './Collision';

export interface VehicleSpec {
  mass: number;
  maxEngineForce: number;
  maxBrakeForce: number;
  /** Max front wheel angle (radians) at standstill. */
  maxSteerAngle: number;
  /** Steer response (rad/s toward the target angle). */
  steerRate: number;
  wheelBase: number;
  halfWidth: number;
  halfLength: number;
  wheelRadius: number;
  /** Quadratic aerodynamic drag (N per (m/s)^2). */
  dragCoeff: number;
  /** Constant (Coulomb-like) rolling resistance force in N, always opposing motion. */
  rollingResistance: number;
  /** Constant engine-braking force in N applied when neither throttle nor brake is pressed. */
  engineBraking: number;
  /** Lateral grip: acceleration per m/s of lateral speed (1/s). */
  lateralGrip: number;
  /** Maximum lateral acceleration before sliding (m/s^2). */
  maxLateralAccel: number;
  /** Multiplier on lateral grip / max lateral accel while the handbrake is pulled. */
  handbrakeGripFactor: number;
  /** Constant braking force from the handbrake (N). */
  handbrakeForce: number;
  /** Top speed (m/s) at which engine force fades to zero. */
  maxSpeed: number;
  maxReverseSpeed: number;
  restitution: number;
}

export const DEFAULT_CAR_SPEC: VehicleSpec = {
  mass: 1300,
  maxEngineForce: 9000,
  maxBrakeForce: 14000,
  maxSteerAngle: 0.6,
  steerRate: 4,
  wheelBase: 2.7,
  halfWidth: 0.95,
  halfLength: 2.25,
  wheelRadius: 0.34,
  dragCoeff: 0.45,
  rollingResistance: 220,
  engineBraking: 1100,
  lateralGrip: 9,
  maxLateralAccel: 11,
  handbrakeGripFactor: 0.2,
  handbrakeForce: 6000,
  maxSpeed: 52,
  maxReverseSpeed: 9,
  restitution: 0.25,
};

export interface VehicleInput {
  throttle: number;
  brake: number;
  steer: number;
  handbrake: boolean;
}

export interface VehicleState {
  x: number;
  z: number;
  heading: number;
  vx: number;
  vz: number;
  /** Current front wheel angle (radians). */
  steerAngle: number;
  /** Yaw rate (rad/s). */
  yawRate: number;
  /** Accumulated wheel spin (radians) for visuals. */
  wheelSpin: number;
  /** Signed forward speed (m/s), cached after each step. */
  forwardSpeed: number;
  /** Lateral speed (m/s), cached after each step. */
  lateralSpeed: number;
}

export interface CollisionEvent {
  /** Impact speed along the contact normal (m/s). */
  impulse: number;
  nx: number;
  nz: number;
  otherId: number | null;
}

export function createVehicleState(x = 0, z = 0, heading = 0): VehicleState {
  return { x, z, heading, vx: 0, vz: 0, steerAngle: 0, yawRate: 0, wheelSpin: 0, forwardSpeed: 0, lateralSpeed: 0 };
}

export function vehicleOBB(s: VehicleState, spec: VehicleSpec): OBB {
  return { x: s.x, z: s.z, halfW: spec.halfWidth, halfL: spec.halfLength, heading: s.heading };
}

export function speedOf(s: VehicleState): number {
  return Math.hypot(s.vx, s.vz);
}

/** Advance the vehicle by `dt` seconds. Mutates `s`. */
export function stepVehicle(s: VehicleState, spec: VehicleSpec, input: VehicleInput, dt: number): void {
  const fx = Math.sin(s.heading);
  const fz = Math.cos(s.heading);
  // right = forward x up = (-cos h, sin h)
  const rx = -fz;
  const rz = fx;

  // Project the world-space velocity onto the current body frame.
  let vF = s.vx * fx + s.vz * fz; // forward speed
  let vL = s.vx * rx + s.vz * rz; // lateral speed (positive = right)

  const throttle = clamp01(input.throttle);
  const brake = clamp01(input.brake);
  const steer = clamp(input.steer, -1, 1);

  // --- steering ------------------------------------------------------------
  // Limit the wheel angle so that the kinematic lateral acceleration v^2 tan(d)/L stays within
  // ~1.25x the tyre limit: full lock at speed produces a controllable slide instead of a spin.
  const v2 = Math.max(1, vF * vF);
  const steerLimit = Math.min(spec.maxSteerAngle, Math.atan((spec.maxLateralAccel * 1.25 * spec.wheelBase) / v2));
  const targetSteer = steer * steerLimit;
  const dSteer = targetSteer - s.steerAngle;
  const maxDelta = spec.steerRate * dt;
  s.steerAngle += clamp(dSteer, -maxDelta, maxDelta);

  // --- longitudinal: driven forces + aerodynamic drag ---------------------------
  let force = 0;
  const movingForward = vF > 0.3;
  const movingBackward = vF < -0.3;
  if (throttle > 0) {
    const fade = clamp(1 - Math.max(0, vF) / spec.maxSpeed, 0, 1);
    force += throttle * spec.maxEngineForce * fade;
    if (movingBackward) force += spec.maxBrakeForce * 0.6; // braking out of reverse
  }
  if (brake > 0) {
    if (movingForward) {
      force -= brake * spec.maxBrakeForce;
    } else if (throttle === 0) {
      // Reverse gear: engine force backwards, limited by the reverse top speed.
      const fade = clamp(1 - Math.max(0, -vF) / spec.maxReverseSpeed, 0, 1);
      force -= brake * spec.maxEngineForce * 0.5 * fade;
    }
  }
  force -= spec.dragCoeff * vF * Math.abs(vF);
  vF += (force / spec.mass) * dt;

  // Passive Coulomb-like resistances: constant magnitude, never reverse the velocity.
  let passive = spec.rollingResistance;
  if (throttle === 0 && brake === 0) passive += spec.engineBraking;
  if (input.handbrake) passive += spec.handbrakeForce;
  const passiveDv = (passive / spec.mass) * dt;
  if (Math.abs(vF) <= passiveDv) vF = 0;
  else vF -= Math.sign(vF) * passiveDv;

  // --- lateral friction ----------------------------------------------------
  const gripScale = input.handbrake ? spec.handbrakeGripFactor : 1;
  const latAcc = clamp(-vL * spec.lateralGrip * gripScale, -spec.maxLateralAccel * gripScale, spec.maxLateralAccel * gripScale);
  const latDv = latAcc * dt;
  vL = Math.abs(latDv) >= Math.abs(vL) && Math.sign(latDv) !== Math.sign(vL) ? 0 : vL + latDv;

  // Reassemble world velocity in the *current* body frame (before yawing) so that turning the
  // body produces real lateral velocity, which the tyres then have to soak up.
  s.vx = fx * vF + rx * vL;
  s.vz = fz * vF + rz * vL;

  // --- yaw: kinematic bicycle, damped while sliding ---------------------------
  const slide = Math.min(1, Math.abs(vL) / 6);
  // Positive rotation about +Y turns the nose from +Z toward +X, i.e. to the LEFT of a car
  // facing +Z, so a right-hand steer angle produces a negative yaw rate.
  const kinematicYaw = -(vF / spec.wheelBase) * Math.tan(s.steerAngle);
  const targetYaw = kinematicYaw * (1 - 0.5 * slide);
  s.yawRate += (targetYaw - s.yawRate) * Math.min(1, dt * 12);
  s.heading = wrapAngle(s.heading + s.yawRate * dt);

  // --- integrate -----------------------------------------------------------
  s.x += s.vx * dt;
  s.z += s.vz * dt;
  s.wheelSpin += (vF / spec.wheelRadius) * dt;
  s.forwardSpeed = vF;
  s.lateralSpeed = vL;
}

const _candidates: (AABB & { id: number })[] = [];

/**
 * Resolve the vehicle against static AABBs. Returns the strongest collision this step (or null).
 * Up to `iterations` passes are made so corner contacts settle.
 */
export function resolveVehicleStatic(
  s: VehicleState,
  spec: VehicleSpec,
  grid: StaticColliderGrid,
  iterations = 3,
): CollisionEvent | null {
  let strongest: CollisionEvent | null = null;
  for (let it = 0; it < iterations; it++) {
    const obb = vehicleOBB(s, spec);
    const reach = Math.hypot(spec.halfWidth, spec.halfLength);
    grid.query({ minX: s.x - reach, maxX: s.x + reach, minZ: s.z - reach, maxZ: s.z + reach }, _candidates);
    let any = false;
    for (const box of _candidates) {
      const mtv = obbVsAABB(obb, box);
      if (!mtv) continue;
      any = true;
      const ev = applyMTV(s, spec, mtv, box.id);
      if (!strongest || ev.impulse > strongest.impulse) strongest = ev;
      obb.x = s.x;
      obb.z = s.z;
    }
    if (!any) break;
  }
  return strongest;
}

/** Resolve two vehicles against each other (symmetric push, momentum-ish exchange). */
export function resolveVehicleVehicle(a: VehicleState, aSpec: VehicleSpec, b: VehicleState, bSpec: VehicleSpec): CollisionEvent | null {
  const mtv = obbVsOBB(vehicleOBB(a, aSpec), vehicleOBB(b, bSpec));
  if (!mtv) return null;
  const total = aSpec.mass + bSpec.mass;
  const wa = bSpec.mass / total;
  const wb = aSpec.mass / total;
  a.x += mtv.nx * mtv.depth * wa;
  a.z += mtv.nz * mtv.depth * wa;
  b.x -= mtv.nx * mtv.depth * wb;
  b.z -= mtv.nz * mtv.depth * wb;
  // Relative velocity along the normal.
  const rvx = a.vx - b.vx;
  const rvz = a.vz - b.vz;
  const vn = rvx * mtv.nx + rvz * mtv.nz;
  if (vn >= 0) return { impulse: 0, nx: mtv.nx, nz: mtv.nz, otherId: null };
  const e = Math.min(aSpec.restitution, bSpec.restitution);
  const j = (-(1 + e) * vn) / (1 / aSpec.mass + 1 / bSpec.mass);
  a.vx += (j / aSpec.mass) * mtv.nx;
  a.vz += (j / aSpec.mass) * mtv.nz;
  b.vx -= (j / bSpec.mass) * mtv.nx;
  b.vz -= (j / bSpec.mass) * mtv.nz;
  return { impulse: -vn, nx: mtv.nx, nz: mtv.nz, otherId: null };
}

function applyMTV(s: VehicleState, spec: VehicleSpec, mtv: MTV, otherId: number): CollisionEvent {
  s.x += mtv.nx * mtv.depth;
  s.z += mtv.nz * mtv.depth;
  const vn = s.vx * mtv.nx + s.vz * mtv.nz;
  let impulse = 0;
  if (vn < 0) {
    impulse = -vn;
    s.vx -= (1 + spec.restitution) * vn * mtv.nx;
    s.vz -= (1 + spec.restitution) * vn * mtv.nz;
    // Impacts scrub off speed and apply a yaw kick from the torque r x F, where r is the body
    // corner that penetrates deepest along -n (support point) and F acts along n.
    s.vx *= 0.85;
    s.vz *= 0.85;
    const fx = Math.sin(s.heading);
    const fz = Math.cos(s.heading);
    const rx = -fz;
    const rz = fx;
    const sr = -(rx * mtv.nx + rz * mtv.nz) >= 0 ? 1 : -1;
    const sf = -(fx * mtv.nx + fz * mtv.nz) >= 0 ? 1 : -1;
    const cx = sr * spec.halfWidth * rx + sf * spec.halfLength * fx;
    const cz = sr * spec.halfWidth * rz + sf * spec.halfLength * fz;
    const torque = cz * mtv.nx - cx * mtv.nz; // (r x F).y
    s.yawRate += torque * Math.min(impulse, 8) * 0.06;
  }
  return { impulse, nx: mtv.nx, nz: mtv.nz, otherId };
}

export function wrapAngle(a: number): number {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function clamp01(v: number): number {
  return clamp(v, 0, 1);
}
