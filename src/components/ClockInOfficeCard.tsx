// The office's side of "clock-in only at the property", on a stop's screen: who
// was refused and how far away, and the button that lets someone in. Web has
// the same on a clean's Time tab (rinsebase-app ClockInLocationCard). Renders
// nothing with the company's switch off, so it costs a phone nothing else.
import React, { useCallback, useEffect, useState } from 'react'
import { ActivityIndicator, Alert, Text, TouchableOpacity, View } from 'react-native'
import { useLang } from '../contexts/LangContext'
import { localeFor, ti } from '../lib/i18n'
import { fmtTime } from '../lib/timezone'
import { fmtClockInDistance } from '../lib/clockInGate'
import { allowClockInHere, clockInEvents, clockInRule, type ClockInEvent } from '../lib/clockInLocation'

type Crew = { id: string; name: string }

export function ClockInOfficeCard({ jobId, tenantId, crew }: { jobId: string; tenantId: string; crew: Crew[] }) {
  const { t, lang } = useLang()
  const [required, setRequired] = useState(false)
  const [events, setEvents] = useState<ClockInEvent[]>([])
  const [busy, setBusy] = useState<string | null>(null)

  const load = useCallback(async () => {
    const rule = await clockInRule(tenantId)
    setRequired(rule.required)
    if (rule.required) setEvents(await clockInEvents(jobId))
  }, [jobId, tenantId])

  useEffect(() => { load() }, [load])

  if (!required || crew.length === 0) return null

  async function allow(person: Crew) {
    setBusy(person.id)
    const { error } = await allowClockInHere(jobId, person.id)
    setBusy(null)
    if (error) { Alert.alert(t('error'), t('clock_in_office_failed')); return }
    Alert.alert('🔓', ti(t('clock_in_office_allowed'), { name: person.name }))
    load()
  }

  return (
    <View style={{ backgroundColor: '#FFFBEB', borderColor: '#FCD34D', borderWidth: 1, borderRadius: 10, padding: 12, marginTop: 12 }}>
      <Text style={{ fontSize: 13, fontWeight: '700', color: '#92400E' }}>{t('clock_in_office_title')}</Text>
      {crew.map(person => {
        const mine = events.filter(e => e.user_id === person.id)
        const refused = mine.find(e => e.kind === 'refused')
        const allowed = mine.some(e => e.kind === 'allowed')
        return (
          <View key={person.id} style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 8, gap: 8 }}>
            <View style={{ flex: 1 }}>
              <Text style={{ fontSize: 13, fontWeight: '600', color: '#1A1408' }}>{person.name}</Text>
              {refused && (
                <Text style={{ fontSize: 12, color: '#92400E' }}>
                  {ti(t('clock_in_office_refused'), {
                    time: fmtTime(refused.created_at, localeFor(lang)),
                    distance: refused.distance_m != null ? fmtClockInDistance(refused.distance_m) : '?',
                  })}
                </Text>
              )}
            </View>
            {allowed
              ? <Text style={{ fontSize: 12, fontWeight: '600', color: '#15803D' }}>{t('clock_in_office_let_in')}</Text>
              : (
                <TouchableOpacity onPress={() => allow(person)} disabled={!!busy} style={{ paddingVertical: 8, paddingHorizontal: 12, borderRadius: 8, backgroundColor: '#1A1408' }}>
                  {busy === person.id
                    ? <ActivityIndicator color="#fff" size="small" />
                    : <Text style={{ color: '#fff', fontSize: 12, fontWeight: '700' }}>{t('clock_in_office_allow')}</Text>}
                </TouchableOpacity>
              )}
          </View>
        )
      })}
    </View>
  )
}
