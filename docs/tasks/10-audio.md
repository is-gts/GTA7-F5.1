# Task 10 — Procedural audio

## Goal
Sound without audio assets: an engine that revs with speed and throttle, tyre screech when sliding,
crash thuds scaled by impact, a horn, rain/ambient beds, and police sirens — all synthesised with
WebAudio and started only after a user gesture.

## Design
* `src/audio/AudioEngine.ts`: lazily creates an `AudioContext` on first key/pointer/touch event
  (never before; handle `suspended` state), master/music/sfx gain nodes, and a `mute` toggle bound
  to `M` and the menu. Provide a safe no-op when WebAudio is unavailable (tests/headless).
* Engine: two detuned sawtooth/square oscillators + low-passed noise; RPM from a pure function
  `rpmFromSpeed(speed, throttle, gearCount)` with simple gear shifting; pitch/volume follow RPM;
  unit-test the mapping (monotonic in speed within a gear, shifts at thresholds, idle at rest).
* Screech: noise through a band-pass whose gain follows `|lateralSpeed|` above a threshold and the
  handbrake. Crash: short filtered noise burst with amplitude ∝ impact impulse (from
  `VehicleEntity.lastCollision`), rate-limited. Horn: two-tone oscillator burst on `hornPressed`.
* Ambient: filtered noise bed (city hum) plus rain noise scaled by `wetness` if Task 08 exists;
  police siren (alternating tones) on pursuing police cars with distance attenuation
  (`PannerNode` optional; simple gain by distance is fine).
* Traffic engines: at most 4 nearest AI cars get quiet engine voices (pool the voices).
* `snapshot()` reports `audio: { started, muted, voices }`.

## Acceptance criteria
1. Unit tests for the pure RPM/gear model and the crash amplitude mapping.
2. e2e: before any gesture `audio.started === false`; after `page.keyboard.press('KeyW')` (a real
   key event) `audio.started === true` and the context state is `running` or `suspended` without
   errors (headless Chromium may keep it suspended — assert no exceptions and `voices ≥ 1`).
3. `pnpm verify` passes; no console errors.
