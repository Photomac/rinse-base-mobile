import type { Language } from './i18n'

// The crew training videos (8 short vertical episodes per language) live on the
// marketing site, one static page per language. The app only links to them:
// the videos are about 3 MB each and are served by the site, not bundled, so
// this stays an OTA-only change and a re-filmed episode needs no app release.
//
// Portuguese has no episodes yet. It opens the English page, and the Profile
// row's Portuguese subtitle says the videos are in English, so nobody taps
// expecting Portuguese. Point 'pt' at its own page once those are filmed.
const BASE = 'https://www.rinsebase.com'

export const CREW_TRAINING_PATH: Record<Language, string> = {
  en: '/crew-training',
  es: '/crew-training-es',
  pt: '/crew-training',
}

export function crewTrainingUrl(lang: Language): string {
  return BASE + (CREW_TRAINING_PATH[lang] ?? CREW_TRAINING_PATH.en)
}
