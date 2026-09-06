import { describe, expect, it } from 'vitest';
import {
  StaticColliderGrid,
  circleVsAABB,
  circleVsOBB,
  obbToAABB,
  obbVsAABB,
  obbVsOBB,
} from '../src/physics/Collision';
import {
  DEFAULT_CAR_SPEC,
  createVehicleState,
  resolveVehicleStatic,
  resolveVehicleVehicle,
  speedOf,
  stepVehicle,
  vehicleOBB,
  wrapAngle,
} from '../src/physics/VehiclePhysics';
import {
  DEFAULT_CHARACTER_SPEC,
  createCharacterState,
  resolveCharacterOBB,
  resolveCharacterStatic,
  stepCharacter,
} from '../src/physics/CharacterController';

const DT = 1 / 60;
const idle = { throttle: 0, brake: 0, steer: 0, handbrake: false };

describe('collision primitives', () => {
  it('circle vs AABB separates along the shortest axis', () => {
    const box = { minX: 0, minZ: 0, maxX: 10, maxZ: 10 };
    expect(circleVsAABB({ x: -5, z: 5, r: 1 }, box)).toBeNull();
    const m = circleVsAABB({ x: -0.5, z: 5, r: 1 }, box)!;
    expect(m.nx).toBeCloseTo(-1);
    expect(m.nz).toBeCloseTo(0);
    expect(m.depth).toBeCloseTo(0.5);
    const inside = circleVsAABB({ x: 1, z: 5, r: 0.5 }, box)!;
    expect(inside.nx).toBe(-1);
    expect(inside.depth).toBeCloseTo(1.5);
  });

  it('OBB vs AABB uses SAT and returns an MTV that separates', () => {
    const box = { minX: 0, minZ: 0, maxX: 10, maxZ: 10 };
    const far = { x: -5, z: 5, halfW: 1, halfL: 2, heading: 0.3 };
    expect(obbVsAABB(far, box)).toBeNull();
    const near = { x: -0.5, z: 5, halfW: 1, halfL: 2, heading: 0 };
    const m = obbVsAABB(near, box)!;
    expect(m.nx).toBeCloseTo(-1);
    expect(m.depth).toBeCloseTo(0.5);
    const rotated = { x: -1.2, z: 5, halfW: 1, halfL: 2, heading: Math.PI / 4 };
    const m2 = obbVsAABB(rotated, box)!;
    expect(m2).not.toBeNull();
    const moved = { ...rotated, x: rotated.x + m2.nx * m2.depth, z: rotated.z + m2.nz * m2.depth };
    expect(obbVsAABB(moved, box)).toBeNull();
    // diagonal reach: a 45deg rotated OBB is wider on both axes
    const aabb = obbToAABB(rotated);
    expect(aabb.maxX - aabb.minX).toBeGreaterThan(2);
  });

  it('circle vs OBB normal points away from the box for a rotated box', () => {
    const o = { x: 0, z: 0, halfW: 1, halfL: 3, heading: Math.PI / 6 };
    // A point just outside the box along its local right axis (-cos h, sin h).
    const rx = -Math.cos(o.heading);
    const rz = Math.sin(o.heading);
    const m = circleVsOBB({ x: rx * 1.2, z: rz * 1.2, r: 0.5 }, o)!;
    expect(m).not.toBeNull();
    expect(m.nx).toBeCloseTo(rx, 5);
    expect(m.nz).toBeCloseTo(rz, 5);
    expect(m.depth).toBeCloseTo(0.3, 5);
  });

  it('OBB vs OBB symmetric and circle vs OBB rotates normals back', () => {
    const a = { x: 0, z: 0, halfW: 1, halfL: 2, heading: 0 };
    const b = { x: 1.5, z: 0, halfW: 1, halfL: 2, heading: 0 };
    const m = obbVsOBB(a, b)!;
    expect(m.nx).toBeCloseTo(-1);
    expect(m.depth).toBeCloseTo(0.5);
    const c = circleVsOBB({ x: 2.2, z: 0, r: 0.5 }, { x: 0, z: 0, halfW: 2, halfL: 1, heading: Math.PI / 2 })!;
    // OBB rotated 90deg: halfL(1) now lies along X, so the circle at x=2.2 is outside (2.2-0.5=1.7>1)
    expect(c).toBeNull();
    const d = circleVsOBB({ x: 1.2, z: 0, r: 0.5 }, { x: 0, z: 0, halfW: 2, halfL: 1, heading: Math.PI / 2 })!;
    expect(Math.abs(d.nx)).toBeCloseTo(1);
    expect(d.depth).toBeCloseTo(0.3);
  });

  it('spatial grid finds overlapping boxes without duplicates', () => {
    const grid = new StaticColliderGrid(16);
    grid.insert({ id: 1, minX: 0, minZ: 0, maxX: 40, maxZ: 40 });
    grid.insert({ id: 2, minX: 100, minZ: 100, maxX: 110, maxZ: 110 });
    const hits = grid.query({ minX: 10, minZ: 10, maxX: 30, maxZ: 30 });
    expect(hits.map((h) => h.id)).toEqual([1]);
    expect(grid.query({ minX: 50, minZ: 50, maxX: 60, maxZ: 60 })).toEqual([]);
    expect(grid.count).toBe(2);
  });
});

