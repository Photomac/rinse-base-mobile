// THROWAWAY: proves the required Rules of Hooks check blocks a merge.
// Not imported anywhere. This PR will be closed, never merged.
import { useState } from 'react'

export function GateProbe({ ready }: { ready: boolean }) {
  if (!ready) return null
  const [count] = useState(0)
  return count
}
