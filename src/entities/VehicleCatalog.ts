/**
 * Vehicle type catalog: a typed table of drivable vehicle types, each with a `VehicleSpec` override
 * (mass, engine/brake force, grip, top speed, wheelbase, size) and a `VehicleBodyProfile` (the
 * procedural body proportions `VehicleEntity` builds its mesh from — panel heights, cabin position,
 * an optional open cargo bed, an optional roof light bar) plus a paint palette.
 *
 * Pure data (no three.js), so it can be unit-tested on its own (see `tests/vehicleCatalog.test.ts`).
 */
import { DEFAULT_CAR_SPEC, type VehicleSpec } from '../physics/VehiclePhysics';
import type { Random } from '../world/Random';

export type VehicleType = 'sedan' | 'sports' | 'suv' | 'van' | 'pickup' | 'police';

export const VEHICLE_TYPES: readonly VehicleType[] = ['sedan', 'sports', 'suv', 'van', 'pickup', 'police'];

/**
 * Procedural body proportions (metres), independent of the physics spec, that `VehicleEntity` uses
 * to build its box/cylinder mesh. All lengths are absolute (not fractions), matched by hand to each
 * type's `spec.halfWidth`/`halfLength` so the panels stay within the car's footprint.
 */
export interface VehicleBodyProfile {
  /** Lower body slab height. */
  bodyHeight: number;
  /** Upper hood/trunk slab height; 0 = no separate slab (a single tall boxy body, e.g. a van). */
  upperHeight: number;
  /** Width trimmed off the upper slab vs. the lower one (0 = flush/boxy, more = a tucked-in hood). */
  hoodTaper: number;
  /** Cabin (glass) box height. */
  cabinHeight: number;
  /** Cabin box length along Z. */
  cabinLength: number;
  /** Cabin box centre offset along Z from the vehicle's centre (+ = toward the front). */
  cabinOffsetZ: number;
  /** Roof cap thickness; 0 = the cabin box's own top doubles as the roof. */
  roofHeight: number;
  /** Open cargo bed length at the rear; 0 = none (pickup only). */
  bedLength: number;
  /** Roof-mounted light bar with flashing red/blue emissive lamps (police only). */
  lightbar: boolean;
}

export interface VehicleTypeDef {
  type: VehicleType;
  label: string;
  /** Overrides merged onto `DEFAULT_CAR_SPEC`. */
  spec: Partial<VehicleSpec>;
  body: VehicleBodyProfile;
  /** Paint colours (0xRRGGBB) a spawner may pick from for this type. */
  palette: readonly number[];
}

const CIVILIAN_PALETTE = [0xb23b3b, 0x2f6fae, 0xd8b23a, 0x2c2c34, 0xdedede, 0x3f8f4f, 0x8a4fd6, 0xc97a2c];
const SPORTS_PALETTE = [0xc0392b, 0xf1c40f, 0xecf0f1, 0x2c3e50, 0x8e44ad];
const UTILITY_PALETTE = [0x556070, 0x3f4a3f, 0x8a6a4f, 0x2c2c34, 0xb8b8b0];
const POLICE_PALETTE = [0x14161c, 0x1c2740];

