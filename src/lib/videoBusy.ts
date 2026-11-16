// What else is going over the network right now, for a video piece to give
// way to (lib/tusUpload.ts): saves waiting in the outbox or on their way
// (clock in/out, Complete, notes, …), photos uploading or waiting for signal,
// an SOS. Its own file so lib/videoQueue.ts doesn't import the photo queue,
// the SOS queue and the network layer (its test harnesses swap this one
// import for a stand-in).
import { pendingOpCount } from './outbox'
import { photoQueueActive, pendingStatus } from './photoQueue'
import { isSOSFlushing } from './sosQueue'
import { oldestWriteWaitMs } from './netFetch'
import type { Busy } from './tusUpload'

export async function videoBusy(): Promise<Busy> {
  const [outbox, photos] = await Promise.all([
    pendingOpCount().catch(() => 0),
    // Photos the server refused aren't waiting for the link: they don't hold
    // a video back (they would hold it for good).
    pendingStatus().then(s => s.count - s.serverRejected).catch(() => 0),
  ])
  return { outbox, writeWaitMs: oldestWriteWaitMs(), photos: photoQueueActive() || photos > 0, sos: isSOSFlushing() }
}
