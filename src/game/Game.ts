/**
 * Top-level game composition: world, entities, rendering, input and the simulation loop.
 */
import { Color, Object3D, PerspectiveCamera, Scene, SpotLight, Vector3 } from 'three';
import { obstacleFromVehicle, TrafficSystem, type TrafficObstacle } from '../ai/Traffic';
import { PedestrianSystem } from '../ai/Pedestrians';
import { PoliceSystem, RAM_STOP_GAP, type PoliceFocus } from '../ai/Police';
import { Engine } from '../core/Engine';
import { EventBus } from '../core/EventBus';
import { Input } from '../core/Input';
import {
  detectQualityPreset,
  getPreset,
  isPresetName,
  loadSavedGameplay,
  saveQuality,
  type GameplaySettings,
  type QualityPresetName,
  type QualitySettings,
} from '../core/Quality';
import { CameraRig } from '../entities/CameraRig';
import { PlayerEntity } from '../entities/PlayerEntity';
import { VehicleEntity } from '../entities/VehicleEntity';
import { pickVehiclePaint, pickVehicleType } from '../entities/VehicleCatalog';
import { DEFAULT_CHARACTER_SPEC } from '../physics/CharacterController';
import { StaticColliderGrid, type OBB } from '../physics/Collision';
import { resolveVehicleVehicle, type VehicleSpec, type VehicleState } from '../physics/VehiclePhysics';
import { GameRenderer } from '../render/GameRenderer';
import { Lighting } from '../render/Lighting';
import { LocalLights, type LampPoint } from '../render/LocalLights';
import { MaterialRegistry } from '../render/MaterialRegistry';
import { SkyDome } from '../render/SkyDome';
import { HUD } from '../ui/HUD';
import { Menu } from '../ui/Menu';
import { Minimap } from '../ui/Minimap';
import { TouchControls, isTouchDevice } from '../ui/TouchControls';
import { Random } from '../world/Random';
import { buildCity, type CityView } from '../world/CityBuilder';
import { buildingAABBs, generateCity, lampHeadPosition, lanePoint, type CityData, type CityParams } from '../world/CityGenerator';
import {
  angleBetweenDeg,
  daylightFactor,
  moonDirection,
  sunAngles,
  ENV_REGEN_THRESHOLD_DEG,
  TIME_UPDATE_MIN_GAME_HOURS,
  TimeOfDay,
  hoursDelta,
  type Vec3,
} from './TimeOfDay';
import { addWantedHeat, createWantedState, policeCountForLevel, stepWanted, POLICE_CONTACT_RANGE, type WantedState } from './Wanted';

export interface GameOptions {
  canvas: HTMLCanvasElement;
  hudContainer: HTMLElement;
  quality: QualitySettings | 'auto';
  city?: Partial<CityParams>;
  devicePixelRatio?: number;
  /** Initial time of day in hours (0..24). */
  timeOfDay?: number;
  /** Real seconds per in-game hour (default 90 — a full day every 36 real minutes). */
  secondsPerGameHour?: number;
  storage?: Storage | null;
  /** Show the on-screen touch overlay (left joystick, right buttons, gear button). Defaults to an
   *  actual touch-capability probe (`isTouchDevice()`) so it "just works" on phones/tablets. */
  touch?: boolean;
}

export type PlayerMode = 'foot' | 'vehicle';

/** Max distance (m) from the player to a car's centre to enter it. */
export const ENTER_VEHICLE_RADIUS = 5.5;

/** Radius (m) around a honking vehicle within which pedestrians are startled into fleeing. */
const HORN_RADIUS = 18;

/** Collision impulse (m/s of closing speed removed) above which a vehicle-vehicle hit counts as a
 *  reckless "crash" for the wanted system. */
const CRASH_IMPULSE_THRESHOLD = 4;

/**
 * Player headlight `SpotLight` intensity (candela, decay=1.4 — see the `new SpotLight(...)` call
 * below) — bright enough to visibly light the road a car-length or two ahead. At the ~3 m closest
 * usually-lit point on the road this contributes roughly HEADLIGHT_INTENSITY / 3^1.4 ≈ 39 to a
 * diffuse surface's shading (comparable to the sun's ~2.8), safely under the ~64 HDR guideline.
 * Only within ~2 m of the fixture itself (e.g. a pedestrian or wall the player noses directly
 * into) does it exceed that guideline, and only mildly (~68 at 2 m) — nowhere near the ~65504
 * half-float ceiling that would actually produce NaN, so this is a soft, accepted edge case rather
 * than a real overflow risk.
 */
const HEADLIGHT_INTENSITY = 180;

/** Player (or their car) must be slower than this and within `BUSTED_RANGE_GAP` (a body-to-body
 *  gap, not centre-to-centre — a cop parked nose-to-tail against the player is ~4.5 m of centre
 *  distance but 0 m of actual gap) of a police car for `BUSTED_HOLD_TIME` continuous seconds. */
const BUSTED_SPEED = 1;
const BUSTED_RANGE_GAP = RAM_STOP_GAP + 0.6;
/** Once the hold has started, it survives out to this gap (m): two cars resting against each other
 *  jostle by a few centimetres as the collision solver settles, and a hard reset on the first such
 *  wobble would mean the 3 s hold could never complete. */
const BUSTED_RELEASE_GAP = BUSTED_RANGE_GAP + 1.2;
const BUSTED_HOLD_TIME = 3;
/** How long the "BUSTED" overlay stays up before the player regains control. */
const BUSTED_OVERLAY_TIME = 2.5;

