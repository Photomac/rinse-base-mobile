// A small copy of a stored photo, for a thumbnail. Job photos are full-size
// camera files (~2.3 MB at Celebrity Clean, ~65 a clean): a room's 34 px
// previews loaded every one of them whole, and on a weak bar they sat as gray
// squares ("doesn't load in", 2026-10-23). Storage's image transformation
// endpoint (render/image) sends a few KB instead. Same rule as the web's
// thumbUrl (rinsebase-app src/components/dashboard/ui.tsx).
//
// Cost: Supabase bills each distinct photo it transforms in a billing cycle
// ($5 per 1,000 past the plan's 100), however many times it is asked for.

/** A `px`-square thumbnail URL for a public storage photo. Anything else (a
 *  file on the phone, another host) comes back unchanged. */
export function thumbUrl(url: string, px: number): string {
  if (!url.includes('/storage/v1/object/public/')) return url
  const size = Math.round(px * 3) // 3x screens
  return url.replace('/storage/v1/object/public/', '/storage/v1/render/image/public/')
    + `${url.includes('?') ? '&' : '?'}width=${size}&height=${size}&resize=cover`
}

/** What a thumbnail tries, in order: the small copy, the photo itself, then
 *  the fallback's small copy and the fallback (components/ShotThumb). */
export function thumbSources(uri: string, fallback: string | null, px: number): string[] {
  const all = [thumbUrl(uri, px), uri, ...(fallback ? [thumbUrl(fallback, px), fallback] : [])]
  return all.filter((u, i) => all.indexOf(u) === i)
}
