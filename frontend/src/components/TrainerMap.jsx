/**
 * TrainerMap.jsx — Passage cycling trainer UI
 *
 * Milestone reveal mechanic (locked — do not replace without discussion):
 *   - Thumbnail grows as rider approaches milestone
 *   - On arrival, panel scales out from thumbnail position (spring easing)
 *   - Full-bleed landmark photo, dark text overlay at bottom
 *   - Auto-dismisses after 15s; tap to dismiss early
 *   - Thumbnail stays on map marked as completed (greyscale + ✓)
 */

import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { MapContainer, TileLayer, Polyline, CircleMarker, useMap } from 'react-leaflet'
import { useWebSocket } from '../hooks/useWebSocket.js'

// ─── Constants ─────────────────────────────────────────────────────────────────

const EW  = 680   // elevation strip SVG viewBox width (stretches via preserveAspectRatio)
const EH  = 74    // elevation strip height (px)
const RS  = 15    // reveal duration (seconds)
const AP  = 0.12  // approach threshold (fraction of route — thumbnail starts growing)
const AR  = 0.03  // arrival threshold (fraction of route — reveal triggers)

// ─── Milestones ────────────────────────────────────────────────────────────────

const MILESTONES = [
  {
    id: 1, lat: 48.8584, lng: 2.2945, name: 'Eiffel Tower', distKm: 5.622, color: '#f59e0b',
    img: '/rides/paris-seine/images/eiffel.jpg',
    imageCredit: '© Benh LIEU SONG / Wikimedia Commons, CC BY-SA 3.0',
    fact: "Built as a temporary structure for the 1889 World's Fair, Gustave Eiffel's iron lattice tower was initially derided as an eyesore — today it's the world's most visited paid monument.",
  },
  {
    id: 2, lat: 48.8606, lng: 2.3376, name: 'The Louvre', distKm: 8.887, color: '#a78bfa',
    img: '/rides/paris-seine/images/louvre.jpg',
    imageCredit: '© Benh LIEU SONG / Wikimedia Commons, CC BY-SA 4.0',
    fact: 'A royal fortress before it became a museum, the Louvre houses over 380,000 objects — at a typical visitor pace it would take nine months to see them all.',
  },
  {
    id: 3, lat: 48.8530, lng: 2.3499, name: 'Notre-Dame de Paris', distKm: 10.561, color: '#34d399',
    img: '/rides/paris-seine/images/notredame.jpg',
    imageCredit: '© Peter Haas (P e z i) / Wikimedia Commons, CC BY-SA 3.0',
    fact: 'After the devastating 2019 fire, Notre-Dame reopened in December 2024 following a meticulous five-year restoration that involved 2,000 craftspeople from across France.',
  },
  {
    id: 4, lat: 48.8867, lng: 2.3431, name: 'Sacré-Cœur', distKm: 15.312, color: '#fb7185',
    img: '/rides/paris-seine/images/sacrecoeur.jpg',
    imageCredit: '© Dietmar Rabich / Wikimedia Commons, CC BY-SA 4.0',
    fact: "Perched on the highest point in Paris at 130m above sea level, Sacré-Cœur's white travertine limestone bleaches whiter every time it rains — the stone actually self-cleans.",
  },
]

// ─── Placeholder elevation profile (used when no backend route data) ──────────

const ELEV_PLACEHOLDER = [
  [0,30],[0.1,32],[0.2,31],[0.3,33],[0.4,32],[0.5,31],
  [0.6,33],[0.65,32],[0.7,35],[0.75,45],[0.8,65],[0.85,80],
  [0.9,75],[0.95,70],[1,65],
]

// ─── Helpers ───────────────────────────────────────────────────────────────────

const lerp = (a, b, t) => a + (b - a) * t

