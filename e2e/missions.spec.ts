import { expect, test, type Page } from '@playwright/test';

/** Minimal shape we care about from window.__gta7.snapshot() (see src/main.ts). */
interface MissionsSnapshot {
  mode: 'foot' | 'vehicle';
  quality: string;
  missions: { available: number; active: string | null; checkpoint: number; money: number };
  renderer: { drawCalls: number; geometries: number; textures: number };
}

interface MissionDef {
  id: string;
  type: 'race' | 'delivery';
  start: { x: number; z: number };
  checkpoints: { x: number; z: number }[];
  reward: number;
}

const errors: string[] = [];

/** Registers the console/pageerror listeners exactly once per `page` (Playwright's `Page` is one
 *  per test here) — `load()` itself may be called more than once within a test (e.g. to reload and
 *  check a save survives it), and re-registering on every call would double- (or triple-) count any
 *  error that happens to fire after a second/third `goto`. */
const listenersAttached = new WeakSet<Page>();
function attachErrorListeners(page: Page): void {
  if (listenersAttached.has(page)) return;
  listenersAttached.add(page);
  page.on('console', (msg) => {
    const text = msg.text();
    if (text.includes('GL Driver Message')) return;
    if (msg.type() === 'error' || msg.type() === 'warning') errors.push(`${msg.type()}: ${text}`);
  });
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
}

async function load(page: Page, query: string): Promise<void> {
  errors.length = 0;
  attachErrorListeners(page);
  await page.goto(`/?autostart=0&${query}`);
  await page.waitForFunction(() => (window as unknown as { __gta7?: { ready: boolean } }).__gta7?.ready === true);
}

const snap = (page: Page) => page.evaluate(() => (window as unknown as { __gta7: { snapshot(): MissionsSnapshot } }).__gta7.snapshot());
const simulate = (page: Page, n: number) => page.evaluate((steps) => (window as unknown as { __gta7: { simulate(n: number): void } }).__gta7.simulate(steps), n);
// Renders one frame so the canvas reflects whatever `simulate()` just did — `simulate()` itself
// only steps the fixed update, it never renders (see main.ts).
const renderFrame = (page: Page) => page.evaluate(() => (window as unknown as { __gta7: { renderFrame(): void } }).__gta7.renderFrame());
// `refreshHud()` (public on `Game`) is itself throttled to ~4 Hz inside `render()`, so a single
// `renderFrame()` right after a state change may leave the DOM (money/mission/mode readouts)
// stale for a screenshot even though the canvas and `snapshot()` are already current — call it
// directly for screenshot assertions that check the HUD text.
const refreshHud = (page: Page) => page.evaluate(() => (window as unknown as { __gta7: { game: { refreshHud(): void } } }).__gta7.game.refreshHud());
const teleportVehicle = (page: Page, x: number, z: number, heading: number) =>
  page.evaluate(
    ([x2, z2, h2]) => (window as unknown as { __gta7: { teleportVehicle(x: number, z: number, heading: number): void } }).__gta7.teleportVehicle(x2, z2, h2),
    [x, z, heading] as [number, number, number],
  );

/** Same as `teleportVehicle`, but also snaps the chase camera to the new position/heading — the
 *  camera otherwise follows with a smoothing lag (see e2e/pedestrians.spec.ts's own `teleportPlayer`
 *  for the on-foot equivalent), so a single `renderFrame()` right after a teleport would still show
 *  wherever the camera used to be. Only needed for screenshot/pixel assertions. */
const teleportVehicleAndSnapCamera = (page: Page, x: number, z: number, heading: number) =>
  page.evaluate(
    ({ x: x2, z: z2, heading: h2 }) => {
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
      const v = g.currentVehicle!;
      v.teleport(x2, z2, h2);
      g.cameraRig.snapTo({ position: v.object.position, heading: h2, speed: 0, mode: 'vehicle' });
    },
    { x, z, heading },
  );

const key = (page: Page, code: string, down: boolean) =>
  page.evaluate(([c, d]) => (window as unknown as { __gta7: { setKey(code: string, down: boolean): void } }).__gta7.setKey(c as string, d as boolean), [code, down]);

/**
 * Enter the car the player spawns beside, through the game's own interact key (like
 * e2e/smoke.spec.ts's drive test) rather than by poking `game.mode`/`currentVehicle` directly: the
 * real path also hides the on-foot figure, switches the control hint to the driving one and syncs
 * the headlights, all of which show up in the screenshots these tests take.
 */
