/**
 * videoExporter — record a playing avatar into an audio/video-synced MP4.
 *
 * The core reusable module of this demo. Framework-agnostic — copy it straight into your
 * project.
 *
 * ## Approach
 *
 * Rather than reaching for the underlying frame data (an SDK internal, not exposed by the
 * public API), we CAPTURE THE CANVAS as it plays:
 *
 *   1. When the connection is ready, before sending audio → start recording. The picture
 *      is still a static idle at this point.
 *   2. Each time the SDK finishes a render, `exportBitmap()` grabs a canvas snapshot; we
 *      composite it onto an opaque background.
 *        - Leading IDLE frames (before `playing`) are buffered in `frames` — we can't trim the
 *          start until we know where speaking begins. Idle is only a few seconds, so this is small.
 *        - SPEAKING frames are pushed onto `encodeQueue` and encoded by a PARALLEL drain loop —
 *          never buffered whole. So memory stays bounded no matter how long the avatar talks.
 *   3. When the session enters `playing` (the avatar starts speaking), we record which frame
 *      index that was — the audio anchor.
 *   4. On idle (playback ends), stop() drains the remaining queue, muxes audio, and finalizes.
 *
 * Capture only ever appends (to `frames`, or FIFO to `encodeQueue`), and the drain loop consumes
 * FIFO, so frame order can never scramble.
 *
 * ## Why capture per render rather than on a 40ms timer
 *
 * `exportBitmap()` doesn't trigger a render — it registers a callback that resolves on the
 * SDK's NEXT render. So our capture cadence naturally follows the SDK's render cadence: we
 * grab exactly as many frames as it renders, with no duplicated or skipped frames. A private
 * timer would race the render loop.
 *
 * ## Two things that keep this correct AND memory-bounded (both matter — see the fields)
 *
 *   - Capture NEVER awaits the encoder. Encoding a speaking frame carries real H.264 backpressure;
 *     if capture waited on it, the encoder stall at the idle→speaking boundary would starve capture
 *     and the SDK's 5-frame start-transition would be skipped — a visible pose JUMP. So capture just
 *     enqueues and moves on; a separate loop encodes. (See `enqueue` / `drainEncodeQueue`.)
 *   - But an unbounded queue would OOM on long clips. So `flowControl` pauses playback when the
 *     queue is high and resumes when it drains — freezing the SDK's audio clock stops new frames
 *     with ZERO drops, capping memory at ~high-water frames regardless of length. (See `flowControl`.)
 *
 * ## Start padding (padBefore) — keep the last N seconds, drop earlier ones
 *
 * There's an unpredictable server wait between send and playing (the picture
 * stays idle). So the idle recorded between "start recording" and "speaking" = your padBefore
 * + that wait. At stop() we keep only the padBefore seconds immediately before speaking and
 * drop the earlier wait frames — so no matter how long the server took, the clip starts with
 * exactly padBefore.
 *
 * ## A/V sync
 *
 *   - Video: the k-th captured frame is stamped at exactly k×40ms (25fps).
 *   - Audio: starts at (kept leading idle frames × 40ms + 0.2s), silence before that.
 * Wall-clock recording time is irrelevant to the output; the send→playing latency shows up
 * as the leading idle frames, and the audio lands at the speaking frame, so they line up.
 *
 * ## Usage
 *
 *   const exporter = new VideoExporter(view, {
 *     audio, onProgress,
 *     // Optional: bound memory on long recordings. Omit for short clips.
 *     flowControl: { pause: () => controller.pause(), resume: () => controller.resume() },
 *   })
 *   await exporter.start()            // when connected, before send — capture begins
 *   controller.send(audio, true)      // drive with audio
 *   // …on onConversationState === 'playing':
 *   exporter.markAudioStart()         // record the audio anchor (current frame index)
 *   // …on idle (playback ends):
 *   const mp4 = await exporter.stop() // get the MP4
 */
import { Output, Mp4OutputFormat, BufferTarget, CanvasSource, AudioBufferSource, canEncodeAudio } from 'mediabunny'

const FRAME_RATE = 25
const FRAME_SEC = 1 / FRAME_RATE
/** SDK start-transition duration (START_TRANSITION_DURATION_MS=200ms). Audio is pushed this
 *  much further past the playing frame, matching the SDK's own leading silence. */
const START_TRANSITION_SEC = 0.2