export interface GameEvents {
  /** A pedestrian was struck by a vehicle moving faster than the knockdown threshold. */
  pedestrianHit: { speed: number };
  /** The player's vehicle crashed into another (parked or AI-driven) car hard enough to matter. */
  vehicleCrash: { impulse: number };
  /** The player's vehicle rammed (or was rammed by) a pursuing police car. */
  policeContact: { impulse: number };
  /** The player leaned on the horn (H) while driving. */
  horn: { x: number; z: number; heading: number };
  [key: string]: unknown;
}

export class Game {
  readonly engine = new Engine({ fixedDelta: 1 / 60 });
  readonly input = new Input();
  readonly registry = new MaterialRegistry();
  /** Gameplay events (currently: `pedestrianHit`), for later systems (wanted level, HUD feedback). */
  readonly events = new EventBus<GameEvents>();
  readonly scene = new Scene();
  readonly camera: PerspectiveCamera;
  readonly gfx: GameRenderer;
  readonly lighting: Lighting;
  readonly sky: SkyDome;
  readonly city: CityData;
  readonly grid: StaticColliderGrid;
  readonly hud: HUD;
  readonly menu: Menu;
  readonly touch: TouchControls | null;
  /** Non-quality settings (FOV, mouse-Y invert, day speed, HUD perf overlay) — see `Quality.ts`. */
  gameplay: GameplaySettings;
  readonly player: PlayerEntity;
  readonly vehicles: VehicleEntity[] = [];
  /**
   * Persistent, index-aligned {state,spec} view of `vehicles` for the traffic AI (follow/yield
   * obstacles + physical resolution) — includes the driven car when in a vehicle. Built once
   * (vehicles never change after construction) so `update()` needs no per-tick allocation here.
   */
  private readonly trafficVehicles: { state: VehicleState; spec: VehicleSpec }[] = [];
  /**
   * `trafficVehicles` plus the currently active police cars, rebuilt (references only, no new
   * per-car objects) each tick — so traffic yields to/pushes pursuing police the same way it does
   * every other vehicle, instead of driving straight through them.
   */
  private readonly trafficVehiclesAndPolice: { state: VehicleState; spec: VehicleSpec }[] = [];
  readonly traffic: TrafficSystem;
  readonly pedestrians: PedestrianSystem;
  readonly police: PoliceSystem;
  readonly minimap: Minimap;
  /** Deterministic day/night clock (see `TimeOfDay.ts`); advanced once per fixed `update()` tick. */
  readonly clock: TimeOfDay;
  /** Pooled real-time street lamps that track the player/vehicle (see `render/LocalLights.ts`). */
  readonly localLights: LocalLights;
  /** World-space lamp-head positions, computed once from the (static) city data. */
  private readonly lampHeads: LampPoint[];
  /** Player car headlights: two `SpotLight`s reparented onto whichever vehicle is currently driven
   *  (medium+ only — `quality.maxLocalLights > 0`), on at night. AI traffic/police/parked cars keep
   *  their existing emissive-only headlight glow (no real light). */
  private readonly headlightL = new SpotLight(0xfff6df, HEADLIGHT_INTENSITY, 26, Math.PI / 8.5, 0.4, 1.4);
  private readonly headlightR = new SpotLight(0xfff6df, HEADLIGHT_INTENSITY, 26, Math.PI / 8.5, 0.4, 1.4);
  private readonly headlightTargetL = new Object3D();
  private readonly headlightTargetR = new Object3D();
  private headlightVehicle: VehicleEntity | null = null;
  wanted: WantedState = createWantedState();
  /** Whether at least one police car currently exists and is chasing the player. */
  policePursuing = false;
  /** True while the "BUSTED" overlay is showing (just after being caught by police). */
  busted = false;
  private bustedContactTimer = 0;
  private bustedOverlayTimer = 0;
  /**
   * Persistent, index-aligned `TrafficObstacle` view of `vehicles` for the pedestrian AI (danger /
   * knockdown checks) — refreshed in place each tick, built once since `vehicles` doesn't change.
   */
  private readonly pedestrianVehicleView: TrafficObstacle[] = [];
  /**
   * Persistent, index-aligned `TrafficObstacle` view of the active police cars (so pursuing cops
   * can also knock pedestrians down / be yielded to, not just parked/traffic vehicles) — resized and
   * refreshed in place each tick.
   */
  private readonly policeObstacleView: TrafficObstacle[] = [];
  /** Combined (vehicles + police + traffic agents) obstacle scratch buffer, rebuilt in place each tick. */
  private readonly pedestrianObstacles: TrafficObstacle[] = [];
  /**
   * What the police road-following controller follows/yields to: every vehicle plus the traffic
   * agents (but not the police cars themselves — `PoliceSystem` adds those per car, minus self).
   * Rebuilt in place each tick from the same persistent views.
   */
  private readonly policeObstacles: TrafficObstacle[] = [];
  /** Persistent pursuit target + bound callbacks (no per-tick allocation in the police hot path). */
  private readonly policeFocus: PoliceFocus = { x: 0, z: 0, heading: 0, vx: 0, vz: 0, halfLength: 0 };
  private readonly onPoliceRam = (impulse: number): void => this.events.emit('policeContact', { impulse });
  private readonly onTrafficImpact = (impulse: number, vehicleIndex: number): void => {
    if (impulse > CRASH_IMPULSE_THRESHOLD && this.vehicles[vehicleIndex] === this.currentVehicle) {
      this.events.emit('vehicleCrash', { impulse });
    }
  };
  /** Reused police-dot buffer for the minimap (redrawn at 10 Hz, but still no need to allocate). */
  private readonly policeDots: { x: number; z: number }[] = [];
  readonly cameraRig: CameraRig;
  cityView: CityView;
  quality: QualitySettings;
  mode: PlayerMode = 'foot';
  currentVehicle: VehicleEntity | null = null;
  paused = false;
  /** Sun direction (unit vector) at the time of the last PMREM environment regeneration. */
  private lastEnvDir: Vec3 = { x: 0, y: 1, z: 0 };
  /** Number of PMREM environment regenerations since construction (diagnostics / e2e). */
  envRegens = 0;
  /** `clock.hours` as of the last time lighting was actually recomputed (throttle bookkeeping). */
  private lastAppliedHours = 0;
  /** Current night factor (0 = full day, 1 = full night), refreshed by `applyTimeOfDay`. */
  private nightFactor = 0;
  // Start at the refresh threshold so the very first rendered frame fills the HUD in (speed, stars,
  // perf line) instead of showing the constructor's placeholders for the first quarter second.
  private hudAccum = 1;
  private readonly focus = new Vector3();
  private readonly storage: Storage | null;
  private readonly dpr: number;
  private hint = '';
  /** Day speed as loaded from storage while a `?dayspeed=` URL override is shadowing it in
   *  `gameplay`; `null` once there is no override (or the player has changed the slider). */
  private storedDaySpeed: number | null = null;
  /** Deterministic RNG for vehicle-type/paint choices, seeded from the city seed. */
  private readonly vehicleRng: Random;

