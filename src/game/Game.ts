/**
 * Top-level game composition: world, entities, rendering, input and the simulation loop.
 */
import { Color, MathUtils, PerspectiveCamera, Scene, Vector3 } from 'three';
import { Engine } from '../core/Engine';
import { Input } from '../core/Input';
import { detectQualityPreset, getPreset, isPresetName, saveQuality, type QualityPresetName, type QualitySettings } from '../core/Quality';
import { CameraRig } from '../entities/CameraRig';
import { PlayerEntity } from '../entities/PlayerEntity';
import { VehicleEntity } from '../entities/VehicleEntity';
import { StaticColliderGrid, type OBB } from '../physics/Collision';
import { resolveVehicleVehicle } from '../physics/VehiclePhysics';
import { GameRenderer } from '../render/GameRenderer';
import { Lighting } from '../render/Lighting';
import { MaterialRegistry } from '../render/MaterialRegistry';
import { SkyDome } from '../render/SkyDome';
import { HUD } from '../ui/HUD';
import { buildCity, type CityView } from '../world/CityBuilder';
import { buildingAABBs, generateCity, lanePoint, type CityData, type CityParams } from '../world/CityGenerator';

export interface GameOptions {
  canvas: HTMLCanvasElement;
  hudContainer: HTMLElement;
  quality: QualitySettings | 'auto';
  city?: Partial<CityParams>;
  devicePixelRatio?: number;
  /** Initial time of day in hours (0..24). */
  timeOfDay?: number;
  storage?: Storage | null;
}

export type PlayerMode = 'foot' | 'vehicle';

/** Max distance (m) from the player to a car's centre to enter it. */
export const ENTER_VEHICLE_RADIUS = 5.5;

const CAR_COLOURS = [0xc0392b, 0x2980b9, 0xf1c40f, 0x2c3e50, 0xecf0f1, 0x27ae60, 0x8e44ad, 0xe67e22];

export class Game {
  readonly engine = new Engine({ fixedDelta: 1 / 60 });
  readonly input = new Input();
  readonly registry = new MaterialRegistry();
  readonly scene = new Scene();
  readonly camera: PerspectiveCamera;
  readonly gfx: GameRenderer;
  readonly lighting: Lighting;
  readonly sky: SkyDome;
  readonly city: CityData;
  readonly grid: StaticColliderGrid;
  readonly hud: HUD;
  readonly player: PlayerEntity;
  readonly vehicles: VehicleEntity[] = [];
  readonly cameraRig: CameraRig;
  cityView: CityView;
  quality: QualitySettings;
  mode: PlayerMode = 'foot';
  currentVehicle: VehicleEntity | null = null;
  paused = false;
  private timeOfDay = 14;
  private lastEnvTime = -1;
  private hudAccum = 0;
  private readonly focus = new Vector3();
  private readonly storage: Storage | null;
  private readonly dpr: number;
  private hint = '';

  constructor(private readonly opts: GameOptions) {
    this.storage = opts.storage ?? null;
    this.dpr = opts.devicePixelRatio ?? 1;
    const provisional = opts.quality === 'auto' ? getPreset('medium') : opts.quality;
    this.gfx = new GameRenderer(opts.canvas, provisional, this.dpr);
    this.quality = opts.quality === 'auto' ? getPreset(detectQualityPreset(this.gfx.deviceInfo)) : opts.quality;

    this.camera = new PerspectiveCamera(62, 16 / 9, 0.3, this.quality.farDistance + 800);
    this.scene.add(this.camera);
    this.sky = new SkyDome(this.gfx.renderer);
    this.scene.add(this.sky.sky);
    this.lighting = new Lighting(this.scene, this.camera, this.registry, this.quality);

    this.city = generateCity(opts.city);
    this.grid = new StaticColliderGrid(32);
    for (const box of buildingAABBs(this.city)) this.grid.insert(box);
    this.cityView = buildCity(this.city, this.quality, this.registry, this.gfx.maxAnisotropy);
    this.scene.add(this.cityView.root);

    this.hud = new HUD(opts.hudContainer);

    // Player starts on foot beside a parked car at the spawn point.
    const spawn = this.city.spawn;
    // right of a car facing +X is +Z (right = (-cos h, sin h)); stand 3 m to its side, slightly behind.
    this.player = new PlayerEntity(this.registry, spawn.x - 1.0, spawn.z + 3.2, spawn.heading);
    this.scene.add(this.player.object);
    this.spawnVehicles();

    this.cameraRig = new CameraRig(this.camera, this.grid);
    this.cameraRig.snapTo(this.cameraTarget());

    this.gfx.applyQuality(this.quality, this.scene, this.camera, this.dpr);
    this.setTimeOfDay(opts.timeOfDay ?? 14, true);
    this.engine.addSystem({ update: (dt) => this.update(dt), render: (alpha, fd) => this.render(alpha, fd) });
    this.updateHint();
  }

