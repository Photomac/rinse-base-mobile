// A file name nobody can guess, for photos in the public job-photos bucket
// (chat and job-thread attachments, chatAttachments.ts).
//
// Whoever knows a public file's path can open it. A <Date.now()> name was
// guessable from the folder and a rough send time; the web names the same
// files crypto.randomUUID() since rinse-base-app #2072, which also lists a
// chat/<channel>/ folder only to that channel's members.
//
// Prefers the runtime's own crypto randomness when it has one; falls back to
// Math.random (122 random bits: far beyond guessing, though not a CSPRNG). No
// native module, so it ships over the air. Pure: scripts/test-random-file-id.mjs
// runs it under Node.
export function randomFileId(): string {
  const c = (globalThis as any).crypto
  try {
    if (typeof c?.randomUUID === 'function') return String(c.randomUUID())
    if (typeof c?.getRandomValues === 'function') {
      const b: Uint8Array = c.getRandomValues(new Uint8Array(16))
      b[6] = (b[6] & 0x0f) | 0x40
      b[8] = (b[8] & 0x3f) | 0x80
      const h = Array.from(b, x => x.toString(16).padStart(2, '0')).join('')
      return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
    }
  } catch { /* fall through */ }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, ch => {
    const r = (Math.random() * 16) | 0
    return (ch === 'x' ? r : (r & 0x3) | 0x8).toString(16)
  })
}
