/**
 * Demo page — render an AvatarKit avatar and export an audio/video-synced MP4.
 *
 * Kept deliberately thin: the real "how to use it" is in lib/useAvatarSession.ts (session
 * lifecycle) and lib/videoExporter.ts (export). This file just wires them to a few buttons.
 */
import { useEffect, useRef, useState } from 'react'
import { useAvatarSession } from './lib/useAvatarSession'

// Restore last inputs after a refresh. Local-demo convenience only, not a production
// practice (the token is a short-lived credential).
const load = (k: string, fallback = '') => localStorage.getItem(k) ?? fallback

// Prepared driving audio under public/.
const DIRECT_AUDIO = '/direct-audio.pcm'
// Sample rate / channels / format must MATCH THE SDK INITIALIZATION CONFIG. The bundled
// fixtures happen to be 16 kHz mono PCM16 — use whatever your SDK is configured for.
const PCM_FORMAT = { sampleRate: 16000, channels: 1, format: 's16' as const }

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
  const { phase, progress, error, boot, speakDirect } = useAvatarSession(stageRef)

  const [appId, setAppId] = useState(() => load('ak_appId', import.meta.env.VITE_APP_ID ?? ''))
  const [avatarId, setAvatarId] = useState(() => load('ak_avatarId', import.meta.env.VITE_AVATAR_ID ?? ''))
  const [token, setToken] = useState(() => load('ak_token'))
  const [ready, setReady] = useState(false) // the SDK is initialized
  const [padBefore, setPadBefore] = useState('0') // extra idle seconds at the start
  const [padAfter, setPadAfter] = useState('0')   // extra idle seconds at the end
  const [bgImage, setBgImage] = useState<string | null>(null) // background image data: URL
  const [bgName, setBgName] = useState<string>('')            // its filename (for the label)
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null)

  useEffect(() => { localStorage.setItem('ak_appId', appId) }, [appId])
  useEffect(() => { localStorage.setItem('ak_avatarId', avatarId) }, [avatarId])
  useEffect(() => { localStorage.setItem('ak_token', token) }, [token])

  async function onBoot() {
    await boot({ appId, sessionToken: token, avatarId })
    setReady(true)
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

  /** Fetch the prepared audio, drive the SDK, export. */
  async function onExport() {
    setDownloadUrl(null)
    const buf = await (await fetch(DIRECT_AUDIO)).arrayBuffer()
    const { mp4, durationMs } = await speakDirect(buf.slice(0), { pcm: buf, ...PCM_FORMAT }, rec())
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
          <Field label="App ID"><input value={appId} onChange={(e) => setAppId(e.target.value)} style={input} disabled={ready} /></Field>
          <Field label="Session Token"><input value={token} onChange={(e) => setToken(e.target.value)} style={input} placeholder="mint one and paste it here" disabled={ready} /></Field>
          <Field label="Avatar ID"><input value={avatarId} onChange={(e) => setAvatarId(e.target.value)} style={input} disabled={ready} /></Field>
        </section>

        <section style={card}>
          <div style={cardTitle}>2 · Initialize</div>
          <button onClick={onBoot} disabled={ready || !appId || !token || !avatarId} style={btn(true)}>
            {ready ? 'Initialized ✓' : 'Initialize'}
          </button>
        </section>

        <section style={{ ...card, opacity: ready ? 1 : 0.5 }}>
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
            onClick={onExport}
            disabled={!ready || busy}
            style={btn(false)}
          >
            {busy ? 'Recording…' : 'Record'}
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