/** Only the public `exportBitmap()` is used. Declared as an interface so it's easy to swap/test. */
export interface CapturableView {
  /** Grab the current canvas as a PNG Blob. Public SDK API. */
  exportBitmap(): Promise<Blob | null>
  /** Canvas size, used to set the video resolution. */
  readonly renderSize: { width: number; height: number }
}

/** Audio parameters DECLARED by the caller — not guessed; we use whatever you pass. */
export interface ExportAudio {
  /** Raw PCM bytes (interleaved for multi-channel). */
  pcm: ArrayBuffer
  /** Sample rate. MUST match the sample rate the SDK was initialized with. */
  sampleRate: number
  /** Channel count (1 = mono). */
  channels: number
  /** Sample format, default s16. */
  format?: 's16' | 'f32'
}

export interface VideoExporterOptions {
  /** Audio to mux into the video. Omit for a silent video. */
  audio?: ExportAudio
  /** H.264 bitrate in bits/sec, default 5_000_000. */
  videoBitrate?: number
  /** AAC bitrate in bits/sec, default 128_000. */
  audioBitrate?: number
  /** Called every few encoded frames, for a progress bar. */
  onProgress?: (encodedFrames: number) => void
  /**
   * Video background color (CSS color, default '#1a1a1f').
   *
   * Why it's needed: the SDK canvas is transparent (premultipliedAlpha) and H.264 has no
   * alpha channel, so the export needs an opaque base. And we MUST fill the base first, then
   * composite the avatar's alpha on top — otherwise the avatar's semi-transparent edge pixels
   * land on an empty canvas and show a white fringe.
   */
  background?: string
  /**
   * Background image (above the base color, below the avatar). Drawn `cover`, centered.
   *
   * ⚠️ Must be a data: URL (or same-origin image). Compositing reads the image's pixels back,
   * so a cross-origin image (most image CDNs) without Access-Control-Allow-Origin taints the
   * canvas → the encoder throws SecurityError. A data: URL is same-origin by definition.
   */
  backgroundImage?: string
  /**
   * Extra idle seconds kept at the start (default 0).
   *
   * The frames recorded between "start recording" and "speaking (playing)" are all idle. That
   * span = your intended lead-in + the unpredictable server wait. However long it is, the clip
   * keeps ONLY the padBeforeSec seconds immediately before speaking and drops the earlier
   * frames — so the unpredictable wait is auto-trimmed and the start is exactly padBeforeSec.
   */
  padBeforeSec?: number
  /** Extra idle seconds recorded at the end (after returning to idle) (default 0). */
  padAfterSec?: number
  /**
   * Optional playback flow control — bounds memory on LONG recordings (e.g. a 10-minute clip).
   *
   * The problem: during speaking, capture runs at the SDK's render cadence (~25fps) and never waits
   * on the encoder (that's what keeps the idle→speaking transition from being dropped). If H.264
   * encoding can't keep up, the pending-frame queue grows unbounded — a 10-minute clip could buffer
   * thousands of ~1 MB bitmaps and OOM.
   *
   * The fix, when this hook is provided: once the queue exceeds the high-water mark, `pause()` the
   * playback. Pausing FREEZES the SDK's audio clock, so it stops producing new frames and capture
   * naturally idles — NOT a single frame is dropped (unlike throttling capture, which would skip
   * frames). The encoder drains the backlog; when the queue falls back to the low-water mark,
   * `resume()` continues from the exact same frame. Memory is capped at ~high-water frames.
   *
   * This changes only the WALL-CLOCK recording time, never the output: frame k is still stamped at
   * k×40ms and audio is still anchored to the kept-idle frame count — both independent of how long
   * recording took. The exported video is byte-for-byte what it would be without pausing.
   *
   * Wire it to the SDK's `controller.pause()` / `controller.resume()`. Omit it to disable flow
   * control (fine for short clips where the queue never grows).
   */
  flowControl?: {
    pause(): void
    resume(): void | Promise<void>
  }
  /** Queue length (frames) that triggers a pause. Default 90 (~3.6s @25fps). */
  flowControlHighWater?: number
  /** Queue length (frames) that triggers a resume after a pause. Default 30 (~1.2s). Must be < high-water. */
  flowControlLowWater?: number
}

