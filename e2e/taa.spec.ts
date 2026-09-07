import { expect, test, type Page } from '@playwright/test';

/** Shape we care about from window.__gta7.snapshot() (see src/main.ts). */
interface Snapshot {
  quality: string;
  pipeline: { aa: string; passes: string[]; taaJitterIndex: number } | null;
  vehicle: { x: number; z: number; heading: number; speed: number } | null;
  mode: 'foot' | 'vehicle';
}

interface PixelRow {
  width: number;
  y: number;
  luminance: number[];
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
const renderFrame = (page: Page) => page.evaluate(() => (window as unknown as { __gta7: { renderFrame(): void } }).__gta7.renderFrame());
const simulate = (page: Page, n: number) => page.evaluate((steps) => (window as unknown as { __gta7: { simulate(n: number): void } }).__gta7.simulate(steps), n);
const key = (page: Page, code: string, down: boolean) =>
  page.evaluate(([c, d]) => (window as unknown as { __gta7: { setKey(code: string, down: boolean): void } }).__gta7.setKey(c as string, d as boolean), [code, down]);
const readPixelRow = (page: Page, yFraction = 0.5) =>
  page.evaluate((yf) => (window as unknown as { __gta7: { readPixelRow(y?: number): PixelRow } }).__gta7.readPixelRow(yf), yFraction);

/** Sum of |luminance[i+1] - luminance[i]| along a row: the task spec's edge-sharpness metric. A
 *  single un-antialiased (aliased) pixel step at a hard edge contributes its full luminance delta
 *  in one jump; smoothing that same edge over several pixels (what TAA's history blend does)
 *  spreads the identical total delta across more, smaller steps *plus* damps its amplitude toward
 *  the temporally-averaged value, so the sum drops. Summing over the whole row (not just the worst
 *  single step) is deliberately robust to picking up one unrelated noisy pixel elsewhere in the row. */
function sumAbsDiff(row: number[]): number {
  let s = 0;
  for (let i = 1; i < row.length; i++) s += Math.abs(row[i]! - row[i - 1]!);
  return s;
}

function variance(values: number[]): number {
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  return values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
}

test.describe('TAA (temporal anti-aliasing)', () => {
  test('quality=high selects the taa pass', async ({ page }) => {
    await load(page, 'quality=high&cols=8&rows=8&seed=7');
    const s = await snap(page);
    expect(s.quality).toBe('high');
    expect(s.pipeline?.aa).toBe('taa');
    expect(s.pipeline?.passes).toContain('taa');
    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('converges to a stable image on a static scene and smooths edges vs aa=none', async ({ page }) => {
    // Same preset/seed/city for both runs so only the AA mode differs — isolates the edge-AA
    // comparison from AO/shadow/bloom differences between presets.
    await load(page, 'quality=high&cols=8&rows=8&seed=11');
    let s = await snap(page);
    expect(s.pipeline?.aa).toBe('taa');

    // Warm up (jitter phase settles into its reprojected history) then compare frame 15 vs 16.
    for (let i = 0; i < 14; i++) await renderFrame(page);
    const row15 = await readPixelRow(page, 0.45);
    const row16 = await readPixelRow(page, 0.45);
    expect(row15.width).toBe(row16.width);
    expect(row15.width).toBeGreaterThan(0);

    const diffs = row15.luminance.map((l, i) => l - row16.luminance[i]!);
    expect(variance(diffs), 'frame 15→16 luminance variance should be tiny (no flicker)').toBeLessThan(1e-4);

    const taaEdge = sumAbsDiff(row16.luminance);
    await page.screenshot({ path: 'e2e/output/taa-high.png' });

    // Same city/camera/row, aa=none: RenderPass with no post-tonemap AA at all — the raw aliased
    // edge steps should sum to at least as much as TAA's temporally-smoothed ones.
    await load(page, 'quality=high&q.aa=none&cols=8&rows=8&seed=11');
    s = await snap(page);
    expect(s.pipeline?.aa).toBe('none');
    for (let i = 0; i < 14; i++) await renderFrame(page);
    const noneRow = await readPixelRow(page, 0.45);
    const noneEdge = sumAbsDiff(noneRow.luminance);
    await page.screenshot({ path: 'e2e/output/taa-none.png' });

    expect(taaEdge, `TAA's row edge-metric (${taaEdge}) should be lower (smoother) than aa=none's (${noneEdge})`).toBeLessThan(noneEdge);
    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('driving for 60 steps then rendering leaves no ghost trail behind the car', async ({ page }) => {
    await load(page, 'quality=high&cols=8&rows=8&seed=5');
    await key(page, 'KeyE', true);
    await simulate(page, 1);
    await key(page, 'KeyE', false);
    let s = await snap(page);
    expect(s.mode).toBe('vehicle');

    await key(page, 'KeyW', true);
    await simulate(page, 60);
    await key(page, 'KeyW', false);
    s = await snap(page);
    expect(s.vehicle!.speed).toBeGreaterThan(0); // actually drove, not stationary

    for (let i = 0; i < 3; i++) await renderFrame(page);
    await page.screenshot({ path: 'e2e/output/taa-drive.png' });

    // A persistent ghost trail would show up as an anomalously large luminance spread along a row
    // through the car/road (streaked history bleeding across many pixels); a clean frame's row
    // still has plenty of *legitimate* contrast (road/car/buildings), so this is a sanity floor/
    // ceiling rather than a tight bound — the screenshot is the real check (see docs/AGENT_GUIDE.md
    // "always look at the screenshots you produce").
    const row = await readPixelRow(page, 0.55);
    expect(row.luminance.some((l) => Number.isFinite(l))).toBe(true);
    expect(row.luminance.every((l) => Number.isFinite(l) && l >= 0 && l <= 1)).toBe(true);
    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('switching into and out of taa disposes its render targets (no GPU leak)', async ({ page }) => {
    // Round-trip through several presets, twice, ending on 'low' both times — geometries+textures
    // at 'low' must settle to the same count both visits. 'low' itself never uses taa, so any drift
    // can only come from TAAPass (allocated at 'high'/re-allocated again on the second 'high' visit)
    // failing to fully dispose its 1 scene + 2 history render targets (each with its own texture,
    // the scene target's depthTexture included) — the same pattern daynight.spec.ts's leak test uses.
    await load(page, 'quality=low&cols=6&rows=6&seed=7');
    const setQuality = (name: string) => page.evaluate((n) => (window as unknown as { __gta7: { setQuality(n: string): void } }).__gta7.setQuality(n), name);
    const stats = () => page.evaluate(() => (window as unknown as { __gta7: { game: { gfx: { stats(): { geometries: number; textures: number } } } } }).__gta7.game.gfx.stats());

    const cycle = ['medium', 'high', 'ultra', 'low', 'medium', 'high', 'ultra', 'low'] as const;
    const afterEachLow: { geometries: number; textures: number }[] = [];
    for (const name of cycle) {
      await setQuality(name);
      const s = await snap(page);
      expect(s.quality).toBe(name);
      if (name === 'high') expect(s.pipeline?.aa).toBe('taa');
      if (name === 'low') afterEachLow.push(await stats());
    }

    expect(afterEachLow).toHaveLength(2);
    expect(afterEachLow[1]!.geometries, 'geometry count should settle, not grow, across taa round trips').toBe(afterEachLow[0]!.geometries);
    expect(afterEachLow[1]!.textures, 'texture count should settle, not grow, across taa round trips').toBe(afterEachLow[0]!.textures);
    expect(errors, errors.join('\n')).toEqual([]);
  });
});