  private spawnVehicles(): void {
    const spawn = this.city.spawn;
    const first = new VehicleEntity(this.registry, { paint: CAR_COLOURS[0]! }, spawn.x, spawn.z, spawn.heading);
    this.addVehicle(first);
    // A few more parked cars along nearby roads so enter/exit and collisions are exercised.
    const edges = this.city.roads.edges;
    let placed = 0;
    for (let i = 0; i < edges.length && placed < 7; i += 7) {
      const e = edges[i]!;
      const lp = lanePoint(this.city, e, 0.35 + (placed % 3) * 0.2, placed % 2 === 0, placed % 2);
      if (Math.hypot(lp.x - spawn.x, lp.z - spawn.z) < 12) continue;
      const v = new VehicleEntity(this.registry, { paint: CAR_COLOURS[(placed + 1) % CAR_COLOURS.length]! }, lp.x, lp.z, lp.heading);
      this.addVehicle(v);
      placed++;
    }
  }

  addVehicle(v: VehicleEntity): void {
    this.vehicles.push(v);
    this.scene.add(v.object);
  }

  // --- quality ----------------------------------------------------------------
  setQualityPreset(name: QualityPresetName): void {
    this.applyQuality(getPreset(name));
  }

  applyQuality(q: QualitySettings): void {
    this.quality = q;
    this.camera.far = q.farDistance + 800;
    this.camera.updateProjectionMatrix();
    // World geometry depends on draw distance / prop density / texture sizes: rebuild it.
    this.scene.remove(this.cityView.root);
    this.cityView.dispose();
    this.cityView = buildCity(this.city, q, this.registry, this.gfx.maxAnisotropy);
    this.scene.add(this.cityView.root);
    this.lighting.rebuild(q);
    this.lighting.onCameraChanged();
    this.gfx.applyQuality(q, this.scene, this.camera, this.dpr);
    this.setTimeOfDay(this.timeOfDay, true);
    saveQuality(this.storage, q);
    this.hud.showToast(`Quality: ${q.preset}`);
    this.updateHint();
  }

  // --- time of day -----------------------------------------------------------
  get currentTimeOfDay(): number {
    return this.timeOfDay;
  }

