/**
 * useAvatarSession — a React hook that wires an AvatarKit driving session to the video
 * exporter.
 *
 * It's the "how to use it" core of the demo. The SDK connects to Motion Server itself
 * (Direct Mode):
 *   init → loadAvatar → controller.start() → wait for `connected`
 *     → exporter.start() (begin recording) → controller.send(audio)
 *     → onConversationState=playing (mark the audio anchor) → …capture per render… → idle (produce MP4)
 *
 * The export logic itself lives in lib/videoExporter.ts and is framework-agnostic; this
 * hook only binds it to the session lifecycle.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { AvatarSDK, AvatarManager, AvatarView, DrivingServiceMode, ConversationState, ConnectionState } from '@spatius/avatarkit'
import { VideoExporter, type ExportAudio } from './videoExporter'

export type SessionPhase = 'uninitialized' | 'ready' | 'playing' | 'exporting' | 'done'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export interface UseAvatarSessionConfig {
  appId: string
  sessionToken: string
  avatarId: string
  region?: string
}

export interface ExportResult {
  mp4: ArrayBuffer
  durationMs: number
}

/** Per-recording options. */
export interface RecordOptions {
  /** Extra idle seconds kept at the start of the clip. */
  padBefore: number
  /** Extra idle seconds recorded at the end (after returning to idle). */
  padAfter: number
  /** Optional background image (data: URL). See VideoExporterOptions.backgroundImage. */
  backgroundImage?: string
}

export function useAvatarSession(containerRef: React.RefObject<HTMLElement>) {
  const [phase, setPhase] = useState<SessionPhase>('uninitialized')
  const [progress, setProgress] = useState(0)
  const [error, setError] = useState<string | null>(null)

  const viewRef = useRef<AvatarView | null>(null)
  const exporterRef = useRef<VideoExporter | null>(null)
  // Resolve with the finished MP4 on idle; reject on error so callers never hang forever.
  const exportResolveRef = useRef<((r: ExportResult) => void) | null>(null)
  const exportRejectRef = useRef<((e: Error) => void) | null>(null)

  /** Initialize the SDK, load the avatar, mount the render view. Once only. */
  const boot = useCallback(async (cfg: UseAvatarSessionConfig) => {
    try {
      setError(null)
      await AvatarSDK.initialize(cfg.appId, {
        region: cfg.region ?? 'us-west',
        drivingServiceMode: DrivingServiceMode.direct,
      })
      AvatarSDK.setSessionToken(cfg.sessionToken)

      const avatar = AvatarManager.shared.retrieve(cfg.avatarId) ?? (await AvatarManager.shared.load(cfg.avatarId))
      const view = new AvatarView(avatar, containerRef.current!)
      viewRef.current = view
      setPhase('ready')
    } catch (e) {
      setError((e as Error).message)
    }
  }, [containerRef])

  /** Arm the recording lifecycle: mark the anchor on playing,
   *  produce the MP4 on idle. Returns the exporter and the done Promise. */
  const armExporter = (view: AvatarView, audioForMux: ExportAudio, rec: RecordOptions) => {
    setProgress(0)
    const exporter = new VideoExporter(view, {
      audio: audioForMux,
      onProgress: setProgress,
      padBeforeSec: rec.padBefore,
      padAfterSec: rec.padAfter,
      backgroundImage: rec.backgroundImage,
      // Bound memory on long recordings: when the encode backlog grows, pause playback so the
      // encoder catches up, then resume. Freezing the audio clock stops the SDK producing frames,
      // so nothing is dropped and the exported video is unaffected (frame k stays at k×40ms). The
      // pause/resume it drives re-fire onConversationState (paused / a second playing); the handler
      // below is idempotent for playing (markAudioStart no-ops) and ignores paused, so it's safe.
      flowControl: {
        pause: () => view.controller.pause(),
        resume: () => view.controller.resume(),
      },
    })
    exporterRef.current = exporter

    const done = new Promise<ExportResult>((resolve, reject) => {
      exportResolveRef.current = resolve
      exportRejectRef.current = reject
    })

    let startedPlaying = false
    view.controller.onConversationState = (state: ConversationState) => {
      if (state === ConversationState.playing) {
        startedPlaying = true
        setPhase('playing')
        exporterRef.current?.markAudioStart()
      } else if (state === ConversationState.idle && startedPlaying) {
        const ex = exporterRef.current
        if (!ex) return
        exporterRef.current = null
        setPhase('exporting')
        ex.stop()
          .then((r) => { setPhase('done'); exportResolveRef.current?.(r) })
          .catch((e) => { setError((e as Error).message); exportRejectRef.current?.(e as Error) })
      }
    }
    return { exporter, done }
  }

  /**
   * The SDK connects to Motion Server. Feed audio to drive, record, export.
   * @param audioForDriving Audio fed to the SDK (PCM16 bytes; length must be even).
   * @param audioForMux     Audio muxed into the exported video (raw PCM with declared format).
   */
  const speakDirect = useCallback(async (audioForDriving: ArrayBuffer, audioForMux: ExportAudio, rec: RecordOptions): Promise<ExportResult> => {
    const view = viewRef.current
    if (!view) throw new Error('call boot() first')
    // PCM16 = 2 bytes/sample. Odd length is rejected server-side and drops the WebSocket;
    // fail early with a readable error.
    if (audioForDriving.byteLength % 2 !== 0) {
      throw new Error(`driving audio must be PCM16 (even byte length), got ${audioForDriving.byteLength} bytes`)
    }

    const controller = view.controller
    const { exporter, done } = armExporter(view, audioForMux, rec)

    // Wait until connected. start() only *initiates* the WebSocket asynchronously — its
    // Promise resolving does NOT mean the connection is up.
    const connected = new Promise<void>((resolve, reject) => {
      controller.onConnectionState = (state: ConnectionState) => {
        if (state === ConnectionState.connected) resolve()
        else if (state === ConnectionState.failed) reject(new Error('connection failed'))
      }
    })
    controller.onError = (err) => setError(err.message)

    await controller.initializeAudioContext() // must be in a user gesture; a button click satisfies this
    await controller.start()
    await connected

    // Connected → begin recording. Idle frames are captured from this moment.
    await exporter.start()
    // Record padBefore seconds of idle, then send. This gives enough leading idle frames;
    // the send→playing server wait records a few more, but those extras get trimmed at
    // playing time so the final clip starts with exactly padBefore.
    await sleep(rec.padBefore * 1000)
    controller.send(audioForDriving, true) // feed the whole clip; end=true ends the round

    return done
  }, [])

  // Clean up on unmount.
  useEffect(() => () => {
    viewRef.current?.dispose()
    viewRef.current = null
  }, [])

  return { phase, progress, error, boot, speakDirect }
}
