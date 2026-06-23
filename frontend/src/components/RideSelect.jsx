import { useState, useEffect } from 'react'

function formatTime(seconds) {
  if (!seconds) return null
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = Math.floor(seconds % 60)
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`
}

function RideCard({ ride, onSelectRide }) {
  const [imgError, setImgError] = useState(false)

  return (
    <div style={{
      background: '#161b22',
      border: '1px solid #21262d',
      borderRadius: 16,
      overflow: 'hidden',
      display: 'flex',
      flexDirection: 'column',
      maxWidth: 480,
      width: '100%',
      transition: 'border-color .2s',
    }}
      onMouseEnter={e => e.currentTarget.style.borderColor = '#f59e0b'}
      onMouseLeave={e => e.currentTarget.style.borderColor = '#21262d'}
    >
      {/* Cover image */}
      <div style={{ position: 'relative', width: '100%', paddingTop: '56.25%', background: '#0d1117' }}>
        {ride.coverImage && !imgError ? (
          <img
            src={ride.coverImage}
            alt={ride.name}
            onError={() => setImgError(true)}
            style={{
              position: 'absolute', inset: 0,
              width: '100%', height: '100%',
              objectFit: 'cover',
            }}
          />
        ) : (
          <div style={{
            position: 'absolute', inset: 0,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 48, opacity: 0.3,
          }}>
            🚴
          </div>
        )}
        {/* Distance badge */}
        {ride.totalKm && (
          <div style={{
            position: 'absolute', top: 10, right: 10,
            background: 'rgba(0,0,0,.7)', color: '#f59e0b',
            fontSize: 13, fontWeight: 700, padding: '3px 10px', borderRadius: 20,
          }}>
            {ride.totalKm.toFixed(1)} km
          </div>
        )}
      </div>

      {/* Content */}
      <div style={{ padding: '20px 24px 24px', flex: 1, display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 20, fontWeight: 700, color: '#e6edf3' }}>
            {ride.name}
          </h2>
          {ride.description && (
            <p style={{ margin: '6px 0 0', fontSize: 13, color: '#8b949e', lineHeight: 1.5 }}>
              {ride.description}
            </p>
          )}
        </div>

        {/* Stats row */}
        <div style={{ display: 'flex', gap: 20, fontSize: 13 }}>
          <div style={{ color: '#8b949e' }}>
            <span style={{ color: '#e6edf3', fontWeight: 600 }}>{ride.milestoneCount}</span>
            {' '}landmarks
          </div>
          {ride.completions > 0 ? (
            <div style={{ color: '#8b949e' }}>
              <span style={{ color: '#34d399', fontWeight: 600 }}>{ride.completions}</span>
              {' '}{ride.completions === 1 ? 'completion' : 'completions'}
            </div>
          ) : (
            <div style={{ color: '#8b949e' }}>Not yet ridden</div>
          )}
          {ride.bestTimeS && (
            <div style={{ color: '#8b949e' }}>
              Best: <span style={{ color: '#e6edf3', fontWeight: 600 }}>{formatTime(ride.bestTimeS)}</span>
            </div>
          )}
        </div>

        {/* Start button */}
        <button
          onClick={() => onSelectRide(ride.id)}
          style={{
            marginTop: 'auto',
            padding: '12px 0',
            background: '#f59e0b',
            color: '#0d1117',
            border: 'none',
            borderRadius: 10,
            fontSize: 15,
            fontWeight: 700,
            cursor: 'pointer',
            transition: 'background .15s',
          }}
          onMouseEnter={e => e.currentTarget.style.background = '#fbbf24'}
          onMouseLeave={e => e.currentTarget.style.background = '#f59e0b'}
        >
          Start Ride
        </button>
      </div>
    </div>
  )
}

export default function RideSelect({ onSelectRide }) {
  const [rides, setRides]     = useState(null)   // null = loading
  const [error, setError]     = useState(null)

  useEffect(() => {
    let cancelled = false
    const tryFetch = async () => {
      try {
        const res = await fetch('/api/rides')
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const data = await res.json()
        if (!cancelled) setRides(data)
      } catch {
        if (!cancelled) {
          // Backend not up yet — retry after 2s
          setTimeout(tryFetch, 2000)
        }
      }
    }
    tryFetch()
    return () => { cancelled = true }
  }, [])

  return (
    <div style={{
      minHeight: '100vh',
      background: '#0d1117',
      color: '#e6edf3',
      fontFamily: 'system-ui, -apple-system, sans-serif',
      display: 'flex',
      flexDirection: 'column',
    }}>
      {/* Header */}
      <header style={{
        padding: '32px 40px 0',
        borderBottom: '1px solid #21262d',
        paddingBottom: 28,
      }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 12 }}>
          <h1 style={{ margin: 0, fontSize: 28, fontWeight: 800, letterSpacing: -0.5 }}>
            VeloQuest
          </h1>
          <span style={{ fontSize: 13, color: '#8b949e' }}>Open-source cycling trainer</span>
        </div>
        <p style={{ margin: '8px 0 0', fontSize: 14, color: '#8b949e' }}>
          Select a ride to begin
        </p>
      </header>

      {/* Content */}
      <main style={{ flex: 1, padding: '40px', maxWidth: 960, width: '100%', margin: '0 auto', boxSizing: 'border-box' }}>
        {rides === null ? (
          // Loading / connecting
          <div style={{ textAlign: 'center', paddingTop: 80, color: '#8b949e' }}>
            <div style={{ fontSize: 32, marginBottom: 16, opacity: 0.5 }}>⏳</div>
            <p style={{ margin: 0, fontSize: 15 }}>Connecting to backend…</p>
            <p style={{ margin: '6px 0 0', fontSize: 13, opacity: 0.7 }}>
              Make sure the backend is running: <code>python -m backend.main</code>
            </p>
          </div>
        ) : error ? (
          <div style={{ textAlign: 'center', paddingTop: 80, color: '#f87171' }}>
            <p>{error}</p>
          </div>
        ) : rides.length === 0 ? (
          <div style={{ textAlign: 'center', paddingTop: 80, color: '#8b949e' }}>
            <p style={{ fontSize: 15 }}>No rides found in the <code>rides/</code> directory.</p>
          </div>
        ) : (
          <div style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: 24,
            justifyContent: rides.length === 1 ? 'center' : 'flex-start',
          }}>
            {rides.map(ride => (
              <RideCard key={ride.id} ride={ride} onSelectRide={onSelectRide} />
            ))}
          </div>
        )}
      </main>
    </div>
  )
}
