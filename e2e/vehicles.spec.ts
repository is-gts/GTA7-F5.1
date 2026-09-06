import { expect, test, type Page } from '@playwright/test';

/** Minimal shape we care about from window.__gta7.snapshot() (see src/main.ts). */
interface Snapshot {
  mode: 'foot' | 'vehicle';
  quality: string;
  vehicle: { x: number; z: number; heading: number; speed: number; damage: number; type: string } | null;
  vehicles: number;
  renderer: { drawCalls: number };
}

interface BuildingDTO {
  id: number;
  x: number;
  z: number;
  w: number;
  d: number;
}

const errors: string[] = [];

async function load(page: Page, query: string): Promise<void> {
  errors.length = 0;
  page.on('console', (msg) => {
    const text = msg.text();
    if (text.includes('GL Driver Message')) return;
    if (msg.type() === 'error' || msg.type() === 'warning') errors.push(`${msg.type()}: ${text}`);
  });
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
  await page.goto(`/?autostart=0&${query}`);
  await page.waitForFunction(() => (window as unknown as { __gta7?: { ready: boolean } }).__gta7?.ready === true);
}

const snap = (page: Page) => page.evaluate(() => (window as unknown as { __gta7: { snapshot(): Snapshot } }).__gta7.snapshot());
const simulate = (page: Page, n: number) => page.evaluate((steps) => (window as unknown as { __gta7: { simulate(n: number): void } }).__gta7.simulate(steps), n);
const renderFrame = (page: Page) => page.evaluate(() => (window as unknown as { __gta7: { renderFrame(): void } }).__gta7.renderFrame());
const key = (page: Page, code: string, down: boolean) =>
  page.evaluate(([c, d]) => (window as unknown as { __gta7: { setKey(code: string, down: boolean): void } }).__gta7.setKey(c as string, d as boolean), [code, down]);

/** Every parked/player VehicleEntity's {id, type, x, z, heading}, straight off `game.vehicles`. */
const listVehicles = (page: Page) =>
  page.evaluate(() => {
    const g = (window as unknown as { __gta7: { game: unknown } }).__gta7.game as {
      vehicles: { id: number; type: string; state: { x: number; z: number; heading: number } }[];
    };
    return g.vehicles.map((v) => ({ id: v.id, type: v.type, x: v.state.x, z: v.state.z, heading: v.state.heading }));
  });

const listBuildings = (page: Page): Promise<BuildingDTO[]> =>
  page.evaluate(() => {
    const g = (window as unknown as { __gta7: { game: unknown } }).__gta7.game as {
      city: { buildings: BuildingDTO[] };
    };
    return g.city.buildings.map((b) => ({ id: b.id, x: b.x, z: b.z, w: b.w, d: b.d }));
  });

/** Teleport the on-foot player and snap the chase camera to look along the new heading immediately
 *  (mirrors the same helper in e2e/traffic.spec.ts and e2e/pedestrians.spec.ts). */
const teleportPlayer = (page: Page, x: number, z: number, heading: number) =>
  page.evaluate(
    ({ x, z, heading }) => {
      const g = (
        window as unknown as {
          __gta7: {
            game: {
              player: { teleport(x: number, z: number, heading: number): void; object: { position: unknown } };
              cameraRig: { snapTo(target: { position: unknown; heading: number; speed: number; mode: 'foot' }): void };
            };
          };
        }
      ).__gta7.game;
      g.player.teleport(x, z, heading);
      g.cameraRig.snapTo({ position: g.player.object.position, heading, speed: 0, mode: 'foot' });
    },
    { x, z, heading },
  );

/**
 * Find a building with a clear ~RUNWAY metre straight approach along one cardinal axis (no other
 * building's footprint crosses that line first), so a vehicle can build up real speed before
 * hitting it. Buildings are axis-aligned boxes (w = X extent, d = Z extent), so approaching along
 * X or Z at a fixed cross-coordinate is a simple interval check against every other building.
 */
