# AvatarKit Web · Export Audio-Synced Video Demo

Shows how to use the [`@spatius/avatarkit`](https://docs.spatius.ai/) npm package to render an avatar and **record its playback into an audio/video-synced MP4**.

> Full SDK integration docs are at **https://docs.spatius.ai/**. This repo focuses only on "render + record + export".

## What it does

1. Render an avatar with the SDK (`AvatarView`) and drive it to speak;
2. Starting when the avatar begins speaking, **capture the canvas frame-by-frame, following the SDK's render cadence** (`AvatarView.exportBitmap()`);
3. Encode the captured frames to H.264 with [WebCodecs](https://developer.mozilla.org/docs/Web/API/WebCodecs_API), encode audio to AAC, and mux into an MP4 with [mediabunny](https://github.com/Vanilagy/mediabunny);
4. Place the audio at the moment the avatar starts speaking. **A/V sync is structural** (the k-th frame = k×40ms in the video).

The core export logic is in [`src/lib/videoExporter.ts`](src/lib/videoExporter.ts) — **framework-agnostic, copy it straight into your project**. React is just this demo's shell.

## How the avatar is driven

The SDK connects to Motion Server itself (Direct Mode): the demo feeds prepared audio (`public/direct-audio.pcm`) with `controller.send`, and playback starts once the server returns motion. Recording follows `onConversationState` (`playing` / `idle`).

## Run

```bash
npm install
npm run dev        # → http://localhost:5190/
```

1. Fill in **App ID / Session Token / Avatar ID** (get them from the platform — see [Credentials](#credentials) below);
2. Click **Initialize**;
3. Optionally set "extra idle at start / end" and a background image, then click **Record**;
4. When playback ends the MP4 is generated automatically — click to download.

### Credentials

Get the **App ID**, **Avatar ID**, and **Session Token** from the platform at **https://app.spatius.ai/**. See the docs site (https://docs.spatius.ai/) for details on each. Note the session token is short-lived — mint a fresh one if it expires.

### Extra idle at start / end

- **Extra idle at start (N s)**: keep N seconds of static idle at the start of the clip before the avatar speaks. In direct mode there's an unpredictable wait between sending audio and the server returning — that wait is automatically trimmed, so the start is exactly N seconds.
- **Extra idle at end (M s)**: after the avatar finishes and returns to idle, record M more seconds.

### Background image

The SDK canvas is transparent. When exporting you can composite a background: pick a local image and it's drawn behind the avatar (`cover`, centered). The image is read as a `data:` URL so it works without CORS issues.

## ⚠️ Notes

- **Direct Mode is network-sensitive**: a good network with no animation stutter is required for the recording to be **smooth and audio/video-synced**. When network jitter stalls the SDK's rendering, the captured frames become uneven and A/V may drift.


- **Match the canvas size to how large the video will be displayed**: the export resolution equals the canvas resolution (`AvatarView.renderSize`, which follows the mount container size — 512×512 in this demo). If the exported video will be shown large in your scene/page, render at a correspondingly larger canvas size; otherwise it's like scaling up a small image and looks blurry. (Larger also means more memory and slower encoding — see the next note.)

- **Memory is bounded for long recordings**: speaking frames are **encoded as they're captured**, not all held until the end, and playback flow control caps the in-flight backlog. When the encode queue grows past a high-water mark, the exporter **pauses playback** until the encoder catches up, then resumes — freezing the SDK's audio clock stops new frames with **zero dropped frames**, so this only extends the wall-clock recording time and **never changes the exported video** (frame *k* is still at *k*×40 ms). Peak memory therefore stays roughly constant regardless of length: about **~90–100 MB at 512×512** (≈1 MB/frame × the ~90-frame high-water mark), scaling with resolution — a 10-minute clip uses about the same as a 10-second one. Only the leading idle before speaking (a few seconds) is buffered whole, and it's released the moment speaking starts. Tune the thresholds via `flowControlHighWater` / `flowControlLowWater` in `VideoExporterOptions`.

- **Audio start point**: the audio starts **0.2 s after** the `onConversationState` callback becomes `playing` (this 0.2 s matches the SDK's start transition and leading silence).

- **Color difference between the exported video and the canvas is normal**: some color difference between the exported MP4 and the on-screen canvas render is expected (capture, encoding, and color-space conversion all introduce differences). Different players show different amounts — for example, on macOS **VLC is closer to the canvas render than QuickTime Player**.

- **Browser requirement**: relies on WebCodecs (`VideoEncoder` / `AudioEncoder`) — needs **Chrome / Edge** (Firefox 130+, Safari 16.4+).

- **Audio format**: driving audio is **PCM16 (s16le) mono**, and its **sample rate must match the sample rate the SDK was initialized with** — it is not fixed to any particular value. In direct mode the byte length must be even (2 bytes per sample) or the server rejects it and drops the connection.

## Structure

```
src/
  lib/
    videoExporter.ts     ← core: capture-per-render + audio mux + H.264/AAC encode (reusable, framework-agnostic)
    useAvatarSession.ts  ← session lifecycle: init → drive → record/export
  App.tsx                ← demo UI (thin shell, just the caller)
public/
  direct-audio.pcm       ← prepared driving audio
```

## License

See https://docs.spatius.ai/.
