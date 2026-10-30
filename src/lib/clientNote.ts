// The crew's note for the client on a clean: jobs.guest_ready_note, the "Note
// from crew" on the guest-ready email and on that clean in the client portal
// (CKS Perfections, 2026-10-29). Only the web's job panel could write it, so
// four cleans on the whole platform had one.
//
// The email reads the note when the clean turns guest ready, inside the write
// that completes it (fn_auto_guest_ready) or when its inspection passes
// (fn_release_guest_ready_on_inspection), and never again. So the note goes in
// the Complete itself, or before it when the server will complete the clean
// later, on the last photo (completeHeldJob). scripts/test-client-note.mjs.

/** Long enough for a real note; the guest-ready text message carries it too. */
export const CLIENT_NOTE_MAX = 500

/** A clean not finished yet: only cleans tell the client, only Complete saves it. */
export function takesClientNote(job: { status?: string | null; job_type?: string | null } | null | undefined): boolean {
  return !!job && (job.job_type ?? 'clean') === 'clean' && job.status !== 'completed'
}

/**
 * What the write adds for the note. Nothing when the box is empty, so a Complete
 * that doesn't use it leaves a note the office already wrote. Null only to take
 * back this phone's own earlier save (savedEarlier), when the Complete it went
 * ahead of didn't go through and the crew then cleared the box.
 */
export function clientNoteValues(typed: string, savedEarlier = false): { guest_ready_note?: string | null } {
  const note = typed.trim()
  if (note) return { guest_ready_note: note }
  return savedEarlier ? { guest_ready_note: null } : {}
}
