# Local n8n Reel Pipeline Design

## Goal

Create a local, Docker-based pipeline that can be triggered from n8n to produce a 9:16 short-form video from a long source clip, a 30-second segment, a local voice overlay, and an optional transparent PNG overlay.

## Scope of the first slice

- Docker Compose starts n8n and a small Node/Remotion render service.
- n8n can call the render service with JSON describing the source video, start time, duration, voice file, and PNG overlay.
- The render service validates inputs, renders a 1080x1920 MP4, and writes it to a mounted output directory.
- The source video is not copied or split permanently; Remotion seeks into the long clip at render time.
- Research and script generation are represented as workflow input fields. They are not coupled to a particular research provider yet.
- Platform posting is intentionally outside this slice and will consume the generated MP4 later.

## Data contract

```json
{
  "sourceVideo": "/media/source.mp4",
  "startFrame": 0,
  "durationInFrames": 900,
  "voiceOverlay": "/media/voice.wav",
  "pngOverlay": "/media/overlay.png",
  "title": "Optional title",
  "research": { "topic": "Optional topic", "notes": "Optional notes" }
}
```

The default frame rate is 30 fps, making 900 frames equal to 30 seconds. The service rejects negative starts, non-positive durations, and paths outside the mounted media directory.

## Architecture

The n8n container owns orchestration and receives manual/webhook triggers. The render container owns Remotion and exposes a local HTTP endpoint. Both containers share `media/` and `output/` mounts. The Remotion composition uses a 1080x1920 canvas, fits the source video to cover the canvas, mixes the voice file when present, and renders the PNG above the video when present.

## Acceptance criteria

1. `docker compose up` starts n8n and the renderer.
2. A documented curl request or n8n importable workflow can produce a reel from a supplied media file.
3. The output is MP4, 1080x1920, and approximately 30 seconds for the default payload.
4. Missing optional voice/PNG inputs still render successfully.
5. Invalid or unsafe media paths return a clear 4xx response.
