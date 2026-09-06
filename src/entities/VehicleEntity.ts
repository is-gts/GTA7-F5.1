/**
 * A drivable car: procedural mesh + arcade physics + interpolated visuals.
 *
 * The mesh is built from a `VehicleType` (see `VehicleCatalog.ts`): the catalog's `VehicleSpec`
 * override drives the physics (mass, power, grip, footprint) and its `VehicleBodyProfile` drives the
 * box/cylinder proportions (panel heights, cabin position, an optional open bed, an optional roof
 * light bar), so different types actually look and drive differently.
 *
 * Damage (0..1, accumulated from collision impulses in `step()`) has four visible effects:
 *  - the front or rear bumper dents/compresses toward the impact side (from the contact normal);
 *  - the paint scuffs toward grey;
 *  - smoke rises from the hood above 0.6 damage (quality-gated: a cheap `Points` emitter, disabled
 *    entirely on `low`);
 *  - at 1.0 damage the engine is dead (`maxEngineForce` forced to 0) until the car is reset
 *    (`teleport`, used on respawn) or the player gets into a different, undamaged car.
 */
import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  Color,
  CylinderGeometry,
  Group,
  Mesh,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  Object3D,
  Points,
  PointsMaterial,
  Vector3,
} from 'three';
import type { QualitySettings } from '../core/Quality';
import type { MaterialRegistry } from '../render/MaterialRegistry';
import { VEHICLE_CATALOG, resolveVehicleSpec, type VehicleType } from './VehicleCatalog';
import {
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
  type: VehicleType;
  paint: number;
  /** Extra spec overrides applied after the catalog entry (tests / special cases). */
  spec?: Partial<VehicleSpec>;
}

let nextVehicleId = 1;

/** Number of points in the damage-smoke emitter (cheap: one draw call, no per-point shader). */
const SMOKE_COUNT = 6;
/** Paint colour damage scuffs toward. */
const SCUFF_COLOR = new Color(0x45454a);

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
function clamp01(v: number): number {
  return clamp(v, 0, 1);
}

export class VehicleEntity {
  readonly id = nextVehicleId++;
  readonly type: VehicleType;
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
  private readonly baseColor: Color;
  private readonly tmpColor = new Color();
  private readonly baseMaxEngineForce: number;

  // --- damage: dents -----------------------------------------------------------------------
  private readonly bumperF: Mesh;
  private readonly bumperR: Mesh;
  private readonly baseBumperFz: number;
  private readonly baseBumperRz: number;
  /** EMA of the (signed) contact side of recent impacts: + = front, - = rear. */
  private frontBias = 0;
  /** EMA of the (signed) lateral contact side: + = right, - = left. */
  private sideBias = 0;

  // --- damage: smoke -------------------------------------------------------------------------
  private smoke: Points | null = null;
  private smokeGeom: BufferGeometry | null = null;
  private smokeMat: PointsMaterial | null = null;
  private smokePhase: Float32Array | null = null;
  private smokeTime = 0;
  private readonly smokeOrigin: Vector3;

  // --- police light bar ----------------------------------------------------------------------
  private readonly hasLightbar: boolean;
  private lightbarRed: MeshStandardMaterial | null = null;
  private lightbarBlue: MeshStandardMaterial | null = null;
  private flashTime = 0;