describe('vehicle physics', () => {
  it('accelerates forward under throttle and stops under brake', () => {
    const s = createVehicleState(0, 0, 0);
    for (let i = 0; i < 180; i++) stepVehicle(s, DEFAULT_CAR_SPEC, { ...idle, throttle: 1 }, DT);
    expect(s.forwardSpeed).toBeGreaterThan(10);
    expect(s.z).toBeGreaterThan(10); // heading 0 => forward +Z
    expect(Math.abs(s.x)).toBeLessThan(1e-6);
    const v = s.forwardSpeed;
    for (let i = 0; i < 600; i++) stepVehicle(s, DEFAULT_CAR_SPEC, { ...idle, brake: 1 }, DT);
    expect(Math.abs(s.forwardSpeed)).toBeLessThan(v);
    // Holding brake from rest reverses the car.
    expect(s.forwardSpeed).toBeLessThan(0);
    expect(s.forwardSpeed).toBeGreaterThanOrEqual(-DEFAULT_CAR_SPEC.maxReverseSpeed - 0.01);
  });

  it('coasts to a stop and never oscillates around zero', () => {
    const s = createVehicleState();
    for (let i = 0; i < 120; i++) stepVehicle(s, DEFAULT_CAR_SPEC, { ...idle, throttle: 1 }, DT);
    for (let i = 0; i < 60 * 60; i++) stepVehicle(s, DEFAULT_CAR_SPEC, idle, DT);
    expect(s.forwardSpeed).toBe(0);
    expect(speedOf(s)).toBeLessThan(1e-3);
  });

  it('respects top speed', () => {
    const s = createVehicleState();
    for (let i = 0; i < 60 * 60; i++) stepVehicle(s, DEFAULT_CAR_SPEC, { ...idle, throttle: 1 }, DT);
    expect(s.forwardSpeed).toBeLessThanOrEqual(DEFAULT_CAR_SPEC.maxSpeed);
    expect(s.forwardSpeed).toBeGreaterThan(DEFAULT_CAR_SPEC.maxSpeed * 0.6);
  });

  it('turns right (clockwise from above, toward -X when facing +Z) with positive steer', () => {
    const s = createVehicleState(0, 0, 0);
    for (let i = 0; i < 120; i++) stepVehicle(s, DEFAULT_CAR_SPEC, { ...idle, throttle: 1 }, DT);
    const h0 = s.heading;
    for (let i = 0; i < 60; i++) stepVehicle(s, DEFAULT_CAR_SPEC, { ...idle, throttle: 0.5, steer: 1 }, DT);
    expect(wrapAngle(s.heading - h0)).toBeLessThan(-0.1);
    expect(s.x).toBeLessThan(0); // drifted toward -X = right of +Z
    // Velocity follows heading closely while gripping (small lateral speed).
    expect(Math.abs(s.lateralSpeed)).toBeLessThan(Math.abs(s.forwardSpeed) * 0.5);
  });

  it('handbrake reduces grip and allows sliding', () => {
    const grip = createVehicleState();
    const slide = createVehicleState();
    for (let i = 0; i < 180; i++) {
      stepVehicle(grip, DEFAULT_CAR_SPEC, { ...idle, throttle: 1 }, DT);
      stepVehicle(slide, DEFAULT_CAR_SPEC, { ...idle, throttle: 1 }, DT);
    }
    for (let i = 0; i < 40; i++) {
      stepVehicle(grip, DEFAULT_CAR_SPEC, { ...idle, steer: 1 }, DT);
      stepVehicle(slide, DEFAULT_CAR_SPEC, { ...idle, steer: 1, handbrake: true }, DT);
    }
    expect(Math.abs(slide.lateralSpeed)).toBeGreaterThan(Math.abs(grip.lateralSpeed));
  });

  it('is deterministic', () => {
    const a = createVehicleState(1, 2, 0.3);
    const b = createVehicleState(1, 2, 0.3);
    for (let i = 0; i < 300; i++) {
      const inp = { throttle: (i % 50) / 50, brake: i > 200 ? 1 : 0, steer: Math.sin(i / 20), handbrake: i % 97 === 0 };
      stepVehicle(a, DEFAULT_CAR_SPEC, inp, DT);
      stepVehicle(b, DEFAULT_CAR_SPEC, inp, DT);
    }
    expect(a).toEqual(b);
  });

  it('resolves against static boxes and reports the impact', () => {
    const grid = new StaticColliderGrid(16);
    grid.insert({ id: 9, minX: -20, minZ: 20, maxX: 20, maxZ: 40 });
    const s = createVehicleState(0, 0, 0);
    let impact = 0;
    for (let i = 0; i < 240; i++) {
      stepVehicle(s, DEFAULT_CAR_SPEC, { ...idle, throttle: 1 }, DT);
      const ev = resolveVehicleStatic(s, DEFAULT_CAR_SPEC, grid);
      if (ev) impact = Math.max(impact, ev.impulse);
    }
    expect(impact).toBeGreaterThan(3);
    expect(s.z + DEFAULT_CAR_SPEC.halfLength).toBeLessThanOrEqual(20 + 1e-6);
    expect(obbVsAABB(vehicleOBB(s, DEFAULT_CAR_SPEC), { minX: -20, minZ: 20, maxX: 20, maxZ: 40 })).toBeNull();
  });

  it('separates two overlapping vehicles and exchanges momentum', () => {
    const a = createVehicleState(0, 0, 0);
    const b = createVehicleState(0, 3, 0);
    a.vz = 10;
    const ev = resolveVehicleVehicle(a, DEFAULT_CAR_SPEC, b, DEFAULT_CAR_SPEC)!;
    expect(ev).not.toBeNull();
    expect(ev.impulse).toBeCloseTo(10);
    expect(b.vz).toBeGreaterThan(0);
    expect(a.vz).toBeLessThan(10);
    expect(obbVsOBB(vehicleOBB(a, DEFAULT_CAR_SPEC), vehicleOBB(b, DEFAULT_CAR_SPEC))).toBeNull();
  });
});

