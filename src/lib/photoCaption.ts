// The caption a photo taken for a checklist line is saved with.
//
// Photos opens with its note filled in from the line ("Scrub toilet inside,
// outside, and base"), shown in the crew's language. The caption SAVED is the
// line's own text, the owner's English, whenever the crew left the note
// naming the line (untouched, or typed back to the line in either language):
//  - the client portal and the office show captions as written, in the
//    language the owner wrote the checklist in, so a Spanish caption under an
//    English checklist would read as a mistake;
//  - the photo is linked to the line by checklist_item_id only while the note
//    names the line, and older bundles still match a photo to its line by
//    caption == title (JobPhotosScreen's dual-write note).
// A note the crew rewrote is theirs and is saved exactly as typed.

export interface ChecklistPhotoLine { title?: string | null; jobItemId?: string | null }

/**
 * typed: the note as the crew left it, or null if they never edited it.
 * shownTitle: the line's title as the crew sees it (machine-translated).
 */
export function checklistPhotoNote(
  typed: string | null,
  line: ChecklistPhotoLine | null | undefined,
  shownTitle: string,
): { caption: string; checklistItemId: string | null } {
  const title = (line?.title || '').trim()
  const shown = (shownTitle || '').trim()
  const text = (typed ?? shownTitle ?? '').trim()
  const namesLine = !!title && (text === title || (!!shown && text === shown))
  return {
    caption: namesLine ? title : text,
    checklistItemId: namesLine && line?.jobItemId ? line.jobItemId : null,
  }
}
