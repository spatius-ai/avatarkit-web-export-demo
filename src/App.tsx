/**
 * Demo page — render an AvatarKit avatar and export an audio/video-synced MP4.
 *
 * Kept deliberately thin: the real "how to use it" is in lib/useAvatarSession.ts (session
 * lifecycle) and lib/videoExporter.ts (export). This file just wires them to a few buttons.
 */
import { useEffect, useRef, useState } from 'react'
import { useAvatarSession, type DriveMode } from './lib/useAvatarSession'

// Restore last inputs after a refresh. Local-demo convenience only, not a production
// practice (the token is a short-lived credential).
const load = (k: string, fallback = '') => localStorage.getItem(k) ?? fallback

// Fixtures under public/. direct uses a prepared audio clip; backend uses integration-test data.
const DIRECT_AUDIO = '/direct-audio.pcm'
const BACKEND_AUDIO = '/backend-audio.pcm'
const BACKEND_FRAMES = '/host_replay_frames.bin'
// Sample rate / channels / format must MATCH THE SDK INITIALIZATION CONFIG. The bundled
// fixtures happen to be 16 kHz mono PCM16 — use whatever your SDK is configured for.
const PCM_FORMAT = { sampleRate: 16000, channels: 1, format: 's16' as const }

/** Parse the length-prefixed binary into an array of raw protobuf Messages (mirrors the
 *  integration test's loader). */
function parseFrames(raw: Uint8Array): Uint8Array[] {
  const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength)
  const out: Uint8Array[] = []
  let off = 0
  while (off + 4 <= raw.length) {
    const len = dv.getUint32(off, true); off += 4
    const end = off + len
    if (end > raw.length) break
    out.push(raw.subarray(off, end)); off = end
  }
  return out
}

/** Read a local file as a data: URL (immune to CORS, so the export can composite it). */
function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(r.result as string)
    r.onerror = () => reject(r.error)
    r.readAsDataURL(file)
  })
}