describe('character controller', () => {
  it('moves toward the requested direction, faces it and stops', () => {
    const s = createCharacterState(0, 0, 0);
    for (let i = 0; i < 120; i++) stepCharacter(s, DEFAULT_CHARACTER_SPEC, { dirX: 1, dirZ: 0, run: true }, DT);
    expect(s.x).toBeGreaterThan(5);
    expect(s.heading).toBeCloseTo(Math.PI / 2, 3);
    expect(Math.hypot(s.vx, s.vz)).toBeCloseTo(DEFAULT_CHARACTER_SPEC.runSpeed, 3);
    for (let i = 0; i < 60; i++) stepCharacter(s, DEFAULT_CHARACTER_SPEC, { dirX: 0, dirZ: 0, run: false }, DT);
    expect(s.vx).toBe(0);
    expect(s.moveBlend).toBe(0);
  });

  it('walks slower than it runs', () => {
    const w = createCharacterState();
    for (let i = 0; i < 120; i++) stepCharacter(w, DEFAULT_CHARACTER_SPEC, { dirX: 0, dirZ: 1, run: false }, DT);
    expect(Math.hypot(w.vx, w.vz)).toBeCloseTo(DEFAULT_CHARACTER_SPEC.walkSpeed, 3);
  });

  it('is pushed out of buildings and vehicles', () => {
    const grid = new StaticColliderGrid(16);
    grid.insert({ id: 1, minX: 5, minZ: -10, maxX: 30, maxZ: 10 });
    const s = createCharacterState(0, 0, 0);
    for (let i = 0; i < 240; i++) {
      stepCharacter(s, DEFAULT_CHARACTER_SPEC, { dirX: 1, dirZ: 0, run: true }, DT);
      resolveCharacterStatic(s, DEFAULT_CHARACTER_SPEC, grid);
    }
    expect(s.x + DEFAULT_CHARACTER_SPEC.radius).toBeLessThanOrEqual(5 + 1e-6);
    const c = createCharacterState(0.5, 0, 0);
    expect(resolveCharacterOBB(c, DEFAULT_CHARACTER_SPEC, { x: 0, z: 0, halfW: 1, halfL: 2, heading: 0 })).toBe(true);
    expect(c.x).toBeGreaterThanOrEqual(1 + DEFAULT_CHARACTER_SPEC.radius - 1e-6);
  });
});
