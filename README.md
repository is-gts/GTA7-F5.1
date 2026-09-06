# GTA7

An open-world city driving game that runs in the browser on WebGL2, built with TypeScript and
[three.js](https://threejs.org/). The city, its textures and every vehicle are generated
procedurally, so the whole game is a ~220 kB bundle with no asset downloads.

> Fan project name only. Not affiliated with Rockstar Games or the Grand Theft Auto series.

## Play

```bash
pnpm install          # or: npm install
pnpm dev              # http://localhost:5173
```

| Action | Keys |
| --- | --- |
| Drive | `W` / `S` throttle & brake (hold `S` at rest to reverse), `A` / `D` steer, `Space` handbrake |
| On foot | `WASD` move, `Shift` run, click the canvas for mouse look |
| Enter / exit vehicle | `E` |
| Look back | `C` (hold) |
| Quality preset | `1` low, `2` medium, `3` high, `4` ultra |
| Pause | `Esc` |

URL parameters: `?quality=low|medium|high|ultra`, `?seed=7`, `?cols=14&rows=14` (city size),
`?tod=14` (time of day in hours), `?autostart=0` (headless stepping), and per-setting overrides such
as `?q.aa=none&q.shadowMapSize=1024&q.bloom=false` (see `QualitySettings` in `src/core/Quality.ts`).

## Rendering features

* **Physically based shading** (metal/roughness) on every surface; car paint uses a clear-coat
  layer (`MeshPhysicalMaterial`) with image-based reflections.
* **Image-based lighting** from a procedural atmospheric sky, pre-filtered with PMREM.
* **Cascaded shadow maps** (2–4 cascades, up to 4096², Vogel-disk soft PCF) with a cheaper
  single-map mode for low-end GPUs.
* **HDR post-processing pipeline**: half-float render target → GTAO / SSAO → Unreal-style
  bloom (HDR highlights only) → ACES / AgX / Neutral tone mapping → edge anti-aliasing.
* **Anti-aliasing**: FXAA, SMAA 1x, hardware MSAA (2/4/8×) or 4× SSAA, selectable per preset.
* **Procedural textures** with normal maps (asphalt, concrete, facades with lit windows at night).
* Day / night cycle with sun colour, fog and emissive windows / street lamps.

## Scalability (low-spec devices)

* Four quality presets, auto-detected from the GPU string, memory and device class
  (software renderers and integrated GPUs start on *low*).
* **Dynamic resolution scaling** toward a target frame rate, with a per-preset floor.
* Per-chunk **instanced rendering** (thousands of buildings in tens of draw calls),
  per-chunk frustum culling, and **LOD** (full PBR → flat impostor → culled) driven by
  draw distance.
* Half-resolution ambient occlusion, capped device pixel ratio, prop density, anisotropy and
  shadow budget all scale with the preset.
* Fixed-timestep simulation decoupled from the render rate; physics is 2D on the ground plane
  (SAT collisions against a static spatial hash) so it costs microseconds per frame.

## Development

```bash
pnpm typecheck   # strict TypeScript
pnpm test        # vitest unit tests (engine, quality, city generation, physics, input, camera)
pnpm build       # production bundle in dist/
pnpm e2e         # Playwright smoke tests: renders the built game headless (SwiftShader), drives the car
pnpm verify      # all of the above
```

The end-to-end tests read back the framebuffer and assert that every preset produces a lit,
non-uniform image without console errors, that the player can enter the car, drive, brake and exit,
and that steering has the correct handedness. Screenshots land in `e2e/output/`.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the code layout and conventions.
