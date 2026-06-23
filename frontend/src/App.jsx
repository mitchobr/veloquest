import { useState } from 'react'
import RideSelect from './components/RideSelect.jsx'
import TrainerMap from './components/TrainerMap.jsx'

export default function App() {
  const [screen, setScreen] = useState('select')  // 'select' | 'riding'
  const [rideId, setRideId] = useState(null)

  const handleSelectRide = (id) => {
    setRideId(id)
    setScreen('riding')
  }

  const handleBack = () => {
    setScreen('select')
    setRideId(null)
  }

  if (screen === 'riding' && rideId) {
    return <TrainerMap rideId={rideId} onBack={handleBack} />
  }

  return <RideSelect onSelectRide={handleSelectRide} />
}