function findCrashApproach(buildings: BuildingDTO[], runway = 32): { startX: number; startZ: number; heading: number } | null {
  // [dx, dz, heading]: start `runway` metres from the building along (dx,dz) and drive the
  // opposite way (forward = (sin h, cos h) = (-dx, -dz)).
  const approaches: [number, number, number][] = [
    [1, 0, -Math.PI / 2],
    [-1, 0, Math.PI / 2],
    [0, 1, Math.PI],
    [0, -1, 0],
  ];
  for (const b of buildings) {
    for (const [dx, dz, heading] of approaches) {
      const half = dx !== 0 ? b.w / 2 : b.d / 2;
      const startX = b.x + dx * (half + runway);
      const startZ = b.z + dz * (half + runway);
      let blocked = false;
      for (const c of buildings) {
        if (c.id === b.id) continue;
        if (dx !== 0) {
          if (Math.abs(c.z - b.z) >= c.d / 2 + 0.5) continue;
          const lo = Math.min(startX, b.x);
          const hi = Math.max(startX, b.x);
          if (c.x + c.w / 2 > lo && c.x - c.w / 2 < hi) {
            blocked = true;
            break;
          }
        } else {
          if (Math.abs(c.x - b.x) >= c.w / 2 + 0.5) continue;
          const lo = Math.min(startZ, b.z);
          const hi = Math.max(startZ, b.z);
          if (c.z + c.d / 2 > lo && c.z - c.d / 2 < hi) {
            blocked = true;
            break;
          }
        }
      }
      if (!blocked) return { startX, startZ, heading };
    }
  }
  return null;
}

