import { expect, test, type Page } from '@playwright/test';

/** Snapshot shape returned by window.__gta7.snapshot() (see src/main.ts). */
interface Snapshot {
  mode: 'foot' | 'vehicle';
  quality: string;
  pipeline: { aa: string; ao: string; bloom: boolean; msaaSamples: number; passes: string[] } | null;
  renderer: { drawCalls: number; triangles: number; renderScale: number; width: number; height: number };
  shadows: string;
  player: { x: number; z: number; heading: number };
  vehicle: { x: number; z: number; heading: number; speed: number; damage: number; type: string } | null;
  vehicles: number;
  city: { buildings: number; chunks: number; instancedMeshes: number };
  frame: number;
  updates: number;
}

interface Pixels {
  width: number;
  height: number;
  mean: number;
  variance: number;
  darkFraction: number;
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
const simulate = (page: Page, n: number) => page.evaluate((steps) => (window as unknown as { __gta7: { simulate(n: number): void } }).__gta7.simulate(steps), n);
const key = (page: Page, code: string, down: boolean) =>
  page.evaluate(([c, d]) => (window as unknown as { __gta7: { setKey(code: string, down: boolean): void } }).__gta7.setKey(c as string, d as boolean), [code, down]);

test.describe('GTA7 smoke', () => {
  test('boots on the low preset, renders a non-trivial frame without errors', async ({ page }) => {
    await load(page, 'quality=low&cols=8&rows=8&seed=7');
    const s = await snap(page);
    expect(s.quality).toBe('low');
    expect(s.pipeline?.aa).toBe('fxaa');
    expect(s.pipeline?.ao).toBe('none');
    expect(s.shadows).toBe('single');
    expect(s.city.buildings).toBeGreaterThan(50);
    expect(s.vehicles).toBeGreaterThanOrEqual(4);
    const px = await pixels(page);
    expect(px.width).toBeGreaterThan(0);
    expect(px.mean).toBeGreaterThan(0.05);
    expect(px.mean).toBeLessThan(0.97);
    expect(px.variance).toBeGreaterThan(0.002); // not a flat colour
    expect(px.darkFraction).toBeLessThan(0.6); // not mostly black
    const after = await snap(page);
    expect(after.renderer.drawCalls).toBeGreaterThan(5);
    expect(after.renderer.drawCalls).toBeLessThan(400);
    await page.screenshot({ path: 'e2e/output/low.png' });
    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('player enters the car, drives forward, brakes and exits', async ({ page }) => {
    await load(page, 'quality=low&cols=8&rows=8&seed=7');
    let s = await snap(page);
    expect(s.mode).toBe('foot');
    const startX = s.player.x;
    // Walk forward a little on foot.
    await key(page, 'KeyW', true);
    await simulate(page, 30);
    await key(page, 'KeyW', false);
    s = await snap(page);
    expect(Math.hypot(s.player.x - startX, 0)).toBeGreaterThan(0.3);
    // Enter the nearest car.
    await key(page, 'KeyE', true);
    await simulate(page, 1);
    await key(page, 'KeyE', false);
    s = await snap(page);
    expect(s.mode).toBe('vehicle');
    expect(s.vehicle).not.toBeNull();
    const v0 = s.vehicle!;
    // Accelerate for 3 s of simulated time.
    await key(page, 'KeyW', true);
    await simulate(page, 180);
    s = await snap(page);
    const v1 = s.vehicle!;
    expect(v1.speed).toBeGreaterThan(8);
    const dist = Math.hypot(v1.x - v0.x, v1.z - v0.z);
    expect(dist).toBeGreaterThan(15);
    // Heading should be preserved when driving straight.
    expect(Math.abs(v1.heading - v0.heading)).toBeLessThan(0.05);
    await key(page, 'KeyW', false);
    // Brake until (nearly) stopped. Holding the brake at rest engages reverse (GTA-style), so
    // release it as soon as the car has stopped.
    await key(page, 'KeyS', true);
    let stopped = false;
    for (let i = 0; i < 60 && !stopped; i++) {
      await simulate(page, 5);
      s = await snap(page);
      stopped = s.vehicle!.speed < 0.5;
    }
    await key(page, 'KeyS', false);
    expect(stopped).toBe(true);
    await simulate(page, 60);
    s = await snap(page);
    expect(Math.abs(s.vehicle!.speed)).toBeLessThan(1.5);
    // Exit.
    await key(page, 'KeyE', true);
    await simulate(page, 1);
    await key(page, 'KeyE', false);
    s = await snap(page);
    expect(s.mode).toBe('foot');
    const px = await pixels(page);
    expect(px.variance).toBeGreaterThan(0.002);
    await page.screenshot({ path: 'e2e/output/drive.png' });
    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('steering right turns the car clockwise (heading decreases)', async ({ page }) => {
    await load(page, 'quality=low&cols=6&rows=6&seed=3');
    await key(page, 'KeyE', true);
    await simulate(page, 1);
    await key(page, 'KeyE', false);
    let s = await snap(page);
    expect(s.mode).toBe('vehicle');
    const h0 = s.vehicle!.heading;
    await key(page, 'KeyW', true);
    await simulate(page, 90);
    await key(page, 'KeyD', true);
    await simulate(page, 60);
    s = await snap(page);
    let dh = s.vehicle!.heading - h0;
    while (dh > Math.PI) dh -= Math.PI * 2;
    while (dh < -Math.PI) dh += Math.PI * 2;
    expect(dh).toBeLessThan(-0.15);
    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('switches quality presets at runtime and rebuilds the pipeline', async ({ page }) => {
    await load(page, 'quality=low&cols=6&rows=6&seed=7');
    const setQuality = (name: string) => page.evaluate((n) => (window as unknown as { __gta7: { setQuality(n: string): void } }).__gta7.setQuality(n), name);
    for (const [name, aa, ao, shadows] of [
      ['ultra', 'msaa', 'gtao', 'csm'],
      ['high', 'smaa', 'gtao', 'csm'],
      ['medium', 'smaa', 'none', 'csm'],
      ['low', 'fxaa', 'none', 'single'],
    ] as const) {
      await setQuality(name);
      const px = await pixels(page);
      const s = await snap(page);
      expect(s.quality).toBe(name);
      expect(s.pipeline?.aa).toBe(aa);
      expect(s.pipeline?.ao).toBe(ao);
      expect(s.shadows).toBe(shadows);
      expect(px.variance, `${name} frame should have detail`).toBeGreaterThan(0.002);
      expect(px.darkFraction, `${name} frame should not be black`).toBeLessThan(0.6);
      await page.screenshot({ path: `e2e/output/quality-${name}.png` });
    }
    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('night time lights up windows and lamps without errors', async ({ page }) => {
    await load(page, 'quality=medium&cols=6&rows=6&seed=7&tod=22');
    const px = await pixels(page);
    expect(px.mean).toBeLessThan(0.5);
    expect(px.variance).toBeGreaterThan(0.0005);
    await page.screenshot({ path: 'e2e/output/night.png' });
    expect(errors, errors.join('\n')).toEqual([]);
  });
});