export class VideoExporter {
  private output: Output
  private videoSource: CanvasSource
  private width: number
  private height: number
  // Lifecycle state. Explicit states rather than a boolean because state callbacks arrive
  // asynchronously: while the 'playing' branch awaits output.start(), the 'idle' callback may
  // already be calling stop(). A state machine makes such ordering deterministic.
  //   idle    → not started yet
  //   running → capturing
  //   stopped → finalized
  private state: 'idle' | 'running' | 'stopped' = 'idle'
  // Leading IDLE frames only (everything captured before 'playing'). Buffered because we can't trim
  // the start until we know the exact speaking frame. Idle is only a few seconds, so this stays small.
  // Speaking frames are NOT stored here — they go through encodeQueue and are encoded by the parallel
  // drain loop (see scheduleCapture / drainEncodeQueue), so memory stays bounded however long the talk.
  private frames: ImageBitmap[] = []
  // Set true once 'playing' fires. From then on every captured frame is a speaking frame and is
  // enqueued for parallel encoding rather than buffered whole.
  private speaking = false
  // How many leading idle frames we've EMITTED once speaking begins (after the start trim). Used as
  // the audio anchor: audio lands at keptIdle×40ms + 0.2s. -1 until computed at the playing moment.
  private keptIdle = -1
  // Running count of frames handed to the encoder; the next frame's timestamp is emittedCount×40ms.
  private emittedCount = 0
  // Frame count when 'playing' fired (= total idle frames captured). null means it never spoke.
  private openFrame: number | null = null
  /** Capture is serialized on this chain so concurrent grabs can't overwrite each other. */
  private chain: Promise<void> = Promise.resolve()
  // ── Capture/encode decoupling (fixes the idle→speaking jump) ─────────────────
  // WHY: videoSource.add() carries real H.264 encoder backpressure — its Promise stalls when the
  // encoder is busy (worst at the first speaking frame: the I-frame is the slowest to encode). If
  // the capture chain AWAITS that add() before scheduling the next exportBitmap(), capture stalls
  // exactly at the idle→speaking boundary; meanwhile the SDK's audio-clock render loop keeps
  // advancing, so the 5-frame (200ms) start-transition gets skipped and the pose visibly jumps.
  // FIX: capture pushes composited frames into this queue and never awaits encoding; a separate
  // consumer drains it. Capture cadence then follows the SDK's render cadence (unaffected by the
  // encoder), so the transition frames are never missed. The queue only grows when encoding briefly
  // falls behind capture (~a few frames), so memory stays far below buffering the whole utterance.
  private encodeQueue: ImageBitmap[] = []
  // The single in-flight encode-drain loop. null when idle; a Promise while draining.
  private draining: Promise<void> | null = null
  // How many speaking frames have been CAPTURED (enqueued), independent of encode progress. padAfter
  // waits on this (a "record M more seconds" measure), not on emittedCount which lags behind encoding.
  private capturedSpeaking = 0
  // Flow control (long-recording memory bound). paused = we've called flowControl.pause() to let the
  // encoder catch up; resume happens once the queue drains to the low-water mark. See flowControl docs.
  private flowPaused = false
  // Serialize pause/resume so a resume() Promise can't race a subsequent pause() (out-of-order calls
  // would desync SDK playback state from flowPaused).
  private flowLock: Promise<void> = Promise.resolve()
  // Audio track is added in start() (must precede output.start); the data is fed in stop().
  private audioSource: AudioBufferSource | null = null
  private audioBuffer: AudioBuffer | null = null
  // Background image is preloaded once in start() (not per frame).
  private bgImage: HTMLImageElement | null = null
  private compositeCanvas: HTMLCanvasElement
  private compositeCtx: CanvasRenderingContext2D

