# Flick-Inspired Renderer and Production Gates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add deterministic, reusable motion scene types and ensure production rendering rejects dialogue/visual packages that have not passed the existing editorial requirements.

**Architecture:** Keep Flick out of the runtime. Add a small scene registry consumed by the existing Remotion composition, with a static-image fallback. Add a renderer validation endpoint that checks the already-produced dialogue and visual manifest before `/v1/render` is called.

**Tech Stack:** Node.js ES modules, Express, Remotion, React, n8n workflow JSON, Node test runner.

**Spec:** `docs/superpowers/specs/2026-09-14-trend-editorial-visual-pipeline-design.md`

## Global Constraints

- No Flick bootstrap, npm dependency, or interactive approval is added to scheduled runs.
- Existing 1080×1920 composition, TTS timing, captions, characters, and publishing remain compatible.
- Validation fails closed for missing or malformed visual metadata.
- Existing tests must remain green.

### Task 1: Scene registry and motion components

**Files:**
- Create: `renderer/src/scene-registry.mjs`
- Create: `renderer/src/scene-registry.test.mjs`
- Modify: `renderer/src/Reel.jsx`

**Interfaces:** `resolveSceneType(visual) -> string`; `sceneMotion(visual, frame, fps) -> object`.

- Add scene types for `screenshot-focus`, `terminal-demo`, `connected-workflow`, `metric-counter`, and `static`.
- Preserve current behavior as the `static` fallback.
- Select motion by `visual.scene_type` without changing existing visual input requirements.

### Task 2: Production editorial validation endpoint

**Files:**
- Create: `renderer/src/production-gate.mjs`
- Create: `renderer/src/production-gate.test.mjs`
- Modify: `renderer/src/server.mjs`
- Modify: `n8n/workflows/research-and-render-reel.json`

**Interfaces:** `validateProductionPackage({dialogue, visuals, storyboard, sequenceReview}) -> {ok, errors}`.

- Reuse dialogue anchor and visual-selection checks.
- Require eight distinct judged visuals covering all six turns before rendering.
- Require an explicit passing sequence review when provided.
- Add `/v1/editorial/production-gate` and call it immediately before render in n8n.

### Task 3: Verification and documentation

**Files:**
- Modify: `README.md`

- Add scene-type examples and explain that Flick-inspired templates are local renderer components.
- Run focused tests, full renderer tests, workflow JSON tests, and `git diff --check`.