  constructor(private readonly opts: GameOptions) {
    this.storage = opts.storage ?? null;
    this.dpr = opts.devicePixelRatio ?? 1;
    this.gameplay = loadSavedGameplay(this.storage);
    // A `?dayspeed=` URL override takes effect on the clock below; mirror it into `gameplay` too so
    // the menu's "Day length" slider reflects the clock actually running, rather than the
    // saved/default value the URL just overrode. It is a session-only override though (same as
    // `?quality=`), so remember what was stored: every later `saveQuality` writes that back
    // instead, and the URL value — which may be far outside the slider's 10..300 s range — never
    // reaches storage to be silently clamped into a different day length on the next load.
    if (opts.secondsPerGameHour !== undefined) {
      this.storedDaySpeed = this.gameplay.daySpeed;
      this.gameplay = { ...this.gameplay, daySpeed: opts.secondsPerGameHour };
    }
    const provisional = opts.quality === 'auto' ? getPreset('medium') : opts.quality;
    this.gfx = new GameRenderer(opts.canvas, provisional, this.dpr);
    this.quality = opts.quality === 'auto' ? getPreset(detectQualityPreset(this.gfx.deviceInfo)) : opts.quality;

    this.camera = new PerspectiveCamera(this.gameplay.fov, 16 / 9, 0.3, this.quality.farDistance + 800);
    this.scene.add(this.camera);
    this.sky = new SkyDome(this.gfx.renderer);
    this.scene.add(this.sky.sky);
    this.scene.add(this.sky.stars);
    this.lighting = new Lighting(this.scene, this.camera, this.registry, this.quality);
    this.localLights = new LocalLights(this.scene, this.quality);
    this.clock = new TimeOfDay(opts.timeOfDay ?? 14, opts.secondsPerGameHour ?? this.gameplay.daySpeed);
    this.lastAppliedHours = this.clock.hours;
    this.headlightL.target = this.headlightTargetL;
    this.headlightR.target = this.headlightTargetR;
    this.headlightL.castShadow = false;
    this.headlightR.castShadow = false;
    this.headlightL.intensity = 0;
    this.headlightR.intensity = 0;
    // Permanently visible, permanently in the scene graph (reparented onto the driven vehicle in
    // `syncHeadlights` and back here otherwise); on/off is driven purely by `intensity`. See the
    // matching note on `LocalLights.update` — toggling `visible` on a light changes the compiled
    // shader-program count for every lit material the first time a new count is seen.
    this.headlightL.visible = true;
    this.headlightR.visible = true;
    this.scene.add(this.headlightL, this.headlightR, this.headlightTargetL, this.headlightTargetR);

    this.city = generateCity(opts.city);
    this.lampHeads = this.city.lamps.map((l) => lampHeadPosition(l));
    this.vehicleRng = new Random(this.city.params.seed ^ 0x5eed1);
    this.grid = new StaticColliderGrid(32);
    for (const box of buildingAABBs(this.city)) this.grid.insert(box);
    this.cityView = buildCity(this.city, this.quality, this.registry, this.gfx.maxAnisotropy);
    this.scene.add(this.cityView.root);

    this.hud = new HUD(opts.hudContainer);
    this.hud.setPerfOverlayVisible(this.gameplay.hudPerfOverlay);

    // Player starts on foot beside a parked car at the spawn point.
    const spawn = this.city.spawn;
    // right of a car facing +X is +Z (right = (-cos h, sin h)); stand 3 m to its side, slightly behind.
    this.player = new PlayerEntity(this.registry, spawn.x - 1.0, spawn.z + 3.2, spawn.heading);
    this.scene.add(this.player.object);
    this.spawnVehicles();
    this.traffic = new TrafficSystem(this.city, this.registry, this.quality, this.city.params.seed, this.trafficFocus());
    this.scene.add(this.traffic.object);
    this.pedestrians = new PedestrianSystem(this.city, this.registry, this.quality, this.city.params.seed, this.trafficFocus());
    this.scene.add(this.pedestrians.object);
    // Horn: nearby pedestrians flee, whether or not a vehicle is actually closing on them.
    this.events.on('horn', ({ x, z }) => this.pedestrians.startle(x, z, HORN_RADIUS));

    this.police = new PoliceSystem(this.registry, this.city.params.seed);
    this.minimap = new Minimap(opts.hudContainer, this.city);
    // Wanted heat: every event kind just feeds the same pure state machine (see Wanted.ts).
    this.events.on('pedestrianHit', () => (this.wanted = addWantedHeat(this.wanted, 'pedestrianHit')));
    this.events.on('vehicleCrash', () => (this.wanted = addWantedHeat(this.wanted, 'vehicleCrash')));
    this.events.on('policeContact', () => (this.wanted = addWantedHeat(this.wanted, 'policeContact')));

    this.cameraRig = new CameraRig(this.camera, this.grid);
    this.cameraRig.baseFov = this.gameplay.fov;
    this.cameraRig.snapTo(this.cameraTarget());

    this.menu = new Menu(opts.hudContainer, {
      getQuality: () => this.quality,
      getGameplay: () => this.gameplay,
      getTimeOfDay: () => this.clock.hours,
      onOpenChange: (open) => {
        this.paused = open;
        if (open) {
          // Any key held at the moment the menu opens would otherwise still read as held on
          // resume (its keyup lands on a menu control, or never arrives at all).
          this.input.clearKeys();
          this.input.releasePointerLock();
        }
      },
      onPreset: (name) => this.setQualityPreset(name),
      onQualityChange: (patch) => this.applyQuality({ ...this.quality, ...patch }),
      onGameplayChange: (patch) => this.applyGameplaySettings({ ...this.gameplay, ...patch }),
      onTimeOfDay: (hours) => this.setTimeOfDay(hours),
      onRestart: () => this.respawn(),
      getStats: () => ({ frame: this.engine.stats.frame, drawCalls: this.gfx.stats().drawCalls }),
    });
    const showTouch = opts.touch ?? isTouchDevice();
    this.touch = showTouch ? new TouchControls(opts.canvas, opts.hudContainer, this.input, () => this.menu.open()) : null;

    this.gfx.applyQuality(this.quality, this.scene, this.camera, this.dpr);
    this.applyTimeOfDay(true);
    this.engine.addSystem({ update: (dt) => this.update(dt), render: (alpha, fd) => this.render(alpha, fd) });
    this.updateHint();
  }

