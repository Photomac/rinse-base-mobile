import type { Language } from './i18n'

// The crew training videos (8 short vertical episodes) live on the marketing
// site, one static page per language. The app only links to them: the videos
// are about 3 MB each and are served by the site, not bundled, so this stays an
// OTA-only change and a re-filmed episode needs no app release.
//
// Portuguese has no episodes filmed yet. Its page has everything in Portuguese
// around the English videos (English captions), and the Profile row's
// Portuguese subtitle says "legendas em inglês", so nobody taps expecting
// Portuguese video.
const BASE = 'https://www.rinsebase.com'

export const CREW_TRAINING_PATH: Record<Language, string> = {
  en: '/crew-training',
  es: '/crew-training-es',
  pt: '/crew-training-pt',
}

export function crewTrainingUrl(lang: Language): string {
  return BASE + (CREW_TRAINING_PATH[lang] ?? CREW_TRAINING_PATH.en)
}
