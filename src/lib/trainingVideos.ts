import type { Language } from './i18n'

// The crew training videos (8 short vertical episodes) live on the marketing
// site, one static page per language. The app only links to them: the videos
// are about 3 MB each and are served by the site, not bundled, so this stays an
// OTA-only change and a re-filmed episode needs no app release.
//
// Portuguese plays the English footage with Portuguese captions (the screens
// show the app in English; captions name buttons by their Portuguese labels).
const BASE = 'https://www.rinsebase.com'

export const CREW_TRAINING_PATH: Record<Language, string> = {
  en: '/crew-training',
  es: '/crew-training-es',
  pt: '/crew-training-pt',
}

export function crewTrainingUrl(lang: Language): string {
  return BASE + (CREW_TRAINING_PATH[lang] ?? CREW_TRAINING_PATH.en)
}