  private spawnVehicles(): void {
    const spawn = this.city.spawn;
    const firstType = pickVehicleType(this.vehicleRng);
    const first = new VehicleEntity(this.registry, { type: firstType, paint: pickVehiclePaint(this.vehicleRng, firstType) }, spawn.x, spawn.z, spawn.heading);
    this.addVehicle(first);
    // A few more parked cars, of random catalog types, along nearby roads so enter/exit and
    // collisions are exercised and the different vehicle types are visible near the spawn point.
    const edges = this.city.roads.edges;
    let placed = 0;
    for (let i = 0; i < edges.length && placed < 7; i += 7) {
      const e = edges[i]!;
      const lp = lanePoint(this.city, e, 0.35 + (placed % 3) * 0.2, placed % 2 === 0, placed % 2);
      if (Math.hypot(lp.x - spawn.x, lp.z - spawn.z) < 12) continue;
      const type = pickVehicleType(this.vehicleRng);
      const v = new VehicleEntity(this.registry, { type, paint: pickVehiclePaint(this.vehicleRng, type) }, lp.x, lp.z, lp.heading);
      this.addVehicle(v);
      placed++;
    }
  }

  addVehicle(v: VehicleEntity): void {
    this.vehicles.push(v);
    this.trafficVehicles.push({ state: v.state, spec: v.spec });
    v.setQuality(this.quality);
    this.scene.add(v.object);
  }

  // --- quality ----------------------------------------------------------------
  setQualityPreset(name: QualityPresetName): void {
    this.applyQuality(getPreset(name));
  }

  applyQuality(q: QualitySettings): void {
    this.quality = q;
    for (const v of this.vehicles) v.setQuality(q);
    this.police.setQuality(q);
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
    this.localLights.setQuality(q);
    this.traffic.rebuild(q, this.trafficFocus());
    this.pedestrians.rebuild(q, this.trafficFocus());
    this.applyTimeOfDay(true);
    this.syncHeadlights();
    saveQuality(this.storage, q, this.gameplayForStorage());
    this.hud.showToast(`Quality: ${q.preset}`);
    this.updateHint();
  }