  constructor(registry: MaterialRegistry, opts: VehicleVisualOptions, x = 0, z = 0, heading = 0) {
    this.type = opts.type;
    const def = VEHICLE_CATALOG[opts.type];
    this.spec = { ...resolveVehicleSpec(opts.type), ...opts.spec };
    this.baseMaxEngineForce = this.spec.maxEngineForce;
    this.state = createVehicleState(x, z, heading);
    this.prev = createVehicleState(x, z, heading);
    this.object.name = `vehicle:${this.id}`;

    const hw = this.spec.halfWidth;
    const hl = this.spec.halfLength;
    const wr = this.spec.wheelRadius;
    const b = def.body;

    this.baseColor = new Color(opts.paint);
    this.paint = registry.register(
      new MeshPhysicalMaterial({
        color: this.baseColor.clone(),
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

    const addPart = (mesh: Mesh): Mesh => {
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.body.add(mesh);
      return mesh;
    };

    // lower body
    const lower = new Mesh(new BoxGeometry(hw * 2, b.bodyHeight, hl * 2), this.paint);
    lower.position.y = ground + b.bodyHeight / 2;
    addPart(lower);

    // hood / trunk slab (skipped for a single tall boxy body, e.g. a van)
    let cabinBaseY = ground + b.bodyHeight;
    if (b.upperHeight > 0) {
      const upper = new Mesh(new BoxGeometry(Math.max(0.4, hw * 2 - b.hoodTaper), b.upperHeight, hl * 2 - 0.5), this.paint);
      upper.position.set(0, cabinBaseY + b.upperHeight / 2, -0.05);
      addPart(upper);
      cabinBaseY += b.upperHeight;
    }

    // cabin
    const cabin = new Mesh(new BoxGeometry(hw * 2 - 0.38, b.cabinHeight, b.cabinLength), glass);
    cabin.position.set(0, cabinBaseY + b.cabinHeight / 2, b.cabinOffsetZ);
    addPart(cabin);

    // roof (skipped when the cabin box's own top is the roof)
    let roofTopY = cabinBaseY + b.cabinHeight;
    if (b.roofHeight > 0) {
      const roof = new Mesh(new BoxGeometry(hw * 2 - 0.42, b.roofHeight, Math.max(0.3, b.cabinLength - 0.05)), this.paint);
      roof.position.set(0, roofTopY + b.roofHeight / 2, b.cabinOffsetZ);
      addPart(roof);
      roofTopY += b.roofHeight;
    }

    // bumpers and trim
    this.baseBumperFz = hl - 0.02;
    this.baseBumperRz = -hl + 0.02;
    this.bumperF = addPart(new Mesh(new BoxGeometry(hw * 2 + 0.04, 0.22, 0.18), trim));
    this.bumperF.position.set(0, ground + 0.2, this.baseBumperFz);
    this.bumperR = addPart(new Mesh(new BoxGeometry(hw * 2 + 0.04, 0.22, 0.18), trim));
    this.bumperR.position.set(0, ground + 0.2, this.baseBumperRz);
    const grille = new Mesh(new BoxGeometry(hw * 0.9, 0.18, 0.06), chrome);
    grille.position.set(0, ground + 0.5, hl + 0.01);
    addPart(grille);

    // open cargo bed (pickup only): a shallow open-top box behind the cabin
    if (b.bedLength > 0) {
      const bedZEnd = -hl + 0.1;
      const bedZStart = bedZEnd + b.bedLength;
      const bedCenterZ = (bedZStart + bedZEnd) / 2;
      const wallH = 0.32;
      const wallY = ground + b.bodyHeight + wallH / 2;
      const sideWallGeo = new BoxGeometry(0.08, wallH, b.bedLength);
      const leftWall = addPart(new Mesh(sideWallGeo, trim));
      leftWall.position.set(-(hw - 0.05), wallY, bedCenterZ);
      const rightWall = addPart(new Mesh(sideWallGeo, trim));
      rightWall.position.set(hw - 0.05, wallY, bedCenterZ);
      const endWallGeo = new BoxGeometry(hw * 2 - 0.1, wallH, 0.08);
      const backWall = addPart(new Mesh(endWallGeo, trim));
      backWall.position.set(0, wallY, bedZEnd - 0.04);
      const frontWall = addPart(new Mesh(endWallGeo, trim));
      frontWall.position.set(0, wallY, bedZStart + 0.04);
    }

    // roof light bar (police only): a trim base plus flashing red/blue emissive lamps
    this.hasLightbar = b.lightbar;
    if (b.lightbar) {
      const barWidth = hw * 1.1;
      const barBase = new Mesh(new BoxGeometry(barWidth, 0.1, 0.32), trim);
      barBase.position.set(0, roofTopY + 0.05, b.cabinOffsetZ);
      addPart(barBase);
      this.lightbarRed = registry.register(
        new MeshStandardMaterial({ color: 0x550000, emissive: new Color(0xff2020), emissiveIntensity: 0, roughness: 0.4 }),
      );
      this.lightbarBlue = registry.register(
        new MeshStandardMaterial({ color: 0x000844, emissive: new Color(0x2050ff), emissiveIntensity: 0, roughness: 0.4 }),
      );
      this.materials.push(this.lightbarRed, this.lightbarBlue);
      const redLamp = new Mesh(new BoxGeometry(barWidth * 0.46, 0.12, 0.3), this.lightbarRed);
      redLamp.position.set(-barWidth * 0.26, roofTopY + 0.16, b.cabinOffsetZ);
      addPart(redLamp);
      const blueLamp = new Mesh(new BoxGeometry(barWidth * 0.46, 0.12, 0.3), this.lightbarBlue);
      blueLamp.position.set(barWidth * 0.26, roofTopY + 0.16, b.cabinOffsetZ);
      addPart(blueLamp);
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

    // Smoke emitter origin: above the hood (or, on hood-less types, the front of the cabin roof).
    this.smokeOrigin = new Vector3(0, cabinBaseY + 0.12, Math.max(0, hl - b.cabinLength * 0.15));

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
    // At full damage the engine is dead; restored only by teleport() (respawn) or the player
    // switching to a different (undamaged) vehicle — this one just won't drive any more.
    this.spec.maxEngineForce = this.damage >= 1 ? 0 : this.baseMaxEngineForce;
    stepVehicle(this.state, this.spec, input, dt);
    const ev = resolveVehicleStatic(this.state, this.spec, grid);
    this.lastCollision = ev;
    if (ev && ev.impulse > 2) this.registerImpact(ev);
    this.updateEffects(dt);
  }

  /**
   * Advance cosmetic damage effects (paint scuff, dents, smoke, light bar flash) without stepping
   * physics — used for vehicles that are not being simulated this tick (e.g. a stationary parked
   * car) so their effects still animate. `step()` calls this itself, so callers never need both.
   */
  updateEffects(dt: number): void {
    this.spec.maxEngineForce = this.damage >= 1 ? 0 : this.baseMaxEngineForce;
    this.applyPaintDamage();
    this.applyDentVisuals();
    if (this.smoke) this.updateSmoke(dt);
    if (this.hasLightbar) this.updateLightbar(dt);
  }

  private registerImpact(ev: CollisionEvent): void {
    this.damage = Math.min(1, this.damage + ev.impulse / 120);
    const h = this.state.heading;
    const fx = Math.sin(h);
    const fz = Math.cos(h);
    const rx = -fz;
    const rz = fx;
    // `ev.nx/nz` point from the obstacle into the vehicle (the direction that separates them), so
    // the side that was actually hit is the opposite direction.
    const contactZ = -(ev.nx * fx + ev.nz * fz); // + = hit the front, - = hit the rear
    const contactX = -(ev.nx * rx + ev.nz * rz); // + = hit the right side, - = the left side
    const w = Math.min(1, ev.impulse / 20);
    this.frontBias += (contactZ - this.frontBias) * w;
    this.sideBias += (contactX - this.sideBias) * w;
  }

  private applyPaintDamage(): void {
    const t = Math.min(0.65, this.damage * 0.7);
    this.tmpColor.copy(this.baseColor).lerp(SCUFF_COLOR, t);
    this.paint.color.copy(this.tmpColor);
  }

  private applyDentVisuals(): void {
    const frontDent = this.damage * clamp01(this.frontBias);
    const rearDent = this.damage * clamp01(-this.frontBias);
    const shift = clamp(this.sideBias, -1, 1) * 0.12;
    this.bumperF.scale.z = 1 - 0.45 * frontDent;
    this.bumperF.position.z = this.baseBumperFz - 0.16 * frontDent;
    this.bumperF.position.x = shift * frontDent;
    this.bumperR.scale.z = 1 - 0.45 * rearDent;
    this.bumperR.position.z = this.baseBumperRz + 0.16 * rearDent;
    this.bumperR.position.x = shift * rearDent;
  }

  // --- damage smoke ----------------------------------------------------------------------------

  /** Enable/disable the smoke emitter for the current quality preset (none on low). */
  setQuality(q: QualitySettings): void {
    const allowed = q.damageSmoke;
    if (allowed === (this.smoke !== null)) return;
    if (allowed) this.createSmoke();
    else this.disposeSmoke();
  }

  private createSmoke(): void {
    if (this.smoke) return;
    const positions = new Float32Array(SMOKE_COUNT * 3);
    const phase = new Float32Array(SMOKE_COUNT);
    for (let i = 0; i < SMOKE_COUNT; i++) {
      phase[i] = (i / SMOKE_COUNT) * Math.PI * 2;
      positions[i * 3] = this.smokeOrigin.x;
      positions[i * 3 + 1] = this.smokeOrigin.y;
      positions[i * 3 + 2] = this.smokeOrigin.z;
    }
    const geom = new BufferGeometry();
    geom.setAttribute('position', new BufferAttribute(positions, 3));
    // Not registered with MaterialRegistry: an unlit Points material needs no CSM/shadow patching.
    const mat = new PointsMaterial({ color: 0x3c3c3c, size: 0.24, sizeAttenuation: true, transparent: true, opacity: 0, depthWrite: false });
    const pts = new Points(geom, mat);
    pts.frustumCulled = false;
    this.smokeGeom = geom;
    this.smokeMat = mat;
    this.smokePhase = phase;
    this.smoke = pts;
    this.object.add(pts);
  }

  private disposeSmoke(): void {
    if (!this.smoke) return;
    this.smoke.removeFromParent();
    this.smokeGeom?.dispose();
    this.smokeMat?.dispose();
    this.smoke = null;
    this.smokeGeom = null;
    this.smokeMat = null;
    this.smokePhase = null;
  }

  private updateSmoke(dt: number): void {
    const geom = this.smokeGeom;
    const mat = this.smokeMat;
    const phase = this.smokePhase;
    if (!geom || !mat || !phase) return;
    if (this.damage <= 0.6) {
      if (mat.opacity !== 0) mat.opacity = 0;
      return;
    }
    this.smokeTime += dt;
    const pos = geom.getAttribute('position') as BufferAttribute;
    const cycle = 1.5;
    for (let i = 0; i < SMOKE_COUNT; i++) {
      const ph = phase[i]!;
      const local = ((this.smokeTime + ph) % cycle) / cycle;
      const rise = local * 0.85;
      const sway = Math.sin(local * Math.PI * 2 + ph) * 0.1;
      pos.setXYZ(i, this.smokeOrigin.x + sway, this.smokeOrigin.y + rise, this.smokeOrigin.z + sway * 0.6);
    }
    pos.needsUpdate = true;
    const severity = Math.min(1, (this.damage - 0.6) / 0.4);
    mat.opacity = 0.18 + 0.32 * severity;
  }

  // --- police light bar --------------------------------------------------------------------------

  private updateLightbar(dt: number): void {
    this.flashTime += dt;
    const cycle = 0.5;
    const redOn = Math.floor(this.flashTime / cycle) % 2 === 0;
    if (this.lightbarRed) this.lightbarRed.emissiveIntensity = redOn ? 3.2 : 0.1;
    if (this.lightbarBlue) this.lightbarBlue.emissiveIntensity = redOn ? 0.1 : 3.2;
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
    // Reset damage on respawn: fresh paint, no dents, engine restored.
    this.damage = 0;
    this.frontBias = 0;
    this.sideBias = 0;
    this.smokeTime = 0;
    this.spec.maxEngineForce = this.baseMaxEngineForce;
    this.applyPaintDamage();
    this.applyDentVisuals();
    if (this.smokeMat) this.smokeMat.opacity = 0;
    this.syncVisual(1);
  }

  dispose(registry: MaterialRegistry): void {
    this.object.removeFromParent();
    this.disposeSmoke();
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
