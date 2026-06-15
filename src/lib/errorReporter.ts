// Reports unexpected mobile errors to the log-client-error edge function so they
// land in admin_error_log and show on the admin System Health page. React Native
// has no window — uncaught JS errors come through global ErrorUtils; render errors
// come through the ErrorBoundary. Defensive: throttled, deduped, never throws.
import { supabase } from './supabase'

let ctx: { tenantId?: string; email?: string; role?: string } = {}
export function setErrorContext(next: Partial<typeof ctx>) {
  ctx = { ...ctx, ...next }
}

const IGNORE = [
  /Network request failed/i,   // offline / transient — not actionable
  /AbortError/i,
]

const seen = new Map<string, number>()
let sent = 0
const MAX_PER_SESSION = 25

export function reportClientError(message?: string, stack?: string, source = 'app') {
  try {
    const msg = (message || '').trim()
    if (!msg) return
    if (IGNORE.some((re) => re.test(msg))) return
    if (sent >= MAX_PER_SESSION) return
    const key = `${source}|${msg.slice(0, 140)}`
    const now = Date.now()
    const last = seen.get(key)
    if (last && now - last < 60_000) return // dedupe: same error at most once/min
    seen.set(key, now)
    sent++
    supabase.functions.invoke('log-client-error', {
      body: {
        platform: 'mobile',
        source,
        message: msg.slice(0, 1000),
        stack: (stack || '').slice(0, 2000),
        tenantId: ctx.tenantId,
        email: ctx.email,
        role: ctx.role,
      },
    }).catch(() => {})
  } catch { /* never throw from the reporter */ }
}

// Hook the RN global error handler (uncaught JS errors, fatal + non-fatal),
// preserving the previous handler so the normal crash/redbox behavior still runs.
export function initErrorReporting() {
  const g: any = global as any
  const EU = g?.ErrorUtils
  if (!EU || typeof EU.setGlobalHandler !== 'function') return
  const prev = typeof EU.getGlobalHandler === 'function' ? EU.getGlobalHandler() : null
  EU.setGlobalHandler((error: any, isFatal?: boolean) => {
    try { reportClientError(error?.message || String(error), error?.stack, isFatal ? 'fatal' : 'global') } catch { /* swallow */ }
    if (typeof prev === 'function') prev(error, isFatal)
  })
}