  constructor(private view: CapturableView, private opts: VideoExporterOptions = {}) {
    this.width = view.renderSize.width
    this.height = view.renderSize.height

    // exportBitmap yields a PNG Blob, but the encoder wants a canvas. Use one offscreen canvas
    // as a bridge: draw each decoded bitmap onto it, then let CanvasSource grab it. Reused
    // throughout the export.
    this.compositeCanvas = document.createElement('canvas')
    this.compositeCanvas.width = this.width
    this.compositeCanvas.height = this.height
    this.compositeCtx = this.compositeCanvas.getContext('2d', { alpha: false })!

    this.output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() })
    this.videoSource = new CanvasSource(this.compositeCanvas, {
      codec: 'avc',
      bitrate: opts.videoBitrate ?? 5_000_000,
    })
    // frameRate makes the muxer snap timestamps to the 25fps grid, so "frame k = k×40ms" is
    // enforced by the container.
    this.output.addVideoTrack(this.videoSource, { frameRate: FRAME_RATE })
  }

  /** Call when connected, before sending audio. Capture begins (the picture is still static idle). */
  async start(): Promise<void> {
    if (this.state !== 'idle') return // already started or stopped — no re-entry

    try {
      // Preload the background image once (reused every frame). A load failure doesn't abort
      // recording — it just means no background image.
      if (this.opts.backgroundImage) {
        this.bgImage = await loadImage(this.opts.backgroundImage)
      }
      // The audio track must be added before output.start() (mediabunny requires all tracks
      // before start). Negotiation also happens here: fail early rather than after recording a
      // pile of frames. Note we negotiate the raw audio WITHOUT leading silence — the actual
      // offset (playing frame + 0.2s) isn't known until stop(); the silence is prepended then.
      // The data (add) is also fed in stop().
      if (this.opts.audio) {
        const { buffer, bitrate } = await negotiateAudio(
          pcmToAudioBuffer(this.opts.audio, 0),
          this.opts.audioBitrate ?? 128_000,
        )
        this.audioBuffer = buffer
        this.audioSource = new AudioBufferSource({ codec: 'aac', bitrate })
        this.output.addAudioTrack(this.audioSource)
      }
      await this.output.start()
    } catch (e) {
      // Audio negotiation / start failed: don't leave state mid-way, or stop() would think
      // frames were recorded.
      this.state = 'stopped'
      await this.output.cancel().catch(() => {})
      throw e
    }

    this.state = 'running'
    this.scheduleCapture()
  }

  /** Call once on ConversationState.playing (the avatar starts speaking): record the leading idle
   *  frame count. Only the first call counts. The actual idle flush happens on the capture chain. */
  markAudioStart(): void {
    if (this.openFrame === null) this.openFrame = this.frames.length
  }

  /**
   * Queue one composited frame for encoding WITHOUT awaiting the encoder. The capture path calls
   * this so it never blocks on encoder backpressure (see the encodeQueue comment). Starts the drain
   * loop if it isn't already running, and applies flow control if the queue is growing too large.
   */
  private enqueue(bm: ImageBitmap): void {
    this.encodeQueue.push(bm)
    this.capturedSpeaking++
    if (!this.draining) this.draining = this.drainEncodeQueue()
    this.maybePause()
  }

  /**
   * The single encode consumer: pull composited frames off the queue in strict FIFO order and hand
   * each to the encoder at the next dense timestamp. This is where encoder backpressure is absorbed
   * — it runs independently of the capture chain, so a slow encode never stalls capture. Exits when
   * the queue is empty AND capture has finished; otherwise it parks and is restarted by enqueue().
   */
  private async drainEncodeQueue(): Promise<void> {
    while (this.encodeQueue.length > 0) {
      const bm = this.encodeQueue.shift()!
      this.compositeCtx.drawImage(bm, 0, 0, this.width, this.height)
      bm.close()
      await this.videoSource.add(this.emittedCount * FRAME_SEC, FRAME_SEC)
      this.emittedCount++
      this.opts.onProgress?.(this.emittedCount)
      this.maybeResume() // once we've drained back to the low-water mark, let playback continue
    }
    this.draining = null
  }

  /** Frame counts at which flow control pauses / resumes playback (see flowControl docs). */
  private get highWater(): number { return this.opts.flowControlHighWater ?? 90 }
  private get lowWater(): number { return this.opts.flowControlLowWater ?? 30 }

  /**
   * If the encode backlog exceeds the high-water mark, pause playback so the encoder can catch up.
   * Pausing freezes the SDK's audio clock → no new frames are produced → capture idles with ZERO
   * dropped frames. Only acts while speaking (never during the idle→speaking transition window,
   * which is far shorter than the high-water mark, so this can't fire there and cause a jump).
   */
  private maybePause(): void {
    if (!this.opts.flowControl || this.flowPaused) return
    if (this.encodeQueue.length < this.highWater) return
    this.flowPaused = true
    this.flowLock = this.flowLock.then(() => { this.opts.flowControl!.pause() })
  }

  /** Resume playback once the backlog has drained back to the low-water mark. */
  private maybeResume(): void {
    if (!this.opts.flowControl || !this.flowPaused) return
    if (this.encodeQueue.length > this.lowWater) return
    this.flowPaused = false
    this.flowLock = this.flowLock.then(() => this.opts.flowControl!.resume())
  }

  /**
   * Schedule one capture. exportBitmap resolves on the SDK's next render; we composite the frame.
   *
   *   - Still idle (before 'playing'): APPEND to `frames` — identical to the original. We can't trim
   *     the start yet, so idle frames are buffered (idle is only a few seconds).
   *   - The moment 'playing' has fired: on this same chain link, trim the start EXACTLY like the
   *     original (keep the padBefore frames immediately before `openFrame`), enqueue those kept idle
   *     frames in order, then enqueue this speaking frame. From here on every frame is enqueued and
   *     encoded by the parallel drain loop — only a small queue is buffered, so memory stays bounded
   *     through the whole utterance.
   *
   * CRITICAL: capture NEVER awaits the encoder. It only composites and enqueue()s, then immediately
   * schedules the next capture, so the capture cadence tracks the SDK's render loop. Awaiting
   * videoSource.add() here (as the first streaming version did) let encoder backpressure stall
   * capture right at the idle→speaking boundary and drop the start-transition frames — the pose jump.
   *
   * Enqueuing happens on this single serialized chain, in strict capture order; the drain loop
   * consumes FIFO — so frames can never interleave or scramble.
   */
  private scheduleCapture(): void {
    if (this.state !== 'running') return
    this.chain = this.chain.then(async () => {
      if (this.state !== 'running') return
      const blob = await this.view.exportBitmap()
      if (this.state !== 'running' || !blob) return
      // premultiplyAlpha:'premultiply': the SDK canvas is premultipliedAlpha; decoding/compositing
      // the premultiplied way avoids the edge RGB being amplified into a white fringe.
      const bm = await createImageBitmap(blob, { premultiplyAlpha: 'premultiply' })
      // Composite order: base color → background image (cover, centered) → avatar. H.264 has no
      // alpha, so lay opaque layers first; then the avatar's semi-transparent edges over-blend
      // correctly with the background and show no white fringe.
      const c = document.createElement('canvas')
      c.width = this.width; c.height = this.height
      const cx = c.getContext('2d', { alpha: false })!
      cx.fillStyle = this.opts.background ?? '#1a1a1f'
      cx.fillRect(0, 0, this.width, this.height)
      if (this.bgImage) drawCover(cx, this.bgImage, this.width, this.height)
      cx.drawImage(bm, 0, 0, this.width, this.height)
      bm.close()
      const frame = await createImageBitmap(c)

      if (!this.speaking && this.openFrame !== null) {
        const padBeforeFrames = Math.round((this.opts.padBeforeSec ?? 0) * FRAME_RATE)
        const open = this.openFrame
        const from = Math.max(0, open - padBeforeFrames)
        for (let i = 0; i < this.frames.length; i++) {
          if (i < from) { this.frames[i].close(); continue }
          this.enqueue(this.frames[i])
        }
        this.keptIdle = open - from
        this.frames = []
        this.speaking = true
      }

      if (this.speaking) {
        // Queue for encoding but DON'T await it — capture must keep pace with the SDK's render
        // loop, or the start-transition frames get skipped and the pose jumps. Encoding drains
        // in parallel via drainEncodeQueue().
        this.enqueue(frame)
      } else {
        this.frames.push(frame)
        this.opts.onProgress?.(this.frames.length)
      }
      this.scheduleCapture()
    })
  }

  /**
   * Call when playback ends (back to idle). Finish encoding, mux audio, finalize the MP4.
   *
   * By now most of the work is already done during capture: the start trim happened at the
   * `playing` moment and speaking frames were encoded as they streamed. stop() only:
   *   - End: first record padAfter more seconds of idle (measured by captured frames, not encoded).
   *   - Drain any frames the parallel encoder hasn't caught up on yet.
   *   - Never-spoke case: encode the whole buffered idle clip (nothing was trimmed or streamed).
   *   - Audio: placed at (kept leading idle frames × 40ms + 0.2s).
   */
  async stop(): Promise<{ mp4: ArrayBuffer; durationMs: number }> {
    if (this.state === 'stopped') throw new Error('exporter already stopped')
    if (this.state === 'idle') {
      this.state = 'stopped'
      await this.output.cancel().catch(() => {})
      throw new Error('exporter stopped before it started (no frames captured)')
    }

    // padAfter: record this many more seconds of idle. We measure by CAPTURED frames (capturedSpeaking
    // once speaking; frames.length before speaking) — not emittedCount, which trails behind the
    // parallel encoder and would make padAfter wait on encoding rather than on capture.
    const padAfterFrames = Math.round((this.opts.padAfterSec ?? 0) * FRAME_RATE)
    if (padAfterFrames > 0) {
      const baseline = this.speaking ? this.capturedSpeaking : this.frames.length
      const target = baseline + padAfterFrames
      const reached = () => (this.speaking ? this.capturedSpeaking : this.frames.length) >= target
      while (!reached() && this.state === 'running') {
        await new Promise((r) => setTimeout(r, FRAME_SEC * 1000))
      }
    }

    this.state = 'stopped'
    await this.chain // wait for the last capture to finish enqueuing

    // If we're finalizing while flow-control had playback paused, clear it so the SDK isn't left
    // hanging in a paused state. (Draining below no longer calls maybeResume once flowPaused is false.)
    if (this.flowPaused) {
      this.flowPaused = false
      this.flowLock = this.flowLock.then(() => this.opts.flowControl?.resume())
    }

    try {
      // Two things remain:
      //   1. If it NEVER spoke (openFrame null), the idle frames are still buffered and untrimmed —
      //      queue the whole thing (original behaviour: keep everything). keptIdle stays 0.
      //   2. Otherwise every frame was already queued during capture; keptIdle was set at the playing
      //      moment.
      if (this.openFrame === null) {
        for (const bm of this.frames) this.enqueue(bm)
        this.frames = []
        this.keptIdle = 0
      }
      // Drain any frames the parallel encoder hasn't caught up on yet, then finalize. Loop because a
      // drain pass can finish and a fresh one start across an await boundary; we're done only when the
      // queue is empty and no pass is running.
      while (this.draining || this.encodeQueue.length > 0) {
        if (!this.draining) this.draining = this.drainEncodeQueue()
        await this.draining
      }
      const totalFrames = this.emittedCount

      // ── audio: placed after the kept leading idle (+0.2s, matching the SDK's leading silence) ──
      if (this.audioSource && this.audioBuffer) {
        const leadSec = (this.keptIdle < 0 ? 0 : this.keptIdle) * FRAME_SEC + START_TRANSITION_SEC
        await this.audioSource.add(prependSilence(this.audioBuffer, leadSec))
        this.audioSource.close()
      }
      this.videoSource.close()
      await this.output.finalize()

      const mp4 = (this.output.target as BufferTarget).buffer
      if (!mp4) throw new Error('export: muxer produced no output')
      return { mp4, durationMs: totalFrames * FRAME_SEC * 1000 }
    } catch (e) {
      await this.output.cancel().catch(() => {})
      throw e
    }
  }
}

