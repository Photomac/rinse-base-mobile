import React, { createContext, useContext, useState, useEffect } from 'react'
import { getLanguage, setLanguage, Language, t, TranslationKey } from '../lib/i18n'

interface LangContextType {
  lang: Language
  t: (key: TranslationKey) => string
  toggleLanguage: () => void
  setLang: (l: Language) => void
}

const LangContext = createContext<LangContextType>({
  lang: 'en',
  t: (key) => key,
  toggleLanguage: () => {},
  setLang: () => {},
})

export function LangProvider({ children }: { children: React.ReactNode }) {
  const [lang, setLangState] = useState<Language>('en')

  useEffect(() => {
    getLanguage().then(setLangState)
  }, [])

  function toggleLanguage() {
    const newLang = lang === 'en' ? 'es' : 'en'
    setLangState(newLang)
    setLanguage(newLang)
  }

  function setLang(l: Language) {
    setLangState(l)
    setLanguage(l)
  }

  return (
    <LangContext.Provider value={{ lang, t: (key) => t(lang, key), toggleLanguage, setLang }}>
      {children}
    </LangContext.Provider>
  )
}

export function useLang() {
  return useContext(LangContext)
}