  // --- gameplay settings -------------------------------------------------------
  /** Apply and persist gameplay settings (FOV, mouse-Y invert, day speed, HUD perf overlay) — the
   *  "Gameplay" section of the settings menu. Cheap (no GPU rebuild), unlike `applyQuality`. */
  applyGameplaySettings(g: GameplaySettings): void {
    // The player moving the "Day length" slider takes ownership of it back from `?dayspeed=`.
    if (this.storedDaySpeed !== null && g.daySpeed !== this.gameplay.daySpeed) this.storedDaySpeed = null;
    this.gameplay = g;
    this.cameraRig.baseFov = g.fov;
    // Defense in depth against a non-positive daySpeed reaching the clock (e.g. via
    // `__gta7.menu.set('daySpeed', 0)`, which bypasses the slider's min) — TimeOfDay divides by
    // this every `advance()`, and 0 (or negative) turns `hours` into NaN within a frame.
    this.clock.secondsPerGameHour = Math.max(0.01, g.daySpeed);
    this.hud.setPerfOverlayVisible(g.hudPerfOverlay);
    saveQuality(this.storage, this.quality, this.gameplayForStorage());
  }

  /** The gameplay settings as they should be *persisted*: identical to `this.gameplay` except that
   *  a session-only `?dayspeed=` override is swapped back for the stored value it shadowed. */
  private gameplayForStorage(): GameplaySettings {
    return this.storedDaySpeed !== null ? { ...this.gameplay, daySpeed: this.storedDaySpeed } : this.gameplay;
  }

  /** Reset the player to the city spawn on foot, exit any vehicle, clear the wanted level and
   *  despawn police — the settings menu's "Restart game" button. Does not touch quality/gameplay
   *  settings or regenerate the city. */
  respawn(): void {
    this.busted = false;
    this.bustedOverlayTimer = 0;
    this.resetToSpawn();
    this.hud.showToast('Restarted');
  }

  // --- time of day -----------------------------------------------------------
  get currentTimeOfDay(): number {
    return this.clock.hours;
  }

  /** Jump the clock directly to `hours` (used by the debug API / `?tod=`) and recompute lighting. */
  setTimeOfDay(hours: number, forceEnv = false): void {
    this.clock.set(hours);
    this.lastAppliedHours = this.clock.hours;
    this.applyTimeOfDay(forceEnv);
  }