export function App() {
  const stageRef = useRef<HTMLDivElement>(null)
  const { phase, progress, error, boot, speakDirect, speakBackend } = useAvatarSession(stageRef)

  const [appId, setAppId] = useState(() => load('ak_appId', import.meta.env.VITE_APP_ID ?? ''))
  const [avatarId, setAvatarId] = useState(() => load('ak_avatarId', import.meta.env.VITE_AVATAR_ID ?? ''))
  const [token, setToken] = useState(() => load('ak_token'))
  const [mode, setMode] = useState<DriveMode | null>(null) // the initialized mode
  const [padBefore, setPadBefore] = useState('0') // extra idle seconds at the start
  const [padAfter, setPadAfter] = useState('0')   // extra idle seconds at the end
  const [bgImage, setBgImage] = useState<string | null>(null) // background image data: URL
  const [bgName, setBgName] = useState<string>('')            // its filename (for the label)
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null)

  useEffect(() => { localStorage.setItem('ak_appId', appId) }, [appId])
  useEffect(() => { localStorage.setItem('ak_avatarId', avatarId) }, [avatarId])
  useEffect(() => { localStorage.setItem('ak_token', token) }, [token])

  async function onBoot(m: DriveMode) {
    await boot({ appId, sessionToken: token, avatarId, mode: m })
    setMode(m)
  }

  async function onPickBackground(file: File) {
    setBgImage(await fileToDataUrl(file))
    setBgName(file.name)
  }

  function finish(mp4: ArrayBuffer, durationMs: number) {
    setDownloadUrl(URL.createObjectURL(new Blob([mp4], { type: 'video/mp4' })))
    console.log(`export done: ${(mp4.byteLength / 1024 / 1024).toFixed(2)} MB, ${(durationMs / 1000).toFixed(2)}s`)
  }

  const rec = () => ({
    padBefore: Math.max(0, Number(padBefore) || 0),
    padAfter: Math.max(0, Number(padAfter) || 0),
    backgroundImage: bgImage ?? undefined,
  })

  /** direct: fetch the prepared audio, drive the SDK, export. */
  async function onExportDirect() {
    setDownloadUrl(null)
    const buf = await (await fetch(DIRECT_AUDIO)).arrayBuffer()
    const { mp4, durationMs } = await speakDirect(buf.slice(0), { pcm: buf, ...PCM_FORMAT }, rec())
    finish(mp4, durationMs)
  }

  /** backend: fetch the prepared audio + frames, feed the SDK, export. */
  async function onExportBackend() {
    setDownloadUrl(null)
    const [audioBuf, framesBuf] = await Promise.all([
      (await fetch(BACKEND_AUDIO)).arrayBuffer(),
      (await fetch(BACKEND_FRAMES)).arrayBuffer(),
    ])
    const frames = parseFrames(new Uint8Array(framesBuf))
    // Use an independent copy for the mux audio so it isn't consumed with the one fed to the SDK.
    const { mp4, durationMs } = await speakBackend(new Uint8Array(audioBuf), frames, { pcm: audioBuf.slice(0), ...PCM_FORMAT }, rec())
    finish(mp4, durationMs)
  }

  const busy = phase === 'playing' || phase === 'exporting'

  return (
    <div style={shell}>
      {/* ───── left: control panel ───── */}
      <aside style={panel}>
        <div>
          <h2 style={{ margin: '0 0 4px' }}>AvatarKit</h2>
          <p style={{ margin: 0, color: '#8a8a94', fontSize: 12, lineHeight: 1.5 }}>
            Render an avatar → capture per render + mux audio during playback → export a synced MP4.
            Export logic in <code>src/lib/videoExporter.ts</code> — copy it straight into your project.
          </p>
        </div>

        <section style={card}>
          <div style={cardTitle}>1 · Credentials</div>
          <Field label="App ID"><input value={appId} onChange={(e) => setAppId(e.target.value)} style={input} disabled={mode !== null} /></Field>
          <Field label="Session Token"><input value={token} onChange={(e) => setToken(e.target.value)} style={input} placeholder="mint one and paste it here" disabled={mode !== null} /></Field>
          <Field label="Avatar ID"><input value={avatarId} onChange={(e) => setAvatarId(e.target.value)} style={input} disabled={mode !== null} /></Field>
        </section>

        <section style={card}>
          <div style={cardTitle}>2 · Initialize (pick a mode)</div>
          <div style={{ fontSize: 11, color: '#8a8a94', lineHeight: 1.5, marginBottom: 10 }}>
            <b style={{ color: '#b0b0ba' }}>direct</b>: SDK connects to the backend, fed by audio.<br />
            <b style={{ color: '#b0b0ba' }}>backend</b>: host feeds audio + frames, SDK offline (test data).
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={() => onBoot('direct')} disabled={mode !== null || !appId || !token || !avatarId} style={{ ...btn(true), flex: 1 }}>
              {mode === 'direct' ? 'direct ✓' : 'direct'}
            </button>
            <button onClick={() => onBoot('backend')} disabled={mode !== null || !appId || !token || !avatarId} style={{ ...btn(true), flex: 1, background: mode === 'backend' ? '#2b8a5a' : '#7a4fd0' }}>
              {mode === 'backend' ? 'backend ✓' : 'backend'}
            </button>
          </div>
        </section>

        <section style={{ ...card, opacity: mode === null ? 0.5 : 1 }}>
          <div style={cardTitle}>3 · Record</div>
          <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
            <Field label="Extra idle at start (s)">
              <input type="number" min={0} step="0.5" value={padBefore} onChange={(e) => setPadBefore(e.target.value)} style={input} disabled={busy} />
            </Field>
            <Field label="Extra idle at end (s)">
              <input type="number" min={0} step="0.5" value={padAfter} onChange={(e) => setPadAfter(e.target.value)} style={input} disabled={busy} />
            </Field>
          </div>
          <Field label="Background image (optional)">
            <input type="file" accept="image/*" onChange={(e) => e.target.files?.[0] && onPickBackground(e.target.files[0])} disabled={busy} style={{ fontSize: 12 }} />
          </Field>
          {bgImage && (
            <div style={{ fontSize: 11, color: '#8a8a94', marginBottom: 10 }}>
              background: {bgName}{' '}
              <button onClick={() => { setBgImage(null); setBgName('') }} style={linkBtn} disabled={busy}>clear</button>
            </div>
          )}
          <button
            onClick={mode === 'backend' ? onExportBackend : onExportDirect}
            disabled={mode === null || busy}
            style={btn(false)}
          >
            {busy ? 'Recording…' : `Record (${mode ?? 'pick a mode'})`}
          </button>
          {busy && <div style={hint}>captured {progress} frames · {phase === 'playing' ? 'playing' : 'encoding'}</div>}
          {downloadUrl && <a href={downloadUrl} download="avatar-export.mp4" style={dlLink}>⬇ Download MP4</a>}
        </section>

        {error && <div style={errBox}>Error: {error}</div>}
        <div style={{ flex: 1 }} />
        <div style={{ fontSize: 11, color: '#5a5a63' }}>phase: {phase}</div>
      </aside>

      {/* ───── right: preview ───── */}
      <main style={stageWrap}>
        {/* The SDK canvas is transparent. A background layer sits behind it (same box), so the
            live preview shows exactly what the export will composite. */}
        <div style={stageBox}>
          {bgImage && (
            <div style={{ ...bgLayer, backgroundImage: `url("${bgImage}")` }} />
          )}
          <div ref={stageRef} style={stage} />
        </div>
      </main>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 10, flex: 1, minWidth: 0 }}>
      <span style={{ fontSize: 12, color: '#b0b0ba' }}>{label}</span>
      {children}
    </label>
  )
}

