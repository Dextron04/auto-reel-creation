# Local n8n Reel Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a local Docker/n8n-to-Remotion pipeline for rendering 9:16 reels from 30-second windows of a long source clip.

**Architecture:** n8n triggers a Node HTTP render service. The service validates a JSON render job and invokes a Remotion composition backed by shared media and output folders.

**Tech Stack:** Docker Compose, Node.js, TypeScript/JavaScript, React, Remotion, n8n.

**Spec:** `docs/superpowers/specs/2026-09-12-local-reel-pipeline-design.md`

## Global Constraints

- Canvas is exactly 1080x1920 (9:16).
- Default frame rate is 30 fps.
- Default duration is 900 frames (30 seconds).
- Source, voice, and overlay files are read only from the mounted media directory.
- Platform posting is out of scope for the first slice.

### Task 1: Scaffold renderer

**Files:** Create a Remotion package under `renderer/` with a composition, render entrypoint, and HTTP server.

- [ ] Scaffold the package with Remotion dependencies and a 1080x1920 composition.
- [ ] Add request validation for frame ranges and mounted paths.
- [ ] Add a render endpoint that writes an MP4 into the shared output folder.
- [ ] Verify with a synthetic or user-provided source clip.

### Task 2: Add Docker orchestration

**Files:** Create `docker-compose.yml`, `renderer/Dockerfile`, `.env.example`, `media/.gitkeep`, and `output/.gitkeep`.

- [ ] Define n8n and renderer services with persistent n8n data.
- [ ] Mount the shared media/output folders into both services.
- [ ] Document ports and startup commands.

### Task 3: Add n8n workflow contract

**Files:** Create `n8n/workflows/render-reel.json` and update `README.md`.

- [ ] Add a manual/webhook trigger with topic, research, clip, voice, overlay, and timing fields.
- [ ] POST the normalized payload to the renderer.
- [ ] Return the output path and render metadata.
- [ ] Document how to import the workflow and where to place the 19-minute clip.

### Task 4: Verify end to end

- [ ] Start the stack and inspect health endpoints.
- [ ] Trigger a render using the documented payload.
- [ ] Inspect the resulting MP4 dimensions and duration.
- [ ] Test missing optional voice/PNG and invalid path cases.
