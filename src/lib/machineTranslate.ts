// Machine translation of OWNER-WRITTEN text for the crew's language.
//
// vocab.ts covers every string Rinsebase itself seeded (default checklist
// tasks, room names, supply catalog) with a static table. This covers the rest:
// custom checklist tasks, custom room names, property crew notes, job notes —
// free text an owner typed, which no table can anticipate. The
// `translate-crew-text` edge function translates a miss once with Claude and
// caches it platform-wide; this module keeps a per-device copy so a screen
// the crew already opened stays translated offline.
//
// Display only, and fails soft: anything not translated yet — no signal, a
// model error, the function not deployed — renders in English, never blank.
// Nothing is written back to the owner's rows.

import { useEffect, useMemo, useState } from 'react'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { supabase } from './supabase'
import { tv } from './vocab'
import type { Language } from './i18n'

const PREFIX = 'mt:'
const MAX_ITEMS = 80
const MAX_CHARS = 600

// Same normalization as the edge function — responses are keyed by it.
export function normalizeText(s: string): string {
  return s.replace(/[ \t]+/g, ' ').replace(/ *\r?\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim()
}

// djb2 — only a storage key, never sent anywhere; the server hashes for itself.
function keyOf(lang: Language, text: string): string {
  let h = 5381
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0
  return `${PREFIX}${lang}:${(h >>> 0).toString(36)}:${text.length}`
}

const mem: Record<Language, Map<string, string>> = { en: new Map(), es: new Map(), pt: new Map() }
const inflight = new Map<string, Promise<void>>()

function translatable(s: string): boolean {
  return /\p{L}{2,}/u.test(s)
}

/**
 * Resolve translations for `texts` in `lang`. Returns a map keyed by the
 * NORMALIZED source string; anything missing simply is not in the map.
 * Reads memory → AsyncStorage → the edge function, in that order.
 */
export async function translateTexts(lang: Language, texts: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  if (lang === 'en') return out
  const wanted = Array.from(new Set(texts.map(t => normalizeText(t || ''))))
    .filter(t => t.length > 0 && t.length <= MAX_CHARS && translatable(t))
    // Seeded vocabulary is already handled locally — never send it.
    .filter(t => tv(lang, t) === t)
    .slice(0, MAX_ITEMS)
  if (wanted.length === 0) return out

  const misses: string[] = []
  for (const t of wanted) {
    const m = mem[lang].get(t)
    if (m !== undefined) { out.set(t, m); continue }
    try {
      const stored = await AsyncStorage.getItem(keyOf(lang, t))
      if (stored != null) { mem[lang].set(t, stored); out.set(t, stored); continue }
    } catch { /* storage unavailable — treat as a miss */ }
    misses.push(t)
  }
  if (misses.length === 0) return out

  // Coalesce identical in-flight batches (a re-render mid-fetch must not fire twice).
  const batchKey = `${lang}|${misses.join('\u0001')}`
  let p = inflight.get(batchKey)
  if (!p) {
    p = (async () => {
      try {
        const { data, error } = await supabase.functions.invoke('translate-crew-text', {
          body: { texts: misses, target: lang },
        })
        if (error || !data?.translations) return
        for (const [src, dst] of Object.entries<string>(data.translations)) {
          if (typeof dst !== 'string' || !dst) continue
          mem[lang].set(src, dst)
          AsyncStorage.setItem(keyOf(lang, src), dst).catch(() => {})
        }
      } catch { /* offline or function unavailable — English stays */ }
    })().finally(() => inflight.delete(batchKey))
    inflight.set(batchKey, p)
  }
  await p
  for (const t of misses) {
    const m = mem[lang].get(t)
    if (m !== undefined) out.set(t, m)
  }
  return out
}

/**
 * Hook: returns `tx(text)` — the text in the crew's language. Seeded strings
 * come from vocab.ts synchronously; owner text arrives once the fetch lands
 * (English until then). Pass every owner-written string the screen renders.
 */
export function useMachineTranslation(lang: Language, texts: (string | null | undefined)[]): (text: string | null | undefined) => string {
  const list = useMemo(
    () => Array.from(new Set(texts.filter((t): t is string => !!t).map(normalizeText).filter(Boolean))),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [texts.filter(Boolean).map(t => normalizeText(t as string)).sort().join('\u0001')],
  )
  const [map, setMap] = useState<Map<string, string>>(() => new Map())

  useEffect(() => {
    let live = true
    if (lang === 'en' || list.length === 0) { setMap(new Map()); return }
    translateTexts(lang, list).then(m => { if (live) setMap(m) })
    return () => { live = false }
  }, [lang, list])

  return (text) => {
    if (!text) return text ?? ''
    if (lang === 'en') return text
    const hit = map.get(normalizeText(text))
    return hit ?? tv(lang, text)
  }
}