test.describe('vehicle catalog, damage and horn', () => {
  test('parked vehicles use varied catalog types, and the snapshot reports the driven one', async ({ page }) => {
    await load(page, 'quality=low&cols=8&rows=8&seed=7');
    const vehicles = await listVehicles(page);
    expect(vehicles.length).toBeGreaterThanOrEqual(4);
    const types = new Set(vehicles.map((v) => v.type));
    expect(types.size).toBeGreaterThanOrEqual(2); // "visibly different vehicles"
    for (const v of vehicles) expect(['sedan', 'sports', 'suv', 'van', 'pickup', 'police']).toContain(v.type);

    // Enter the car parked right at spawn.
    await key(page, 'KeyE', true);
    await simulate(page, 1);
    await key(page, 'KeyE', false);
    const s = await snap(page);
    expect(s.mode).toBe('vehicle');
    expect(s.vehicle).not.toBeNull();
    expect(s.vehicle!.type).toBe(vehicles[0]!.type);
    expect(s.vehicle!.damage).toBe(0);
    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('a screenshot of each parked vehicle type up close, to compare their shapes', async ({ page }) => {
    await load(page, 'quality=low&cols=10&rows=10&seed=7');
    const vehicles = await listVehicles(page);
    const seen = new Set<string>();
    let shot = 0;
    // Stand a fixed 9 m south of the vehicle, facing it (+Z), regardless of its own heading — a
    // world-axis-fixed viewpoint that (unlike one relative to the car's own heading, which can put
    // the player across the road or against a building depending on which way the car happens to be
    // parked) reliably keeps a clear, close, consistently-framed shot of every parked car.
    const standoff = 9;
    for (const v of vehicles) {
      if (seen.has(v.type)) continue;
      seen.add(v.type);
      await teleportPlayer(page, v.x, v.z - standoff, 0);
      await renderFrame(page);
      await page.screenshot({ path: `e2e/output/vehicle-${shot++}-${v.type}.png` });
    }
    expect(seen.size).toBeGreaterThanOrEqual(2);
    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('driving into a building at speed raises damage above 0.1', async ({ page }) => {
    await load(page, 'quality=low&cols=8&rows=8&seed=7');
    const buildings = await listBuildings(page);
    expect(buildings.length).toBeGreaterThan(20);
    const approach = findCrashApproach(buildings);
    expect(approach).not.toBeNull();
    const { startX, startZ, heading } = approach!;

    // Enter the car at spawn, then place it at the start of the clear approach.
    await key(page, 'KeyE', true);
    await simulate(page, 1);
    await key(page, 'KeyE', false);
    let s = await snap(page);
    expect(s.mode).toBe('vehicle');
    await page.evaluate(
      ({ x, z, heading }) => {
        const g = (
          window as unknown as {
            __gta7: {
              game: {
                currentVehicle: { teleport(x: number, z: number, heading: number): void; object: { position: unknown } } | null;
                cameraRig: { snapTo(target: { position: unknown; heading: number; speed: number; mode: 'vehicle' }): void };
              };
            };
          }
        ).__gta7.game;
        g.currentVehicle!.teleport(x, z, heading);
        // Snap the chase camera to the car's new spot immediately — simulate() alone never advances
        // the camera's own follow-lag smoothing (that only happens inside render()), so without this
        // a screenshot right after would still show wherever the camera was in 'foot' mode.
        g.cameraRig.snapTo({ position: g.currentVehicle!.object.position, heading, speed: 0, mode: 'vehicle' });
      },
      { x: startX, z: startZ, heading },
    );
    s = await snap(page);
    expect(s.vehicle!.damage).toBe(0);

    // Full throttle straight at the wall; stop as soon as damage shows up (or after a generous cap).
    await key(page, 'KeyW', true);
    let damaged = false;
    for (let i = 0; i < 40 && !damaged; i++) {
      await simulate(page, 15);
      s = await snap(page);
      if (s.vehicle!.damage > 0.1) damaged = true;
    }
    await key(page, 'KeyW', false);
    expect(s.vehicle!.damage).toBeGreaterThan(0.1);
    // A couple more frames so the chase camera (which follows with a little lag) settles behind
    // the now-stopped, damaged car before the screenshot.
    for (let i = 0; i < 20; i++) await renderFrame(page);
    await page.screenshot({ path: 'e2e/output/vehicle-crash-damage.png' });
    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('honking the horn (H) startles nearby pedestrians into fleeing', async ({ page }) => {
    await load(page, 'quality=low&cols=8&rows=8&seed=7');
    await key(page, 'KeyE', true);
    await simulate(page, 1);
    await key(page, 'KeyE', false);
    let s = await snap(page);
    expect(s.mode).toBe('vehicle');

    const peds = await page.evaluate(() => {
      const g = (window as unknown as { __gta7: { game: unknown } }).__gta7.game as {
        pedestrians: { agents: { id: number; mode: string; state: { x: number; z: number } }[] };
      };
      return g.pedestrians.agents.map((a) => ({ id: a.id, mode: a.mode, x: a.state.x, z: a.state.z }));
    });
    expect(peds.length).toBeGreaterThan(0);
    const target = peds.find((p) => p.mode === 'walk' || p.mode === 'wait');
    expect(target, 'expected at least one pedestrian not already fleeing/down').toBeTruthy();

    // Place the driven car 6 m from that pedestrian (well within the horn's radius) without
    // touching it, and honk.
    await page.evaluate(
      ({ x, z }) => {
        const g = (window as unknown as { __gta7: { game: { currentVehicle: { teleport(x: number, z: number, heading: number): void } | null } } }).__gta7.game;
        g.currentVehicle!.teleport(x - 6, z, 0);
      },
      { x: target!.x, z: target!.z },
    );
    await key(page, 'KeyH', true);
    await simulate(page, 1);
    await key(page, 'KeyH', false);
    await simulate(page, 3);

    const after = await page.evaluate((id: number) => {
      const g = (window as unknown as { __gta7: { game: unknown } }).__gta7.game as {
        pedestrians: { agents: { id: number; mode: string }[] };
      };
      return g.pedestrians.agents.find((a) => a.id === id)?.mode ?? null;
    }, target!.id);
    expect(after).toBe('flee');
    s = await snap(page);
    expect(s.mode).toBe('vehicle'); // sanity: honking didn't kick the player out of the car
    expect(errors, errors.join('\n')).toEqual([]);
  });
});
