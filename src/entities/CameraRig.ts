/**
 * Third-person chase camera with smoothing, mouse orbit, look-back, speed-dependent FOV and
 * 2D building-aware collision (the camera never sits inside a building).
 */
import { MathUtils, PerspectiveCamera, Vector3 } from 'three';
import type { AABB, StaticColliderGrid } from '../physics/Collision';

export interface CameraTarget {
  position: Vector3;
  heading: number;
  /** m/s, used for FOV and follow distance. */
  speed: number;
  /** 'vehicle' uses a longer, lower framing than 'foot'. */
  mode: 'vehicle' | 'foot';
}

const _desired = new Vector3();
const _focus = new Vector3();
const _candidates: (AABB & { id: number })[] = [];

export class CameraRig {
  /** Smoothed yaw the camera orbits around (radians). */
  yaw = 0;
  pitch = 0.22;
  orbitYaw = 0;
  orbitPitch = 0;
  private readonly position = new Vector3();
  private initialised = false;
  baseFov = 62;

  constructor(readonly camera: PerspectiveCamera, private readonly grid: StaticColliderGrid | null) {}

  snapTo(target: CameraTarget): void {
    this.yaw = target.heading;
    this.orbitYaw = 0;
    this.orbitPitch = 0;
    this.initialised = false;
    this.update(target, 1 / 60, 0, 0, false);
  }

  /**
   * @param lookDX/lookDY mouse deltas (pixels) this frame
   */
  update(target: CameraTarget, frameDelta: number, lookDX: number, lookDY: number, lookBack: boolean): void {
    const dt = Math.min(0.1, Math.max(0, frameDelta));
    const vehicle = target.mode === 'vehicle';
    const dist = vehicle ? 6.5 + Math.min(3, target.speed * 0.06) : 3.6;
    const height = vehicle ? 2.4 : 1.7;

    // Mouse orbit; returns to the chase position when idle and moving.
    this.orbitYaw -= lookDX * 0.0035;
    this.orbitPitch = MathUtils.clamp(this.orbitPitch - lookDY * 0.003, -0.35, 0.6);
    const idleReturn = target.speed > 1 && Math.abs(lookDX) + Math.abs(lookDY) === 0;
    if (idleReturn) {
      const k = 1 - Math.exp(-dt * 1.2);
      this.orbitYaw += (0 - this.orbitYaw) * k;
      this.orbitPitch += (0 - this.orbitPitch) * k;
    }
    this.orbitYaw = wrap(this.orbitYaw);

    // Follow the heading with lag (more lag while sliding at speed feels dynamic).
    const followRate = vehicle ? 4.5 : 8;
    const k = this.initialised ? 1 - Math.exp(-dt * followRate) : 1;
    this.yaw += wrap(target.heading - this.yaw) * k;
    this.yaw = wrap(this.yaw);

    const totalYaw = this.yaw + this.orbitYaw + (lookBack ? Math.PI : 0);
    const totalPitch = this.pitch + this.orbitPitch;
    _focus.copy(target.position);
    _focus.y += vehicle ? 1.0 : 1.35;

    // Camera sits behind the target (opposite of forward = (sin yaw, cos yaw)).
    const back = -1;
    const horiz = dist * Math.cos(totalPitch);
    _desired.set(_focus.x + back * Math.sin(totalYaw) * horiz, _focus.y + height * 0.35 + dist * Math.sin(totalPitch), _focus.z + back * Math.cos(totalYaw) * horiz);

    // Building collision: pull the camera toward the focus until the 2D segment is clear.
    if (this.grid) this.resolveOcclusion(_focus, _desired);

    if (!this.initialised) {
      this.position.copy(_desired);
      this.initialised = true;
    } else {
      const posK = 1 - Math.exp(-dt * (vehicle ? 10 : 12));
      this.position.lerp(_desired, posK);
    }
    this.camera.position.copy(this.position);
    this.camera.lookAt(_focus);

    const fovTarget = this.baseFov + (vehicle ? Math.min(18, target.speed * 0.35) : 0);
    const newFov = this.camera.fov + (fovTarget - this.camera.fov) * (1 - Math.exp(-dt * 3));
    if (Math.abs(newFov - this.camera.fov) > 0.01) {
      this.camera.fov = newFov;
      this.camera.updateProjectionMatrix();
    }
  }

  private resolveOcclusion(focus: Vector3, desired: Vector3): void {
    if (!this.grid) return;
    const minX = Math.min(focus.x, desired.x) - 1;
    const maxX = Math.max(focus.x, desired.x) + 1;
    const minZ = Math.min(focus.z, desired.z) - 1;
    const maxZ = Math.max(focus.z, desired.z) + 1;
    this.grid.query({ minX, minZ, maxX, maxZ }, _candidates);
    let tMin = 1;
    for (const box of _candidates) {
      const t = segmentVsAABB(focus.x, focus.z, desired.x, desired.z, box, 0.6);
      if (t !== null && t < tMin) tMin = t;
    }
    if (tMin < 1) {
      desired.x = focus.x + (desired.x - focus.x) * tMin;
      desired.z = focus.z + (desired.z - focus.z) * tMin;
      // Keep the camera from dipping to eye level when squeezed close.
      desired.y = Math.max(desired.y, focus.y + 0.6);
    }
  }
}

/** Parametric entry (0..1) of segment p0→p1 into `box` expanded by `pad`, or null. */
export function segmentVsAABB(x0: number, z0: number, x1: number, z1: number, box: AABB, pad: number): number | null {
  const minX = box.minX - pad;
  const maxX = box.maxX + pad;
  const minZ = box.minZ - pad;
  const maxZ = box.maxZ + pad;
  const dx = x1 - x0;
  const dz = z1 - z0;
  let t0 = 0;
  let t1 = 1;
  const clip = (p: number, q: number): boolean => {
    if (p === 0) return q >= 0;
    const r = q / p;
    if (p < 0) {
      if (r > t1) return false;
      if (r > t0) t0 = r;
    } else {
      if (r < t0) return false;
      if (r < t1) t1 = r;
    }
    return true;
  };
  if (!clip(-dx, x0 - minX)) return null;
  if (!clip(dx, maxX - x0)) return null;
  if (!clip(-dz, z0 - minZ)) return null;
  if (!clip(dz, maxZ - z0)) return null;
  if (t0 <= 0 && t1 >= 1) {
    // segment starts inside the box; treat as immediately blocked only if it exits
    return t0 > 0 ? t0 : null;
  }
  return t0 > 0 ? Math.max(0, t0 - 0.02) : null;
}

function wrap(a: number): number {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}