  setTimeOfDay(hours: number, forceEnv = false): void {
    this.timeOfDay = ((hours % 24) + 24) % 24;
    const t = (this.timeOfDay - 6) / 12; // 0 at 06:00, 1 at 18:00
    const elevation = Math.sin(t * Math.PI) * 65;
    const azimuth = 90 + t * 180;
    this.sky.setSun(elevation, azimuth);
    const daylight = MathUtils.smoothstep(elevation, -6, 10);
    const night = 1 - daylight;
    if (elevation > -2) {
      this.lighting.sunDirection.copy(this.sky.sunDirection);
      this.lighting.setSun({ color: this.sky.sunColor(), intensity: Math.max(0.12, this.sky.sunIntensity()) });
    } else {
      // Moonlight: a faint cool light from the sun's antipode so night surfaces stay readable.
      const d = this.sky.sunDirection;
      this.lighting.sunDirection.set(-d.x, Math.max(0.35, -d.y), -d.z).normalize();
      this.lighting.setSun({ color: new Color(0x8fa6d8), intensity: 0.18 });
    }
    const horizon = this.sky.horizonColor();
    this.lighting.setFog(horizon, this.quality.drawDistance * 0.55, this.quality.farDistance);
    const hemiBase = this.quality.envReflections ? 0.35 : 0.85;
    this.lighting.setHemisphere(
      new Color(0x9fc4ff).lerp(new Color(0x2a3450), night),
      new Color(0x6b6b5a).lerp(new Color(0x14141a), night),
      Math.max(0.24, hemiBase * (0.35 + 0.65 * daylight)),
    );
    this.cityView.setNightFactor(night);
    for (const v of this.vehicles) v.setLights(night > 0.5);
    this.scene.environmentIntensity = 0.25 + 0.75 * daylight;
    if (this.quality.envReflections) {
      if (forceEnv || Math.abs(this.timeOfDay - this.lastEnvTime) > 0.25) {
        this.scene.environment = this.sky.updateEnvironment();
        this.lastEnvTime = this.timeOfDay;
      }
    } else {
      this.scene.environment = null;
    }
    this.scene.background = null; // the sky mesh provides the background
  }

  // --- simulation ---------------------------------------------------------------
  private update(dt: number): void {
    const inp = this.input.poll(dt);
    if (inp.pausePressed) this.paused = !this.paused;
    if (inp.qualityPressed) {
      const name = (['low', 'medium', 'high', 'ultra'] as const)[inp.qualityPressed - 1];
      if (name && isPresetName(name) && name !== this.quality.preset) this.setQualityPreset(name);
    }
    if (this.paused) return;
    if (inp.interactPressed) this.toggleVehicle();

    if (this.mode === 'vehicle' && this.currentVehicle) {
      const v = this.currentVehicle;
      v.step(dt, { throttle: inp.throttle, brake: inp.brake, steer: inp.steer, handbrake: inp.handbrake }, this.grid);
      for (const other of this.vehicles) {
        if (other === v) continue;
        if (Math.hypot(other.state.x - v.state.x, other.state.z - v.state.z) > 12) continue;
        Object.assign(other.prev, other.state);
        resolveVehicleVehicle(v.state, v.spec, other.state, other.spec);
      }
    } else {
      // Camera-relative movement: forward = (sin yaw, cos yaw), right = (-cos yaw, sin yaw).
      const yaw = this.cameraRig.yaw + this.cameraRig.orbitYaw;
      const fx = Math.sin(yaw), fz = Math.cos(yaw);
      const rx = -Math.cos(yaw), rz = Math.sin(yaw);
      const dirX = fx * inp.moveY + rx * inp.moveX;
      const dirZ = fz * inp.moveY + rz * inp.moveX;
      const obbs: OBB[] = [];
      for (const v of this.vehicles) {
        if (Math.hypot(v.state.x - this.player.state.x, v.state.z - this.player.state.z) < 8) obbs.push(v.obb);
      }
      this.player.step(dt, { dirX, dirZ, run: inp.sprint }, this.grid, obbs);
    }
    // Let parked vehicles settle (they are static unless bumped).
    for (const v of this.vehicles) {
      if (v === this.currentVehicle) continue;
      if (Math.hypot(v.state.vx, v.state.vz) > 0.01) v.step(dt, { throttle: 0, brake: 0.3, steer: 0, handbrake: true }, this.grid);
    }
  }

  private toggleVehicle(): void {
    if (this.mode === 'foot') {
      let best: VehicleEntity | null = null;
      let bestD = ENTER_VEHICLE_RADIUS;
      for (const v of this.vehicles) {
        const d = Math.hypot(v.state.x - this.player.state.x, v.state.z - this.player.state.z);
        if (d < bestD) {
          bestD = d;
          best = v;
        }
      }
      if (!best) return;
      this.currentVehicle = best;
      best.driven = true;
      this.mode = 'vehicle';
      this.player.object.visible = false;
      this.hud.showToast('Entered vehicle');
    } else if (this.currentVehicle) {
      const v = this.currentVehicle;
      // Exit on the left side of the car (right = (-cos h, sin h), so left = (cos h, -sin h)).
      const h = v.state.heading;
      const ex = v.state.x + Math.cos(h) * (v.spec.halfWidth + 0.9);
      const ez = v.state.z - Math.sin(h) * (v.spec.halfWidth + 0.9);
      this.player.teleport(ex, ez, h);
      this.player.object.visible = true;
      v.driven = false;
      this.currentVehicle = null;
      this.mode = 'foot';
      this.hud.showToast('Exited vehicle');
    }
    this.updateHint();
  }