const shell: React.CSSProperties = { display: 'flex', height: '100vh', font: '14px system-ui', color: '#e8e8ee', background: '#0e0e12' }
const panel: React.CSSProperties = { width: 340, flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 16, padding: 20, background: '#17171d', borderRight: '1px solid #26262e', overflowY: 'auto' }
const card: React.CSSProperties = { background: '#1e1e26', border: '1px solid #2b2b35', borderRadius: 10, padding: 14 }
const cardTitle: React.CSSProperties = { fontSize: 12, fontWeight: 600, color: '#9a9aa6', marginBottom: 12, letterSpacing: 0.3 }
const input: React.CSSProperties = { padding: '7px 9px', font: 'inherit', fontSize: 13, background: '#0e0e12', border: '1px solid #33333d', borderRadius: 6, color: '#e8e8ee', width: '100%', boxSizing: 'border-box' }
const hint: React.CSSProperties = { marginTop: 10, fontSize: 12, color: '#8a8a94' }
const dlLink: React.CSSProperties = { display: 'inline-block', marginTop: 10, color: '#6aa8ff', fontSize: 13 }
const linkBtn: React.CSSProperties = { background: 'none', border: 'none', color: '#6aa8ff', cursor: 'pointer', fontSize: 11, padding: 0 }
const errBox: React.CSSProperties = { background: '#3a1a1e', border: '1px solid #5a2530', color: '#ff9aa5', padding: 10, borderRadius: 8, fontSize: 12 }
const stageWrap: React.CSSProperties = { flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }
// Positioned box that clips the rounded corners; holds the background layer + the SDK canvas.
const stageBox: React.CSSProperties = { position: 'relative', width: 512, height: 512, maxWidth: '100%', maxHeight: '100%', aspectRatio: '1 / 1', background: '#1a1a1f', borderRadius: 12, overflow: 'hidden', boxShadow: '0 8px 40px rgba(0,0,0,.5)' }
// Background layer behind the transparent canvas (cover, centered) — mirrors the export composite.
const bgLayer: React.CSSProperties = { position: 'absolute', inset: 0, backgroundSize: 'cover', backgroundPosition: 'center' }
// The SDK mounts its (transparent) canvas here; fills the box so the background shows through.
const stage: React.CSSProperties = { position: 'absolute', inset: 0, width: '100%', height: '100%' }

function btn(primary: boolean): React.CSSProperties {
  return {
    width: '100%', padding: '9px 12px', font: 'inherit', fontSize: 13, fontWeight: 600,
    border: 'none', borderRadius: 7, cursor: 'pointer', marginTop: 4,
    background: primary ? '#3b6fe0' : '#2b8a5a', color: '#fff',
  }
}
