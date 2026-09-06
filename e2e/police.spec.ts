import { expect, test, type Page } from '@playwright/test';

/** Minimal shape we care about from window.__gta7.snapshot() (see src/main.ts). */
interface PoliceSnapshot {
  mode: 'foot' | 'vehicle';
  wanted: { level: number; heat: number };
  police: { count: number; pursuing: boolean; distance: number };
  busted: boolean;
  pedestrians: { agents: number; walking: number; down: number };
  minimap: { redraws: number };
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

const snap = (page: Page) => page.evaluate(() => (window as unknown as { __gta7: { snapshot(): PoliceSnapshot } }).__gta7.snapshot());
const simulate = (page: Page, n: number) => page.evaluate((steps) => (window as unknown as { __gta7: { simulate(n: number): void } }).__gta7.simulate(steps), n);
const renderFrame = (page: Page) => page.evaluate(() => (window as unknown as { __gta7: { renderFrame(): void } }).__gta7.renderFrame());
const key = (page: Page, code: string, down: boolean) =>
  page.evaluate(([c, d]) => (window as unknown as { __gta7: { setKey(code: string, down: boolean): void } }).__gta7.setKey(c as string, d as boolean), [code, down]);

/** Same deterministic knockdown setup as e2e/pedestrians.spec.ts: put the player's own car right on
 *  a pedestrian, already moving above the knockdown threshold, and mark it driven. */
const runOverAPedestrian = (page: Page) =>
  page.evaluate(() => {
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

test.describe('wanted level and police pursuit', () => {
  test('running over a pedestrian raises the wanted level and spawns a pursuing police car', async ({ page }) => {
    await load(page, 'quality=low&cols=8&rows=8&seed=7');
    await simulate(page, 5);
    let s = await snap(page);
    expect(s.wanted.level).toBe(0);
    expect(s.police.count).toBe(0);

    await runOverAPedestrian(page);
    await key(page, 'KeyW', true);
    await simulate(page, 30);
    await key(page, 'KeyW', false);

    s = await snap(page);
    expect(s.pedestrians.down).toBeGreaterThan(0); // sanity: the knockdown actually happened
    expect(s.wanted.level).toBeGreaterThanOrEqual(1);

    // Bring the player's car to a dead stop right where the knockdown left it (rather than letting
    // it coast and potentially crash/bounce off whatever is ahead at whatever heading the knockdown
    // staging happened to use) — isolates this assertion to what it is actually testing, the police
    // navigation, rather than the player's own uncontrolled post-crash physics.
    await page.evaluate(() => {
      const g = (
        window as unknown as {
          __gta7: { game: { currentVehicle: { state: { vx: number; vz: number; forwardSpeed: number }; prev: object } | null } };
        }
      ).__gta7.game;
      const car = g.currentVehicle;
      if (!car) return;
      car.state.vx = 0;
      car.state.vz = 0;
      car.state.forwardSpeed = 0;
      Object.assign(car.prev, car.state);
    });

    // Give the wanted system time to spawn a police car (it spawns 45-95 m out — see PoliceSystem).
    await simulate(page, 120); // 2s: long enough for the first car to exist and start navigating
    s = await snap(page);
    expect(s.police.count).toBeGreaterThanOrEqual(1);
    const distAfterSpawn = s.police.distance;

    // Let the real pursuit navigation (lane-following road-graph routing, then a direct approach
    // once close) close the distance to the now-stationary player — the behaviour the naive
    // straight-line controller could not deliver (it mostly ground into the nearest building
    // instead). Poll in short chunks and stop as soon as the car is actually on top of the player,
    // rather than simulating a fixed block: the pursuit is fast enough that a fixed wait can run
    // straight past the arrival into a completed arrest (which despawns the police car again).
    let minDistance = s.police.distance;
    let sawPursuing = false;
    let arrived = false;
    for (let chunk = 0; chunk < 40 && !arrived; chunk++) {
      await simulate(page, 30); // 0.5s
      s = await snap(page);
      if (s.police.pursuing) sawPursuing = true;
      if (s.police.distance < minDistance) minDistance = s.police.distance;
      arrived = s.police.distance < 12 || s.busted;
    }
    expect(sawPursuing, 'a police car reported pursuing at some point').toBe(true);
    // The pursuing car actually gained ground rather than merely existing somewhere on the map...
    expect(minDistance).toBeLessThan(distAfterSpawn);
    // ...and got right on top of the stationary player (or had already arrested them).
    expect(arrived, `nearest police distance ${s.police.distance}`).toBe(true);

    // Snap the (lagged, smoothing) chase camera straight to the car so the screenshot actually
    // frames it, and render enough frames for the throttled minimap to have drawn at least once.
    // (The player may have already been busted by this point — the real pursuit closing distance
    // this fast is exactly the point — in which case there is no vehicle to snap to; skip it then.)
    // Enough frames for the throttled minimap (10 Hz) and HUD (4 Hz) to have drawn the live state,
    // then point the (lagged, smoothing) chase camera down the line to the pursuing car and render
    // one more frame, so the screenshot actually frames it.
    for (let i = 0; i < 30; i++) await renderFrame(page);
    await page.evaluate(() => {
      const g = (
        window as unknown as {
          __gta7: {
            game: {
              currentVehicle: { state: { x: number; z: number; heading: number } } | null;
              police: { cars: { state: { x: number; z: number } }[] };
              cameraRig: { snapTo(target: { position: { x: number; y: number; z: number }; heading: number; speed: number; mode: 'vehicle' }): void };
            };
          };
        }
      ).__gta7.game;
      if (!g.currentVehicle) return;
      const v = g.currentVehicle.state;
      const cop = g.police.cars[0];
      if (!cop) {
        g.cameraRig.snapTo({ position: { x: v.x, y: 0, z: v.z }, heading: v.heading, speed: 0, mode: 'vehicle' });
        return;
      }
      // Frame the chase: the camera sits behind the player's car and looks along the given heading
      // (see CameraRig), so look toward the police car — swung a little off that line so the two
      // cars appear side by side instead of one hidden behind the other.
      const heading = Math.atan2(cop.state.x - v.x, cop.state.z - v.z) + 0.35;
      g.cameraRig.snapTo({ position: { x: v.x, y: 0, z: v.z }, heading, speed: 0, mode: 'vehicle' });
    });
    await renderFrame(page);
    await page.screenshot({ path: 'e2e/output/police-pursuit.png' });
    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('busted: stopping next to a pursuing police car respawns the player on foot with wanted reset', async ({ page }) => {
    await load(page, 'quality=low&cols=10&rows=10&seed=13');
    await simulate(page, 5);

    await runOverAPedestrian(page);
    await key(page, 'KeyW', true);
    await simulate(page, 30);
    await key(page, 'KeyW', false);
    let s = await snap(page);
    expect(s.wanted.level).toBeGreaterThanOrEqual(1);

    await simulate(page, 60); // 1s: just long enough for the first car to exist
    s = await snap(page);
    expect(s.police.count).toBeGreaterThanOrEqual(1);

    // Stage the "player stopped" half of the scenario deterministically (teleport the player's car,
    // already stopped, to the open city spawn point) but leave the police car's own state entirely
    // to the simulation: the real pursuit navigation (road-graph routing, then a direct approach that
    // brakes as it closes on a slow/stationary target — see src/ai/Police.ts) has to actually find and
    // close on the player and hold station beside it, with no engine disabled and no hand-placement.
    await page.evaluate(() => {
      const g = (
        window as unknown as {
          __gta7: {
            game: {
              city: { spawn: { x: number; z: number; heading: number } };
              currentVehicle: {
                state: { x: number; z: number; heading: number; vx: number; vz: number; forwardSpeed: number };
                prev: object;
              };
            };
          };
        }
      ).__gta7.game;
      const spawn = g.city.spawn;
      const car = g.currentVehicle;
      car.state.x = spawn.x;
      car.state.z = spawn.z;
      car.state.heading = spawn.heading;
      car.state.vx = 0;
      car.state.vz = 0;
      car.state.forwardSpeed = 0;
      Object.assign(car.prev, car.state);
    });
    await key(page, 'KeyW', false);
    await key(page, 'KeyS', false);

    // Not busted the instant the player stops (the cop still has to arrive and hold for 3s).
    s = await snap(page);
    expect(s.busted).toBe(false);
    expect(s.mode).toBe('vehicle');

    // Poll in chunks (rather than one giant simulate()) so the wait is bounded but not brittle about
    // exactly how long the real navigation takes to arrive and settle into the hold.
    const chunkTicks = 30; // 0.5s — fine enough to not skip over the ~2.5s "busted" overlay window
    const maxTotalTicks = 60 * 60; // 60s bound
    let elapsed = 0;
    let busted = false;
    while (elapsed < maxTotalTicks) {
      await simulate(page, chunkTicks);
      elapsed += chunkTicks;
      s = await snap(page);
      if (s.busted) {
        busted = true;
        break;
      }
    }
    expect(busted, `not busted within ${maxTotalTicks / 60}s (nearest police distance: ${s.police.distance})`).toBe(true);
    expect(s.mode).toBe('foot');
    expect(s.wanted.level).toBe(0);
    expect(s.police.count).toBe(0);

    // Force the throttled HUD refresh (>0.25s of accumulated render time) so the DOM actually
    // reflects `busted` — not just checking the internal flag, but that the "BUSTED" overlay is
    // really shown (an element with the `hidden` attribute that a CSS rule fails to respect would
    // pass a flag-only check while still rendering the overlay, or vice versa).
    for (let i = 0; i < 20; i++) await renderFrame(page);
    let overlayVisible = await page.evaluate(() => {
      const el = document.querySelector('.hud-busted') as HTMLElement | null;
      return !!el && getComputedStyle(el).display !== 'none' && el.textContent === 'BUSTED';
    });
    expect(overlayVisible).toBe(true);
    await page.screenshot({ path: 'e2e/output/busted.png' });

    // The overlay clears itself a couple of seconds later and play continues normally.
    await simulate(page, 200);
    s = await snap(page);
    expect(s.busted).toBe(false);
    expect(s.mode).toBe('foot');
    for (let i = 0; i < 20; i++) await renderFrame(page);
    overlayVisible = await page.evaluate(() => {
      const el = document.querySelector('.hud-busted') as HTMLElement | null;
      return !!el && getComputedStyle(el).display !== 'none';
    });
    expect(overlayVisible).toBe(false);

    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('minimap: canvas exists, renders content, and its redraws are throttled', async ({ page }) => {
    await load(page, 'quality=low&cols=8&rows=8&seed=7');
    await simulate(page, 5);
    const before = (await snap(page)).minimap.redraws;

    // 60 real frames at the default ~1/60s frame delta (~1s of wall time).
    for (let i = 0; i < 60; i++) await renderFrame(page);

    const s = await snap(page);
    const redrew = s.minimap.redraws - before;
    expect(redrew).toBeGreaterThan(0);
    expect(redrew).toBeLessThanOrEqual(12);

    const dataUrlLength = await page.evaluate(() => {
      const canvas = document.querySelector('canvas.hud-minimap') as HTMLCanvasElement | null;
      return canvas ? canvas.toDataURL('image/png').length : 0;
    });
    expect(dataUrlLength).toBeGreaterThan(1000);

    await page.screenshot({ path: 'e2e/output/minimap.png' });
    expect(errors, errors.join('\n')).toEqual([]);
  });
});
