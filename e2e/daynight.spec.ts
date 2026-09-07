import { expect, test, type Page } from '@playwright/test';

/** Minimal shape we care about from window.__gta7.snapshot() (see src/main.ts). */
interface Snapshot {
  mode: 'foot' | 'vehicle';
  quality: string;
  vehicle: { x: number; z: number; heading: number; speed: number } | null;
  time: number;
  envRegens: number;
  localLights: { active: number; max: number };
  renderer: { geometries: number; textures: number; programs: number };
}

interface Pixels {
  width: number;
  height: number;
  mean: number;
  variance: number;
  darkFraction: number;
  maxLuminance: number;
  brightCount: number;
}

/** Minimal shape of `game` needed to poke at internals directly from a few probe tests below. */
interface DebugGame {
  localLights: {
    lights: { intensity: number; position: { x: number; y: number; z: number } }[];
    update: (...args: unknown[]) => void;
  };
  player: {
    state: { x: number; z: number; heading: number; vx: number; vz: number };
    prev: { x: number; z: number; heading: number };
    object: { position: { x: number; y: number; z: number } };
    syncVisual: (alpha: number) => void;
  };
  camera: {
    position: { set: (x: number, y: number, z: number) => void };
    up: { set: (x: number, y: number, z: number) => void };
    lookAt: (x: number, y: number, z: number) => void;
  };
  cameraRig: {
    snapTo: (t: { position: { x: number; y: number; z: number }; heading: number; speed: number; mode: 'foot' | 'vehicle' }) => void;
    update: (...args: unknown[]) => void;
  };
}

const errors: string[] = [];

async function load(page: Page, query: string): Promise<void> {
  errors.length = 0;
  page.on('console', (msg) => {
    const text = msg.text();
    // SwiftShader emits GL performance notices for readPixels; they are not application errors.
    if (text.includes('GL Driver Message')) return;
    if (msg.type() === 'error' || msg.type() === 'warning') errors.push(`${msg.type()}: ${text}`);
  });
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
  await page.goto(`/?autostart=0&${query}`);
  await page.waitForFunction(() => (window as unknown as { __gta7?: { ready: boolean } }).__gta7?.ready === true);
}

const snap = (page: Page) => page.evaluate(() => (window as unknown as { __gta7: { snapshot(): Snapshot } }).__gta7.snapshot());
const pixels = (page: Page) => page.evaluate(() => (window as unknown as { __gta7: { readPixels(): Pixels } }).__gta7.readPixels());
const renderFrame = (page: Page) => page.evaluate(() => (window as unknown as { __gta7: { renderFrame(): void } }).__gta7.renderFrame());
const simulate = (page: Page, n: number) => page.evaluate((steps) => (window as unknown as { __gta7: { simulate(n: number): void } }).__gta7.simulate(steps), n);
const key = (page: Page, code: string, down: boolean) =>
  page.evaluate(([c, d]) => (window as unknown as { __gta7: { setKey(code: string, down: boolean): void } }).__gta7.setKey(c as string, d as boolean), [code, down]);