function interpolateLatLng(waypoints, riderT, totalKm) {
  if (!waypoints.length) return null
  const distM = riderT * totalKm * 1000
  let lo = 0, hi = waypoints.length - 1
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1
    if (waypoints[mid].dist_m <= distM) lo = mid; else hi = mid
  }
  const w0 = waypoints[lo], w1 = waypoints[hi]
  if (w1.dist_m === w0.dist_m) return [w0.lat, w0.lng]
  const frac = (distM - w0.dist_m) / (w1.dist_m - w0.dist_m)
  return [lerp(w0.lat, w1.lat, frac), lerp(w0.lng, w1.lng, frac)]
}

function getGrade(t) {
  // Sim-mode fallback grade from placeholder elevation profile
  const dt = 0.02
  function elev(x) {
    for (let i = 0; i < ELEV_PLACEHOLDER.length - 1; i++) {
      const [t0, e0] = ELEV_PLACEHOLDER[i], [t1, e1] = ELEV_PLACEHOLDER[i+1]
      if (x >= t0 && x <= t1) return lerp(e0, e1, (x - t0) / (t1 - t0))
    }
    return ELEV_PLACEHOLDER[ELEV_PLACEHOLDER.length - 1][1]
  }
  const rise = elev(Math.min(1, t + dt)) - elev(Math.max(0, t - dt))
  return (rise * 5) / (dt * 2 * 18 * 1000) * 100
}

// ─── Child components (must be inside MapContainer) ────────────────────────────

function MapSync({ onReady }) {
  const map = useMap()
  useEffect(() => { onReady(map) }, [map, onReady])
  return null
}

