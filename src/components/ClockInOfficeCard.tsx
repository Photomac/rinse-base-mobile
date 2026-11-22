// The office's side of "clock-in only at the property", on a stop's screen: who
// was refused and how far away, and the button that lets someone in. Web has
// the same on a clean's Time tab (rinsebase-app ClockInLocationCard). Renders
// nothing with the company's switch off, so it costs a phone nothing else.
//
// When the newest refusal had a sharp fix away from the pin, the office can move
// the property's pin to where that person is (which lets them in too): a rural
// address's pin often sits on the road with the house up the drive.
import React, { useCallback, useEffect, useState } from 'react'
import { ActivityIndicator, Alert, Text, TouchableOpacity, View } from 'react-native'
import { useLang } from '../contexts/LangContext'
import { localeFor, ti } from '../lib/i18n'
import { fmtTime } from '../lib/timezone'
import { fmtClockInDistance, pinMoveOffer, pinOf } from '../lib/clockInGate'
import { allowClockInHere, clockInEvents, clockInRule, clockInSite, movePinHere, type ClockInEvent } from '../lib/clockInLocation'

type Crew = { id: string; name: string }

export function ClockInOfficeCard({ jobId, tenantId, crew }: { jobId: string; tenantId: string; crew: Crew[] }) {
  const { t, lang } = useLang()
  const [required, setRequired] = useState(false)
  const [events, setEvents] = useState<ClockInEvent[]>([])
  const [pin, setPin] = useState<{ lat: number; lng: number } | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const load = useCallback(async () => {
    const rule = await clockInRule(tenantId)
    setRequired(rule.required)
    if (!rule.required) return
    const [rows, site] = await Promise.all([clockInEvents(jobId), clockInSite({ id: jobId })])
    setEvents(rows)
    setPin(pinOf(site))
  }, [jobId, tenantId])

  useEffect(() => { load() }, [load])

  if (!required || crew.length === 0) return null

  const offer = pinMoveOffer(events, pin)

  async function allow(person: Crew) {
    setBusy(person.id)
    const { error } = await allowClockInHere(jobId, person.id)
    setBusy(null)
    if (error) { Alert.alert(t('error'), t('clock_in_office_failed')); return }
    Alert.alert('🔓', ti(t('clock_in_office_allowed'), { name: person.name }))
    load()
  }

  function movePin(person: Crew, eventId: string, distanceM: number) {
    Alert.alert(t('clock_in_office_move_pin_title'), ti(t('clock_in_office_move_pin_confirm'), { name: person.name, distance: fmtClockInDistance(distanceM) }), [
      { text: t('cancel'), style: 'cancel' },
      {
        text: t('clock_in_office_move_pin'),
        onPress: async () => {
          setBusy(person.id)
          const { error } = await movePinHere(eventId)
          setBusy(null)
          if (error) { Alert.alert(t('error'), t('clock_in_office_failed')); return }
          Alert.alert('📍', ti(t('clock_in_office_move_pin_done'), { name: person.name }))
          load()
        },
      },
    ])
  }

  return (
    <View style={{ backgroundColor: '#FFFBEB', borderColor: '#FCD34D', borderWidth: 1, borderRadius: 10, padding: 12, marginTop: 12 }}>
      <Text style={{ fontSize: 13, fontWeight: '700', color: '#92400E' }}>{t('clock_in_office_title')}</Text>
      {crew.map(person => {
        const mine = events.filter(e => e.user_id === person.id)
        const refused = mine.find(e => e.kind === 'refused')
        const allowed = mine.some(e => e.kind === 'allowed')
        const moved = mine.some(e => e.kind === 'allowed' && e.pin_moved_from_lat != null)
        const mineOffer = offer && offer.event.user_id === person.id ? offer : null
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
              {mineOffer && (
                <>
                  <Text style={{ fontSize: 12, color: '#92400E', marginTop: 2 }}>
                    {ti(t('clock_in_office_move_pin_hint'), { distance: fmtClockInDistance(mineOffer.distanceM), accuracy: String(mineOffer.event.accuracy_m) })}
                  </Text>
                  <TouchableOpacity onPress={() => movePin(person, mineOffer.event.id, mineOffer.distanceM)} disabled={!!busy} style={{ alignSelf: 'flex-start', marginTop: 6, paddingVertical: 6, paddingHorizontal: 10, borderRadius: 8, borderWidth: 1, borderColor: '#92400E' }}>
                    <Text style={{ color: '#92400E', fontSize: 12, fontWeight: '700' }}>📍 {t('clock_in_office_move_pin')}</Text>
                  </TouchableOpacity>
                </>
              )}
            </View>
            {allowed
              ? <Text style={{ fontSize: 12, fontWeight: '600', color: '#15803D' }}>{t(moved ? 'clock_in_office_pin_moved' : 'clock_in_office_let_in')}</Text>
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
