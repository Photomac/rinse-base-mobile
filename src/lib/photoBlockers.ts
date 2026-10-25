// src/lib/photoBlockers.ts
// Which of the completion gate's blockers (job_completion_blockers) a photo
// still on this phone answers once it lands.
//
// Why (2026-10-25, Celebrity Clean): Complete refused while a clean's photos
// were still uploading, so on a weak bar the crew stayed clocked in until
// they went up: hours, once. When every blocker is a photo on its way from
// this phone, Complete now goes at the tap and the outbox holds it until they
// land (lib/outbox: a queued Complete waits for its clean's photos). Only
// then: a blocker no photo here answers (one never taken, a teammate's shot
// still on their phone, an unticked line) still stops the Complete, or the
// held Complete would reach a gate that refuses it and park.
//
// Matched the way the gate matches a saved job_photos row, one rule per code.

export interface GateBlocker {
  code: string
  checklist_item_id?: string | null
  task?: string | null
  requirement_id?: string | null
}

/** A photo still on the phone, by what the gate matches its row on (photoQueue.photosOnPhone). */
export interface PhotoOnPhone {
  photo_type: string
  caption: string | null
  checklist_item_id: string | null
  photo_requirement_id: string | null
  check_first_line_id: string | null
}

export function answeredOnPhone(b: GateBlocker, photos: PhotoOnPhone[]): boolean {
  switch (b.code) {
    // A named property shot: its requirement only, no caption fallback.
    case 'missing_required_area_photo':
      return !!b.requirement_id && photos.some(p => p.photo_requirement_id === b.requirement_id)
    // A checklist line's photo: its item, or (legacy) an unlinked photo captioned with the task.
    case 'missing_required_photo':
      return photos.some(p =>
        (!!b.checklist_item_id && p.checklist_item_id === b.checklist_item_id) ||
        (!p.checklist_item_id && b.task != null && p.caption === b.task))
    // Any after or general photo that isn't a Check first photo.
    case 'no_after_photo':
      return photos.some(p => (p.photo_type === 'after' || p.photo_type === 'general') && !p.check_first_line_id)
    // A Check first line's photo (requirement_id = the line's id).
    case 'check_first_photo_missing':
      return !!b.requirement_id && photos.some(p => p.check_first_line_id === b.requirement_id)
    // Not a photo: nothing on the phone answers it.
    default:
      return false
  }
}

/** The blockers no photo on this phone answers. Empty: Complete can go now and wait for them. */
export function blockersNotOnPhone<B extends GateBlocker>(blockers: B[], photos: PhotoOnPhone[]): B[] {
  return blockers.filter(b => !answeredOnPhone(b, photos))
}

/** What Complete does with the gate's blockers while this clean has photos on the phone. */
export type WhileUploading<B> =
  /** Every blocker is a photo on its way from here: complete now, the outbox holds it until they land. */
  | { kind: 'go' }
  /** Some are: these aren't, and still have to be done. */
  | { kind: 'name'; left: B[] }
  /** None is: say the photos are uploading, as before (they may be what is missing after all). */
  | { kind: 'wait' }

export function completeWhileUploading<B extends GateBlocker>(blockers: B[], photos: PhotoOnPhone[]): WhileUploading<B> {
  const left = blockersNotOnPhone(blockers, photos)
  if (left.length === 0) return { kind: 'go' }
  if (left.length < blockers.length) return { kind: 'name', left }
  return { kind: 'wait' }
}