// ─── Background image ────────────────────────────────────────────────────────

/** Load the background image. Compositing reads pixels back, so it must be CORS-clean (a
 *  data: URL is same-origin). Returns null on failure without aborting the recording. */
function loadImage(src: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const im = new Image()
    if (!src.startsWith('data:')) im.crossOrigin = 'anonymous'
    im.onload = () => resolve(im)
    im.onerror = () => {
      console.warn(`[export] background image failed to load (${src.slice(0, 48)}…) — must be CORS-clean, prefer a data: URL. Skipping background.`)
      resolve(null)
    }
    im.src = src
  })
}

/** Draw an image `cover` over w×h, centered (scale up to just cover, crop the overflow). */
function drawCover(cx: CanvasRenderingContext2D, img: HTMLImageElement, w: number, h: number): void {
  const scale = Math.max(w / img.naturalWidth, h / img.naturalHeight)
  const dw = img.naturalWidth * scale
  const dh = img.naturalHeight * scale
  cx.drawImage(img, (w - dw) / 2, (h - dh) / 2, dw, dh)
}

// ─── Audio: PCM → AudioBuffer + AAC negotiation ──────────────────────────────
// Same logic as the iframe exporter: the caller declares the format, we don't guess; we only
// negotiate when the browser refuses the requested AAC config.

