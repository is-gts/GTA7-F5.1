# Task 06 — Pause / settings menu and touch controls

## Goal
Players can tune graphics without editing URLs: a pause menu with every quality knob, applied live
and persisted; and the game is playable on phones/tablets with on-screen controls.

## Design
* `src/ui/Menu.ts`: DOM overlay opened with `Esc` (and a ⚙ button for touch). Sections:
  * Preset buttons (low/medium/high/ultra) and a "custom" indicator when any knob differs.
  * Knobs bound to `QualitySettings`: render scale slider (0.5-2.0), adaptive resolution toggle +
    target fps, AA mode select (none/fxaa/smaa/msaa/ssaa/taa when available), MSAA samples, AO
    (none/ssao/gtao) + AO scale, bloom, tone mapping, shadows (none/single/csm), shadow map size,
    cascades, shadow distance, soft shadows, draw distance, far distance, anisotropy, env
    reflections, traffic/pedestrian density, prop density, local lights (Task 05).
  * Gameplay: time of day slider (0-24), day speed, invert mouse Y, FOV slider (55-90), HUD
    performance overlay toggle.
  * Buttons: Resume, Reset to preset, Restart game (respawn), and a "Benchmark" button that runs 5 s
    and shows average frame time / draw calls.
  * Apply changes with debouncing (rebuilding the pipeline is expensive); `Game.applyQuality`
    handles the rest; persist via `saveQuality` (extend the saved record with gameplay settings).
  * Keyboard focus: while the menu is open the game is paused, input polling ignores gameplay
    keys, and the pointer is unlocked; closing restores.
* Touch (`src/ui/TouchControls.ts`): shown when `('ontouchstart' in window) || navigator.maxTouchPoints > 0`
  or `?touch=1`. Left virtual joystick (steer / move), right buttons (throttle, brake/reverse,
  handbrake, enter/exit, horn, camera), a pinch/drag area for look. Drive `Input.virtual` only —
  no direct calls into Game. Prevent default touch scrolling on the canvas.
* Mobile defaults: when a touch device is detected and no saved settings exist, start on `low` with
  `maxPixelRatio` 1 and adaptive resolution on.
* `snapshot()` reports `menuOpen`, and `window.__gta7.menu` exposes `open()/close()/set(key, value)`
  for tests.

## Acceptance criteria
1. Unit tests for the settings model (diffing a custom setting against presets, debounce logic,
   persistence round trip including gameplay fields, touch joystick → axis mapping with deadzone).
2. e2e: open the menu via `__gta7.menu.open()`, set AA to `fxaa` and AO to `none`; snapshot shows the
   pipeline rebuilt accordingly and `menuOpen` true, gameplay keys ignored while open (pressing W
   for 60 steps does not move the car), and after `close()` the settings persisted (reload page →
   `quality` custom with aa fxaa). With `?touch=1` the touch overlay exists and dragging the
   joystick (synthetic touch events via Playwright `page.touchscreen` or dispatched TouchEvents)
   produces non-zero `input.virtual.steer`.
3. `pnpm verify` passes; no console errors.
