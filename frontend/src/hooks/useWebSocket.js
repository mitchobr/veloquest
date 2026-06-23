import { useState, useEffect, useRef, useCallback } from 'react'

const WS_URL = `ws://${window.location.host}/ws`
const MAX_BACKOFF = 16000

/**
 * WebSocket connection to the Passage backend.
 * Returns { telemetry, trainerStatus, lastEvent, sendMessage, connected }.
 *
 * lastEvent: { type, milestoneId?, ts } — single latest event, not a queue.
 * Auto-reconnects with exponential backoff (1s → 2s → 4s → ... → 16s).
 */
export function useWebSocket() {
  const [telemetry,      setTelemetry]      = useState(null)
  const [trainerStatus,  setTrainerStatus]  = useState('disconnected')
  const [lastEvent,      setLastEvent]      = useState(null)
  const [connected,      setConnected]      = useState(false)
  const [routeWaypoints, setRouteWaypoints] = useState([])
  const [routeTotalKm,   setRouteTotalKm]   = useState(0)

  const ws           = useRef(null)
  const retryDelay   = useRef(1000)
  const retryTimer   = useRef(null)
  const unmounted    = useRef(false)

  const connect = useCallback(() => {
    if (unmounted.current) return

    const socket = new WebSocket(WS_URL)
    ws.current = socket

    socket.onopen = () => {
      if (unmounted.current) return
      retryDelay.current = 1000
      setConnected(true)
    }

    socket.onmessage = (e) => {
      if (unmounted.current) return
      let msg
      try { msg = JSON.parse(e.data) } catch { return }

      switch (msg.type) {
        case 'telemetry':
          setTelemetry(msg)
          break
        case 'trainer_status':
          setTrainerStatus(msg.status)
          break
        case 'milestone_reached':
        case 'ride_complete':
          setLastEvent({ ...msg, ts: Date.now() })
          break
        case 'route_loaded':
          setRouteWaypoints(msg.waypoints || [])
          setRouteTotalKm(msg.totalKm || 0)
          break
      }
    }

    socket.onclose = () => {
      if (unmounted.current) return
      setConnected(false)
      setTelemetry(null)
      setTrainerStatus('disconnected')
      ws.current = null
      retryTimer.current = setTimeout(() => {
        retryDelay.current = Math.min(retryDelay.current * 2, MAX_BACKOFF)
        connect()
      }, retryDelay.current)
    }

    socket.onerror = () => {
      socket.close()
    }
  }, [])

  useEffect(() => {
    unmounted.current = false
    connect()
    return () => {
      unmounted.current = true
      clearTimeout(retryTimer.current)
      ws.current?.close()
    }
  }, [connect])

  const sendMessage = useCallback((msg) => {
    if (ws.current?.readyState === WebSocket.OPEN) {
      ws.current.send(JSON.stringify(msg))
    }
  }, [])

  return { telemetry, trainerStatus, lastEvent, sendMessage, connected, routeWaypoints, routeTotalKm }
}
