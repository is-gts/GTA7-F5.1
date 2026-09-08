import { expect, test, type Page } from '@playwright/test';

/** Minimal shape we care about from window.__gta7.snapshot() (see src/main.ts). */
interface Snapshot {
  mode: 'foot' | 'vehicle';
  quality: string;
  vehicle: { x: number; z: number; heading: number; speed: number } | null;
  menuOpen: boolean;
  audio: { started: boolean; muted: boolean; voices: number; contextState: string | null };
}

const errors: string[] = [];

/** `autostart: true` (the real `autostart` param unset — its default is on) makes `Game.start()`
 *  call `Input.attach(window, canvas)`, the real keydown/keyup listeners a live player's keyboard
 *  goes through — required here since the audio gesture must be a *real* DOM event, not the
 *  `__gta7.setKey` synthetic state every other spec uses. */
async function load(page: Page, query: string, opts: { autostart?: boolean } = {}): Promise<void> {
  errors.length = 0;
  page.on('console', (msg) => {
    const text = msg.text();
    if (text.includes('GL Driver Message')) return; // SwiftShader perf notices, not app errors
    if (msg.type() === 'error' || msg.type() === 'warning') errors.push(`${msg.type()}: ${text}`);
  });
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
  const autostartParam = opts.autostart ? '' : 'autostart=0&';
  await page.goto(`/?${autostartParam}${query}`);
  await page.waitForFunction(() => (window as unknown as { __gta7?: { ready: boolean } }).__gta7?.ready === true);
}

const snap = (page: Page) => page.evaluate(() => (window as unknown as { __gta7: { snapshot(): Snapshot } }).__gta7.snapshot());
const simulate = (page: Page, n: number) => page.evaluate((steps) => (window as unknown as { __gta7: { simulate(n: number): void } }).__gta7.simulate(steps), n);
const key = (page: Page, code: string, down: boolean) =>
  page.evaluate(([c, d]) => (window as unknown as { __gta7: { setKey(code: string, down: boolean): void } }).__gta7.setKey(c as string, d as boolean), [code, down]);

interface MenuApi {
  open(): void;
  close(): void;
  isOpen(): boolean;
  set(key: string, value: unknown): void;
}
const menuOpen = (page: Page) => page.evaluate(() => (window as unknown as { __gta7: { menu: MenuApi } }).__gta7.menu.open());
const menuSet = (page: Page, k: string, v: unknown) =>
  page.evaluate(([kk, vv]) => (window as unknown as { __gta7: { menu: MenuApi } }).__gta7.menu.set(kk as string, vv), [k, v]);

const muteCheckboxChecked = (page: Page) =>
  page.evaluate(() => (document.querySelector('input[data-key="mute"]') as HTMLInputElement | null)?.checked ?? null);

test.describe('procedural audio', () => {
  test('AudioContext is never created before a gesture; a real key event starts it with no errors and at least one voice', async ({ page }) => {
    await load(page, 'quality=low&cols=6&rows=6&seed=7', { autostart: true });
    let s = await snap(page);
    expect(s.audio.started).toBe(false);
    expect(s.audio.voices).toBe(0);
    expect(s.audio.contextState).toBeNull();

    // A real DOM key event — the only thing allowed to start the AudioContext (see AudioEngine.ts).
    await page.keyboard.press('KeyW');
    s = await snap(page);
    expect(s.audio.started).toBe(true);
    // Headless Chromium (SwiftShader) may keep the context suspended forever — both outcomes are
    // accepted; what matters is that nothing threw and the graph is actually up (voices >= 1, the
    // always-on ambient bed).
    expect(['running', 'suspended']).toContain(s.audio.contextState);
    expect(s.audio.voices).toBeGreaterThanOrEqual(1);
    expect(s.audio.muted).toBe(false);
    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('setKey (synthetic automation input) never starts audio — only a real gesture does', async ({ page }) => {
    await load(page, 'quality=low&cols=6&rows=6&seed=7', { autostart: true });
    // Drive around a little purely through the automation API (no real DOM events dispatched).
    await key(page, 'KeyW', true);
    await simulate(page, 30);
    await key(page, 'KeyW', false);
    const s = await snap(page);
    expect(s.audio.started).toBe(false);
    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('mute toggles from the settings menu and is reflected in both the checkbox and the snapshot', async ({ page }) => {
    await load(page, 'quality=low&cols=6&rows=6&seed=7', { autostart: true });
    await page.keyboard.press('KeyW'); // start audio
    let s = await snap(page);
    expect(s.audio.started).toBe(true);
    expect(s.audio.muted).toBe(false);

    await menuOpen(page);
    expect(await muteCheckboxChecked(page)).toBe(false);
    await menuSet(page, 'mute', true);
    s = await snap(page);
    expect(s.audio.muted).toBe(true);
    expect(await muteCheckboxChecked(page)).toBe(true);

    await menuSet(page, 'mute', false);
    s = await snap(page);
    expect(s.audio.muted).toBe(false);
    expect(await muteCheckboxChecked(page)).toBe(false);
    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('the M key toggles mute during real play', async ({ page }) => {
    await load(page, 'quality=low&cols=6&rows=6&seed=7', { autostart: true });
    await page.keyboard.press('KeyW'); // start audio
    let s = await snap(page);
    expect(s.audio.started).toBe(true);
    expect(s.audio.muted).toBe(false);

    await page.keyboard.press('KeyM');
    await page.waitForFunction(() => (window as unknown as { __gta7: { snapshot(): Snapshot } }).__gta7.snapshot().audio.muted === true);
    s = await snap(page);
    expect(s.audio.muted).toBe(true);

    await page.keyboard.press('KeyM');
    await page.waitForFunction(() => (window as unknown as { __gta7: { snapshot(): Snapshot } }).__gta7.snapshot().audio.muted === false);
    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('driving, crashing, honking and switching quality after audio has started never throws', async ({ page }) => {
    await load(page, 'quality=low&cols=8&rows=8&seed=7', { autostart: true });
    await page.keyboard.press('KeyW'); // start audio (also nudges the player forward on foot)
    let s = await snap(page);
    expect(s.audio.started).toBe(true);

    // Enter the nearest car, drive and honk the horn — regardless of whether this happens to bump
    // into anything (which would also exercise `playCrash`), none of it should ever throw.
    await key(page, 'KeyE', true);
    await simulate(page, 1);
    await key(page, 'KeyE', false);
    s = await snap(page);
    expect(s.mode).toBe('vehicle');
    await key(page, 'KeyW', true);
    await simulate(page, 300);
    await key(page, 'KeyW', false);
    await key(page, 'KeyH', true); // horn
    await simulate(page, 2);
    await key(page, 'KeyH', false);
    s = await snap(page);
    // A voice graph that's still alive and reporting sanely, regardless of exactly what's audible.
    expect(s.audio.voices).toBeGreaterThanOrEqual(1);

    for (const name of ['medium', 'high', 'low'] as const) {
      await page.evaluate((n) => (window as unknown as { __gta7: { setQuality(n: string): void } }).__gta7.setQuality(n), name);
      await simulate(page, 5);
      s = await snap(page);
      expect(s.quality).toBe(name);
      expect(s.audio.started).toBe(true);
      expect(s.audio.voices).toBeGreaterThanOrEqual(1);
    }
    expect(errors, errors.join('\n')).toEqual([]);
  });
});