function RiderFollower({ position }) {
  const map = useMap()
  useEffect(() => {
    if (!position) return
    try {
      const cur = map.latLngToContainerPoint(map.getCenter())
      const tgt = map.latLngToContainerPoint(position)
      if (Math.hypot(tgt.x - cur.x, tgt.y - cur.y) > 12) {
        map.panTo(position, { animate: true, duration: 1.2, easeLinearity: 0.5 })
      }
    } catch { /* map not ready */ }
  }, [map, position])
  return null
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function TrainerMap() {
  const { telemetry, trainerStatus, lastEvent, sendMessage, routeWaypoints, routeTotalKm } = useWebSocket()
  const isLive = telemetry !== null

  const totalKm = routeTotalKm || 17.4
  const msWithT = useMemo(() => MILESTONES.map(m => ({ ...m, t: m.distKm / totalKm })), [totalKm])

  const [riderT,         setRiderT]         = useState(0.05)
  const [playing,        setPlaying]        = useState(false)
  const [livePlaying,    setLivePlaying]    = useState(false)
  const [speed,          setSpeed]          = useState(5)
  const [done,           setDone]           = useState(new Set())
  const [revealId,       setRevealId]       = useState(null)
  const [revealSec,      setRevealSec]      = useState(RS)
  const [revealIn,       setRevealIn]       = useState(false)
  const [panelMilestone, setPanelMilestone] = useState(null)
  const [tick,           setTick]           = useState(0)

  // Leaflet map ref + milestone pixel positions
  const leafletMapRef = useRef(null)
  const [msPx,           setMsPx]           = useState({})

  // Elevation strip — measure actual rendered width to avoid non-uniform SVG scaling
  const elevContainerRef = useRef(null)
  const [elevWidth,      setElevWidth]      = useState(680)
  useEffect(() => {
    const el = elevContainerRef.current
    if (!el) return
    const ro = new ResizeObserver(entries => setElevWidth(entries[0].contentRect.width))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // Mutable ref bag for animation loop — avoids stale closure issues with RAF
  const r = useRef({
    T: 0.05, playing: false, speed: 5,
    revealId: null, done: new Set(), revealSec: RS, last: null,
  }).current

  // Keep refs in sync with state (render-time sync, safe with non-concurrent React)
  // r.playing tracks unified play state for both live and sim modes
  r.T = riderT; r.playing = isLive ? livePlaying : playing; r.speed = speed; r.revealSec = revealSec

  // ── Milestone pixel position refresh ──────────────────────────────────────

  const refreshMsPx = useCallback(() => {
    const map = leafletMapRef.current
    if (!map) return
    const px = {}
    msWithT.forEach(m => {
      const p = map.latLngToContainerPoint([m.lat, m.lng])
      px[m.id] = { x: p.x, y: p.y }
    })
    setMsPx({ ...px })
  }, [msWithT])

  const onMapReady = useCallback(map => {
    leafletMapRef.current = map
    map.on('move zoom resize', refreshMsPx)
    refreshMsPx()
  }, [refreshMsPx])

  // ── Reveal lifecycle ──────────────────────────────────────────────────────

  useEffect(() => {
    let clearTimer, revealTimer
    if (revealId) {
      setPanelMilestone(msWithT.find(m => m.id === revealId))
      setRevealSec(RS); r.revealSec = RS
      revealTimer = setTimeout(() => setRevealIn(true), 20)
    } else {
      setRevealIn(false)
      clearTimer = setTimeout(() => setPanelMilestone(null), 420)
    }
    return () => { clearTimeout(clearTimer); clearTimeout(revealTimer) }
  }, [revealId])

  // ── Sync riderT from live telemetry ──────────────────────────────────────

  useEffect(() => {
    if (!isLive || telemetry?.riderT == null) return
    const t = telemetry.riderT
    setRiderT(t); r.T = t
    if (t >= 1) { setPlaying(false); r.playing = false }
  }, [telemetry?.riderT])

  // ── Handle backend events (milestone reached, ride complete) ──────────────

  useEffect(() => {
    if (!lastEvent) return
    if (lastEvent.type === 'milestone_reached') {
      const mid = lastEvent.milestoneId
      if (!r.done.has(mid) && r.revealId === null) {
        setRevealId(mid); r.revealId = mid
      }
    } else if (lastEvent.type === 'ride_complete') {
      setPlaying(false); r.playing = false
    }
  }, [lastEvent])

  // ── Main animation loop ───────────────────────────────────────────────────

  useEffect(() => {
    let af
    function loop(ts) {
      if (!r.last) r.last = ts
      const dt = Math.min((ts - r.last) / 1000, 0.1)
      r.last = ts

      if (r.playing) {
        if (!isLive) {
          // Simulate rider advancement
          const nT = Math.min(1, r.T + r.speed * 0.004 * dt)
          setRiderT(nT); r.T = nT
          if (nT >= 1) setPlaying(false)
        }

        // Milestone proximity check — runs in both sim and live modes.
        // In live mode r.T tracks telemetry; backend milestone_reached is also wired
        // but this provides a frontend fallback so the reveal fires reliably.
        if (r.revealId === null) {
          for (const m of msWithT) {
            if (r.done.has(m.id)) continue
            const d = m.t - r.T
            if (d >= 0 && d < AR) { setRevealId(m.id); r.revealId = m.id; break }
          }
        }

        if (r.revealId !== null) {
          // Count down the reveal timer (runs in both modes)
          const ns = Math.max(0, r.revealSec - dt)
          setRevealSec(ns); r.revealSec = ns
          if (ns <= 0) {
            const id = r.revealId
            const s = new Set(r.done); s.add(id); r.done = s
            setDone(new Set(s)); setRevealId(null); r.revealId = null
          }
        }

        setTick(t => t + 1)
      }

      af = requestAnimationFrame(loop)
    }
    af = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(af)
  }, [isLive, msWithT])

  // ─── Derived display values ──────────────────────────────────────────────

  const tm      = tick * 0.016
  const grade   = isLive ? (telemetry.grade ?? 0) : getGrade(riderT)
  const power   = isLive ? telemetry.power   : Math.round(175 + grade * 11 + Math.sin(tm * 1.3) * 16)
  const cadence = isLive ? telemetry.cadence : Math.round(87 + Math.sin(tm * 0.9) * 4)
  const hr      = isLive ? telemetry.hr      : Math.round(146 + grade * 5 + Math.sin(tm * 0.4) * 8)
  const kph     = isLive ? telemetry.speed   : Math.max(8, 31 - grade * 2.2 + Math.sin(tm * 1.7) * 2)
  const distKm  = isLive ? telemetry.distKm  : riderT * totalKm
  const elapsed = distKm / Math.max(kph, 1) * 3600
  const mins    = Math.floor(elapsed / 60)
  const secs    = Math.floor(elapsed % 60)

  // Rider lat/lng for map
  const riderLatLng = useMemo(
    () => interpolateLatLng(routeWaypoints, riderT, totalKm),
    [routeWaypoints, riderT, totalKm]
  )

  // Route split at rider position for polylines
  const riderDistM = riderT * totalKm * 1000
  const donePts  = useMemo(() => routeWaypoints.filter(w => w.dist_m <= riderDistM).map(w => [w.lat, w.lng]), [routeWaypoints, riderDistM])
  const aheadPts = useMemo(() => routeWaypoints.filter(w => w.dist_m >= riderDistM).map(w => [w.lat, w.lng]), [routeWaypoints, riderDistM])

  const nextMilestone = msWithT.find(m => !done.has(m.id) && m.id !== revealId && m.t > riderT)

  // Panel burst origin — thumbnail viewport position minus panel top-left (10vw / 10vh)
  // so the spring-scale animation appears to grow out of the thumbnail
  const mapRect = leafletMapRef.current?.getContainer().getBoundingClientRect() ?? null
  const panelOrigin = (() => {
    const px = panelMilestone && msPx[panelMilestone.id]
    if (px && mapRect) {
      return {
        x: px.x + mapRect.left - window.innerWidth  * 0.1,
        y: px.y + mapRect.top  - window.innerHeight * 0.1,
      }
    }
    return { x: window.innerWidth * 0.4, y: window.innerHeight * 0.4 }
  })()

  // Elevation strip data — real from route, or placeholder
  // Uses elevWidth (measured via ResizeObserver) so SVG coords match rendered pixels — no distortion
  const elevPts = useMemo(() => {
    const W = elevWidth
    if (routeWaypoints.length > 1) {
      const elevs = routeWaypoints.map(w => w.elevation_m)
      const eMin  = Math.min(...elevs)
      const eMax  = Math.max(...elevs)
      const range = eMax - eMin || 1
      return routeWaypoints.map(w => [
        (w.dist_m / (totalKm * 1000)) * W,
        EH - 6 - ((w.elevation_m - eMin) / range) * (EH - 16),
      ])
    }
    return ELEV_PLACEHOLDER.map(([t, e]) => [t * W, EH - 6 - (e / 100) * (EH - 16)])
  }, [routeWaypoints, totalKm, elevWidth])

  const elevLine = elevPts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`).join(' ')
  const elevArea = `${elevLine} L${elevWidth} ${EH} L0 ${EH} Z`
  const rX = riderT * elevWidth

  // ─── Handlers ─────────────────────────────────────────────────────────────

  const dismiss = () => {
    if (!r.revealId) return
    const id = r.revealId
    const s = new Set(r.done); s.add(id); r.done = s
    setDone(new Set(s)); setRevealId(null); r.revealId = null
  }

  const reset = () => {
    r.T = 0.05; r.done = new Set(); r.revealId = null; r.playing = false
    setRiderT(0.05); setDone(new Set()); setRevealId(null)
    setPlaying(false); setPanelMilestone(null); setLivePlaying(false)
  }

  const togglePlay = () => {
    if (isLive) {
      const np = !livePlaying
      setLivePlaying(np)
      sendMessage({ type: np ? 'resume' : 'pause' })
    } else {
      const np = !r.playing; r.playing = np; setPlaying(np)
    }
  }

  const onSpeedChange = (v) => {
    setSpeed(v)
    if (isLive) sendMessage({ type: 'set_demo_speed', multiplier: v })
  }

  // ─── HUD config ────────────────────────────────────────────────────────────

  const hudItems = [
    { label: 'PWR',   value: power,                                          unit: 'W',    color: '#f59e0b', big: true },
    { label: 'CAD',   value: cadence,                                        unit: 'rpm',  color: '#94a3b8' },
    { label: 'HR',    value: hr,                                             unit: 'bpm',  color: '#fb7185' },
    { label: 'SPD',   value: kph.toFixed(1),                                 unit: 'km/h', color: '#94a3b8' },
    { label: 'GRADE', value: (grade >= 0 ? '+' : '') + grade.toFixed(1),     unit: '%',
      color: grade > 5 ? '#fb7185' : grade > 2 ? '#f59e0b' : '#94a3b8' },
    { label: 'DIST',  value: distKm.toFixed(1),                              unit: 'km',   color: '#94a3b8' },
    { label: 'TIME',  value: `${String(mins).padStart(2,'0')}:${String(secs).padStart(2,'0')}`,
      unit: '', color: '#94a3b8' },
  ]

  // Show speed slider in sim mode OR in no-trainer backend mode
  const showSpeedSlider = !isLive || (isLive && trainerStatus === 'disconnected')

  // ─── Render ────────────────────────────────────────────────────────────────

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', height: '100vh',
      background: '#0d1117', fontFamily: 'system-ui, -apple-system, sans-serif',
      overflow: 'hidden',
    }}>

      {/* ── HUD bar ── */}
      <div style={{ flex: '0 0 auto', display: 'flex', background: '#080c14', borderBottom: '1px solid #1e293b' }}>
        {hudItems.map((h, i) => (
          <div key={i} style={{ flex: h.big ? 1.5 : 1, padding: '5px 8px 6px', borderRight: i < 6 ? '1px solid #1e293b' : 'none' }}>
            <div style={{ color: '#334155', fontSize: 8, letterSpacing: '.12em', fontWeight: 700, textTransform: 'uppercase' }}>
              {h.label}
            </div>
            <div style={{ color: h.color, fontSize: h.big ? 22 : 15, fontWeight: 600, fontFamily: 'monospace', lineHeight: 1.15, marginTop: 1 }}>
              {h.value}
              <span style={{ fontSize: 8, color: '#475569', marginLeft: 2 }}>{h.unit}</span>
            </div>
          </div>
        ))}
        {/* BLE status badge */}
        {isLive && trainerStatus !== 'connected' && (
          <div style={{ padding: '5px 10px 6px', display: 'flex', flexDirection: 'column', justifyContent: 'center', borderLeft: '1px solid #1e293b' }}>
            <div style={{ color: trainerStatus === 'searching' ? '#f59e0b' : '#f59e0b', fontSize: 8, letterSpacing: '.1em', fontWeight: 700 }}>
              BLE
            </div>
            <div style={{ color: trainerStatus === 'searching' ? '#f59e0b' : '#64748b', fontSize: 9, fontWeight: 600 }}>
              {trainerStatus}
            </div>
          </div>
        )}
      </div>

      {/* ── Map area ── */}
      <div style={{ flex: 1, position: 'relative', minHeight: 0 }}>

        <MapContainer
          center={[48.865, 2.32]}
          zoom={13}
          style={{ height: '100%', width: '100%' }}
          zoomControl={false}
          attributionControl={false}
        >
          <TileLayer
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          />
          {donePts.length  > 1 && <Polyline positions={donePts}  color="#f59e0b" weight={5} opacity={0.9} />}
          {aheadPts.length > 1 && <Polyline positions={aheadPts} color="#334155" weight={5} opacity={0.8} />}
          {riderLatLng && <>
            <CircleMarker center={riderLatLng} radius={11} pathOptions={{ color: '#f59e0b', fillColor: '#f59e0b', fillOpacity: 0.15, weight: 0 }} />
            <CircleMarker center={riderLatLng} radius={7}  pathOptions={{ color: '#f59e0b', fillColor: '#f59e0b', fillOpacity: 1, weight: 0 }} />
            <CircleMarker center={riderLatLng} radius={3}  pathOptions={{ color: '#fff', fillColor: '#fff', fillOpacity: 1, weight: 0 }} />
          </>}
          <MapSync onReady={onMapReady} />
          {riderLatLng && <RiderFollower position={riderLatLng} />}
        </MapContainer>

        {/* OSM attribution */}
        <div style={{
          position: 'absolute', bottom: 4, right: 6, zIndex: 1000,
          color: '#94a3b8', fontSize: 9, background: 'rgba(0,0,0,.45)',
          padding: '1px 5px', borderRadius: 2, pointerEvents: 'none',
        }}>
          © OpenStreetMap contributors
        </div>

        {/* ── Overlay container: above all Leaflet panes (tile pane=200, overlay=400, marker=600, control=800) ── */}
        <div style={{ position: 'absolute', inset: 0, zIndex: 1000, pointerEvents: 'none' }}>

        {/* Milestone thumbnails */}
        {msWithT.map(m => {
          const px         = msPx[m.id]
          if (!px) return null
          const { x: mx, y: my } = px
          const isCompleted = done.has(m.id)
          const isRevealing = m.id === revealId
          const dist        = m.t - riderT
          let sz, proximity

          if      (isCompleted)              { sz = 36; proximity = 0 }
          else if (isRevealing)              { sz = 68; proximity = 1 }
          else if (dist > 0 && dist < AP)    { proximity = 1 - dist / AP; sz = 30 + proximity * 52 }
          else                               { sz = 30; proximity = 0 }

          return (
            <div key={m.id} style={{ pointerEvents: 'auto' }}>
              {/* Circular thumbnail */}
              <div style={{
                position: 'absolute', left: mx, top: my,
                width: sz, height: sz,
                transform: 'translate(-50%, -50%)',
                borderRadius: '50%', overflow: 'hidden',
                border: `2.5px solid ${isCompleted ? '#22c55e' : m.color}`,
                transition: 'width .35s ease, height .35s ease',
                filter: isCompleted ? 'grayscale(.75) brightness(.65)' : 'none',
                zIndex: Math.round(sz),
                boxShadow: isRevealing ? `0 0 0 5px ${m.color}40` : undefined,
              }}>
                <img
                  src={m.img} alt={m.name}
                  style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
                  onError={e => { e.target.style.display = 'none'; e.target.parentNode.style.background = m.color + '22' }}
                />
                {isCompleted && (
                  <div style={{
                    position: 'absolute', inset: 0,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    background: 'rgba(0,0,0,.45)',
                    color: '#22c55e', fontSize: Math.max(11, sz * 0.38),
                  }}>✓</div>
                )}
              </div>

              {/* Landmark label — fades in as you approach */}
              {!isCompleted && proximity > 0.28 && (
                <div style={{
                  position: 'absolute', left: mx, top: my + sz / 2 + 5,
                  transform: 'translateX(-50%)',
                  color: m.color, fontSize: 10, fontWeight: 600,
                  letterSpacing: '.04em', whiteSpace: 'nowrap',
                  opacity: proximity, pointerEvents: 'none',
                  textShadow: '0 1px 5px rgba(0,0,0,.95)',
                }}>
                  {m.name}
                </div>
              )}
            </div>
          )
        })}

        {/* Next milestone chip */}
        {nextMilestone && !revealId && (
          <div style={{
            position: 'absolute', bottom: 10, left: '50%',
            transform: 'translateX(-50%)',
            background: 'rgba(8,12,20,.9)',
            border: `0.5px solid ${nextMilestone.color}44`,
            borderRadius: 7, padding: '4px 10px',
            color: '#475569', fontSize: 11,
          }}>
            Next:{' '}
            <span style={{ color: nextMilestone.color, fontWeight: 600 }}>{nextMilestone.name}</span>
            {' · '}{((nextMilestone.t - riderT) * totalKm).toFixed(1)} km
          </div>
        )}

        </div>{/* end overlay container */}
      </div>

      {/* ── Elevation strip ── */}
      <div ref={elevContainerRef} style={{ flex: '0 0 auto', background: '#0a0f1a', borderTop: '1px solid #1e293b' }}>
        <svg
          width={elevWidth} height={EH}
          viewBox={`0 0 ${elevWidth} ${EH}`}
          style={{ display: 'block', width: '100%' }}
        >
          <defs>
            <clipPath id="elev-done">  <rect x={0}  y={0} width={rX}              height={EH} /></clipPath>
            <clipPath id="elev-ahead"> <rect x={rX} y={0} width={elevWidth - rX}  height={EH} /></clipPath>
          </defs>

          <path d={elevArea} fill="#1e3a5f" opacity={0.4}  clipPath="url(#elev-ahead)" />
          <path d={elevArea} fill="#f59e0b" opacity={0.18} clipPath="url(#elev-done)"  />
          <path d={elevLine} fill="none" stroke="#283650" strokeWidth={1.5} clipPath="url(#elev-ahead)" />
          <path d={elevLine} fill="none" stroke="#f59e0b" strokeWidth={1.5} clipPath="url(#elev-done)"  />

          {msWithT.map(m => {
            const ex = m.t * elevWidth
            // Find approximate elevation at this t
            const mDistM = m.t * totalKm * 1000
            let ey = EH - 10
            if (routeWaypoints.length > 1) {
              const nearest = routeWaypoints.reduce((best, w) =>
                Math.abs(w.dist_m - mDistM) < Math.abs(best.dist_m - mDistM) ? w : best
              )
              const elevs = routeWaypoints.map(w => w.elevation_m)
              const eMin  = Math.min(...elevs), eMax = Math.max(...elevs)
              ey = EH - 6 - ((nearest.elevation_m - eMin) / (eMax - eMin || 1)) * (EH - 16)
            }
            const ic = done.has(m.id)
            return (
              <g key={m.id}>
                <line x1={ex} y1={ey} x2={ex} y2={EH - 1}
                  stroke={ic ? '#22c55e' : m.color} strokeWidth={1} opacity={0.5} strokeDasharray="2 3" />
                <circle cx={ex} cy={ey} r={3} fill={ic ? '#22c55e' : m.color} opacity={0.85} />
              </g>
            )
          })}

          {/* Rider position */}
          <line x1={rX} y1={0} x2={rX} y2={EH} stroke="#f59e0b" strokeWidth={1} opacity={0.3} />
          <circle cx={rX} cy={(() => {
            if (routeWaypoints.length > 1) {
              const nearest = routeWaypoints.reduce((best, w) =>
                Math.abs(w.dist_m - riderDistM) < Math.abs(best.dist_m - riderDistM) ? w : best
              )
              const elevs = routeWaypoints.map(w => w.elevation_m)
              const eMin = Math.min(...elevs), eMax = Math.max(...elevs)
              return EH - 6 - ((nearest.elevation_m - eMin) / (eMax - eMin || 1)) * (EH - 16)
            }
            return EH - 10
          })()} r={4} fill="#f59e0b" />
        </svg>
      </div>

      {/* ── Controls ── */}
      <div style={{
        flex: '0 0 auto',
        display: 'flex', alignItems: 'center', gap: 10,
        padding: '8px 14px', background: '#0d1117', borderTop: '1px solid #1e293b',
      }}>
        {/* Play/Pause */}
        {(() => {
          const active = isLive ? livePlaying : playing
          return (
            <button
              onClick={togglePlay}
              style={{
                background: active ? 'transparent' : '#f59e0b',
                color: active ? '#64748b' : '#0d1117',
                border: active ? '0.5px solid #1e293b' : 'none',
                borderRadius: 7, padding: '6px 18px',
                fontSize: 13, fontWeight: 700, cursor: 'pointer', minWidth: 85,
              }}
            >
              {active ? '⏸ Pause' : '▶ Ride'}
            </button>
          )
        })()}

        {/* Speed slider — sim mode or no-trainer backend mode */}
        {showSpeedSlider && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1 }}>
            <span style={{ color: '#334155', fontSize: 11 }}>Speed</span>
            <input
              type="range" min={1} max={10} step={1} value={speed}
              onChange={e => onSpeedChange(Number(e.target.value))}
              style={{ flex: 1 }}
            />
            <span style={{ color: '#64748b', fontSize: 11, minWidth: 24 }}>{speed}×</span>
          </div>
        )}

        {!showSpeedSlider && <div style={{ flex: 1 }} />}

        <button
          onClick={reset}
          style={{
            background: 'transparent', color: '#334155',
            border: '0.5px solid #1e293b', borderRadius: 7,
            padding: '6px 12px', fontSize: 11, cursor: 'pointer',
          }}
        >
          Reset
        </button>

        <span style={{ color: '#1e3a5f', fontSize: 10, fontStyle: 'italic' }}>
          Paris · Seine · {totalKm.toFixed(0)} km
        </span>
      </div>

      {/* ── Reveal modal ──────────────────────────────────────────────────────────
          Fixed at 80% viewport so it covers the full UI. Scales out from the
          thumbnail's viewport position via transform-origin spring animation.
          Lives outside the map overlay to avoid Leaflet stacking-context limits. */}
      {panelMilestone && (
        <>
          {/* Dim backdrop */}
          <div
            onClick={dismiss}
            style={{
              position: 'fixed', inset: 0,
              background: 'rgba(0,0,0,0.72)',
              opacity: revealIn ? 1 : 0,
              transition: 'opacity .3s ease',
              zIndex: 9998,
            }}
          />

          {/* Modal panel */}
          <div
            onClick={dismiss}
            style={{
              position: 'fixed',
              top: '10vh', left: '10vw', width: '80vw', height: '80vh',
              cursor: 'pointer', overflow: 'hidden', borderRadius: 14,
              boxShadow: '0 32px 80px rgba(0,0,0,.85)',
              transform: revealIn ? 'scale(1)' : 'scale(0)',
              transformOrigin: `${panelOrigin.x}px ${panelOrigin.y}px`,
              opacity: revealIn ? 1 : 0,
              transition: 'transform .48s cubic-bezier(.34,1.45,.64,1), opacity .22s ease',
              zIndex: 9999,
            }}
          >
            {/* Full-bleed photo */}
            <img
              src={panelMilestone.img} alt={panelMilestone.name}
              style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
              onError={e => { e.target.style.display = 'none'; e.target.parentNode.style.background = panelMilestone.color + '33' }}
            />

            {/* Colored accent bar at top */}
            <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 4, background: panelMilestone.color, zIndex: 2 }} />

            {/* Text overlay — gradient scrim at bottom */}
            <div style={{
              position: 'absolute', bottom: 0, left: 0, right: 0,
              background: 'linear-gradient(to bottom, transparent 0%, rgba(5,8,14,.55) 28%, rgba(5,8,14,.96) 100%)',
              padding: '56px 32px 28px',
              zIndex: 2,
            }}>
              <div style={{ color: panelMilestone.color, fontSize: 11, letterSpacing: '.14em', fontWeight: 700, marginBottom: 6 }}>
                ● MILESTONE · {panelMilestone.distKm.toFixed(1)} km
              </div>
              <div style={{ color: '#f1f5f9', fontSize: 34, fontWeight: 700, lineHeight: 1.15, marginBottom: 10 }}>
                {panelMilestone.name}
              </div>
              <div style={{ color: '#cbd5e1', fontSize: 14, lineHeight: 1.72, marginBottom: 8 }}>
                {panelMilestone.fact}
              </div>
              <div style={{ color: '#475569', fontSize: 10, marginBottom: 14 }}>
                {panelMilestone.imageCredit}
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                <span style={{ color: '#64748b', fontSize: 11 }}>tap anywhere to continue · auto in</span>
                <span style={{ color: panelMilestone.color, fontSize: 13, fontFamily: 'monospace', fontWeight: 600 }}>
                  {Math.ceil(revealSec)}s
                </span>
              </div>
              <div style={{ height: 3, background: '#1e293b', borderRadius: 2 }}>
                <div style={{
                  height: '100%', background: panelMilestone.color,
                  width: `${(revealSec / RS) * 100}%`,
                  borderRadius: 2, transition: 'width .15s linear',
                }} />
              </div>
            </div>
          </div>
        </>
      )}

    </div>
  )
}