export const VEHICLE_CATALOG: Record<VehicleType, VehicleTypeDef> = {
  sedan: {
    type: 'sedan',
    label: 'Sedan',
    spec: {},
    body: {
      bodyHeight: 0.62,
      upperHeight: 0.28,
      hoodTaper: 0.18,
      cabinHeight: 0.5,
      cabinLength: 2.36,
      cabinOffsetZ: -0.35,
      roofHeight: 0.06,
      bedLength: 0,
      lightbar: false,
    },
    palette: CIVILIAN_PALETTE,
  },
  sports: {
    type: 'sports',
    label: 'Sports car',
    spec: {
      mass: 1150,
      maxEngineForce: 13500,
      maxBrakeForce: 16500,
      maxSteerAngle: 0.55,
      steerRate: 5,
      wheelBase: 2.55,
      halfWidth: 0.92,
      halfLength: 2.15,
      wheelRadius: 0.33,
      dragCoeff: 0.3,
      rollingResistance: 190,
      engineBraking: 900,
      lateralGrip: 12,
      maxLateralAccel: 14,
      handbrakeGripFactor: 0.25,
      handbrakeForce: 5500,
      maxSpeed: 70,
    },
    body: {
      bodyHeight: 0.5,
      upperHeight: 0.22,
      hoodTaper: 0.32,
      cabinHeight: 0.4,
      cabinLength: 1.9,
      cabinOffsetZ: -0.55,
      roofHeight: 0.05,
      bedLength: 0,
      lightbar: false,
    },
    palette: SPORTS_PALETTE,
  },
  suv: {
    type: 'suv',
    label: 'SUV',
    spec: {
      mass: 1950,
      maxEngineForce: 10800,
      maxBrakeForce: 15500,
      maxSteerAngle: 0.55,
      steerRate: 3.6,
      wheelBase: 2.95,
      halfWidth: 1.05,
      halfLength: 2.45,
      wheelRadius: 0.4,
      dragCoeff: 0.55,
      rollingResistance: 260,
      engineBraking: 1250,
      lateralGrip: 8,
      maxLateralAccel: 10,
      handbrakeGripFactor: 0.18,
      handbrakeForce: 6500,
      maxSpeed: 46,
      maxReverseSpeed: 8,
      restitution: 0.22,
    },
    body: {
      bodyHeight: 0.78,
      upperHeight: 0.3,
      hoodTaper: 0.12,
      cabinHeight: 0.62,
      cabinLength: 2.9,
      cabinOffsetZ: -0.15,
      roofHeight: 0.08,
      bedLength: 0,
      lightbar: false,
    },
    palette: UTILITY_PALETTE,
  },
  van: {
    type: 'van',
    label: 'Van',
    spec: {
      mass: 2250,
      maxEngineForce: 9800,
      maxBrakeForce: 15500,
      maxSteerAngle: 0.5,
      steerRate: 3.2,
      wheelBase: 3.25,
      halfWidth: 1.08,
      halfLength: 2.95,
      wheelRadius: 0.37,
      dragCoeff: 0.68,
      rollingResistance: 300,
      engineBraking: 1300,
      lateralGrip: 7,
      maxLateralAccel: 8,
      handbrakeGripFactor: 0.16,
      handbrakeForce: 7000,
      maxSpeed: 40,
      maxReverseSpeed: 7,
      restitution: 0.2,
    },
    body: {
      bodyHeight: 1.05,
      upperHeight: 0,
      hoodTaper: 0,
      cabinHeight: 0.75,
      cabinLength: 4.6,
      cabinOffsetZ: -0.35,
      roofHeight: 0.07,
      bedLength: 0,
      lightbar: false,
    },
    palette: UTILITY_PALETTE,
  },
  pickup: {
    type: 'pickup',
    label: 'Pickup',
    spec: {
      mass: 1800,
      maxEngineForce: 11200,
      maxBrakeForce: 15200,
      maxSteerAngle: 0.55,
      steerRate: 3.8,
      wheelBase: 3.05,
      halfWidth: 1.0,
      halfLength: 2.65,
      wheelRadius: 0.38,
      dragCoeff: 0.5,
      rollingResistance: 240,
      engineBraking: 1150,
      lateralGrip: 8,
      maxLateralAccel: 10,
      handbrakeGripFactor: 0.2,
      handbrakeForce: 6200,
      maxSpeed: 48,
      maxReverseSpeed: 8,
      restitution: 0.22,
    },
    body: {
      bodyHeight: 0.6,
      upperHeight: 0.26,
      hoodTaper: 0.18,
      cabinHeight: 0.48,
      cabinLength: 1.7,
      cabinOffsetZ: 0.85,
      roofHeight: 0.06,
      bedLength: 2.45,
      lightbar: false,
    },
    palette: UTILITY_PALETTE,
  },
  police: {
    type: 'police',
    label: 'Police interceptor',
    spec: {
      mass: 1420,
      maxEngineForce: 11800,
      maxBrakeForce: 15800,
      maxSteerAngle: 0.58,
      steerRate: 4.5,
      wheelBase: 2.78,
      halfWidth: 0.97,
      halfLength: 2.3,
      wheelRadius: 0.34,
      dragCoeff: 0.4,
      rollingResistance: 220,
      engineBraking: 1050,
      lateralGrip: 10,
      maxLateralAccel: 12,
      handbrakeGripFactor: 0.22,
      handbrakeForce: 6200,
      maxSpeed: 58,
    },
    body: {
      bodyHeight: 0.62,
      upperHeight: 0.28,
      hoodTaper: 0.18,
      cabinHeight: 0.5,
      cabinLength: 2.35,
      cabinOffsetZ: -0.35,
      roofHeight: 0.06,
      bedLength: 0,
      lightbar: true,
    },
    palette: POLICE_PALETTE,
  },
};

/** Merge a type's spec overrides onto `DEFAULT_CAR_SPEC`. */
export function resolveVehicleSpec(type: VehicleType): VehicleSpec {
  return { ...DEFAULT_CAR_SPEC, ...VEHICLE_CATALOG[type].spec };
}

/** Uniformly pick a catalog type. */
export function pickVehicleType(rng: Random): VehicleType {
  return rng.pick(VEHICLE_TYPES);
}

/** Pick a paint colour from `type`'s palette. */
export function pickVehiclePaint(rng: Random, type: VehicleType): number {
  return rng.pick(VEHICLE_CATALOG[type].palette);
}