function pcmToAudioBuffer(audio: ExportAudio, leadSilenceSec: number): AudioBuffer {
  const { pcm, sampleRate, channels, format = 's16' } = audio
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) throw new Error(`export: bad sampleRate ${sampleRate}`)
  if (!Number.isInteger(channels) || channels < 1) throw new Error(`export: bad channels ${channels}`)

  let framesPerChannel: number
  let read: (ch: number, i: number) => number
  if (format === 's16') {
    if (pcm.byteLength % 2 !== 0) throw new Error(`export: s16 PCM must be whole samples, got ${pcm.byteLength} bytes`)
    const i16 = new Int16Array(pcm)
    framesPerChannel = Math.floor(i16.length / channels)
    read = (ch, i) => i16[i * channels + ch] / 32768
  } else {
    if (pcm.byteLength % 4 !== 0) throw new Error(`export: f32 PCM must be whole samples, got ${pcm.byteLength} bytes`)
    const f32 = new Float32Array(pcm)
    framesPerChannel = Math.floor(f32.length / channels)
    read = (ch, i) => f32[i * channels + ch]
  }

  const leadFrames = Math.round(leadSilenceSec * sampleRate)
  const total = Math.max(1, leadFrames + framesPerChannel)
  const ctx = new OfflineAudioContext(channels, total, sampleRate)
  const buf = ctx.createBuffer(channels, total, sampleRate)
  for (let ch = 0; ch < channels; ch++) {
    const out = new Float32Array(total)
    for (let i = 0; i < framesPerChannel; i++) out[leadFrames + i] = read(ch, i)
    buf.copyToChannel(out, ch)
  }
  return buf
}