test.describe('day/night cycle and dynamic street lighting', () => {
  test('medium preset at night: real street PointLights and player headlights light the road', async ({ page }) => {
    await load(page, 'quality=medium&cols=8&rows=8&seed=7&tod=22');
    let s = await snap(page);
    expect(s.quality).toBe('medium');
    // maxLocalLights = 4 on medium; at 22:00 (deep night) the pool near the spawn point should be
    // fully lit, never more than the pool size.
    expect(s.localLights.max).toBe(4);
    expect(s.localLights.active).toBeGreaterThanOrEqual(4);
    expect(s.localLights.active).toBeLessThanOrEqual(s.localLights.max);

    // Get into the car and drive a little way down the road so the chase camera frames the road
    // ahead of it (and its headlight cone) rather than the spawn point itself.
    await key(page, 'KeyE', true);
    await simulate(page, 1);
    await key(page, 'KeyE', false);
    s = await snap(page);
    expect(s.mode).toBe('vehicle');
    await key(page, 'KeyW', true);
    await simulate(page, 90);
    await key(page, 'KeyW', false);
    s = await snap(page);
    expect(s.vehicle).not.toBeNull();
    // Still driving at night: the street-light pool should still be tracking the car.
    expect(s.localLights.active).toBeGreaterThanOrEqual(4);

    for (let i = 0; i < 20; i++) await renderFrame(page);
    await page.evaluate(() => {
      const g = (
        window as unknown as {
          __gta7: {
            game: {
              currentVehicle: { object: { position: unknown }; state: { heading: number } } | null;
              cameraRig: { snapTo(target: { position: unknown; heading: number; speed: number; mode: 'vehicle' }): void };
            };
          };
        }
      ).__gta7.game;
      const v = g.currentVehicle;
      if (!v) return;
      g.cameraRig.snapTo({ position: v.object.position, heading: v.state.heading, speed: 0, mode: 'vehicle' });
    });
    await renderFrame(page);
    const px = await pixels(page);
    expect(px.mean).toBeLessThan(0.55); // night: much darker than a daytime frame
    expect(px.variance).toBeGreaterThan(0.0005); // lit pools/headlight cone/windows give it detail
    await page.screenshot({ path: 'e2e/output/night-headlights.png' });
    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('low preset at night: no real lights, ground light-pool decals substitute instead', async ({ page }) => {
    await load(page, 'quality=low&cols=8&rows=8&seed=7&tod=22');
    const s = await snap(page);
    expect(s.quality).toBe('low');
    expect(s.localLights.max).toBe(0);
    expect(s.localLights.active).toBe(0);
    for (let i = 0; i < 5; i++) await renderFrame(page);
    const px = await pixels(page);
    expect(px.mean).toBeLessThan(0.55);
    expect(px.variance).toBeGreaterThan(0.0003); // emissive lamp heads + ground decals still read
    await page.screenshot({ path: 'e2e/output/night-low-decals.png' });
    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('time advances on its own and the PMREM environment regeneration count stays bounded', async ({ page }) => {
    // tod=11, dayspeed=4: 10 sim-seconds (600 fixed steps at 60 Hz) advances 2.5 game hours,
    // 11:00 -> 13:30, moving the sun ~18° (mostly azimuth, near its peak elevation) — enough to
    // cross the 10° regeneration threshold at least once, unlike a sub-threshold window that would
    // never exercise the throttle at all (see the regression note this replaced).
    await load(page, 'quality=medium&cols=6&rows=6&seed=7&tod=11&dayspeed=4');
    const before = await snap(page);
    expect(before.time).toBeCloseTo(11, 1);
    // The very first `applyTimeOfDay(true)` call at construction always regenerates once.
    expect(before.envRegens).toBe(1);

    await simulate(page, 600);
    const after = await snap(page);
    expect(after.time).toBeGreaterThan(before.time);
    expect(after.time).toBeLessThan(before.time + 3); // sanity: didn't wrap around the whole day
    // The design goal is "regenerate only when the sun moved enough to matter" — verified against a
    // full day's budget in tests/timeOfDay.test.ts. Over this short window the throttle must have
    // actually fired at least once (proving it isn't dead code) while staying well under budget.
    expect(after.envRegens).toBeGreaterThan(before.envRegens);
    expect(after.envRegens).toBeLessThanOrEqual(3);
    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('day-to-night transition: exposure, fog and materials all change without errors', async ({ page }) => {
    await load(page, 'quality=medium&cols=6&rows=6&seed=7&tod=13');
    const dayPixels = await pixels(page);
    await page.evaluate(() => (window as unknown as { __gta7: { setTimeOfDay(h: number): void } }).__gta7.setTimeOfDay(1));
    await renderFrame(page);
    const nightPixels = await pixels(page);
    const nightSnap = await snap(page);
    expect(nightSnap.time).toBeCloseTo(1, 5);
    // A 01:00 frame should read unambiguously darker than a 13:00 (early-afternoon) frame, but
    // still not a totally flat/black image — the night-exposure lift and street/window lights keep
    // some detail.
    expect(nightPixels.mean).toBeLessThan(dayPixels.mean);
    expect(nightPixels.variance).toBeGreaterThan(0.0003);
    expect(nightPixels.darkFraction).toBeLessThan(0.97);
    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('switching quality at night does not leak GPU resources (local lights, headlights, decals)', async ({ page }) => {
    await load(page, 'quality=low&cols=6&rows=6&seed=7&tod=22');
    const setQuality = (name: string) => page.evaluate((n) => (window as unknown as { __gta7: { setQuality(n: string): void } }).__gta7.setQuality(n), name);
    // Enter a vehicle first so headlights get attached/detached across every switch too.
    await key(page, 'KeyE', true);
    await simulate(page, 1);
    await key(page, 'KeyE', false);

    const cycle = ['medium', 'high', 'ultra', 'low', 'medium', 'high', 'ultra', 'low'] as const;
    const afterEachLow: number[] = [];
    for (const name of cycle) {
      await setQuality(name);
      await renderFrame(page);
      const s = await snap(page);
      expect(s.quality).toBe(name);
      expect(s.localLights.max).toBe(name === 'low' ? 0 : name === 'medium' ? 4 : name === 'high' ? 8 : 16);
      if (name === 'low') afterEachLow.push(s.renderer.geometries + s.renderer.textures);
    }
    // Repeated round-trips back to the same ('low') preset should settle at the same resource
    // count, not grow every cycle (each preset switch disposes and rebuilds the city view, the
    // local-light pool and the light-pool decals).
    expect(afterEachLow[1]).toBe(afterEachLow[0]);
    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('medium at night: a street lamp PointLight makes a real, visible ground pool (not just headlights/windows)', async ({ page }) => {
    await load(page, 'quality=medium&cols=8&rows=8&seed=7&tod=22');
    // Teleport the player right in front of one of the currently-active pooled lamp lights, facing
    // it, and frame the chase camera on it directly — isolates the PointLight's own contribution
    // from headlights and emissive windows elsewhere in the frame.
    const framed = await page.evaluate(() => {
      const g = (window as unknown as { __gta7: { game: DebugGame } }).__gta7.game;
      const lamp = g.localLights.lights.find((l) => l.intensity > 0);
      if (!lamp) return false;
      const px = lamp.position.x;
      const pz = lamp.position.z - 6; // stand 6 m south of the lamp, facing it (heading 0 = +Z)
      g.player.state.x = px;
      g.player.state.z = pz;
      g.player.state.heading = 0;
      g.player.state.vx = 0;
      g.player.state.vz = 0;
      g.player.prev.x = px;
      g.player.prev.z = pz;
      g.player.prev.heading = 0;
      g.player.syncVisual(1);
      g.cameraRig.snapTo({ position: g.player.object.position, heading: 0, speed: 0, mode: 'foot' });
      return true;
    });
    expect(framed).toBe(true);
    await renderFrame(page);
    const lit = await pixels(page);
    await page.screenshot({ path: 'e2e/output/night-lamp-pool-on.png' });

    // Freeze the pool (so its own per-frame update can't immediately recompute intensity) and zero
    // out every light, leaving the camera, materials and everything else exactly as they were —
    // isolates just the streetlamp PointLights' visible contribution.
    await page.evaluate(() => {
      const g = (window as unknown as { __gta7: { game: DebugGame } }).__gta7.game;
      g.localLights.update = () => {};
      for (const l of g.localLights.lights) l.intensity = 0;
    });
    await renderFrame(page);
    const dark = await pixels(page);
    await page.screenshot({ path: 'e2e/output/night-lamp-pool-off.png' });

    // A real, visible lit pool must make a clear difference, not the ~10% wash that a too-dim
    // fixture leaves behind (the regression this guards against: BASE_INTENSITY=9 measured ~32/255
    // vs 23.5/255 under the same framing — imperceptible, and invisible to the old coarse
    // whole-frame variance assertion).
    expect(lit.mean).toBeGreaterThan(dark.mean * 1.15);
    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('stars are visible against the night sky on low and medium (not fogged into invisibility)', async ({ page }) => {
    for (const quality of ['low', 'medium'] as const) {
      await load(page, `quality=${quality}&cols=6&rows=6&seed=7&tod=0`);
      // Freeze the camera rig and point the camera straight up from well above the tallest
      // downtown towers (up to ~130 m) -- isolates the star field (and night sky dome) from every
      // building facade and ground light in the scene.
      await page.evaluate(() => {
        const g = (window as unknown as { __gta7: { game: DebugGame } }).__gta7.game;
        g.cameraRig.update = () => {};
        const p = g.player.object.position;
        g.camera.position.set(p.x, 250, p.z);
        g.camera.up.set(0, 0, -1); // avoid the lookAt() singularity when facing straight up
        g.camera.lookAt(p.x + 5, 250 + 400, p.z + 5);
      });
      await renderFrame(page);
      const px = await pixels(page);
      await page.screenshot({ path: `e2e/output/night-stars-${quality}.png` });
      // The sky itself should still read as (near-)black -- this isn't a washed-out frame -- but a
      // real star field puts many individual pixels far brighter than that background. A sparse
      // sampling grid can step clean over 2 px points, which is exactly how PointsMaterial's
      // default `fog: true` fogging the whole field into invisibility slipped past the old
      // variance-only assertion; a full-resolution max/count catches it.
      expect(px.mean).toBeLessThan(0.12);
      expect(px.maxLuminance).toBeGreaterThan(0.4);
      expect(px.brightCount).toBeGreaterThan(5);
      expect(errors, errors.join('\n')).toEqual([]);
    }
  });

  test('toggling day/night and entering/exiting a vehicle never recompiles shaders (constant visible light count)', async ({ page }) => {
    await load(page, 'quality=ultra&cols=8&rows=8&seed=7&tod=12');
    for (let i = 0; i < 3; i++) await renderFrame(page); // warm up compilation of the steady-state materials
    const before = (await snap(page)).renderer.programs;

    await page.evaluate(() => (window as unknown as { __gta7: { setTimeOfDay(h: number): void } }).__gta7.setTimeOfDay(22));
    await renderFrame(page);
    let s = await snap(page);
    expect(s.localLights.active).toBeGreaterThan(0); // night: the pool actually lit up (0 -> 16 lights)

    await key(page, 'KeyE', true);
    await simulate(page, 1);
    await key(page, 'KeyE', false);
    await renderFrame(page);
    s = await snap(page);
    expect(s.mode).toBe('vehicle'); // headlight spot lights now attached and on (0 -> 2 lights)

    await page.evaluate(() => (window as unknown as { __gta7: { setTimeOfDay(h: number): void } }).__gta7.setTimeOfDay(12));
    await renderFrame(page);
    s = await snap(page);
    expect(s.localLights.active).toBe(0); // back to day: pool off, headlights off

    await key(page, 'KeyE', true);
    await simulate(page, 1);
    await key(page, 'KeyE', false);
    await renderFrame(page);
    s = await snap(page);
    expect(s.mode).toBe('foot');

    const after = s.renderer.programs;
    // Lights toggle on/off through `intensity` alone (never `visible`), so the set of *visible*
    // lights in the scene never changes shape across any of the transitions above — no lit
    // material should ever need to compile a new shader variant here.
    expect(after).toBe(before);
    expect(errors, errors.join('\n')).toEqual([]);
  });
});
