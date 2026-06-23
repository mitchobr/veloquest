/**
 * TrainerMap.jsx — Passage prototype
 *
 * The approved milestone reveal mechanic. Currently runs on simulated data.
 * Next step: replace simulated riderT + stats with live WebSocket feed (useWebSocket hook).
 * Next step: replace SVG placeholder map with Leaflet + OSM tiles.
 *
 * Core mechanic (locked — do not replace without discussion):
 *   - Thumbnail grows as rider approaches milestone
 *   - On arrival, panel scales out from thumbnail position (spring easing)
 *   - Full-bleed landmark photo, dark text overlay at bottom
 *   - Auto-dismisses after 15s; tap to dismiss early
 *   - Thumbnail stays on map marked as completed (greyscale + ✓)
 */

import { useState, useEffect, useRef } from 'react'
import { useWebSocket } from '../hooks/useWebSocket.js'

// ─── Layout constants ──────────────────────────────────────────────────────────

const MW = 680   // map width (px)
const MH = 340   // map height (px)
const EW = 680   // elevation strip width
const EH = 74    // elevation strip height
const KM = 18    // total route distance (km) — placeholder
const RS = 15    // reveal duration (seconds)
const AP = 0.12  // approach threshold (fraction of route — thumbnail starts growing)
const AR = 0.03  // arrival threshold (fraction of route — reveal triggers)
const PH = 272   // reveal panel height (px)

// ─── Route data (placeholder — will be replaced by GPX + lat/lng loader) ──────

const ROUTE = [
  [22,192],[62,200],[102,186],[142,194],[176,180],[212,184],
  [248,174],[286,178],[320,168],[360,170],[394,160],[430,164],
  [462,154],[498,148],[530,140],[565,134],[606,128],[652,132],
]

const RIVER = ROUTE.map(([x, y], i) => [x, y + 22 + Math.sin(i * 0.85) * 9])

const CITY_BLOCKS = [
  [10,15,55,35],[80,10,50,45],[140,20,60,35],[210,15,45,40],
  [265,10,55,50],[332,20,60,35],[402,15,50,40],[462,10,55,45],
  [530,20,60,35],[600,15,60,40],
  [15,242,60,45],[88,247,55,40],[154,240,65,50],[230,246,55,42],
  [296,241,60,48],[366,246,55,42],[432,240,60,50],[502,246,55,42],
  [568,240,65,48],[20,292,50,40],[82,297,60,35],[154,290,55,42],
  [218,296,65,38],[360,296,60,38],[568,290,70,42],
]

// Elevation profile (placeholder — will be derived from OpenTopoData + GPX)
const ELEV_PROFILE = [
  [0,30],[0.1,32],[0.2,31],[0.3,33],[0.4,32],[0.5,31],
  [0.6,33],[0.65,32],[0.7,35],[0.75,45],[0.8,65],[0.85,80],
  [0.9,75],[0.95,70],[1,65],
]

// ─── Milestones (placeholder — will be loaded from rides/[name]/milestones.json) ─

