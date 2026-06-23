import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import 'leaflet/dist/leaflet.css'
import TrainerMap from './components/TrainerMap.jsx'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <TrainerMap />
  </StrictMode>
)