  /**
   * Recompute sun/moon direction, fog, hemisphere, night materials, vehicle-light toggles and (at
   * most every `ENV_REGEN_THRESHOLD_DEG` of sun movement) the PMREM environment, from `clock.hours`.
   * Called from `update()` at most every `TIME_UPDATE_MIN_GAME_HOURS` of game time — everything here
   * changes slowly enough (over game-minutes) that per-frame recomputation would be pure waste.
   */
  private applyTimeOfDay(forceEnv: boolean): void {
    const hours = this.clock.hours;
    const angles = sunAngles(hours);
    this.sky.setSun(angles.elevationDeg, angles.azimuthDeg);
    const daylight = daylightFactor(hours);
    const night = 1 - daylight;
    this.nightFactor = night;
    if (angles.elevationDeg > -2) {
      this.lighting.sunDirection.copy(this.sky.sunDirection);
      this.lighting.setSun({ color: this.sky.sunColor(), intensity: Math.max(0.12, this.sky.sunIntensity()) });
    } else {
      // Moonlight: a faint cool light from the sun's antipode so night surfaces stay readable.
      const m = moonDirection(hours);
      this.lighting.sunDirection.set(m.x, m.y, m.z);
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
    this.traffic.setLights(night > 0.5);
    this.police.setLights(night > 0.5);
    this.scene.environmentIntensity = 0.25 + 0.75 * daylight;
    if (this.quality.envReflections) {
      const sunDir = this.sky.sunDirection;
      const angleMoved = angleBetweenDeg(this.lastEnvDir, { x: sunDir.x, y: sunDir.y, z: sunDir.z });
      if (forceEnv || angleMoved > ENV_REGEN_THRESHOLD_DEG) {
        this.scene.environment = this.sky.updateEnvironment();
        this.lastEnvDir = { x: sunDir.x, y: sunDir.y, z: sunDir.z };
        this.envRegens++;
      }
    } else {
      this.scene.environment = null;
    }
    this.scene.background = null; // the sky mesh provides the background
    // "Night vision" exposure lift and the headlight on/off toggle both key off `night`, which just
    // changed — no need to wait for the next per-frame update.
    this.gfx.setNightExposureBoost(night);
    this.syncHeadlights();
  }

  /** Advance the clock, applying lighting at most every `TIME_UPDATE_MIN_GAME_HOURS` of game time. */
  private updateClock(dt: number): void {
    this.clock.advance(dt);
    if (Math.abs(hoursDelta(this.lastAppliedHours, this.clock.hours)) >= TIME_UPDATE_MIN_GAME_HOURS) {
      this.lastAppliedHours = this.clock.hours;
      this.applyTimeOfDay(false);
    }
  }

  /**
   * Reparent the two headlight `SpotLight`s onto whichever vehicle is currently driven (or back
   * onto the scene root when not driving) and set their on/off state — driven by both the quality
   * gate (`maxLocalLights > 0`) and the current night factor. Cheap and idempotent, so it's called
   * from every place that can change either input (enter/exit vehicle, quality switch, time of day)
   * instead of needing its own per-frame poll.
   *
   * The lights stay `visible = true` and attached *somewhere* in the scene graph at all times —
   * only `intensity` ever turns them off — for the same shader-program-stability reason as
   * `LocalLights.update`: reparenting between the vehicle body and the scene root doesn't change
   * how many visible spot lights three.js sees, but toggling `visible` would.
   */
  private syncHeadlights(): void {
    const shouldExist = this.mode === 'vehicle' && this.currentVehicle !== null && this.quality.maxLocalLights > 0;
    if (shouldExist && this.headlightVehicle !== this.currentVehicle) {
      const v = this.currentVehicle!;
      const y = v.spec.wheelRadius + 0.56;
      const side = v.spec.halfWidth - 0.3;
      this.headlightL.position.set(-side, y, v.spec.halfLength + 0.05);
      this.headlightR.position.set(side, y, v.spec.halfLength + 0.05);
      this.headlightTargetL.position.set(-side * 0.4, y - 0.5, v.spec.halfLength + 20);
      this.headlightTargetR.position.set(side * 0.4, y - 0.5, v.spec.halfLength + 20);
      v.body.add(this.headlightL, this.headlightTargetL, this.headlightR, this.headlightTargetR);
      this.headlightVehicle = v;
    } else if (!shouldExist && this.headlightVehicle !== null) {
      // Back onto the scene root (never fully removed) — position is irrelevant once intensity
      // drops to 0 below.
      this.scene.add(this.headlightL, this.headlightTargetL, this.headlightR, this.headlightTargetR);
      this.headlightVehicle = null;
    }
    const on = shouldExist && this.nightFactor > 0.5;
    const intensity = on ? HEADLIGHT_INTENSITY : 0;
    this.headlightL.intensity = intensity;
    this.headlightR.intensity = intensity;
  }

  // --- simulation ---------------------------------------------------------------
  private update(dt: number): void {
    const inp = this.input.poll(dt);
    if (inp.pausePressed) this.menu.toggle();
    // Quality hotkeys are gameplay keys too: applying a preset behind the open menu would leave
    // its preset buttons/knobs showing stale values. (Input.ts already stops the 1-4 codes from
    // reaching here while a control *inside the open menu* has focus, but they still arrive when
    // nothing in the menu has focus — e.g. right after opening it with Escape.)
    if (inp.qualityPressed && !this.paused) {
      const name = (['low', 'medium', 'high', 'ultra'] as const)[inp.qualityPressed - 1];
      if (name && isPresetName(name) && name !== this.quality.preset) this.setQualityPreset(name);
    }
    if (this.paused) return;
    this.updateClock(dt);

    // While the "BUSTED" overlay is up, the player (on foot or in a car) is frozen — no movement
    // input is processed — so the fade genuinely reads as "caught", not "still driving with a red
    // overlay on screen". The world around them (traffic, pedestrians, parked-vehicle settling, and
    // `updatePolice` itself, which ticks the overlay countdown) keeps going.
    if (!this.busted) {
      if (inp.interactPressed) this.toggleVehicle();

      if (this.mode === 'vehicle' && this.currentVehicle) {
        const v = this.currentVehicle;
        if (inp.hornPressed) this.events.emit('horn', { x: v.state.x, z: v.state.z, heading: v.state.heading });
        v.step(dt, { throttle: inp.throttle, brake: inp.brake, steer: inp.steer, handbrake: inp.handbrake }, this.grid);
        for (const other of this.vehicles) {
          if (other === v) continue;
          if (Math.hypot(other.state.x - v.state.x, other.state.z - v.state.z) > 12) continue;
          Object.assign(other.prev, other.state);
          const impact = resolveVehicleVehicle(v.state, v.spec, other.state, other.spec);
          if (impact && impact.impulse > CRASH_IMPULSE_THRESHOLD) this.events.emit('vehicleCrash', { impulse: impact.impulse });
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
        for (const c of this.police.cars) {
          if (Math.hypot(c.state.x - this.player.state.x, c.state.z - this.player.state.z) < 8) obbs.push(c.obb);
        }
        this.player.step(dt, { dirX, dirZ, run: inp.sprint }, this.grid, obbs);
      }
    }
    // Let parked vehicles settle (they are static unless bumped). Sync `prev` unconditionally
    // (even when not stepped) so a later traffic-AI collision push this same tick still
    // interpolates smoothly from "start of frame" instead of popping (v.step() already does this
    // for itself when it runs; this covers the vehicles it skips).
    for (const v of this.vehicles) {
      if (v === this.currentVehicle) continue;
      Object.assign(v.prev, v.state);
      if (Math.hypot(v.state.vx, v.state.vz) > 0.01) v.step(dt, { throttle: 0, brake: 0.3, steer: 0, handbrake: true }, this.grid);
      // Not physically stepped (fully at rest): still advance its cosmetic damage effects (paint
      // scuff, dents, smoke, a police light bar) so they animate even while parked.
      else v.updateEffects(dt);
    }
    // Every vehicle (parked, the driven one if any, and pursuing police) is a follow/yield obstacle
    // and a physical collision partner for the traffic AI — so traffic actually avoids/gets pushed
    // by a police car instead of driving straight through it. A hard hit on the player's own car
    // (whichever index that is in `trafficVehicles`, always at the front of the combined array) still
    // counts as a reckless crash for the wanted system; a hit on a police car does not.
    this.trafficVehiclesAndPolice.length = this.trafficVehicles.length + this.police.cars.length;
    let tvi = 0;
    for (const v of this.trafficVehicles) this.trafficVehiclesAndPolice[tvi++] = v;
    for (const c of this.police.cars) this.trafficVehiclesAndPolice[tvi++] = c;
    this.traffic.update(dt, this.trafficFocus(), this.grid, this.trafficVehiclesAndPolice, this.onTrafficImpact);
    this.pedestrians.update(dt, this.trafficFocus(), this.grid, this.refreshPedestrianObstacles(), (speed) => this.events.emit('pedestrianHit', { speed }));
    this.updatePolice(dt);
  }

  /** Wanted decay/level, police spawn/despawn + pursuit, and the busted state machine. */
  private updatePolice(dt: number): void {
    const focus = this.trafficFocus();
    // Spawn/despawn for the *current* level (any event this tick already bumped `this.wanted` via
    // the listeners above) before checking contact, so a freshly-raised wanted level gets its
    // police car in the same tick — otherwise the very first decay step (there being no police car
    // yet to be "in contact") could erase the heat before one ever gets the chance to spawn.
    const desired = policeCountForLevel(this.wanted.level, this.quality.maxPolice);
    this.police.sync(desired, this.city, focus, this.scene);
    const nearestPolice = this.police.nearestDistance(focus.x, focus.z);
    // The response is still being dispatched (the pool spawns one car per tick) — hold the
    // "they lose you" clock at zero until it is complete, so a level can never time out before the
    // cars it called for have even appeared.
    const deploying = this.police.count < desired;
    this.wanted = stepWanted(this.wanted, dt, deploying || nearestPolice <= POLICE_CONTACT_RANGE);

    const targetVel = this.mode === 'vehicle' && this.currentVehicle ? this.currentVehicle.state : this.player.state;
    const playerVehicle = this.mode === 'vehicle' && this.currentVehicle ? this.currentVehicle : null;
    const playerHalfLength = this.mode === 'vehicle' && this.currentVehicle ? this.currentVehicle.spec.halfLength : DEFAULT_CHARACTER_SPEC.radius;
    const pf = this.policeFocus;
    pf.x = focus.x;
    pf.z = focus.z;
    pf.heading = focus.heading;
    pf.vx = targetVel.vx;
    pf.vz = targetVel.vz;
    pf.halfLength = playerHalfLength;
    this.policePursuing = this.police.update(
      dt,
      pf,
      this.city,
      this.grid,
      this.trafficVehicles,
      playerVehicle,
      this.refreshPoliceObstacles(),
      this.onPoliceRam,
    );

    if (this.busted) {
      this.bustedOverlayTimer -= dt;
      if (this.bustedOverlayTimer <= 0) this.busted = false;
      return;
    }
    const speed = Math.hypot(targetVel.vx, targetVel.vz);
    const nearestPoliceGap = this.police.nearestGap(focus.x, focus.z, playerHalfLength);
    const holding = this.bustedContactTimer > 0;
    const gapLimit = holding ? BUSTED_RELEASE_GAP : BUSTED_RANGE_GAP;
    if (this.wanted.level >= 1 && speed < BUSTED_SPEED && nearestPoliceGap < gapLimit) {
      this.bustedContactTimer += dt;
      if (this.bustedContactTimer >= BUSTED_HOLD_TIME) this.triggerBusted();
    } else {
      this.bustedContactTimer = 0;
    }
  }

  /**
   * Refresh the persistent, index-aligned `TrafficObstacle` view of `vehicles` (parked cars and the
   * player's own) in place — built once, since `vehicles` never changes after construction. Marked
   * `parked`, so an AI car that finds one blocking its lane drives around it instead of queueing
   * behind it for ever.
   */
  private refreshVehicleView(): void {
    if (this.pedestrianVehicleView.length !== this.vehicles.length) {
      this.pedestrianVehicleView.length = 0;
      for (const v of this.vehicles) this.pedestrianVehicleView.push(obstacleFromVehicle(v.state, v.spec, true));
      return;
    }
    for (let i = 0; i < this.vehicles.length; i++) {
      const v = this.vehicles[i]!;
      const ob = this.pedestrianVehicleView[i]!;
      ob.x = v.state.x;
      ob.z = v.state.z;
      ob.heading = v.state.heading;
      ob.forwardSpeed = v.state.forwardSpeed;
    }
  }

  /**
   * The obstacle view the police road-following controller uses: every vehicle plus the traffic
   * agents. Police cars are deliberately excluded — `PoliceSystem` appends the other police cars per
   * car so none of them sees itself as an obstacle.
   */
  private refreshPoliceObstacles(): readonly TrafficObstacle[] {
    this.refreshVehicleView();
    const trafficObstacles = this.traffic.obstacles;
    this.policeObstacles.length = this.pedestrianVehicleView.length + trafficObstacles.length;
    let n = 0;
    for (const ob of this.pedestrianVehicleView) this.policeObstacles[n++] = ob;
    for (const ob of trafficObstacles) this.policeObstacles[n++] = ob;
    return this.policeObstacles;
  }

  /** Caught by police: freeze the chase, respawn on foot at the city spawn, reset the wanted level. */
  private triggerBusted(): void {
    this.busted = true;
    this.bustedOverlayTimer = BUSTED_OVERLAY_TIME;
    this.resetToSpawn();
  }

  /** Exit any vehicle, teleport the player back to the city spawn on foot, and clear the wanted
   *  level + despawn police. Shared by `triggerBusted` (caught by police) and `respawn` (the
   *  settings menu's "Restart game" button) — the only difference is who else it resets. */
  private resetToSpawn(): void {
    this.bustedContactTimer = 0;
    if (this.mode === 'vehicle' && this.currentVehicle) {
      this.currentVehicle.driven = false;
      this.currentVehicle = null;
      this.mode = 'foot';
    }
    const spawn = this.city.spawn;
    this.player.teleport(spawn.x - 1.0, spawn.z + 3.2, spawn.heading);
    this.player.object.visible = true;
    this.wanted = createWantedState();
    this.police.dispose(this.scene);
    this.policePursuing = false;
    this.syncHeadlights();
    this.updateHint();
  }

  /**
   * Combined (parked/player vehicles + police + traffic agents) obstacle view for the pedestrian
   * AI's danger and knockdown checks, rebuilt in place each tick (source arrays are themselves
   * persistent and index-aligned, so this is index copies, not object allocation, beyond an
   * occasional resize of the buffers themselves).
   */
  private refreshPedestrianObstacles(): readonly TrafficObstacle[] {
    this.refreshVehicleView();
    const policeCars = this.police.cars;
    if (this.policeObstacleView.length !== policeCars.length) {
      this.policeObstacleView.length = 0;
      for (const c of policeCars) this.policeObstacleView.push(obstacleFromVehicle(c.state, c.spec));
    } else {
      for (let i = 0; i < policeCars.length; i++) {
        const c = policeCars[i]!;
        const ob = this.policeObstacleView[i]!;
        ob.x = c.state.x;
        ob.z = c.state.z;
        ob.heading = c.state.heading;
        ob.forwardSpeed = c.state.forwardSpeed;
      }
    }
    const trafficObstacles = this.traffic.obstacles;
    this.pedestrianObstacles.length = this.pedestrianVehicleView.length + this.policeObstacleView.length + trafficObstacles.length;
    let n = 0;
    for (const ob of this.pedestrianVehicleView) this.pedestrianObstacles[n++] = ob;
    for (const ob of this.policeObstacleView) this.pedestrianObstacles[n++] = ob;
    for (const ob of trafficObstacles) this.pedestrianObstacles[n++] = ob;
    return this.pedestrianObstacles;
  }

  /** Point the traffic system uses to decide what to spawn/despawn around (player or their car). */
  private trafficFocus(): { x: number; z: number; heading: number } {
    if (this.mode === 'vehicle' && this.currentVehicle) {
      const v = this.currentVehicle.state;
      return { x: v.x, z: v.z, heading: v.heading };
    }
    const p = this.player.state;
    return { x: p.x, z: p.z, heading: p.heading };
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
    this.syncHeadlights();
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
    this.police.syncVisual(alpha);
    this.traffic.syncVisual(alpha);
    this.pedestrians.syncVisual(alpha);
    this.player.syncVisual(alpha);
    const target = this.cameraTarget();
    const s = this.input.state;
    const lookDY = this.gameplay.invertMouseY ? -s.lookDY : s.lookDY;
    this.cameraRig.update(target, frameDelta, s.lookDX, lookDY, s.lookBack);
    // The settings menu's debounced knobs (and its benchmark) run off real frame time, independent
    // of `paused` — the menu is only interactive while paused, so it must keep ticking then.
    this.menu.tick(frameDelta);
    this.camera.updateMatrixWorld();
    this.focus.copy(target.position);
    this.lighting.update(this.focus);
    // Position-dependent, so these run every frame (unlike the throttled `applyTimeOfDay`, which
    // only ever changes the cached `nightFactor` they read).
    this.localLights.update(this.lampHeads, this.focus.x, this.focus.z, this.nightFactor);
    this.sky.updateStars(this.camera.position, this.nightFactor);
    this.gfx.render(frameDelta);

    this.minimap.update(frameDelta, () => ({
      playerX: target.position.x,
      playerZ: target.position.z,
      playerHeading: target.heading,
      // `traffic.obstacles` is the system's own persistent, post-step view — reading it here keeps
      // the (throttled) minimap redraw free of per-redraw allocation.
      traffic: this.traffic.obstacles,
      pedestrians: this.pedestrians.positions,
      police: this.refreshPoliceDots(),
    }));

    this.hudAccum += frameDelta;
    if (this.hudAccum > 0.25) {
      this.hudAccum = 0;
      this.refreshHud();
    }
  }

  /** Police positions for the minimap, written into a persistent buffer. */
  private refreshPoliceDots(): readonly { x: number; z: number }[] {
    const cars = this.police.cars;
    while (this.policeDots.length < cars.length) this.policeDots.push({ x: 0, z: 0 });
    this.policeDots.length = cars.length;
    for (let i = 0; i < cars.length; i++) {
      const dot = this.policeDots[i]!;
      dot.x = cars[i]!.state.x;
      dot.z = cars[i]!.state.z;
    }
    return this.policeDots;
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
      timeOfDay: this.clock.hours,
      hint: this.hint,
      wanted: this.wanted.level,
      busted: this.busted,
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
    this.headlightL.removeFromParent();
    this.headlightR.removeFromParent();
    this.headlightTargetL.removeFromParent();
    this.headlightTargetR.removeFromParent();
    this.localLights.dispose();
    for (const v of this.vehicles) v.dispose(this.registry);
    this.traffic.dispose();
    this.pedestrians.dispose();
    this.police.dispose(this.scene);
    this.player.dispose(this.registry);
    this.cityView.dispose();
    this.lighting.dispose();
    this.sky.dispose();
    this.hud.dispose();
    this.menu.dispose();
    this.touch?.dispose();
    this.minimap.dispose();
    this.gfx.dispose();
  }
}