const MILESTONES = [
  {
    id: 1, t: 0.22, name: 'Eiffel Tower', dist: '3.9 km', color: '#f59e0b',
    // In production: local file path resolved at ride load time
    img: 'https://upload.wikimedia.org/wikipedia/commons/thumb/a/a8/Tour_Eiffel_Wikimedia_Commons.jpg/800px-Tour_Eiffel_Wikimedia_Commons.jpg',
    fact: "Built for the 1889 World's Fair, Gustave Eiffel's iron tower was initially despised by Parisian artists. Today it's the most visited paid monument on the planet.",
  },
  {
    id: 2, t: 0.44, name: 'The Louvre', dist: '7.9 km', color: '#a78bfa',
    img: 'https://upload.wikimedia.org/wikipedia/commons/thumb/3/30/Louvre_Courtyard%2C_Looking_West.jpg/800px-Louvre_Courtyard%2C_Looking_West.jpg',
    fact: 'A royal palace for 400 years before Napoleon turned it into a museum. Home to over 35,000 works of art — the Mona Lisa gets a room all to herself.',
  },
  {
    id: 3, t: 0.65, name: 'Notre Dame', dist: '11.7 km', color: '#34d399',
    img: 'https://upload.wikimedia.org/wikipedia/commons/thumb/d/d3/Notre-Dame_de_Paris%2C_4_Octobre_2021.jpg/800px-Notre-Dame_de_Paris%2C_4_Octobre_2021.jpg',
    fact: 'After the devastating 2019 fire, Notre Dame reopened in December 2024 following five years of meticulous restoration. The gargoyles are back on the job.',
  },
  {
    id: 4, t: 0.85, name: 'Sacré-Cœur', dist: '15.3 km', color: '#fb7185',
    img: 'https://upload.wikimedia.org/wikipedia/commons/thumb/b/b2/Sacre_Coeur_1_%28pixinn.net%29.jpg/800px-Sacre_Coeur_1_%28pixinn.net%29.jpg',
    fact: "Perched atop Montmartre — Paris's highest point — Sacré-Cœur was built as national penance after the Franco-Prussian War. That 8% gradient wasn't in the brochure.",
  },
]

// ─── Pure helpers ──────────────────────────────────────────────────────────────

const lerp = (a, b, t) => a + (b - a) * t

function ptAt(pts, t) {
  const n = pts.length - 1
  const st = Math.min(t * n, n - 0.0001)
  const i = Math.floor(st)
  return [lerp(pts[i][0], pts[i+1][0], st - i), lerp(pts[i][1], pts[i+1][1], st - i)]
}

function mkPath(pts) {
  let d = `M${pts[0][0]} ${pts[0][1]}`
  for (let i = 1; i < pts.length - 1; i++) {
    const mx = (pts[i][0] + pts[i+1][0]) / 2
    const my = (pts[i][1] + pts[i+1][1]) / 2
    d += ` Q${pts[i][0]} ${pts[i][1]} ${mx} ${my}`
  }
  return d + ` L${pts[pts.length-1][0]} ${pts[pts.length-1][1]}`
}

function getElev(t) {
  for (let i = 0; i < ELEV_PROFILE.length - 1; i++) {
    const [t0, e0] = ELEV_PROFILE[i], [t1, e1] = ELEV_PROFILE[i+1]
    if (t >= t0 && t <= t1) return lerp(e0, e1, (t - t0) / (t1 - t0))
  }
  return ELEV_PROFILE[ELEV_PROFILE.length - 1][1]
}

function getGrade(t) {
  const dt = 0.02
  const rise = getElev(Math.min(1, t + dt)) - getElev(Math.max(0, t - dt))
  // elevation units * 5 ≈ meters; route fraction * KM * 1000 = meters
  return (rise * 5) / (dt * 2 * KM * 1000) * 100
}

// ─── Precomputed static paths ──────────────────────────────────────────────────

