import { describe, expect, it } from 'vitest';
import { VEHICLE_CATALOG, VEHICLE_TYPES, pickVehiclePaint, pickVehicleType, resolveVehicleSpec, type VehicleType } from '../src/entities/VehicleCatalog';
import { Random } from '../src/world/Random';
import { createVehicleState, resolveVehicleVehicle, stepVehicle, type VehicleInput } from '../src/physics/VehiclePhysics';

const DT = 1 / 60;
const FULL_THROTTLE: VehicleInput = { throttle: 1, brake: 0, steer: 0, handbrake: false };

describe('vehicle catalog', () => {
  it('lists every required type', () => {
    for (const t of ['sedan', 'sports', 'suv', 'van', 'pickup', 'police'] as const) {
      expect(VEHICLE_TYPES).toContain(t);
      expect(VEHICLE_CATALOG[t].type).toBe(t);
    }
  });

  it('produces a valid, physically sane spec for every entry', () => {
    for (const type of VEHICLE_TYPES) {
      const spec = resolveVehicleSpec(type);
      // All physical quantities must be positive.
      for (const [key, value] of Object.entries(spec)) {
        expect(value, `${type}.${key} should be positive`).toBeGreaterThan(0);
      }
      // The body must be long enough to actually contain its own wheelbase.
      expect(spec.halfLength, `${type}: halfLength > wheelBase/2`).toBeGreaterThan(spec.wheelBase / 2);
      // Top speed must be reachable: engine force must still exceed aerodynamic drag at 60% of it,
      // otherwise the car asymptotes below its stated maxSpeed and never gets there.
      const v60 = spec.maxSpeed * 0.6;
      const engineForceAt60 = spec.maxEngineForce * (1 - v60 / spec.maxSpeed);
      const dragAt60 = spec.dragCoeff * v60 * v60;
      expect(engineForceAt60, `${type}: engine force > drag at 60% top speed`).toBeGreaterThan(dragAt60);
    }
  });

  it('every palette is non-empty and pickVehiclePaint/pickVehicleType stay within the catalog', () => {
    const rng = new Random('catalog-paint');
    for (const type of VEHICLE_TYPES) {
      expect(VEHICLE_CATALOG[type].palette.length).toBeGreaterThan(0);
      for (let i = 0; i < 20; i++) expect(VEHICLE_CATALOG[type].palette).toContain(pickVehiclePaint(rng, type));
    }
    const rngType = new Random('catalog-type');
    for (let i = 0; i < 50; i++) expect(VEHICLE_TYPES).toContain(pickVehicleType(rngType));
  });

  it('a sports car reaches a higher top speed than a van in a straight-line simulation', () => {
    const topSpeedAfter = (type: VehicleType, seconds: number): number => {
      const spec = resolveVehicleSpec(type);
      const state = createVehicleState(0, 0, 0);
      const steps = Math.round(seconds / DT);
      for (let i = 0; i < steps; i++) stepVehicle(state, spec, FULL_THROTTLE, DT);
      return state.forwardSpeed;
    };
    const sportsSpeed = topSpeedAfter('sports', 40);
    const vanSpeed = topSpeedAfter('van', 40);
    expect(sportsSpeed).toBeGreaterThan(vanSpeed);
    // Both should have settled near (but not over) their own top speed — well short of it is a
    // sign the simulated run wasn't long enough to reach equilibrium.
    expect(sportsSpeed).toBeGreaterThan(resolveVehicleSpec('sports').maxSpeed * 0.8);
    expect(sportsSpeed).toBeLessThanOrEqual(resolveVehicleSpec('sports').maxSpeed);
    expect(vanSpeed).toBeGreaterThan(resolveVehicleSpec('van').maxSpeed * 0.8);
    expect(vanSpeed).toBeLessThanOrEqual(resolveVehicleSpec('van').maxSpeed);
  });

  it('a heavier vehicle pushes a lighter one further in resolveVehicleVehicle', () => {
    const heavySpec = resolveVehicleSpec('van'); // mass 2250
    const lightSpec = resolveVehicleSpec('sports'); // mass 1150
    // Rear-end: heavy directly behind light, both facing +Z, overlapping by a small amount so the
    // SAT's minimum-translation axis is along Z (the direction of travel) rather than sideways.
    const gapDepth = 0.5;
    const heavy = createVehicleState(0, 0, 0);
    heavy.vz = 10;
    const light = createVehicleState(0, heavySpec.halfLength + lightSpec.halfLength - gapDepth, 0);

    const heavyStart = { x: heavy.x, z: heavy.z };
    const lightStart = { x: light.x, z: light.z };
    const ev = resolveVehicleVehicle(heavy, heavySpec, light, lightSpec);
    expect(ev).not.toBeNull();
    expect(ev!.impulse).toBeGreaterThan(0);

    const heavyMoved = Math.hypot(heavy.x - heavyStart.x, heavy.z - heavyStart.z);
    const lightMoved = Math.hypot(light.x - lightStart.x, light.z - lightStart.z);
    expect(lightMoved).toBeGreaterThan(heavyMoved);

    // The lighter vehicle should also pick up more speed from the impact than the heavy one loses.
    const lightSpeed = Math.hypot(light.vx, light.vz);
    const heavySpeedAfter = Math.hypot(heavy.vx, heavy.vz);
    expect(lightSpeed).toBeGreaterThan(heavySpeedAfter);
  });
});