const enterFirstVehicle = async (page: Page): Promise<void> => {
  await key(page, 'KeyE', true);
  await simulate(page, 1);
  await key(page, 'KeyE', false);
  await simulate(page, 1);
  expect((await snap(page)).mode).toBe('vehicle');
};

/** Render one frame with a large frame delta so the ~10 Hz-throttled minimap actually redraws (a
 *  plain `renderFrame()` advances its clock by only 1/60 s — see `Minimap.update`). */
const renderFrameAndMinimap = (page: Page) =>
  page.evaluate(() => (window as unknown as { __gta7: { game: { renderFrame(dt: number): void } } }).__gta7.game.renderFrame(0.5));

/** The HUD's mission line (`.hud-mission`): its text, and whether it is showing at all. */
const missionHud = (page: Page) =>
  page.evaluate(() => {
    const el = document.querySelector('.hud-mission') as HTMLElement | null;
    return { text: el?.textContent ?? '', hidden: el?.hidden ?? true };
  });

/**
 * Count the mission-marker coloured pixels actually painted on the minimap canvas: orange
 * (`#ff8c2b`) start rings and magenta (`#ff5ce6`) active-checkpoint rings. Nothing else the minimap
 * draws is in either hue — the roads/blocks are grey, traffic is near-white, pedestrians gold
 * (g ~ 210, above the orange window), police and the player arrow cyan/blue (r ~ 63-79, below the
 * red floor) — so a non-zero count means that marker really was drawn.
 */
const minimapMarkerPixels = (page: Page) =>
  page.evaluate(() => {
    const canvas = (window as unknown as { __gta7: { game: { minimap: { canvas: HTMLCanvasElement } } } }).__gta7.game.minimap.canvas;
    // Read back through a scratch copy declared `willReadFrequently` rather than off the minimap's
    // own context: repeated `getImageData` on a GPU-backed canvas makes Chromium log a Canvas2D
    // performance warning, which these tests (rightly) treat as a console error.
    const scratch = document.createElement('canvas');
    scratch.width = canvas.width;
    scratch.height = canvas.height;
    const ctx = scratch.getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(canvas, 0, 0);
    const data = ctx.getImageData(0, 0, scratch.width, scratch.height).data;
    let orange = 0;
    let magenta = 0;
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i]!;
      const g = data[i + 1]!;
      const b = data[i + 2]!;
      if (r > 180 && g > 90 && g < 190 && b < 90) orange++;
      if (r > 180 && g < 120 && b > 140) magenta++;
    }
    return { orange, magenta };
  });

const missionDefs = (page: Page) =>
  page.evaluate(() => (window as unknown as { __gta7: { game: { missionDefs: MissionDef[] } } }).__gta7.game.missionDefs);

