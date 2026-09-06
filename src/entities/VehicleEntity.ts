/**
 * A drivable car: procedural mesh + arcade physics + interpolated visuals.
 */
import {
  BoxGeometry,
  Color,
  CylinderGeometry,
  Group,
  Mesh,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  Object3D,
  Vector3,
} from 'three';
import type { MaterialRegistry } from '../render/MaterialRegistry';
import {
  DEFAULT_CAR_SPEC,
  createVehicleState,
  resolveVehicleStatic,
  stepVehicle,
  vehicleOBB,
  wrapAngle,
  type CollisionEvent,
  type VehicleInput,
  type VehicleSpec,
  type VehicleState,
} from '../physics/VehiclePhysics';
import type { StaticColliderGrid, OBB } from '../physics/Collision';

export interface VehicleVisualOptions {
  paint: number;
  spec?: Partial<VehicleSpec>;
}

let nextVehicleId = 1;

export class VehicleEntity {
  readonly id = nextVehicleId++;
  readonly spec: VehicleSpec;
  readonly state: VehicleState;
  /** State at the previous fixed step (for render interpolation). */
  readonly prev: VehicleState;
  readonly object = new Group();
  readonly wheels: Object3D[] = [];
  readonly frontWheels: Object3D[] = [];
  readonly body: Group;
  readonly headlights: MeshStandardMaterial;
  readonly taillights: MeshStandardMaterial;
  readonly paint: MeshPhysicalMaterial;
  lastCollision: CollisionEvent | null = null;
  /** Accumulated damage 0..1 (visual / gameplay hook). */
  damage = 0;
  driven = false;
  private readonly materials: (MeshStandardMaterial | MeshPhysicalMaterial)[] = [];

  constructor(registry: MaterialRegistry, opts: VehicleVisualOptions, x = 0, z = 0, heading = 0) {
    this.spec = { ...DEFAULT_CAR_SPEC, ...opts.spec };
    this.state = createVehicleState(x, z, heading);
    this.prev = createVehicleState(x, z, heading);
    this.object.name = `vehicle:${this.id}`;

    const hw = this.spec.halfWidth;
    const hl = this.spec.halfLength;
    const wr = this.spec.wheelRadius;

    this.paint = registry.register(
      new MeshPhysicalMaterial({
        color: new Color(opts.paint),
        metalness: 0.7,
        roughness: 0.32,
        clearcoat: 1,
        clearcoatRoughness: 0.06,
        envMapIntensity: 1.2,
      }),
    );
    const glass = registry.register(
      new MeshPhysicalMaterial({ color: 0x0b1016, metalness: 0.9, roughness: 0.05, transparent: true, opacity: 0.72, envMapIntensity: 1.5 }),
    );
    const rubber = registry.register(new MeshStandardMaterial({ color: 0x111214, roughness: 0.9, metalness: 0 }));
    const chrome = registry.register(new MeshStandardMaterial({ color: 0xcfd4d8, roughness: 0.2, metalness: 1 }));
    const trim = registry.register(new MeshStandardMaterial({ color: 0x1a1c1f, roughness: 0.6, metalness: 0.2 }));
    this.headlights = registry.register(new MeshStandardMaterial({ color: 0xffffff, emissive: new Color(0xfff6df), emissiveIntensity: 0, roughness: 0.3 }));
    this.taillights = registry.register(new MeshStandardMaterial({ color: 0x550000, emissive: new Color(0xff2a1a), emissiveIntensity: 0.2, roughness: 0.4 }));
    this.materials.push(this.paint, glass, rubber, chrome, trim, this.headlights, this.taillights);

    this.body = new Group();
    const ground = wr; // body rides at axle height

    // lower body
    const lower = new Mesh(new BoxGeometry(hw * 2, 0.62, hl * 2), this.paint);
    lower.position.y = ground + 0.31;
    // hood / trunk slopes via a narrower upper body slab
    const upper = new Mesh(new BoxGeometry(hw * 2 - 0.18, 0.28, hl * 2 - 0.5), this.paint);
    upper.position.set(0, ground + 0.62 + 0.14, -0.05);
    // cabin
    const cabin = new Mesh(new BoxGeometry(hw * 2 - 0.38, 0.5, hl * 1.05), glass);
    cabin.position.set(0, ground + 0.9 + 0.25, -0.35);
    const roof = new Mesh(new BoxGeometry(hw * 2 - 0.42, 0.06, hl * 1.0), this.paint);
    roof.position.set(0, ground + 1.4 + 0.03, -0.35);
    // bumpers and trim
    const bumperF = new Mesh(new BoxGeometry(hw * 2 + 0.04, 0.22, 0.18), trim);
    bumperF.position.set(0, ground + 0.2, hl - 0.02);
    const bumperR = new Mesh(new BoxGeometry(hw * 2 + 0.04, 0.22, 0.18), trim);
    bumperR.position.set(0, ground + 0.2, -hl + 0.02);
    const grille = new Mesh(new BoxGeometry(hw * 0.9, 0.18, 0.06), chrome);
    grille.position.set(0, ground + 0.5, hl + 0.01);
    for (const mesh of [lower, upper, cabin, roof, bumperF, bumperR, grille]) {
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.body.add(mesh);
    }
    // lights
    for (const side of [-1, 1]) {
      const hlMesh = new Mesh(new BoxGeometry(0.34, 0.16, 0.06), this.headlights);
      hlMesh.position.set(side * (hw - 0.3), ground + 0.56, hl + 0.01);
      const tlMesh = new Mesh(new BoxGeometry(0.34, 0.14, 0.06), this.taillights);
      tlMesh.position.set(side * (hw - 0.3), ground + 0.56, -hl - 0.01);
      this.body.add(hlMesh, tlMesh);
    }
    this.object.add(this.body);

    // wheels (cylinder axis along X)
    const wheelGeo = new CylinderGeometry(wr, wr, 0.26, 14);
    wheelGeo.rotateZ(Math.PI / 2);
    const rimGeo = new CylinderGeometry(wr * 0.55, wr * 0.55, 0.27, 10);
    rimGeo.rotateZ(Math.PI / 2);
    const axleZ = this.spec.wheelBase / 2;
    for (const [sx, sz] of [[-1, 1], [1, 1], [-1, -1], [1, -1]] as [number, number][]) {
      const pivot = new Object3D();
      pivot.position.set(sx * (hw - 0.05), wr, sz * axleZ);
      const spin = new Object3D();
      const tyre = new Mesh(wheelGeo, rubber);
      const rim = new Mesh(rimGeo, chrome);
      tyre.castShadow = true;
      spin.add(tyre, rim);
      pivot.add(spin);
      this.object.add(pivot);
      this.wheels.push(spin);
      if (sz > 0) this.frontWheels.push(pivot);
    }
    this.syncVisual(1);
  }

