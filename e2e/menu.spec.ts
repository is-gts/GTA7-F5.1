import { expect, test, type Page } from '@playwright/test';

/** Shape we care about from window.__gta7.snapshot() (see src/main.ts). */
interface Snapshot {
  mode: 'foot' | 'vehicle';
  quality: string;
  pipeline: { aa: string; ao: string } | null;
  player: { x: number; z: number; heading: number };
  vehicle: { x: number; z: number; heading: number; speed: number } | null;
  menuOpen: boolean;
  touch: boolean;
  input: { virtual: { steer: number; throttle: number; moveX: number; moveY: number } };
  gameplay: { invertMouseY: boolean; fov: number; daySpeed: number; hudPerfOverlay: boolean };
}

const errors: string[] = [];

/** `autostart: true` leaves the real `autostart` param unset (its default is on), which makes
 *  `Game.start()` call `Input.attach(window, canvas)` — the real keydown/keyup listeners a live
 *  player's keyboard goes through. Every other test drives input via `__gta7.setKey`/the menu
 *  automation API directly, so they stick with `autostart=0` (cheaper: no rAF loop) by default. */
async function load(page: Page, query: string, opts: { autostart?: boolean } = {}): Promise<void> {
  errors.length = 0;
  page.on('console', (msg) => {
    const text = msg.text();
    if (text.includes('GL Driver Message')) return;
    if (msg.type() === 'error' || msg.type() === 'warning') errors.push(`${msg.type()}: ${text}`);
  });
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
  const autostartParam = opts.autostart ? '' : 'autostart=0&';
  await page.goto(`/?${autostartParam}${query}`);
  await page.waitForFunction(() => (window as unknown as { __gta7?: { ready: boolean } }).__gta7?.ready === true);
}

const snap = (page: Page) => page.evaluate(() => (window as unknown as { __gta7: { snapshot(): Snapshot } }).__gta7.snapshot());
const pixels = (page: Page) => page.evaluate(() => (window as unknown as { __gta7: { readPixels(): { variance: number } } }).__gta7.readPixels());
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
const menuClose = (page: Page) => page.evaluate(() => (window as unknown as { __gta7: { menu: MenuApi } }).__gta7.menu.close());
const menuSet = (page: Page, k: string, v: unknown) =>
  page.evaluate(([kk, vv]) => (window as unknown as { __gta7: { menu: MenuApi } }).__gta7.menu.set(kk as string, vv), [k, v]);

/** `Input.isDown('forward')` — the raw keyboard state W/ArrowUp feed, read straight off the live
 *  Input instance so a test can tell "the key never reached the game" apart from "the car was
 *  blocked". */
const forwardDown = (page: Page) =>
  page.evaluate(() => (window as unknown as { __gta7: { game: { input: { isDown(a: string): boolean } } } }).__gta7.game.input.isDown('forward'));

const waitForMenu = (page: Page, open: boolean) =>
  page.waitForFunction(
    (want) => (window as unknown as { __gta7: { snapshot(): Snapshot } }).__gta7.snapshot().menuOpen === want,
    open,
  );

/** Dispatch a synthetic single-finger TouchEvent of `type` at (clientX, clientY) on `selector`. */
async function dispatchTouch(page: Page, selector: string, type: 'touchstart' | 'touchmove' | 'touchend', clientX: number, clientY: number): Promise<void> {
  await page.evaluate(
    ([sel, t, x, y]) => {
      const el = document.querySelector(sel as string) as HTMLElement;
      if (!el) throw new Error(`no element for ${sel as string}`);
      const touch = new Touch({ identifier: 1, target: el, clientX: x as number, clientY: y as number });
      const active = t !== 'touchend';
      const ev = new TouchEvent(t as string, {
        touches: active ? [touch] : [],
        targetTouches: active ? [touch] : [],
        changedTouches: [touch],
        bubbles: true,
        cancelable: true,
      });
      el.dispatchEvent(ev);
    },
    [selector, type, clientX, clientY],
  );
}

