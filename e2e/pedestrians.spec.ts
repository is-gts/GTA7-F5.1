import { expect, test, type Page } from '@playwright/test';

/** Minimal shape we care about from window.__gta7.snapshot() (see src/main.ts). */
interface PedestrianSnapshot {
  quality: string;
  pedestrians: { agents: number; walking: number; down: number };
  renderer: { drawCalls: number };
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

const snap = (page: Page) => page.evaluate(() => (window as unknown as { __gta7: { snapshot(): PedestrianSnapshot } }).__gta7.snapshot());
const simulate = (page: Page, n: number) => page.evaluate((steps) => (window as unknown as { __gta7: { simulate(n: number): void } }).__gta7.simulate(steps), n);
const renderFrame = (page: Page) => page.evaluate(() => (window as unknown as { __gta7: { renderFrame(): void } }).__gta7.renderFrame());
const key = (page: Page, code: string, down: boolean) =>
  page.evaluate(([c, d]) => (window as unknown as { __gta7: { setKey(code: string, down: boolean): void } }).__gta7.setKey(c as string, d as boolean), [code, down]);

/** Read every active pedestrian agent's {id,x,z} straight off `game.pedestrians` (debug-only access
 *  to the pool's internals — there is no public per-agent API, only the aggregate `stats`). */
const listPedestrians = (page: Page) =>
  page.evaluate(() => {
    const g = (window as unknown as { __gta7: { game: unknown } }).__gta7.game as {
      pedestrians: { agents: { id: number; state: { x: number; z: number } }[] };
    };
    return g.pedestrians.agents.map((a) => ({ id: a.id, x: a.state.x, z: a.state.z }));
  });

/**
 * Teleport the on-foot player (mirrors e2e/traffic.spec.ts's own helper) and snap the chase camera
 * to look along the new heading immediately, so a single `renderFrame()` afterwards actually shows
 * whatever we teleported to face (the camera otherwise follows with a smoothing lag).
 */
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

test.describe('pedestrian AI', () => {
  test('populates sidewalks with pedestrians that actually walk around', async ({ page }) => {
    await load(page, 'quality=low&cols=8&rows=8&seed=7');
    let s = await snap(page);
    expect(s.quality).toBe('low');
    expect(s.pedestrians.agents).toBeGreaterThanOrEqual(8); // low.maxPedestrians = 16

    const before = await listPedestrians(page);
    await simulate(page, 300); // 5 s
    const after = await listPedestrians(page);

    const beforeMap = new Map(before.map((a) => [a.id, a]));
    let moved = 0;
    for (const a of after) {
      const b = beforeMap.get(a.id);
      if (b && Math.hypot(a.x - b.x, a.z - b.z) > 0.5) moved++;
    }
    expect(moved).toBeGreaterThanOrEqual(Math.ceil(before.length / 2));

    // Teleport the player right behind the nearest pedestrian so the screenshot actually shows one
    // in frame (spawn is out-of-view by design — see e2e/traffic.spec.ts's identical rationale).
    const player = (await page.evaluate(() => {
      const g = (window as unknown as { __gta7: { game: { player: { state: { x: number; z: number } } } } }).__gta7.game;
      return { x: g.player.state.x, z: g.player.state.z };
    }))!;
    let nearest = after[0]!;
    let nearestDist = Infinity;
    for (const a of after) {
      const d = Math.hypot(a.x - player.x, a.z - player.z);
      if (d < nearestDist) {
        nearestDist = d;
        nearest = a;
      }
    }
    const dx = nearest.x - player.x;
    const dz = nearest.z - player.z;
    const dist = Math.hypot(dx, dz) || 1;
    const heading = Math.atan2(dx, dz); // forward = (sin h, cos h) points at the pedestrian
    const standoff = 6;
    await teleportPlayer(page, nearest.x - (dx / dist) * standoff, nearest.z - (dz / dist) * standoff, heading);
    await renderFrame(page);

    s = await snap(page);
    expect(s.renderer.drawCalls).toBeGreaterThan(5);
    expect(s.renderer.drawCalls).toBeLessThan(400);
    await page.screenshot({ path: 'e2e/output/pedestrians-low.png' });
    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('pedestrian count follows the quality preset and rebuilds on setQuality', async ({ page }) => {
    await load(page, 'quality=low&cols=8&rows=8&seed=7');
    const low = await snap(page);
    expect(low.pedestrians.agents).toBeLessThanOrEqual(16); // low.maxPedestrians

    await page.evaluate(() => (window as unknown as { __gta7: { setQuality(n: string): void } }).__gta7.setQuality('high'));
    await simulate(page, 5);
    const high = await snap(page);
    expect(high.quality).toBe('high');
    expect(high.pedestrians.agents).toBeGreaterThan(low.pedestrians.agents);
    expect(high.pedestrians.agents).toBeLessThanOrEqual(48); // high.maxPedestrians

    await page.evaluate(() => (window as unknown as { __gta7: { setQuality(n: string): void } }).__gta7.setQuality('low'));
    await simulate(page, 5);
    const back = await snap(page);
    expect(back.pedestrians.agents).toBeLessThanOrEqual(16);
    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('driving the player car through a pedestrian at speed knocks it down', async ({ page }) => {
    await load(page, 'quality=low&cols=8&rows=8&seed=7');
    await simulate(page, 5);
    const s0 = await snap(page);
    expect(s0.pedestrians.down).toBe(0);

    // Put the player's own car right on a pedestrian, already moving well above the knockdown
    // threshold, and mark it driven — the same per-tick vehicle/pedestrian interaction a real
    // drive-through-a-crowd moment exercises, without a multi-second approach across the block.
    await page.evaluate(() => {
      const g = (
        window as unknown as {
          __gta7: {
            game: {
              mode: string;
              currentVehicle: unknown;
              pedestrians: { agents: { state: { x: number; z: number } }[] };
              vehicles: {
                state: { x: number; z: number; heading: number; vx: number; vz: number; forwardSpeed: number };
                prev: object;
                driven: boolean;
              }[];
            };
          };
        }
      ).__gta7.game;
      const ped = g.pedestrians.agents[0]!;
      const car = g.vehicles[0]!;
      // Start a couple of metres short (not exactly on top of it) so the impact has a well-defined
      // direction — the knockback aims away from the vehicle's centre, which is undefined if the
      // two start out perfectly concentric — and the car visibly drives on past afterwards.
      car.state.x = ped.state.x;
      car.state.z = ped.state.z - 2;
      car.state.heading = 0;
      car.state.vx = 0;
      car.state.vz = 16;
      car.state.forwardSpeed = 16;
      Object.assign(car.prev, car.state);
      g.mode = 'vehicle';
      g.currentVehicle = car;
      car.driven = true;
    });
    await key(page, 'KeyW', true);
    await simulate(page, 30);
    await key(page, 'KeyW', false);

    const s = await snap(page);
    expect(s.pedestrians.down).toBeGreaterThan(0);

    // Snap the (lagged, smoothing) chase camera straight to the car's current position before the
    // one-off renderFrame() below, so the screenshot actually frames the car and the pedestrian it
    // just hit instead of wherever the camera was last pointed.
    await page.evaluate(() => {
      const g = (
        window as unknown as {
          __gta7: {
            game: {
              vehicles: { state: { x: number; z: number; heading: number } }[];
              cameraRig: { snapTo(target: { position: { x: number; y: number; z: number }; heading: number; speed: number; mode: 'vehicle' }): void };
            };
          };
        }
      ).__gta7.game;
      const car = g.vehicles[0]!;
      g.cameraRig.snapTo({ position: { x: car.state.x, y: 0, z: car.state.z }, heading: car.state.heading, speed: 0, mode: 'vehicle' });
    });
    await renderFrame(page);
    await page.screenshot({ path: 'e2e/output/pedestrians-down.png' });
    expect(errors, errors.join('\n')).toEqual([]);
  });
});
