import React from 'react'
import { Text, StyleSheet } from 'react-native'
import { useLang } from '../contexts/LangContext'
import { crewNames, crewLineText, type CrewAssignment } from '../lib/crewNames'

/**
 * "👥 Tasia C. (lead) · You · Marin L." under a job on a list (see lib/crewNames).
 * Renders nothing when the crew wasn't fetched — a row cached before this line
 * existed has no `crew` — so it never claims a job is unassigned on a guess.
 * The office (`showUnassigned`) sees an explicit "No crew assigned": an
 * unassigned clean is on nobody's phone, and that is what they need to catch.
 */
export function CrewLine({ crew, viewerId, showUnassigned }: {
  crew: CrewAssignment[] | null | undefined
  viewerId: string
  showUnassigned: boolean
}) {
  const { t } = useLang()
  if (!Array.isArray(crew)) return null
  const names = crewNames(crew, viewerId, t('crew_you'))
  if (names.length === 0) {
    return showUnassigned ? <Text style={[styles.line, styles.none]}>⚠️ {t('crew_unassigned')}</Text> : null
  }
  return <Text style={styles.line} numberOfLines={1}>👥 {crewLineText(names, t('lead_tag'))}</Text>
}

const styles = StyleSheet.create({
  line: { fontSize: 12, color: '#475569', fontWeight: '500', marginTop: 3 },
  none: { color: '#B45309', fontWeight: '700' },
})
