import { expect, test, type Page } from '@playwright/test';

/** Minimal shape we care about from window.__gta7.snapshot() (see src/main.ts). */
interface TrafficSnapshot {
  quality: string;
  vehicles: number;
  traffic: { agents: number; moving: number; list: { id: number; x: number; z: number; speed: number }[] };
  renderer: { drawCalls: number };
  player: { x: number; z: number; heading: number };
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

const snap = (page: Page) => page.evaluate(() => (window as unknown as { __gta7: { snapshot(): TrafficSnapshot } }).__gta7.snapshot());
const simulate = (page: Page, n: number) => page.evaluate((steps) => (window as unknown as { __gta7: { simulate(n: number): void } }).__gta7.simulate(steps), n);
const renderFrame = (page: Page) => page.evaluate(() => (window as unknown as { __gta7: { renderFrame(): void } }).__gta7.renderFrame());
const setQuality = (page: Page, name: string) => page.evaluate((n) => (window as unknown as { __gta7: { setQuality(n: string): void } }).__gta7.setQuality(n), name);
/**
 * Teleport the on-foot player (game.player is reachable straight off window.__gta7.game) and snap
 * the chase camera to look along the new heading immediately — the camera normally follows with a
 * smoothing lag, which a single renderFrame() wouldn't clear, leaving the camera still pointed the
 * old way right after a teleport.
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

test.describe('traffic AI', () => {
  test('populates the road with AI traffic and cars actually drive around', async ({ page }) => {
    await load(page, 'quality=low&cols=8&rows=8&seed=7');
    await simulate(page, 5);
    let s = await snap(page);
    expect(s.quality).toBe('low');
    expect(s.traffic.agents).toBeGreaterThanOrEqual(6);
    const before = new Map(s.traffic.list.map((a) => [a.id, a]));

    await simulate(page, 300);
    s = await snap(page);
    let movedFarEnough = 0;
    for (const a of s.traffic.list) {
      const b = before.get(a.id);
      if (!b) continue;
      if (Math.hypot(a.x - b.x, a.z - b.z) > 5) movedFarEnough++;
    }
    expect(movedFarEnough).toBeGreaterThanOrEqual(Math.ceil(before.size / 2));

    // Teleport the player right behind the nearest traffic agent so the screenshot actually shows
    // a traffic car in frame (spawn is out-of-view by design, so a screenshot from the spawn point
    // alone never demonstrates traffic cars rendering).
    let nearest = s.traffic.list[0]!;
    let nearestDist = Infinity;
    for (const a of s.traffic.list) {
      const d = Math.hypot(a.x - s.player.x, a.z - s.player.z);
      if (d < nearestDist) {
        nearestDist = d;
        nearest = a;
      }
    }
    const dx = nearest.x - s.player.x;
    const dz = nearest.z - s.player.z;
    const dist = Math.hypot(dx, dz) || 1;
    const heading = Math.atan2(dx, dz); // forward = (sin h, cos h) points at the agent
    const standoff = 15;
    const px = nearest.x - (dx / dist) * standoff;
    const pz = nearest.z - (dz / dist) * standoff;
    await teleportPlayer(page, px, pz, heading);

    await renderFrame(page);
    const after = await snap(page);
    expect(after.renderer.drawCalls).toBeGreaterThan(5);
    expect(after.renderer.drawCalls).toBeLessThan(400);
    // At least one agent is within ~40m and in front of the camera (which follows the player's
    // heading), i.e. actually visible in the screenshot below, not just spawned somewhere in the city.
    const fx = Math.sin(heading);
    const fz = Math.cos(heading);
    const visible = after.traffic.list.some((a) => {
      const ddx = a.x - px;
      const ddz = a.z - pz;
      if (Math.hypot(ddx, ddz) > 40) return false;
      return ddx * fx + ddz * fz > 0;
    });
    expect(visible).toBe(true);
    await page.screenshot({ path: 'e2e/output/traffic-low.png' });
    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('traffic keeps flowing over a long run (no gridlock)', async ({ page }) => {
    // Guards the deadlock class of bug: rules that are individually correct (yield to whoever is
    // in the junction; never drive into the car in front) used to be able to lock cars against
    // each other for good, and the whole population would silently grind to a halt.
    await load(page, 'quality=low&cols=8&rows=8&seed=7');
    await simulate(page, 120);
    const start = await snap(page);
    expect(start.traffic.agents).toBeGreaterThanOrEqual(6);

    let worstMoving = start.traffic.moving;
    // Follow only the cars that were already there, so the distances below cover the whole run
    // (agents that spawn part way through, or despawn out of range, are not comparable).
    const original = new Set(start.traffic.list.map((a) => a.id));
    const distance = new Map<number, number>(start.traffic.list.map((a) => [a.id, 0]));
    let previous = new Map(start.traffic.list.map((a) => [a.id, a]));
    // 60 s of simulation, sampled every 5 s.
    for (let chunk = 0; chunk < 12; chunk++) {
      await simulate(page, 300);
      const s = await snap(page);
      worstMoving = Math.min(worstMoving, s.traffic.moving);
      for (const a of s.traffic.list) {
        if (!original.has(a.id)) continue;
        const b = previous.get(a.id);
        if (b) distance.set(a.id, (distance.get(a.id) ?? 0) + Math.hypot(a.x - b.x, a.z - b.z));
      }
      previous = new Map(s.traffic.list.map((a) => [a.id, a]));
    }
    const end = await snap(page);
    // Most of the traffic is moving at every single sample...
    expect(worstMoving).toBeGreaterThanOrEqual(Math.ceil(end.traffic.agents / 2));
    // ...and every car that was there for the whole run really drove around the city (60 s even at
    // the 4.5 m/s corner speed is 270 m; a gridlocked car would show a few tens of metres at most).
    const survivors = end.traffic.list.filter((a) => original.has(a.id));
    expect(survivors.length).toBeGreaterThanOrEqual(4);
    for (const a of survivors) expect(distance.get(a.id) ?? 0).toBeGreaterThan(150);
    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('traffic count follows the quality preset and rebuilds on setQuality', async ({ page }) => {
    await load(page, 'quality=low&cols=8&rows=8&seed=7');
    await simulate(page, 5);
    const low = await snap(page);
    expect(low.traffic.agents).toBeLessThanOrEqual(12); // low.maxTraffic

    await setQuality(page, 'high');
    await simulate(page, 5);
    const high = await snap(page);
    expect(high.quality).toBe('high');
    expect(high.traffic.agents).toBeGreaterThan(low.traffic.agents);
    expect(high.traffic.agents).toBeLessThanOrEqual(40); // high.maxTraffic

    await setQuality(page, 'low');
    await simulate(page, 5);
    const back = await snap(page);
    expect(back.traffic.agents).toBeLessThanOrEqual(12);
    expect(errors, errors.join('\n')).toEqual([]);
  });
});