  get obb(): OBB {
    return vehicleOBB(this.state, this.spec);
  }

  get position(): Vector3 {
    return this.object.position;
  }

  get speedKmh(): number {
    return Math.abs(this.state.forwardSpeed) * 3.6;
  }

  /** Fixed-step update. */
  step(dt: number, input: VehicleInput, grid: StaticColliderGrid): void {
    Object.assign(this.prev, this.state);
    stepVehicle(this.state, this.spec, input, dt);
    const ev = resolveVehicleStatic(this.state, this.spec, grid);
    this.lastCollision = ev;
    if (ev && ev.impulse > 2) this.damage = Math.min(1, this.damage + ev.impulse / 120);
  }

  /** Interpolate render transform between the previous and current physics state. */
  syncVisual(alpha: number): void {
    const a = Math.max(0, Math.min(1, alpha));
    const s = this.state;
    const p = this.prev;
    const x = p.x + (s.x - p.x) * a;
    const z = p.z + (s.z - p.z) * a;
    const heading = p.heading + wrapAngle(s.heading - p.heading) * a;
    this.object.position.set(x, 0, z);
    this.object.rotation.set(0, heading, 0);
    // Body roll from lateral speed and pitch from longitudinal acceleration (visual only).
    const roll = Math.max(-0.08, Math.min(0.08, s.lateralSpeed * 0.012));
    const accel = (s.forwardSpeed - p.forwardSpeed) * 60;
    const pitch = Math.max(-0.05, Math.min(0.05, -accel * 0.004));
    this.body.rotation.set(pitch, 0, roll);
    const spin = p.wheelSpin + (s.wheelSpin - p.wheelSpin) * a;
    for (const w of this.wheels) w.rotation.x = spin;
    const steer = p.steerAngle + (s.steerAngle - p.steerAngle) * a;
    for (const w of this.frontWheels) w.rotation.y = -steer;
  }

  setLights(on: boolean): void {
    this.headlights.emissiveIntensity = on ? 4 : 0;
    this.taillights.emissiveIntensity = on ? 2.5 : 0.2;
  }

  teleport(x: number, z: number, heading: number): void {
    Object.assign(this.state, createVehicleState(x, z, heading));
    Object.assign(this.prev, this.state);
    this.syncVisual(1);
  }

  dispose(registry: MaterialRegistry): void {
    this.object.removeFromParent();
    this.object.traverse((o) => {
      const mesh = o as Mesh;
      if (mesh.geometry) mesh.geometry.dispose();
    });
    for (const m of this.materials) {
      registry.unregister(m);
      m.dispose();
    }
  }
}