const ROUTE_PATH = mkPath(ROUTE)
const RIVER_PATH = mkPath(RIVER)
const ELEV_PTS   = ELEV_PROFILE.map(([t, e]) => [t * EW, EH - 6 - (e / 100) * (EH - 16)])
const ELEV_LINE  = ELEV_PTS.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`).join(' ')
const ELEV_AREA  = `${ELEV_LINE} L${EW} ${EH} L0 ${EH} Z`

// ─── Component ────────────────────────────────────────────────────────────────

export default function TrainerMap() {
  const { telemetry, trainerStatus, lastEvent, sendMessage } = useWebSocket()
  const isLive = telemetry !== null

  const [riderT,         setRiderT]         = useState(0.05)
  const [playing,        setPlaying]        = useState(false)
  const [speed,          setSpeed]          = useState(5)
  const [done,           setDone]           = useState(new Set())
  const [revealId,       setRevealId]       = useState(null)
  const [revealSec,      setRevealSec]      = useState(RS)
  const [revealIn,       setRevealIn]       = useState(false)
  const [panelMilestone, setPanelMilestone] = useState(null)
  const [tick,           setTick]           = useState(0)

  // Mutable ref bag for animation loop — avoids stale closure issues with RAF
  const r = useRef({
    T: 0.05, playing: false, speed: 5,
    revealId: null, done: new Set(), revealSec: RS, last: null,
  }).current

  // Keep refs in sync with state (render-time sync, safe with non-concurrent React)
  r.T = riderT; r.playing = playing; r.speed = speed; r.revealSec = revealSec

  // Reveal lifecycle — panelMilestone persists during the scale-out animation
  useEffect(() => {
    let clearTimer
    if (revealId) {
      setPanelMilestone(MILESTONES.find(m => m.id === revealId))
      setRevealSec(RS); r.revealSec = RS
      setTimeout(() => setRevealIn(true), 20)
    } else {
      setRevealIn(false)
      clearTimer = setTimeout(() => setPanelMilestone(null), 420)
    }
    return () => clearTimeout(clearTimer)
  }, [revealId])

  // Sync riderT from live telemetry
  useEffect(() => {
    if (!isLive || telemetry?.riderT == null) return
    const t = telemetry.riderT
    setRiderT(t); r.T = t
    if (t >= 1) { setPlaying(false); r.playing = false }
  }, [telemetry?.riderT])

  // Handle backend events (milestone reached, ride complete)
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

  // Main animation loop
  useEffect(() => {
    let af
    function loop(ts) {
      if (!r.last) r.last = ts
      const dt = Math.min((ts - r.last) / 1000, 0.1)
      r.last = ts

      if (r.playing) {
        if (!isLive) {
          // Simulate rider advancement (no backend)
          const nT = Math.min(1, r.T + r.speed * 0.004 * dt)
          setRiderT(nT); r.T = nT

          // Check milestone proximity in simulated mode
          if (r.revealId === null) {
            for (const m of MILESTONES) {
              if (r.done.has(m.id)) continue
              const d = m.t - nT
              if (d >= 0 && d < AR) { setRevealId(m.id); r.revealId = m.id; break }
            }
          }

          if (nT >= 1) setPlaying(false)
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
  }, [isLive])

  // ─── Derived display values ───────────────────────────────────────────────────

  const tm      = tick * 0.016
  const grade   = isLive ? (telemetry.grade ?? 0) : getGrade(riderT)
  const power   = isLive ? telemetry.power   : Math.round(175 + grade * 11 + Math.sin(tm * 1.3) * 16)
  const cadence = isLive ? telemetry.cadence : Math.round(87 + Math.sin(tm * 0.9) * 4)
  const hr      = isLive ? telemetry.hr      : Math.round(146 + grade * 5 + Math.sin(tm * 0.4) * 8)
  const kph     = isLive ? telemetry.speed   : Math.max(8, 31 - grade * 2.2 + Math.sin(tm * 1.7) * 2)
  const distKm  = isLive ? telemetry.distKm  : riderT * KM
  const elapsed = distKm / Math.max(kph, 1) * 3600
  const mins    = Math.floor(elapsed / 60)
  const secs    = Math.floor(elapsed % 60)

  const [rpx, rpy] = ptAt(ROUTE, riderT)
  const rX = riderT * EW
  const rY = EH - 6 - (getElev(riderT) / 100) * (EH - 16)

  const nextMilestone = MILESTONES.find(m => !done.has(m.id) && m.id !== revealId && m.t > riderT)

  // Panel bursts from the thumbnail's position — transform-origin is set per milestone
  const panelOrigin = panelMilestone
    ? (() => { const [mx, my] = ptAt(ROUTE, panelMilestone.t); return { x: mx, y: my - (MH - PH) } })()
    : { x: MW / 2, y: PH / 2 }

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
    setPlaying(false); setPanelMilestone(null)
  }

  const togglePlay = () => { const np = !r.playing; r.playing = np; setPlaying(np) }

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

  // ─── Render ────────────────────────────────────────────────────────────────

  return (
    <div style={{ width: '100%', fontFamily: 'system-ui, -apple-system, sans-serif' }}>
      <div style={{ background: '#0d1117', borderRadius: 12, overflow: 'hidden', maxWidth: MW, margin: '0 auto' }}>

        {/* ── HUD bar ── */}
        <div style={{ display: 'flex', background: '#080c14', borderBottom: '1px solid #1e293b' }}>
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
          {/* BLE status badge — only shown when trainer not connected */}
          {isLive && trainerStatus !== 'connected' && (
            <div style={{ padding: '5px 10px 6px', display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
              <div style={{ color: trainerStatus === 'searching' ? '#f59e0b' : '#ef4444', fontSize: 8, letterSpacing: '.1em', fontWeight: 700 }}>
                BLE
              </div>
              <div style={{ color: trainerStatus === 'searching' ? '#f59e0b' : '#ef4444', fontSize: 9, fontWeight: 600 }}>
                {trainerStatus}
              </div>
            </div>
          )}
        </div>

        {/* ── Map area ── */}
        <div style={{ position: 'relative', height: MH, overflow: 'hidden', background: '#111827' }}>

          {/* SVG: city grid, river, route, rider, compass
              TODO: replace with <MapContainer> from react-leaflet + OSM tiles */}
          <svg
            width="100%" height={MH}
            viewBox={`0 0 ${MW} ${MH}`}
            preserveAspectRatio="xMidYMid slice"
            style={{ display: 'block' }}
          >
            <defs>
              <clipPath id="route-done">
                <rect x={0} y={0} width={rpx + 2} height={MH} />
              </clipPath>
              <clipPath id="route-ahead">
                <rect x={Math.max(0, rpx - 2)} y={0} width={MW} height={MH} />
              </clipPath>
            </defs>

            <rect width={MW} height={MH} fill="#111827" />

            {CITY_BLOCKS.map(([x, y, w, h], i) => (
              <rect key={i} x={x} y={y} width={w} height={h} fill="#151e2e" rx={2} />
            ))}

            {/* Seine */}
            <path d={RIVER_PATH} fill="none" stroke="#1e3a5f" strokeWidth={20} strokeLinecap="round" />
            <path d={RIVER_PATH} fill="none" stroke="#1e4976" strokeWidth={13} strokeLinecap="round" />
            <path d={RIVER_PATH} fill="none" stroke="#2563eb" strokeWidth={7}  strokeLinecap="round" opacity={0.2} />

            {/* Road */}
            <path d={ROUTE_PATH} fill="none" stroke="#1a2435" strokeWidth={9} strokeLinecap="round" />
            <path d={ROUTE_PATH} fill="none" stroke="#334155" strokeWidth={4} strokeLinecap="round" clipPath="url(#route-ahead)" />
            <path d={ROUTE_PATH} fill="none" stroke="#f59e0b" strokeWidth={4} strokeLinecap="round" clipPath="url(#route-done)" />

            {/* Rider dot */}
            <circle cx={rpx} cy={rpy} r={11} fill="#f59e0b" opacity={0.15} />
            <circle cx={rpx} cy={rpy} r={7}  fill="#f59e0b" />
            <circle cx={rpx} cy={rpy} r={3}  fill="#fff" />

            {/* Compass */}
            <g transform="translate(22,22)" opacity={0.75}>
              <circle r={16} fill="#0a0f1a" />
              <text x={0} y={-5} textAnchor="middle" fill="#f59e0b" fontSize={9} fontWeight="700">N</text>
              <text x={0} y={12} textAnchor="middle" fill="#475569" fontSize={7}>S</text>
              <text x={9} y={4}  textAnchor="middle" fill="#475569" fontSize={7}>E</text>
              <text x={-9} y={4} textAnchor="middle" fill="#475569" fontSize={7}>W</text>
              <polygon points="0,-10 2,-3 0,0 -2,-3" fill="#f59e0b" />
              <polygon points="0,10 2,3 0,0 -2,3"   fill="#475569" />
            </g>

            <text x={MW - 8} y={MH - 6} textAnchor="end" fill="#1e293b" fontSize={9} fontStyle="italic">
              PARIS · SEINE ROUTE · 18 KM
            </text>
          </svg>

          {/* ── Milestone thumbnails ── */}
          {MILESTONES.map(m => {
            const [mx, my]  = ptAt(ROUTE, m.t)
            const isCompleted = done.has(m.id)
            const isRevealing = m.id === revealId
            const dist = m.t - riderT
            let sz, proximity

            if      (isCompleted)              { sz = 36; proximity = 0 }
            else if (isRevealing)              { sz = 68; proximity = 1 }
            else if (dist > 0 && dist < AP)    { proximity = 1 - dist / AP; sz = 30 + proximity * 52 }
            else                               { sz = 30; proximity = 0 }

            return (
              <div key={m.id}>
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

          {/* ── Next milestone chip ── */}
          {nextMilestone && !revealId && (
            <div style={{
              position: 'absolute', bottom: 10, right: 10,
              background: 'rgba(8,12,20,.9)',
              border: `0.5px solid ${nextMilestone.color}44`,
              borderRadius: 7, padding: '4px 10px',
              color: '#475569', fontSize: 11,
            }}>
              Next:{' '}
              <span style={{ color: nextMilestone.color, fontWeight: 600 }}>{nextMilestone.name}</span>
              {' · '}{((nextMilestone.t - riderT) * KM).toFixed(1)} km
            </div>
          )}

          {/* ── Reveal panel ──
              Scales out from the thumbnail's position via transform-origin.
              panelMilestone persists after revealId clears to allow the scale-out
              animation to play before the element is removed from the DOM. */}
          {panelMilestone && (
            <div
              onClick={dismiss}
              style={{
                position: 'absolute', bottom: 0, left: 0, right: 0, height: PH,
                cursor: 'pointer', overflow: 'hidden', borderRadius: 6,
                transform: revealIn ? 'scale(1)' : 'scale(0)',
                transformOrigin: `${panelOrigin.x}px ${panelOrigin.y}px`,
                opacity: revealIn ? 1 : 0,
                transition: 'transform .48s cubic-bezier(.34,1.45,.64,1), opacity .22s ease',
                zIndex: 100,
              }}
            >
              {/* Full-bleed landmark photo */}
              <img
                src={panelMilestone.img} alt={panelMilestone.name}
                style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
                onError={e => { e.target.style.display = 'none'; e.target.parentNode.style.background = panelMilestone.color + '33' }}
              />

              {/* Colored accent bar at top */}
              <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 3, background: panelMilestone.color, zIndex: 2 }} />

              {/* Dot at marker's x — visual thread from thumbnail to panel */}
              <div style={{
                position: 'absolute', top: -3, left: panelOrigin.x - 6,
                width: 12, height: 12, borderRadius: '50%',
                background: panelMilestone.color,
                border: '2px solid rgba(255,255,255,.3)',
                zIndex: 3,
              }} />

              {/* Text overlay */}
              <div style={{
                position: 'absolute', bottom: 0, left: 0, right: 0,
                background: 'rgba(5,8,14,.92)',
                padding: '10px 20px 14px',
                zIndex: 2,
              }}>
                <div style={{ color: panelMilestone.color, fontSize: 10, letterSpacing: '.14em', fontWeight: 700, marginBottom: 3 }}>
                  ● MILESTONE · {panelMilestone.dist}
                </div>
                <div style={{ color: '#f1f5f9', fontSize: 23, fontWeight: 600, lineHeight: 1.2, marginBottom: 6 }}>
                  {panelMilestone.name}
                </div>
                <div style={{ color: '#aab4c2', fontSize: 11.5, lineHeight: 1.65, marginBottom: 10 }}>
                  {panelMilestone.fact}
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 5 }}>
                  <span style={{ color: '#334155', fontSize: 10 }}>tap to continue · auto in</span>
                  <span style={{ color: panelMilestone.color, fontSize: 11, fontFamily: 'monospace', fontWeight: 600 }}>
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
          )}
        </div>

        {/* ── Elevation strip ── */}
        <div style={{ background: '#0a0f1a', borderTop: '1px solid #1e293b' }}>
          <svg
            width="100%" height={EH}
            viewBox={`0 0 ${EW} ${EH}`}
            preserveAspectRatio="none"
            style={{ display: 'block' }}
          >
            <defs>
              <clipPath id="elev-done">  <rect x={0}  y={0} width={rX}       height={EH} /></clipPath>
              <clipPath id="elev-ahead"> <rect x={rX} y={0} width={EW - rX}  height={EH} /></clipPath>
            </defs>

            <path d={ELEV_AREA} fill="#1e3a5f" opacity={0.4}  clipPath="url(#elev-ahead)" />
            <path d={ELEV_AREA} fill="#f59e0b" opacity={0.18} clipPath="url(#elev-done)"  />
            <path d={ELEV_LINE} fill="none" stroke="#283650" strokeWidth={1.5} clipPath="url(#elev-ahead)" />
            <path d={ELEV_LINE} fill="none" stroke="#f59e0b" strokeWidth={1.5} clipPath="url(#elev-done)"  />

            {MILESTONES.map(m => {
              const ex = m.t * EW
              const ey = EH - 6 - (getElev(m.t) / 100) * (EH - 16)
              const ic = done.has(m.id)
              return (
                <g key={m.id}>
                  <line x1={ex} y1={ey} x2={ex} y2={EH - 1}
                    stroke={ic ? '#22c55e' : m.color} strokeWidth={1} opacity={0.5} strokeDasharray="2 3" />
                  <circle cx={ex} cy={ey} r={3} fill={ic ? '#22c55e' : m.color} opacity={0.85} />
                </g>
              )
            })}

            {/* Rider position on elevation */}
            <line x1={rX} y1={0} x2={rX} y2={EH} stroke="#f59e0b" strokeWidth={1} opacity={0.3} />
            <circle cx={rX} cy={rY} r={4} fill="#f59e0b" />
            <circle cx={rX} cy={rY} r={7} fill="none" stroke="#f59e0b" strokeWidth={1} opacity={0.4} />
          </svg>
        </div>

        {/* ── Controls (simulation only — hidden when live backend is connected) ── */}
        <div style={{
          display: isLive ? 'none' : 'flex', alignItems: 'center', gap: 10,
          padding: '8px 14px', background: '#0d1117', borderTop: '1px solid #1e293b',
        }}>
          <button
            onClick={togglePlay}
            style={{
              background: playing ? 'transparent' : '#f59e0b',
              color: playing ? '#64748b' : '#0d1117',
              border: playing ? '0.5px solid #1e293b' : 'none',
              borderRadius: 7, padding: '6px 18px',
              fontSize: 13, fontWeight: 700, cursor: 'pointer', minWidth: 85,
            }}
          >
            {playing ? '⏸ Pause' : '▶ Ride'}
          </button>

          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1 }}>
            <span style={{ color: '#334155', fontSize: 11 }}>Demo speed</span>
            <input
              type="range" min={1} max={10} step={1} value={speed}
              onChange={e => setSpeed(Number(e.target.value))}
              style={{ flex: 1 }}
            />
            <span style={{ color: '#64748b', fontSize: 11, minWidth: 24 }}>{speed}×</span>
          </div>

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

          <span style={{ color: '#1e3a5f', fontSize: 10, fontStyle: 'italic' }}>Paris · Seine · 18 km</span>
        </div>

      </div>
    </div>
  )
}