test.describe('missions', () => {
  test('generates available missions with markers, none active, zero money at boot', async ({ page }) => {
    await load(page, 'quality=low&cols=8&rows=8&seed=11');
    const s = await snap(page);
    expect(s.missions.available).toBeGreaterThan(0);
    expect(s.missions.active).toBeNull();
    expect(s.missions.checkpoint).toBe(0);
    expect(s.missions.money).toBe(0);
    const defs = await missionDefs(page);
    expect(defs.length).toBe(s.missions.available);
    await page.screenshot({ path: 'e2e/output/missions-markers.png' });
    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('renders a visible glowing start marker column in front of the camera', async ({ page }) => {
    await load(page, 'quality=low&cols=8&rows=8&seed=11');
    await enterFirstVehicle(page);
    const defs = await missionDefs(page);
    const def = defs[0]!;
    // Park the vehicle right on the marker itself (guaranteed to be a valid on-road point — see the
    // unit tests) rather than offsetting by a fixed world distance: since the mission's start edge
    // can run along either axis, an arbitrary fixed offset can just as easily land the vehicle in a
    // building as on the road. The marker is a translucent additive column taller than the car, so
    // it still reads clearly around/above it. `simulate()` is never called here, so this doesn't
    // actually start the mission (which would make the marker disappear).
    await teleportVehicleAndSnapCamera(page, def.start.x, def.start.z, 0);
    await renderFrame(page);
    await refreshHud(page);
    const px = await page.evaluate((grid: number) => (window as unknown as { __gta7: { readPixels(g: number): { mean: number; variance: number; maxLuminance: number } } }).__gta7.readPixels(grid), 24);
    expect(px.variance).toBeGreaterThan(0.002); // not a flat colour
    expect(px.mean).toBeGreaterThan(0.05);
    expect(px.mean).toBeLessThan(0.97); // not washed out
    // The marker is additive/emissive (gold, 0xffd24a): its column should read as a clearly bright
    // patch of pixels against the ordinary-lit road/building scene around it.
    expect(px.maxLuminance).toBeGreaterThan(0.4);
    await page.screenshot({ path: 'e2e/output/missions-marker-closeup.png' });
    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('driving into a start marker begins the mission; reaching every checkpoint in order completes it and pays money', async ({ page }) => {
    await load(page, 'quality=low&cols=8&rows=8&seed=11');
    await enterFirstVehicle(page);
    const defs = await missionDefs(page);
    const def = defs.find((d) => d.type === 'race')!;

    // Drive the marker's start into the vehicle (not the vehicle to some incidental point — same
    // effect either way, `teleportVehicle` just moves the vehicle's own state).
    await teleportVehicle(page, def.start.x, def.start.z, 0);
    await simulate(page, 3);
    let s = await snap(page);
    expect(s.missions.active).toBe(def.id);
    expect(s.missions.checkpoint).toBe(0);
    const moneyAtStart = s.missions.money;

    const lastCheckpoint = def.checkpoints[def.checkpoints.length - 1]!;
    for (let i = 0; i < def.checkpoints.length; i++) {
      const cp = def.checkpoints[i]!;
      await teleportVehicle(page, cp.x, cp.z, 0);
      await simulate(page, 3);
      s = await snap(page);
      if (i < def.checkpoints.length - 1) {
        expect(s.missions.active).toBe(def.id);
        expect(s.missions.checkpoint).toBe(i + 1);
      }
    }

    // Last checkpoint reached: mission complete, no longer active, reward paid.
    expect(s.missions.active).toBeNull();
    expect(s.missions.money).toBe(moneyAtStart + def.reward);
    expect(s.missions.available).toBeLessThan(defs.length); // one fewer mission left to start
    // Snap the camera onto the vehicle at its final (on-road) position before the screenshot — the
    // chase camera otherwise still trails wherever it last was mid-checkpoint-hopping (each
    // `teleportVehicle` above moves the car instantly but not the camera, which follows with a
    // smoothing lag), which can leave it clipped into a nearby building facade. Same fix as the
    // marker-closeup test's `teleportVehicleAndSnapCamera`.
    await teleportVehicleAndSnapCamera(page, lastCheckpoint.x, lastCheckpoint.z, 0);
    await renderFrame(page);
    await refreshHud(page); // so the HUD money readout in the screenshot matches `s.missions.money`
    await page.screenshot({ path: 'e2e/output/missions-complete.png' });
    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('money survives a page reload (localStorage save)', async ({ page }) => {
    await load(page, 'quality=low&cols=8&rows=8&seed=11');
    await enterFirstVehicle(page);
    const defs = await missionDefs(page);
    const def = defs.find((d) => d.type === 'delivery')!;

    await teleportVehicle(page, def.start.x, def.start.z, 0);
    await simulate(page, 3);
    for (const cp of def.checkpoints) {
      await teleportVehicle(page, cp.x, cp.z, 0);
      await simulate(page, 3);
    }
    const before = await snap(page);
    expect(before.missions.money).toBeGreaterThan(0);
    expect(before.missions.active).toBeNull();

    await load(page, 'quality=low&cols=8&rows=8&seed=11'); // reload (same origin -> same localStorage)
    const after = await snap(page);
    expect(after.missions.money).toBe(before.missions.money);
    // The completed mission should no longer be offered again.
    expect(after.missions.available).toBe(before.missions.available);
    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('wrecking the car during an active mission fails it (mission goes inactive without paying)', async ({ page }) => {
    await load(page, 'quality=low&cols=8&rows=8&seed=11');
    await enterFirstVehicle(page);
    const defs = await missionDefs(page);
    const def = defs[0]!;
    await teleportVehicle(page, def.start.x, def.start.z, 0);
    await simulate(page, 3);
    let s = await snap(page);
    expect(s.missions.active).toBe(def.id);
    const moneyBefore = s.missions.money;

    await page.evaluate(() => {
      const g = (window as unknown as { __gta7: { game: { currentVehicle: { damage: number } | null } } }).__gta7.game;
      if (g.currentVehicle) g.currentVehicle.damage = 1;
    });
    await simulate(page, 3);
    s = await snap(page);
    expect(s.missions.active).toBeNull();
    expect(s.missions.money).toBe(moneyBefore);
    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('mission markers survive repeated quality switches without leaking GPU resources', async ({ page }) => {
    await load(page, 'quality=low&cols=8&rows=8&seed=11');
    const setQuality = (name: string) => page.evaluate((n) => (window as unknown as { __gta7: { setQuality(n: string): void } }).__gta7.setQuality(n), name);
    // One warm-up switch first: the very first `applyQuality` call after boot changes some
    // unrelated pipeline resource counts once (a one-time transient, not a leak — the initial
    // construction path and `applyQuality`'s rebuild path don't allocate identically) but every
    // switch after that is stable; baselining post-warm-up isolates the leak check below to actual
    // repeated dispose/rebuild cycles (what `MissionMarkers.setQuality` and its siblings do), not
    // that one-time difference.
    await setQuality('medium');
    await setQuality('low');
    const before = await snap(page);
    expect(before.missions.available).toBeGreaterThan(0);
    // Cycle through every preset (and back to low) twice — `Game.applyQuality` disposes/rebuilds
    // `missionMarkers`' geometry each time (see `MissionMarkers.setQuality`), same as the city view,
    // lighting and rain pipelines it sits alongside.
    for (const name of ['medium', 'high', 'ultra', 'low', 'medium', 'high', 'ultra', 'low']) {
      await setQuality(name);
    }
    const after = await snap(page);
    expect(after.quality).toBe('low');
    // The mission set/state itself is untouched by quality switching.
    expect(after.missions.available).toBe(before.missions.available);
    expect(after.missions.money).toBe(before.missions.money);
    // No leak: geometry/texture counts back on `low` after a full round trip should match the
    // (post-warm-up) baseline, not have grown with every switch.
    expect(after.renderer.geometries).toBe(before.renderer.geometries);
    expect(after.renderer.textures).toBe(before.renderer.textures);
    const px = await page.evaluate(() => (window as unknown as { __gta7: { readPixels(): { variance: number; darkFraction: number } } }).__gta7.readPixels());
    expect(px.variance).toBeGreaterThan(0.002);
    expect(px.darkFraction).toBeLessThan(0.6);
    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('"Reset missions" in the settings menu wipes money/progress and survives a reload', async ({ page }) => {
    await load(page, 'quality=low&cols=8&rows=8&seed=11');
    await enterFirstVehicle(page);
    const defs = await missionDefs(page);
    const def = defs[0]!;
    await teleportVehicle(page, def.start.x, def.start.z, 0);
    await simulate(page, 3);
    for (const cp of def.checkpoints) {
      await teleportVehicle(page, cp.x, cp.z, 0);
      await simulate(page, 3);
    }
    const completed = await snap(page);
    expect(completed.missions.money).toBeGreaterThan(0);
    expect(completed.missions.available).toBeLessThan(defs.length);

    await page.evaluate(() => (window as unknown as { __gta7: { menu: { open(): void } } }).__gta7.menu.open());
    await page.locator('[data-action="resetmissions"]').click();
    const reset = await snap(page);
    expect(reset.missions.money).toBe(0);
    expect(reset.missions.available).toBe(defs.length);
    expect(reset.missions.active).toBeNull();

    await load(page, 'quality=low&cols=8&rows=8&seed=11'); // reload: the reset itself must persist too
    const afterReload = await snap(page);
    expect(afterReload.missions.money).toBe(0);
    expect(afterReload.missions.available).toBe(defs.length);
    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('the HUD points toward the next checkpoint: an arrow, the distance and the clock', async ({ page }) => {
    await load(page, 'quality=low&cols=8&rows=8&seed=11');
    // Nothing active at boot: no mission line at all.
    await refreshHud(page);
    expect((await missionHud(page)).hidden).toBe(true);

    await enterFirstVehicle(page);
    const defs = await missionDefs(page);
    const def = defs.find((d) => d.type === 'race')!;
    await teleportVehicle(page, def.start.x, def.start.z, 0);
    await simulate(page, 3);
    expect((await snap(page)).missions.active).toBe(def.id);

    const cp = def.checkpoints[0]!;
    // Facing +Z (heading 0) 40 m "below" the checkpoint in Z: it is dead ahead.
    // (`teleportVehicle` alone never advances the mission — only `simulate` does, and we don't.)
    await teleportVehicle(page, cp.x, cp.z - 40, 0);
    await refreshHud(page);
    let hud = await missionHud(page);
    expect(hud.hidden).toBe(false);
    // e.g. "\u2191 Race \u00b7 checkpoint 1/4 \u00b7 40m \u00b7 1:12"
    expect(hud.text).toMatch(/^[\u2190-\u2199] Race \u00b7 checkpoint 1\/4 \u00b7 \d+m \u00b7 \d+:\d\d$/);
    expect(hud.text.startsWith('\u2191')).toBe(true);
    expect(hud.text).toContain('40m');

    // Same spot, turned around (heading PI): the checkpoint is now behind the car.
    await teleportVehicle(page, cp.x, cp.z - 40, Math.PI);
    await refreshHud(page);
    hud = await missionHud(page);
    expect(hud.text.startsWith('\u2193')).toBe(true);

    // 40 m away along -X while facing +Z: right = (-cos h, sin h) = (-1, 0), so -X is to the
    // player's right and the arrow must point right (docs/ARCHITECTURE.md's convention).
    await teleportVehicle(page, cp.x + 40, cp.z, 0);
    await refreshHud(page);
    hud = await missionHud(page);
    expect(hud.text.startsWith('\u2192')).toBe(true);

    await teleportVehicle(page, cp.x - 40, cp.z, 0);
    await refreshHud(page);
    hud = await missionHud(page);
    expect(hud.text.startsWith('\u2190')).toBe(true);

    // The clock counts down while the mission runs.
    const timeOf = (text: string) => {
      const m = /(\d+):(\d\d)$/.exec(text)!;
      return Number(m[1]) * 60 + Number(m[2]);
    };
    const before = timeOf(hud.text);
    await simulate(page, 300); // 5 s
    await refreshHud(page);
    const after = timeOf((await missionHud(page)).text);
    expect(after).toBeLessThan(before);
    expect(after).toBeGreaterThan(0);
    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('the active checkpoint is drawn as its own marker column and minimap ring', async ({ page }) => {
    await load(page, 'quality=low&cols=8&rows=8&seed=11');
    // At boot the minimap carries orange start rings and no magenta checkpoint ring.
    await renderFrameAndMinimap(page);
    let px = await minimapMarkerPixels(page);
    expect(px.orange).toBeGreaterThan(0);
    expect(px.magenta).toBe(0);

    await enterFirstVehicle(page);
    const defs = await missionDefs(page);
    const def = defs.find((d) => d.type === 'race')!;
    await teleportVehicle(page, def.start.x, def.start.z, 0);
    await simulate(page, 3);
    const s = await snap(page);
    expect(s.missions.active).toBe(def.id);
    // Starting a mission takes its own start ring off the map...
    expect(s.missions.available).toBe(defs.length - 1);

    // ...and puts a magenta checkpoint ring on it (clamped to the rim when the leg is longer than
    // the minimap's 130 m view range, so it is always visible as a direction).
    await renderFrameAndMinimap(page);
    px = await minimapMarkerPixels(page);
    expect(px.magenta).toBeGreaterThan(0);

    // The checkpoint's own world marker: park on it (a known on-road point) and look at it, the
    // same way the start-marker close-up does.
    const cp = def.checkpoints[0]!;
    await teleportVehicleAndSnapCamera(page, cp.x, cp.z, 0);
    await renderFrame(page);
    await refreshHud(page);
    const frame = await page.evaluate((grid: number) => (window as unknown as { __gta7: { readPixels(g: number): { mean: number; variance: number; maxLuminance: number } } }).__gta7.readPixels(grid), 24);
    expect(frame.variance).toBeGreaterThan(0.002);
    expect(frame.mean).toBeGreaterThan(0.05);
    expect(frame.mean).toBeLessThan(0.97);
    expect(frame.maxLuminance).toBeGreaterThan(0.4); // the additive column reads as a bright patch
    await page.screenshot({ path: 'e2e/output/missions-checkpoint.png' });
    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('markers stay within the low-preset draw-call budget in the full-size default city', async ({ page }) => {
    // The other tests use a small 8x8 city for speed; the shipped default is 14x14, which is what
    // has to stay inside the budget on the weakest devices with every mission marker in the scene.
    await load(page, 'quality=low&seed=7');
    const s = await snap(page);
    expect(s.quality).toBe('low');
    expect(s.missions.available).toBeGreaterThan(0);
    await renderFrame(page);
    const after = await snap(page);
    expect(after.renderer.drawCalls).toBeGreaterThan(5);
    expect(after.renderer.drawCalls).toBeLessThan(400);
    const px = await page.evaluate(() => (window as unknown as { __gta7: { readPixels(): { mean: number; variance: number; darkFraction: number } } }).__gta7.readPixels());
    expect(px.variance).toBeGreaterThan(0.002);
    expect(px.darkFraction).toBeLessThan(0.6);
    expect(errors, errors.join('\n')).toEqual([]);
  });
});