  private updateHint(): void {
    this.hint =
      this.mode === 'vehicle'
        ? 'W/S throttle & brake · A/D steer · Space handbrake · E exit · C look back · 1-4 quality'
        : 'WASD move · Shift run · E enter car · mouse look (click) · 1-4 quality';
  }

  private cameraTarget(): { position: Vector3; heading: number; speed: number; mode: 'vehicle' | 'foot' } {
    if (this.mode === 'vehicle' && this.currentVehicle) {
      const v = this.currentVehicle;
      return { position: v.object.position, heading: v.state.heading, speed: Math.abs(v.state.forwardSpeed), mode: 'vehicle' };
    }
    return { position: this.player.object.position, heading: this.player.state.heading, speed: Math.hypot(this.player.state.vx, this.player.state.vz), mode: 'foot' };
  }

  // --- rendering ----------------------------------------------------------------
  private render(alpha: number, frameDelta: number): void {
    for (const v of this.vehicles) v.syncVisual(alpha);
    this.player.syncVisual(alpha);
    const target = this.cameraTarget();
    const s = this.input.state;
    this.cameraRig.update(target, frameDelta, s.lookDX, s.lookDY, s.lookBack);
    this.camera.updateMatrixWorld();
    this.focus.copy(target.position);
    this.lighting.update(this.focus);
    this.gfx.render(frameDelta);

    this.hudAccum += frameDelta;
    if (this.hudAccum > 0.25) {
      this.hudAccum = 0;
      this.refreshHud();
    }
  }

  refreshHud(): void {
    const st = this.gfx.stats();
    const avg = this.engine.stats.avgFrameDelta;
    this.hud.update({
      speedKmh: this.currentVehicle ? this.currentVehicle.speedKmh : Math.hypot(this.player.state.vx, this.player.state.vz) * 3.6,
      mode: this.mode,
      fps: avg > 0 ? 1 / avg : 0,
      frameMs: avg * 1000,
      quality: this.quality.preset,
      renderScale: st.renderScale,
      drawCalls: st.drawCalls,
      triangles: st.triangles,
      aa: this.gfx.pipeline?.info.aa ?? 'none',
      ao: this.gfx.pipeline?.info.ao ?? 'none',
      shadows: this.quality.shadows,
      timeOfDay: this.timeOfDay,
      hint: this.hint,
    });
  }

  resize(cssWidth: number, cssHeight: number): void {
    this.gfx.resize(cssWidth, cssHeight);
    this.lighting.onCameraChanged();
  }

  /** Run `n` fixed updates without rendering (deterministic headless stepping). */
  simulate(n: number): void {
    for (let i = 0; i < n; i++) this.update(this.engine.fixedDelta);
    this.engine.stats.updates += n;
    this.engine.stats.simTime += n * this.engine.fixedDelta;
  }

  /** Render exactly one frame with the current state. */
  renderFrame(frameDelta = 1 / 60): void {
    this.render(1, frameDelta);
    this.engine.stats.frame++;
  }

  start(): void {
    this.input.attach(window, this.opts.canvas);
    this.engine.start();
  }

  stop(): void {
    this.engine.stop();
    this.input.detach();
  }

  dispose(): void {
    this.stop();
    for (const v of this.vehicles) v.dispose(this.registry);
    this.player.dispose(this.registry);
    this.cityView.dispose();
    this.lighting.dispose();
    this.sky.dispose();
    this.hud.dispose();
    this.gfx.dispose();
  }
}
