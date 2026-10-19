import React, { useEffect, useState } from 'react'
import { Text, type StyleProp, type TextStyle } from 'react-native'
import { jobClockMs, fmtJobClock } from '../lib/jobTimer'

// Often enough that the minute shown is never more than 15 s behind.
const TICK_MS = 15_000

/**
 * "⏱ 1h 12m" on a job in progress (see lib/jobTimer). Renders nothing when no
 * clock runs, so a caller can place it unconditionally.
 */
export function JobClock({ job, prefix = '', style }: {
  job: { status?: string | null; started_at?: string | null } | null | undefined
  prefix?: string
  style?: StyleProp<TextStyle>
}) {
  const [now, setNow] = useState(() => Date.now())
  const running = job?.status === 'in_progress' && !!job?.started_at
  useEffect(() => {
    if (!running) return
    setNow(Date.now())
    const id = setInterval(() => setNow(Date.now()), TICK_MS)
    return () => clearInterval(id)
  }, [running, job?.started_at])
  const ms = jobClockMs(job, now)
  if (ms == null) return null
  return <Text style={style}>{prefix}{fmtJobClock(ms)}</Text>
}