/** Prepend leadSec seconds of silence to an AudioBuffer, returning a new one. Used to push
 *  the audio back to its anchor point. */
function prependSilence(buf: AudioBuffer, leadSec: number): AudioBuffer {
  if (leadSec <= 0) return buf
  const rate = buf.sampleRate
  const leadFrames = Math.round(leadSec * rate)
  const total = leadFrames + buf.length
  const ctx = new OfflineAudioContext(buf.numberOfChannels, total, rate)
  const out = ctx.createBuffer(buf.numberOfChannels, total, rate)
  for (let ch = 0; ch < buf.numberOfChannels; ch++) {
    const data = new Float32Array(total)
    data.set(buf.getChannelData(ch), leadFrames) // [0, leadFrames) stays silent
    out.copyToChannel(data, ch)
  }
  return out
}

async function resample(buf: AudioBuffer, targetRate: number): Promise<AudioBuffer> {
  const frames = Math.ceil(buf.duration * targetRate)
  const ctx = new OfflineAudioContext(buf.numberOfChannels, frames, targetRate)
  const src = ctx.createBufferSource()
  src.buffer = buf
  src.connect(ctx.destination)
  src.start()
  return ctx.startRendering()
}

/**
 * Find an AAC config the browser can actually encode. A low sample rate + high bitrate makes
 * the browser pick HE-AAC and then refuse to encode (e.g. mono @128kbps at a low rate fails
 * outright). Tries options in order of least-to-most change to the audio:
 *   1. original rate + sane bitrate   2. original rate + requested bitrate   3. resample to 48k/44.1k
 */
async function negotiateAudio(buf: AudioBuffer, requestedBitrate: number): Promise<{ buffer: AudioBuffer; bitrate: number }> {
  const rate = buf.sampleRate
  const channels = buf.numberOfChannels
  const sane = Math.min(requestedBitrate, Math.max(32_000, Math.round(rate * channels * 4)))

  for (const bitrate of sane === requestedBitrate ? [requestedBitrate] : [sane, requestedBitrate]) {
    if (await canEncodeAudio('aac', { numberOfChannels: channels, sampleRate: rate, bitrate })) {
      if (bitrate !== requestedBitrate) console.warn(`[export] audio bitrate ${requestedBitrate}→${bitrate} bps (${rate}Hz x${channels})`)
      return { buffer: buf, bitrate }
    }
  }
  for (const target of [48000, 44100]) {
    if (await canEncodeAudio('aac', { numberOfChannels: channels, sampleRate: target, bitrate: requestedBitrate })) {
      console.warn(`[export] ${rate}Hz not AAC-encodable here — resampling to ${target}Hz`)
      return { buffer: await resample(buf, target), bitrate: requestedBitrate }
    }
  }
  throw new Error(`export: browser cannot encode AAC at ${rate}Hz x${channels} or at 48/44.1kHz`)
}
