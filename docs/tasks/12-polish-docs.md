# Task 12 — Polish, robustness and documentation

## Goal
Make the game feel finished: loading screen, respawn/wasted flow, camera modes, edge cases, and
documentation with screenshots.

## Design
* Loading: show a simple overlay while the city builds and textures generate (build in idle
  callbacks or a worker if Task 11 added one); fade out on first frame.
* Camera modes (`V`, and the touch `CAM` button which currently queues `cameraTogglePressed` that
  nothing consumes): chase (default), far chase, hood/bonnet cam, cinematic (slow orbit when the
  car idles for 10 s, exits on input). Look-back works in all.
* Input timing bug: `Input.poll()` runs once per fixed update and zeroes the mouse/touch look
  deltas, while `CameraRig` reads `state.lookDX/lookDY` once per rendered frame — on frames with two
  fixed updates the look delta is lost and on frames with none it is applied twice. Accumulate look
  deltas per rendered frame (consume them in `render`, not in `update`) and add a unit test.
* Touch buttons only listen to `touchstart/touchend`; switch to pointer events so hybrid devices
  and `?touch=1` on desktop work with a mouse.
* Low preset at night is too dark away from the lamp pools (roads and kerbs pure black): raise the
  night ambient floor for `maxLocalLights === 0` and/or widen the light-pool decals; keep it
  cheap (no real lights on low). Verify with a night screenshot on low that lane markings are
  readable everywhere on screen.
* Headlight beams should read as cones reaching down the road, not a bright patch at the bumper:
  tune the SpotLight angle/penumbra/decay and add a cheap additive beam-pool decal on the road for
  low (which has no SpotLights).
* Failure states: falling off the world is impossible (clamp to bounds with an invisible wall +
  fog), `wasted` when the player on foot is hit at > 8 m/s (respawn at spawn after 3 s), vehicle
  flipped/stuck detection (if speed < 0.5 for 5 s while throttle held and colliding → nudge).
* Free-roam extras: `R` resets the current vehicle to the nearest lane; `T` toggles the HUD.
* Accessibility: colour-blind-safe minimap palette, remappable keys in the menu (store in settings).
* Docs: README rewrite with feature list, controls table, quality presets table (what each preset
  enables), a "performance on low-end devices" section, and 3-4 screenshots copied from
  `e2e/output` into `docs/screenshots/` (day, night, rain, minimap/wanted). ARCHITECTURE.md updated
  for every module added since the foundation.
* Final sweep: `pnpm verify` green, no `console.warn` in normal play, no TODOs left in code.

## Acceptance criteria
1. e2e: camera modes cycle (`snapshot().cameraMode` changes on `V`), wasted/respawn flow works
   (teleport a fast car into the player on foot → `wasted` then respawn), vehicle reset works.
2. README/ARCHITECTURE updated and accurate (verifier cross-checks against `src/`).
3. `pnpm verify` passes; no console errors/warnings.
