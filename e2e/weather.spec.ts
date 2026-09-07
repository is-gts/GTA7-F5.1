import { expect, test, type Page } from '@playwright/test';

/** Minimal shape we care about from window.__gta7.snapshot() (see src/main.ts). */
interface Snapshot {
  quality: string;
  mode: 'foot' | 'vehicle';
  pipeline: { aa: string; ao: string; bloom: boolean; passes: string[] } | null;
  renderer: { drawCalls: number; geometries: number; textures: number; programs: number };
  weather: { state: 'clear' | 'overcast' | 'rain'; wetness: number; rainVisual: number };
  vehicle: { x: number; z: number; heading: number; speed: number } | null;
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

const errors: string[] = [];

async function load(page: Page, query: string): Promise<void> {
  errors.length = 0;
  page.on('console', (msg) => {
    const text = msg.text();
    if (text.includes('GL Driver Message')) return; // SwiftShader perf notices, not app errors
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
const setQuality = (page: Page, name: string) => page.evaluate((n) => (window as unknown as { __gta7: { setQuality(n: string): void } }).__gta7.setQuality(n), name);

/** Drive the player's car forward a little so the chase camera frames the wet road ahead of it
 *  (with its own headlight cone and any nearby streetlamps/lit windows) rather than the spawn point. */
async function driveForward(page: Page, steps = 90): Promise<void> {
  await key(page, 'KeyE', true);
  await simulate(page, 1);
  await key(page, 'KeyE', false);
  await key(page, 'KeyW', true);
  await simulate(page, steps);
  await key(page, 'KeyW', false);
  await simulate(page, 5); // let the chase camera catch up before rendering
}

test.describe('weather: rain, wet roads, screen-space reflections', () => {
  test('?weather=rain&quality=high&tod=20: rains, wetness climbs, SSR is in the pipeline, screenshot shows rain/reflections', async ({ page }) => {
    await load(page, 'weather=rain&quality=high&tod=20&cols=8&rows=8&seed=7');
    let s = await snap(page);
    expect(s.quality).toBe('high');
    expect(s.weather.state).toBe('rain');
    expect(s.pipeline?.passes).toContain('ssr');

    await driveForward(page, 120);
    // 120 fixed steps (2 s) plus the initial vehicle-entry step is nowhere near enough on its own;
    // simulate further real sim-time so wetness has clearly climbed past the acceptance threshold
    // (WETNESS_RISE_RATE = 1/18 /s — 10 s comfortably clears 0.5) without leaving the 40 s minimum
    // rain duration, so the state can't flip away mid-test.
    await simulate(page, 600);
    s = await snap(page);
    expect(s.weather.state).toBe('rain');
    expect(s.weather.wetness).toBeGreaterThan(0.5);
    expect(s.weather.rainVisual).toBeGreaterThan(0.9);

    for (let i = 0; i < 3; i++) await renderFrame(page);
    const px = await pixels(page);
    await page.screenshot({ path: 'e2e/output/weather-rain-high.png' });
    // A believable night-rain frame: not pitch black (streaks/lit windows/lamps/reflections give it
    // detail), not washed out either.
    expect(px.mean).toBeGreaterThan(0.01);
    expect(px.mean).toBeLessThan(0.6);
    expect(px.variance).toBeGreaterThan(0.0003);
    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('?weather=rain&quality=low: rain still renders, but no SSR and draw calls stay under budget', async ({ page }) => {
    await load(page, 'weather=rain&quality=low&tod=20&cols=8&rows=8&seed=7');
    let s = await snap(page);
    expect(s.quality).toBe('low');
    expect(s.weather.state).toBe('rain');
    expect(s.pipeline?.passes).not.toContain('ssr');

    await driveForward(page, 120);
    await simulate(page, 600);
    s = await snap(page);
    expect(s.weather.wetness).toBeGreaterThan(0.5);

    for (let i = 0; i < 3; i++) await renderFrame(page);
    s = await snap(page);
    expect(s.renderer.drawCalls).toBeLessThan(400);
    const px = await pixels(page);
    await page.screenshot({ path: 'e2e/output/weather-rain-low.png' });
    expect(px.variance).toBeGreaterThan(0.0002);
    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('default weather is clear: no rain, zero wetness, no SSR pass even on high (only when it starts raining)', async ({ page }) => {
    await load(page, 'quality=high&cols=6&rows=6&seed=7');
    const s = await snap(page);
    expect(s.weather.state).toBe('clear');
    expect(s.weather.wetness).toBe(0);
    expect(s.weather.rainVisual).toBe(0);
    // SSR is still *built* on high regardless of weather (it's a quality-gated pass, cheap when
    // wetness is 0 — the resolve shader bails out per-pixel on `reflectivity < 0.015`), but nothing
    // wet exists yet to reflect.
    expect(s.pipeline?.passes).toContain('ssr');
    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('wetness dries after the menu forces the weather back to clear', async ({ page }) => {
    await load(page, 'weather=rain&quality=medium&tod=13&cols=6&rows=6&seed=7');
    await simulate(page, 60 * 15); // 15 s of rain: wetness well above 0
    let s = await snap(page);
    expect(s.weather.state).toBe('rain');
    const wetAtPeak = s.weather.wetness;
    expect(wetAtPeak).toBeGreaterThan(0.5);

    await page.evaluate(() => (window as unknown as { __gta7: { setWeather(name: string): void } }).__gta7.setWeather('clear'));
    s = await snap(page);
    expect(s.weather.state).toBe('clear');
    expect(s.weather.wetness).toBeCloseTo(wetAtPeak, 5); // forcing state doesn't reset wetness

    await simulate(page, 60 * 30); // 30 s of drying (WETNESS_DRY_RATE = 1/70 /s)
    s = await snap(page);
    expect(s.weather.wetness).toBeLessThan(wetAtPeak);
    expect(s.weather.rainVisual).toBe(0);
    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('settings menu weather selector forces rain and is reflected back by snapshot/select value', async ({ page }) => {
    await load(page, 'quality=medium&cols=6&rows=6&seed=7');
    let s = await snap(page);
    expect(s.weather.state).toBe('clear');

    await page.evaluate(() => (window as unknown as { __gta7: { menu: { open(): void; set(k: string, v: unknown): void } } }).__gta7.menu.open());
    await page.evaluate(() => (window as unknown as { __gta7: { menu: { set(k: string, v: unknown): void } } }).__gta7.menu.set('weather', 'rain'));
    s = await snap(page);
    expect(s.weather.state).toBe('rain');
    const selectValue = await page.evaluate(
      () => (document.querySelector('select[data-key="weather"]') as HTMLSelectElement | null)?.value ?? null,
    );
    expect(selectValue).toBe('rain');
    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('quality switching while raining does not leak GPU resources (rain mesh + SSR G-buffer/reflection targets)', async ({ page }) => {
    await load(page, 'weather=rain&quality=low&tod=20&cols=6&rows=6&seed=7');
    await simulate(page, 60 * 12); // get wetness up so SSR/wet-road code paths are actually exercised
    const cycle = ['medium', 'high', 'ultra', 'low', 'medium', 'high', 'ultra', 'low'] as const;
    const afterEachLow: number[] = [];
    for (const name of cycle) {
      await setQuality(page, name);
      await renderFrame(page);
      const s = await snap(page);
      expect(s.quality).toBe(name);
      expect(s.pipeline?.passes.includes('ssr')).toBe(name === 'high' || name === 'ultra');
      if (name === 'low') afterEachLow.push(s.renderer.geometries + s.renderer.textures);
    }
    // Repeated round-trips back to the same ('low') preset should settle at the same resource
    // count, not grow every cycle.
    expect(afterEachLow[1]).toBe(afterEachLow[0]);
    expect(errors, errors.join('\n')).toEqual([]);
  });
});
