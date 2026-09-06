# Agent guide (implementers and verifiers)

Working directory: `/home/user/GTA7-F5.1` (branch `claude/gta7-game-creation-53g5kb`).

## Read first
* `docs/ARCHITECTURE.md` — layout, conventions (heading/right-vector, fixed step, registry, HDR limits).
* `src/core/Quality.ts` — every rendering/simulation cost must be gated by a preset field.
* The task spec you were given (`docs/tasks/<task>.md`).

## Tooling rules
* Use **pnpm** (`pnpm install`, `pnpm add`); `npm install` crashes in this environment.
* Do not add heavy dependencies. three.js addons (`three/addons/...`) are already available.
* `pnpm verify` = typecheck → unit tests → build → Playwright e2e (headless SwiftShader; ~1-2 min).
  Run it before you finish. Fix everything it reports; never skip, disable or loosen a test.
* e2e screenshots are written to `e2e/output/*.png`; look at them (Read tool) when your change is visual.
* Only one e2e run at a time (port 4173). Never leave servers running.
* Keep the game running on **low** end devices: anything expensive gets a quality gate and a cheap path.
* No `Math.random()` outside `src/world/Random.ts`; simulation stays deterministic and testable.
* Do not commit; the verifier commits. Do not push. Do not touch git history.
* Keep `window.__gta7` (src/main.ts) working; extend `snapshot()` with fields your e2e tests need.
* New pure logic gets a vitest test in `tests/`. New behaviour gets an e2e assertion in `e2e/`.
* TypeScript is strict with `noUncheckedIndexedAccess`; do not weaken `tsconfig.json`.

## Definition of done (what the verifier checks)
1. `pnpm verify` passes from a clean state (`rm -rf dist` first is fine).
2. Every acceptance criterion in the task spec is met and demonstrated by a test or a screenshot.
3. No regressions: existing tests/e2e still pass, no console errors/warnings in e2e, low preset still
   renders under its draw-call budget, quality switching still works.
4. Code follows the conventions above; resources are disposed on quality change; no per-frame
   allocations in hot loops without reason.
5. The diff is scoped to the task (no unrelated refactors).
