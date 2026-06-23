import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import TrainerMap from './components/TrainerMap.jsx'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <TrainerMap />
  </StrictMode>
)
