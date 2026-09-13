// THROWAWAY: proves the required Rules of Hooks check blocks a merge.
// Not imported anywhere. This PR will be closed, never merged.
import { useState } from 'react'

export function GateProbe({ ready }: { ready: boolean }) {
  const [count] = useState(0)
  if (!ready) return null
  return count
}