test.describe('settings menu', () => {
  test('opens via the automation API, live-applies AA/AO, pauses gameplay input, and persists on close', async ({ page }) => {
    await load(page, 'quality=low&cols=6&rows=6&seed=7');

    // Enter the nearest car so we have something whose motion proves gameplay input is (or isn't) live.
    await key(page, 'KeyE', true);
    await simulate(page, 1);
    await key(page, 'KeyE', false);
    let s = await snap(page);
    expect(s.mode).toBe('vehicle');
    const v0 = s.vehicle!;

    await menuOpen(page);
    s = await snap(page);
    expect(s.menuOpen).toBe(true);

    await menuSet(page, 'aa', 'fxaa');
    await menuSet(page, 'ao', 'none');
    s = await snap(page);
    expect(s.pipeline?.aa).toBe('fxaa');
    expect(s.pipeline?.ao).toBe('none');
    expect(s.quality).toBe('custom'); // any manual knob change stops tracking a preset
    const px = await pixels(page);
    expect(px.variance).toBeGreaterThan(0.001); // pipeline rebuild still renders a real frame
    await page.screenshot({ path: 'e2e/output/menu-open.png' });

    // Gameplay keys are ignored while the menu is open: holding W for 60 fixed steps moves nothing.
    await key(page, 'KeyW', true);
    await simulate(page, 60);
    await key(page, 'KeyW', false);
    s = await snap(page);
    expect(s.vehicle!.x).toBe(v0.x);
    expect(s.vehicle!.z).toBe(v0.z);
    expect(s.vehicle!.speed).toBe(0);

    await menuClose(page);
    s = await snap(page);
    expect(s.menuOpen).toBe(false);

    // Closing restores gameplay input.
    await key(page, 'KeyW', true);
    await simulate(page, 30);
    await key(page, 'KeyW', false);
    s = await snap(page);
    expect(s.vehicle!.speed).toBeGreaterThan(0);

    // Persistence round trip: reload without an explicit ?quality= so the saved record is what wins.
    await load(page, 'cols=6&rows=6&seed=7');
    s = await snap(page);
    expect(s.quality).toBe('custom');
    expect(s.pipeline?.aa).toBe('fxaa');
    expect(s.pipeline?.ao).toBe('none');

    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('preset buttons and reset-to-preset apply through the same path', async ({ page }) => {
    await load(page, 'quality=low&cols=6&rows=6&seed=7');
    await menuOpen(page);
    await menuSet(page, 'preset', 'high');
    let s = await snap(page);
    expect(s.quality).toBe('high');
    expect(s.pipeline?.aa).toBe('smaa');

    await menuSet(page, 'aa', 'fxaa');
    s = await snap(page);
    expect(s.quality).toBe('custom');
    expect(s.pipeline?.aa).toBe('fxaa');

    await menuSet(page, 'preset', 'high'); // "reset to preset" is just re-applying the preset
    s = await snap(page);
    expect(s.quality).toBe('high');
    expect(s.pipeline?.aa).toBe('smaa');
    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('gameplay settings (FOV, day speed, HUD overlay) apply without a pipeline rebuild', async ({ page }) => {
    await load(page, 'quality=low&cols=6&rows=6&seed=7');
    let s = await snap(page);
    expect(s.gameplay.fov).toBe(62);
    expect(s.gameplay.hudPerfOverlay).toBe(true);

    await menuOpen(page);
    await menuSet(page, 'fov', 80);
    await menuSet(page, 'hudPerfOverlay', false);
    await menuSet(page, 'invertMouseY', true);
    s = await snap(page);
    expect(s.gameplay.fov).toBe(80);
    expect(s.gameplay.hudPerfOverlay).toBe(false);
    expect(s.gameplay.invertMouseY).toBe(true);
    const perfLine = page.locator('.hud-perf');
    await expect(perfLine).toBeHidden();

    await menuClose(page);
    await load(page, 'cols=6&rows=6&seed=7'); // reload: gameplay settings persisted too
    s = await snap(page);
    expect(s.gameplay.fov).toBe(80);
    expect(s.gameplay.hudPerfOverlay).toBe(false);
    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('focused menu controls keep native keyboard behaviour while the menu is open (arrow keys, space)', async ({ page }) => {
    // autostart: true so Input.attach(window, canvas) is live, matching how a real player's
    // keydown events reach the page — this is the path that previously called preventDefault() on
    // every bound code, swallowing arrow keys/space meant for the focused menu control instead of
    // letting the browser drive it natively, and is also what proves Escape still reaches the game
    // (a real keydown, not the `__gta7.menu.close()` automation hook other tests use).
    await load(page, 'quality=low&cols=6&rows=6&seed=7', { autostart: true });
    await menuOpen(page);
    let s = await snap(page);
    expect(s.menuOpen).toBe(true);

    const renderScale = page.locator('[data-key="renderScale"]');
    const before = Number(await renderScale.inputValue());
    await renderScale.focus();
    await page.keyboard.press('ArrowRight');
    const after = Number(await renderScale.inputValue());
    expect(after).toBeGreaterThan(before);

    const bloom = page.locator('[data-key="bloom"]');
    expect(await bloom.isChecked()).toBe(false); // low preset default
    await bloom.focus();
    await page.keyboard.press('Space');
    expect(await bloom.isChecked()).toBe(true);

    // Escape still closes the menu even while a control has focus. It goes through the real
    // engine's fixed-update loop (not an automation hook), so wait for the next tick to pick it up.
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => (window as unknown as { __gta7: { snapshot(): Snapshot } }).__gta7.snapshot().menuOpen === false);
    s = await snap(page);
    expect(s.menuOpen).toBe(false);
    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('keyboard control survives closing the menu with the mouse (Resume button, preset button)', async ({ page }) => {
    // The regression this guards: Chromium keeps dispatching keydown at the button the player
    // clicked, even after `Menu.close()` hid it (document.activeElement reads <body>), so a
    // target-tag-based "is this a UI control?" check in Input swallowed every gameplay key after
    // the extremely common "Esc -> click Resume -> play" flow, until the canvas was clicked again.
    // autostart so the real window keydown/keyup listeners (Input.attach) are the path under test.
    await load(page, 'quality=low&cols=6&rows=6&seed=7', { autostart: true });

    // Baseline: the keyboard reaches the game before the menu has ever been touched.
    await page.keyboard.down('KeyW');
    expect(await forwardDown(page)).toBe(true);
    await page.keyboard.up('KeyW');
    expect(await forwardDown(page)).toBe(false);

    // A real Escape keypress opens the menu (nothing is pointer-locked — we never clicked the canvas).
    await page.keyboard.press('Escape');
    await waitForMenu(page, true);

    // ...and a real mouse click on Resume closes it.
    await page.locator('[data-action="resume"]').click();
    await waitForMenu(page, false);
    await page.keyboard.down('KeyW');
    expect(await forwardDown(page), 'W must still reach the game after closing the menu with the mouse').toBe(true);
    // ...and it must actually drive the player, not merely register as held.
    const before = (await snap(page)).player;
    await simulate(page, 60);
    const after = (await snap(page)).player;
    expect(Math.hypot(after.x - before.x, after.z - before.z)).toBeGreaterThan(0.5);
    await page.keyboard.up('KeyW');
    expect(await forwardDown(page)).toBe(false);

    // Same after clicking a preset button (which stays focused) and closing with Escape.
    await page.keyboard.press('Escape');
    await waitForMenu(page, true);
    await page.locator('[data-preset="medium"]').click();
    expect((await snap(page)).quality).toBe('medium');
    await page.keyboard.press('Escape');
    await waitForMenu(page, false);
    await page.keyboard.down('KeyW');
    expect(await forwardDown(page), 'W must still reach the game after clicking a preset button').toBe(true);
    await page.keyboard.up('KeyW');

    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('a key released while a menu control has focus does not stay stuck down', async ({ page }) => {
    await load(page, 'quality=low&cols=6&rows=6&seed=7', { autostart: true });
    await page.keyboard.press('Escape');
    await waitForMenu(page, true);

    // Press W with the menu already open (nothing in the menu has focus yet, so this is an
    // ordinary gameplay keydown — it is simply ignored while paused), then give a slider focus and
    // release: the keyup lands on the slider. Filtering keyups by target would leave W stuck down,
    // and the car would take off by itself the moment the menu closed.
    await page.keyboard.down('KeyW');
    expect(await forwardDown(page)).toBe(true);
    await page.locator('[data-key="renderScale"]').focus();
    await page.keyboard.up('KeyW');
    expect(await forwardDown(page)).toBe(false);

    await page.keyboard.press('Escape');
    await waitForMenu(page, false);
    const before = (await snap(page)).player;
    await simulate(page, 60);
    const after = (await snap(page)).player;
    expect(Math.hypot(after.x - before.x, after.z - before.z)).toBeLessThan(0.05);
    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('reset to preset returns to the preset the custom settings came from, even after a reload', async ({ page }) => {
    await load(page, 'quality=low&cols=6&rows=6&seed=7');
    await menuOpen(page);
    await menuSet(page, 'maxTraffic', 0);
    let s = await snap(page);
    expect(s.quality).toBe('custom');
    await menuClose(page);

    // The saved record only says `preset: 'custom'` — the origin preset has to be recovered from
    // the remaining fields, or "Reset to preset" would jump to an unrelated default.
    await load(page, 'cols=6&rows=6&seed=7');
    s = await snap(page);
    expect(s.quality).toBe('custom');
    await menuOpen(page);
    await page.locator('[data-action="reset"]').click();
    s = await snap(page);
    expect(s.quality).toBe('low');
    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('a ?dayspeed= URL override drives the session without being persisted', async ({ page }) => {
    // 5 s/hour is below the menu slider's 10 s minimum: if it leaked into storage it would come
    // back clamped to 10 on the next load and silently change the day length for good.
    await load(page, 'quality=low&cols=6&rows=6&seed=7&dayspeed=5');
    let s = await snap(page);
    expect(s.gameplay.daySpeed).toBe(5); // the slider mirrors the clock actually running

    await menuOpen(page);
    await menuSet(page, 'fov', 70); // an unrelated gameplay change persists the whole record
    await menuClose(page);
    await load(page, 'cols=6&rows=6&seed=7');
    s = await snap(page);
    expect(s.gameplay.fov).toBe(70);
    expect(s.gameplay.daySpeed).toBe(90); // the untouched default, not 5 (nor 5 clamped to 10)

    // Moving the slider itself does persist, override or not.
    await load(page, 'cols=6&rows=6&seed=7&dayspeed=5');
    await menuOpen(page);
    await menuSet(page, 'daySpeed', 120);
    await menuClose(page);
    await load(page, 'cols=6&rows=6&seed=7');
    s = await snap(page);
    expect(s.gameplay.daySpeed).toBe(120);
    expect(errors, errors.join('\n')).toEqual([]);
  });
});

test.describe('touch controls', () => {
  test('the overlay is shown with ?touch=1 and hidden otherwise', async ({ page }) => {
    await load(page, 'quality=low&cols=6&rows=6&seed=7');
    let s = await snap(page);
    expect(s.touch).toBe(false);
    await expect(page.locator('.touch-controls')).toHaveCount(0);

    await load(page, 'quality=low&cols=6&rows=6&seed=7&touch=1');
    s = await snap(page);
    expect(s.touch).toBe(true);
    await expect(page.locator('.touch-controls')).toBeVisible();
    await expect(page.locator('.tc-joystick')).toBeVisible();
    await expect(page.locator('.tc-btn-throttle')).toBeVisible();
    await page.screenshot({ path: 'e2e/output/touch-controls.png' });
    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('dragging the joystick drives input.virtual.steer, and releasing zeroes it', async ({ page }) => {
    await load(page, 'quality=low&cols=6&rows=6&seed=7&touch=1');
    const joystick = page.locator('.tc-joystick');
    const box = await joystick.boundingBox();
    expect(box).not.toBeNull();
    const cx = box!.x + box!.width / 2;
    const cy = box!.y + box!.height / 2;

    let s = await snap(page);
    expect(s.input.virtual.steer).toBe(0);

    await dispatchTouch(page, '.tc-joystick', 'touchstart', cx, cy);
    await dispatchTouch(page, '.tc-joystick', 'touchmove', cx + 40, cy);
    s = await snap(page);
    expect(s.input.virtual.steer).toBeGreaterThan(0);
    expect(s.input.virtual.moveX).toBeGreaterThan(0);

    await dispatchTouch(page, '.tc-joystick', 'touchend', cx + 40, cy);
    s = await snap(page);
    expect(s.input.virtual.steer).toBe(0);
    expect(s.input.virtual.moveX).toBe(0);
    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('the throttle button drives input.virtual.throttle while held', async ({ page }) => {
    await load(page, 'quality=low&cols=6&rows=6&seed=7&touch=1');
    let s = await snap(page);
    expect(s.input.virtual.throttle).toBe(0);
    await dispatchTouch(page, '.tc-btn-throttle', 'touchstart', 0, 0);
    s = await snap(page);
    expect(s.input.virtual.throttle).toBe(1);
    await dispatchTouch(page, '.tc-btn-throttle', 'touchend', 0, 0);
    s = await snap(page);
    expect(s.input.virtual.throttle).toBe(0);
    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('the gear button opens the settings menu', async ({ page }) => {
    await load(page, 'quality=low&cols=6&rows=6&seed=7&touch=1');
    let s = await snap(page);
    expect(s.menuOpen).toBe(false);
    await page.locator('.tc-gear').click();
    s = await snap(page);
    expect(s.menuOpen).toBe(true);
    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('opening the menu from the gear button leaves the keyboard working after it closes', async ({ page }) => {
    // A mouse click on the gear leaves it focused, and Chromium keeps aiming key events at it —
    // so this is the touch-overlay twin of the desktop "close with the mouse" regression.
    await load(page, 'quality=low&cols=6&rows=6&seed=7&touch=1', { autostart: true });
    await page.locator('.tc-gear').click();
    await waitForMenu(page, true);
    await page.keyboard.press('Escape');
    await waitForMenu(page, false);

    await page.keyboard.down('KeyW');
    expect(await forwardDown(page), 'W must still reach the game after using the gear button').toBe(true);
    const before = (await snap(page)).player;
    await simulate(page, 60);
    const after = (await snap(page)).player;
    expect(Math.hypot(after.x - before.x, after.z - before.z)).toBeGreaterThan(0.5);
    await page.keyboard.up('KeyW');
    expect(await forwardDown(page)).toBe(false);
    expect(errors, errors.join('\n')).toEqual([]);
  });
});
