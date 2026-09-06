/**
 * On-foot character: a circle on the XZ plane with acceleration-based movement.
 */
import { circleVsAABB, circleVsOBB, type AABB, type OBB, type StaticColliderGrid } from './Collision';
import { wrapAngle } from './VehiclePhysics';

export interface CharacterSpec {
  radius: number;
  walkSpeed: number;
  runSpeed: number;
  acceleration: number;
  deceleration: number;
  turnRate: number;
}

export const DEFAULT_CHARACTER_SPEC: CharacterSpec = {
  radius: 0.4,
  walkSpeed: 3.6,
  runSpeed: 7,
  acceleration: 28,
  deceleration: 32,
  turnRate: 14,
};

export interface CharacterState {
  x: number;
  z: number;
  heading: number;
  vx: number;
  vz: number;
  /** 0 idle .. 1 full run, used for animation blending. */
  moveBlend: number;
}

export interface CharacterInput {
  /** Desired world-space direction (not necessarily normalised). */
  dirX: number;
  dirZ: number;
  run: boolean;
}

export function createCharacterState(x = 0, z = 0, heading = 0): CharacterState {
  return { x, z, heading, vx: 0, vz: 0, moveBlend: 0 };
}

export function stepCharacter(s: CharacterState, spec: CharacterSpec, input: CharacterInput, dt: number): void {
  let dx = input.dirX;
  let dz = input.dirZ;
  const len = Math.hypot(dx, dz);
  const maxSpeed = input.run ? spec.runSpeed : spec.walkSpeed;
  if (len > 1e-6) {
    dx /= len;
    dz /= len;
    const wantX = dx * maxSpeed * Math.min(1, len);
    const wantZ = dz * maxSpeed * Math.min(1, len);
    s.vx = approach(s.vx, wantX, spec.acceleration * dt);
    s.vz = approach(s.vz, wantZ, spec.acceleration * dt);
    const targetHeading = Math.atan2(dx, dz);
    const diff = wrapAngle(targetHeading - s.heading);
    s.heading = wrapAngle(s.heading + clamp(diff, -spec.turnRate * dt, spec.turnRate * dt));
  } else {
    s.vx = approach(s.vx, 0, spec.deceleration * dt);
    s.vz = approach(s.vz, 0, spec.deceleration * dt);
  }
  s.x += s.vx * dt;
  s.z += s.vz * dt;
  s.moveBlend = Math.min(1, Math.hypot(s.vx, s.vz) / spec.runSpeed);
}

const _candidates: (AABB & { id: number })[] = [];

export function resolveCharacterStatic(s: CharacterState, spec: CharacterSpec, grid: StaticColliderGrid, iterations = 3): boolean {
  let collided = false;
  for (let it = 0; it < iterations; it++) {
    grid.query({ minX: s.x - spec.radius, maxX: s.x + spec.radius, minZ: s.z - spec.radius, maxZ: s.z + spec.radius }, _candidates);
    let any = false;
    for (const box of _candidates) {
      const mtv = circleVsAABB({ x: s.x, z: s.z, r: spec.radius }, box);
      if (!mtv) continue;
      any = collided = true;
      s.x += mtv.nx * mtv.depth;
      s.z += mtv.nz * mtv.depth;
      const vn = s.vx * mtv.nx + s.vz * mtv.nz;
      if (vn < 0) {
        s.vx -= vn * mtv.nx;
        s.vz -= vn * mtv.nz;
      }
    }
    if (!any) break;
  }
  return collided;
}

/** Push the character out of a vehicle's OBB. */
export function resolveCharacterOBB(s: CharacterState, spec: CharacterSpec, obb: OBB): boolean {
  const mtv = circleVsOBB({ x: s.x, z: s.z, r: spec.radius }, obb);
  if (!mtv) return false;
  s.x += mtv.nx * mtv.depth;
  s.z += mtv.nz * mtv.depth;
  const vn = s.vx * mtv.nx + s.vz * mtv.nz;
  if (vn < 0) {
    s.vx -= vn * mtv.nx;
    s.vz -= vn * mtv.nz;
  }
  return true;
}

function approach(v: number, target: number, maxDelta: number): number {
  if (v < target) return Math.min(target, v + maxDelta);
  if (v > target) return Math.max(target, v - maxDelta);
  return v;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
