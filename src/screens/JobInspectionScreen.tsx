// The crew-side inspection form — Blueprint Ch.7 §7.8, the mobile half of the
// web JobPanel "Inspection" tab.
//
// THIS IS NOT A CHECKLIST. The cleaning checklist says what the crew was asked
// to do; this says whether an independent person confirmed the standard was met,
// which layer performed that check, and — the part that matters most — whether
// the inspector corrected anything before taking the photo.
//
// §7.8: "If inspectors routinely finish beds, restock bathrooms, wipe
// appliances, or repair presentation before taking final photos, the company's
// production data becomes false." A silent pass after a quiet fix is a falsified
// record, so pass_with_corrections is its own result and the DB refuses
// pass + corrections_made outright (job_inspections_no_hidden_production).
//
// DEFECTS BELONG TO THE PARENT CLEAN, NOT TO THIS VISIT — a defect is a property
// of the work that failed, not of the visit that found it. There is no defect
// form here; crew are pointed at their manager instead, the same hand-off the
// web tab makes.
//
// ORDERING MATTERS ON FILING. Writing completed_at fires
// trg_complete_inspection_job, which completes the visit job. A completed job
// with an open time entry runs forever and corrupts payroll, so we clock out
// FIRST (clockOut, owned by JobDetailScreen) and only file if that succeeded.

import React, { useState, useEffect } from 'react'
import { View, Text, ScrollView, TouchableOpacity, StyleSheet, TextInput, ActivityIndicator, Alert } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { supabase } from '../lib/supabase'
import { useLang } from '../contexts/LangContext'
import type { TranslationKey } from '../lib/i18n'
import { SLATE_DARK, GOLD } from '../lib/theme'

const NAVY = SLATE_DARK
const GREEN = '#10B981'
const AMBER = '#F59E0B'
const RED = '#EF4444'

// Mirrors the job_inspections CHECK constraints and LAYERS/INSPECTION_RESULTS in
// the web src/lib/quality.ts. Adding a value here without a migration is a
// runtime 23514; client/guest are excluded because those are the escape path,
// not a layer anyone performs.
const LAYERS: { id: string; key: TranslationKey }[] = [
  { id: 'self', key: 'insp_layer_self' },
  { id: 'peer_lead', key: 'insp_layer_peer_lead' },
  { id: 'supervisor', key: 'insp_layer_supervisor' },
  { id: 'remote_review', key: 'insp_layer_remote_review' },
  { id: 'random_audit', key: 'insp_layer_random_audit' },
]

const RESULTS: { id: string; key: TranslationKey; descKey: TranslationKey; color: string }[] = [
  { id: 'pass', key: 'insp_pass', descKey: 'insp_pass_desc', color: GREEN },
  { id: 'pass_with_corrections', key: 'insp_pass_corr', descKey: 'insp_pass_corr_desc', color: AMBER },
  { id: 'fail', key: 'insp_fail', descKey: 'insp_fail_desc', color: RED },
]

const TRIGGER_KEY: Record<string, TranslationKey> = {
  always: 'insp_trg_always',
  new_property: 'insp_trg_new_property',
  prior_defect: 'insp_trg_prior_defect',
  same_day_turnover: 'insp_trg_same_day_turnover',
  manual: 'insp_trg_manual',
}

interface Props {
  job: any
  user: any
  onBack: () => void
  /** Clocks out the active time entry. Returns false if that failed — do not
   *  file the inspection in that case; see the ordering note above. */
  clockOut: () => Promise<boolean>
  /** Called after the record is filed; JobDetailScreen closes the visit out. */
  onFiled: () => void
}

export function JobInspectionScreen({ job, user, onBack, clockOut, onFiled }: Props) {
  const { t } = useLang()
  // The dashboard/schedule queries do not select job.tenant_id, so the crew's
  // own tenant is the reliable source — same reasoning as JobInventoryScreen.
  const tenantId = user?.tenant_id || job.tenant_id

  const [rec, setRec] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  // True when filing this visit would pay nothing at all — see load().
  const [noPay, setNoPay] = useState(false)

  // The parent clean's executed Turnover Checklist — the standard the crew
  // worked to AND what they claim they did (ticks, verify answers, photo
  // state), room by room. §7.9's point: a score is only fair against the
  // standard, so put the standard on the inspector's screen.
  const [standard, setStandard] = useState<any[]>([])
  const [parentJob, setParentJob] = useState<any>(null)
  const [openStd, setOpenStd] = useState<Record<string, boolean>>({})

  const [layer, setLayer] = useState('supervisor')
  const [result, setResult] = useState('')
  const [corrections, setCorrections] = useState(false)
  const [minutes, setMinutes] = useState('')
  const [notes, setNotes] = useState('')

  useEffect(() => { load() }, [])

  async function load() {
    setLoading(true)
    const [{ data }, { data: jobRow }, { count: entryCount }] = await Promise.all([
      supabase.from('job_inspections').select('*').eq('job_id', job.id).maybeSingle(),
      supabase.from('jobs').select('task_pay').eq('id', job.id).maybeSingle(),
      supabase.from('job_time_entries').select('id', { count: 'exact', head: true }).eq('job_id', job.id),
    ])
    // A FLAT rate now pays on filing (crew_pay_for_period_core's
    // unclocked_inspections branch), so a priced visit needs no warning even
    // unclocked. The unpaid case is the other one: no rate means hourly on
    // clocked time, and zero clocked time is zero pay — with no payroll line at
    // all rather than a $0 one anyone would spot. Checked at load, which is
    // after any clock-in on the job screen; clock-out happens later in doFile().
    const pay = Number((jobRow as any)?.task_pay ?? 0)
    setNoPay(pay === 0 && (entryCount ?? 0) === 0)
    if (data) {
      setRec(data)
      setLayer(data.layer ?? 'supervisor')
      setResult(data.result ?? '')
      setCorrections(!!data.corrections_made)
      setMinutes(data.correction_minutes != null ? String(data.correction_minutes) : '')
      setNotes(data.notes ?? '')
      if (data.parent_job_id) {
        // Best-effort — the form works without it (old cleans have no rooms).
        const [{ data: std }, { data: parent }] = await Promise.all([
          supabase.rpc('job_turnover_checklist', { p_job_id: data.parent_job_id }),
          supabase.from('jobs').select('completed_at, scheduled_start').eq('id', data.parent_job_id).maybeSingle(),
        ])
        setStandard(std ?? [])
        setParentJob(parent ?? null)
      }
    }
    setLoading(false)
  }

  function pickResult(id: string) {
    setResult(id)
    // Picking "pass with corrections" IS the statement that something was
    // corrected — don't make them tick it twice. Picking a clean pass clears it,
    // because the DB refuses that combination outright.
    if (id === 'pass_with_corrections') setCorrections(true)
    if (id === 'pass') { setCorrections(false); setMinutes('') }
  }

  function fields() {
    return {
      layer,
      result: result || null,
      corrections_made: corrections,
      correction_minutes: minutes.trim() === '' ? null : Number(minutes),
      notes: notes.trim() || null,
    }
  }

  async function saveProgress() {
    setSaving(true)
    const patch: any = fields()
    if (!rec?.started_at) patch.started_at = new Date().toISOString()
    const { error } = await supabase.from('job_inspections')
      .update(patch).eq('id', rec.id).eq('tenant_id', tenantId)
    setSaving(false)
    if (error) { Alert.alert(t('could_not_save'), error.message); return }
    load()
  }

  // Mirror the DB CHECK constraints client-side so the inspector gets a sentence
  // rather than a 23514. The constraints stay the real guard.
  function validate(): string | null {
    if (!result) return t('insp_need_result')
    if (result === 'pass' && corrections) return t('insp_pass_no_corr')
    if (result === 'pass_with_corrections' && !corrections) return t('insp_corr_needs_tick')
    return null
  }

  async function file() {
    const problem = validate()
    if (problem) { Alert.alert(t('error'), problem); return }

    const msg = noPay
      ? `${t('insp_confirm_msg')}\n\n${t('insp_unpaid_confirm')}`
      : t('insp_confirm_msg')
    Alert.alert(t('insp_confirm_title'), msg, [
      { text: t('cancel'), style: 'cancel' },
      { text: t('insp_complete'), onPress: doFile },
    ])
  }

  async function doFile() {
    setSaving(true)
    // Clock out BEFORE filing — see the ordering note at the top of this file.
    // One of the two writes has to go first, and this is the safer failure: if
    // the record write below fails the inspector is clocked out with the form
    // still open and retryable, whereas the other order would leave a completed
    // job carrying an open time entry.
    if (!(await clockOut())) { setSaving(false); return }

    const patch: any = fields()
    patch.started_at = rec?.started_at ?? new Date().toISOString()
    patch.completed_at = new Date().toISOString()
    const { error } = await supabase.from('job_inspections')
      .update(patch).eq('id', rec.id).eq('tenant_id', tenantId)
    setSaving(false)
    if (error) { Alert.alert(t('could_not_save'), error.message); return }
    onFiled()
  }

  if (loading) {
    return (
      <SafeAreaView style={styles.screen}>
        <Header onBack={onBack} title={t('inspection')} />
        <View style={styles.center}><ActivityIndicator color={GOLD} /></View>
      </SafeAreaView>
    )
  }

  if (!rec) {
    return (
      <SafeAreaView style={styles.screen}>
        <Header onBack={onBack} title={t('inspection')} />
        <View style={styles.center}>
          <Text style={styles.emptyBig}>{t('insp_none')}</Text>
          <Text style={styles.empty}>{t('insp_none_hint')}</Text>
        </View>
      </SafeAreaView>
    )
  }

  const done = !!rec.completed_at
  const triggerKey = TRIGGER_KEY[rec.trigger_reason]

  return (
    <SafeAreaView style={styles.screen}>
      <Header onBack={onBack} title={t('inspection')} />
      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 40 }}>

        {/* WHY this clean was inspected. §7.14: a pass rate without its sample is
            worse than no pass rate, so the reason is shown, never buried. */}
        <View style={styles.whyCard}>
          <Text style={styles.whyTitle}>
            {t('insp_why')}: {triggerKey ? t(triggerKey) : rec.trigger_reason}
          </Text>
          <Text style={styles.whySub}>{done ? t('insp_locked') : t('insp_not_completed')}</Text>
        </View>

        {/* The parent clean's executed standard — what the crew signed off,
            room by room (§7.9: a score is only fair against the standard).
            Read-only; collapsed rooms; issues and missing photos surfaced. */}
        {standard.some((r: any) => r.item_id) && (
          <View style={{ marginTop: 4, marginBottom: 16 }}>
            <Text style={styles.label}>{t('insp_standard_title')}</Text>
            <Text style={styles.hint}>{t('insp_standard_hint')}</Text>
            {/* WHICH clean is being judged — a property can have several cleans
                a day (bulk-completed backlogs especially), and inspecting the
                wrong one's empty checklist reads as a bug (Todd, 2026-08-24). */}
            {parentJob?.completed_at && (
              <Text style={{ fontSize: 11, color: '#6B7280', marginBottom: 6 }}>
                {t('insp_parent_clean')} {new Date(parentJob.completed_at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
              </Text>
            )}
            {/* An untouched checklist is a FACT the inspector should weigh
                (desk-completed clean, no recorded work) — say it, don't render
                a silent wall of empty boxes. */}
            {!standard.some((r: any) => r.item_id && (r.completed || r.result != null || (r.item_kind === 'evidence' && r.photo_url) || r.room_signed_off_at)) && (
              <View style={{ backgroundColor: '#FEF3C7', borderColor: '#F59E0B', borderWidth: 1, borderRadius: 8, padding: 8, marginBottom: 6 }}>
                <Text style={{ fontSize: 11, color: '#92400E', fontWeight: '700' }}>{t('insp_no_recorded_work')}</Text>
              </View>
            )}
            {(() => {
              const groups: any[] = []
              for (const r of standard) {
                if (!r.item_id) continue
                const key = r.room_id ?? '__other__'
                let g = groups.find(x => x.key === key)
                if (!g) { g = { key, name: r.room_name, items: [] }; groups.push(g) }
                g.items.push(r)
              }
              return groups.map(g => {
                const issues = g.items.filter((i: any) => i.result === 'issue')
                const evid = g.items.filter((i: any) => i.item_kind === 'evidence')
                const evidDone = evid.filter((i: any) => i.photo_url).length
                const answered = g.items.filter((i: any) => i.item_kind !== 'evidence')
                const doneN = answered.filter((i: any) => i.completed || i.result != null).length
                const signed = !!g.items[0]?.room_signed_off_at
                const evidNeeded = evid.filter((i: any) => i.level === 'evidence_required')
                const roomDone = signed || (answered.length > 0
                  && doneN === answered.length
                  && evidNeeded.every((i: any) => i.photo_url))
                const isOpen = !!openStd[g.key]
                return (
                  <View key={g.key} style={{ borderWidth: 1, borderColor: '#E5E7EB', borderRadius: 10, marginBottom: 5, overflow: 'hidden' }}>
                    <TouchableOpacity onPress={() => setOpenStd(prev => ({ ...prev, [g.key]: !isOpen }))}
                      style={{ flexDirection: 'row', alignItems: 'center', gap: 8, padding: 9, backgroundColor: '#F9FAFB' }}>
                      <Text style={{ flex: 1, fontSize: 13, fontWeight: '800', color: roomDone ? '#059669' : '#111827' }} numberOfLines={1}>{roomDone ? '\u2713 ' : ''}{g.name}</Text>
                      {signed && <Text style={{ fontSize: 10, fontWeight: '800', color: '#059669' }}>{t('insp_std_signed')}</Text>}
                      {issues.length > 0 && <Text style={{ fontSize: 11, fontWeight: '800', color: '#DC2626' }}>⚠ {issues.length}</Text>}
                      <Text style={{ fontSize: 10, color: '#6B7280' }}>
                        {doneN}/{answered.length}{evid.length ? `  📷 ${evidDone}/${evid.length}` : ''}
                      </Text>
                      <Text style={{ color: '#9CA3AF' }}>{isOpen ? '▾' : '▸'}</Text>
                    </TouchableOpacity>
                    {isOpen && (
                      <View style={{ padding: 9, paddingTop: 3 }}>
                        {g.items.map((i: any) => {
                          const icon = i.item_kind === 'evidence'
                            ? (i.photo_url ? '📷' : '📷❗')
                            : i.result === 'issue' ? '⚠'
                            : i.result === 'na' ? '–'
                            : (i.completed ? '✓' : '□')
                          const color = i.result === 'issue' ? '#DC2626'
                            : i.item_kind === 'evidence' && !i.photo_url ? '#B45309'
                            : i.completed ? '#059669' : '#6B7280'
                          return (
                            <View key={i.item_id} style={{ flexDirection: 'row', gap: 7, paddingVertical: 2 }}>
                              <Text style={{ width: 22, textAlign: 'center', color, fontSize: 12 }}>{icon}</Text>
                              <Text style={{ flex: 1, fontSize: 12, color: '#374151' }}>
                                {i.body}
                                {i.result === 'issue' && i.issue_note ? ` — ${i.issue_note}` : ''}
                              </Text>
                            </View>
                          )
                        })}
                      </View>
                    )}
                  </View>
                )
              })
            })()}
          </View>
        )}

        {done ? (
          <View style={[styles.filedCard, { borderColor: RESULTS.find(r => r.id === rec.result)?.color ?? '#E2E8F0' }]}>
            <Text style={styles.filedText}>
              {(() => { const r = RESULTS.find(x => x.id === rec.result); return r ? t(r.key) : rec.result })()}
              {rec.correction_minutes ? `  ·  ${rec.correction_minutes} min` : ''}
            </Text>
            {!!rec.notes && <Text style={styles.filedNotes}>{rec.notes}</Text>}
          </View>
        ) : (<>

          {noPay && (
            <View style={styles.unpaidCard}>
              <Text style={styles.unpaidText}>{t('insp_unpaid_banner')}</Text>
            </View>
          )}

          <Text style={styles.label}>{t('insp_layer_label')}</Text>
          <Text style={styles.hint}>{t('insp_layer_hint')}</Text>
          <View style={styles.chipWrap}>
            {LAYERS.map(l => (
              <TouchableOpacity key={l.id} onPress={() => setLayer(l.id)}
                style={[styles.chip, layer === l.id && styles.chipOn]}>
                <Text style={[styles.chipText, layer === l.id && styles.chipTextOn]}>{t(l.key)}</Text>
              </TouchableOpacity>
            ))}
          </View>

          <Text style={[styles.label, { marginTop: 18 }]}>{t('insp_result_label')}</Text>
          {RESULTS.map(r => (
            <TouchableOpacity key={r.id} onPress={() => pickResult(r.id)}
              style={[styles.resultRow, result === r.id && { borderColor: r.color, backgroundColor: `${r.color}12` }]}>
              <View style={[styles.radio, result === r.id && { borderColor: r.color }]}>
                {result === r.id && <View style={[styles.radioDot, { backgroundColor: r.color }]} />}
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.resultName}>{t(r.key)}</Text>
                <Text style={styles.resultDesc}>{t(r.descKey)}</Text>
              </View>
            </TouchableOpacity>
          ))}

          {/* §7.4 — the hidden-production capture. Shown for fail too: an
              inspector can correct part of a failing property and still fail
              the release. Hidden for a clean pass, which forbids corrections. */}
          {result !== 'pass' && (
            <View style={{ marginTop: 18 }}>
              <Text style={styles.label}>{t('insp_corr_label')}</Text>
              <Text style={styles.hint}>{t('insp_corr_hint')}</Text>
              <TouchableOpacity onPress={() => setCorrections(v => !v)} style={styles.checkRow}>
                <View style={[styles.checkbox, corrections && styles.checkboxOn]}>
                  {corrections && <Text style={styles.checkMark}>✓</Text>}
                </View>
                <Text style={styles.checkLabel}>{t('insp_corr_check')}</Text>
              </TouchableOpacity>
              {corrections && (
                <TextInput
                  style={styles.minutesInput}
                  keyboardType="number-pad"
                  value={minutes}
                  onChangeText={v => setMinutes(v.replace(/[^0-9]/g, ''))}
                  placeholder={t('insp_corr_minutes')}
                  placeholderTextColor="#94A3B8"
                  maxLength={4}
                />
              )}
            </View>
          )}

          <Text style={[styles.label, { marginTop: 18 }]}>{t('insp_notes')}</Text>
          <TextInput
            style={styles.notesInput}
            value={notes}
            onChangeText={setNotes}
            placeholder={t('insp_notes_placeholder')}
            placeholderTextColor="#94A3B8"
            multiline
          />

          {result === 'fail' && (
            <View style={styles.failCard}>
              <Text style={styles.failText}>{t('insp_fail_hint')}</Text>
            </View>
          )}

          <Text style={[styles.hint, { marginTop: 14 }]}>{t('insp_photos_hint')}</Text>

          <View style={{ flexDirection: 'row', gap: 10, marginTop: 18 }}>
            <TouchableOpacity onPress={saveProgress} disabled={saving}
              style={[styles.btn, styles.btnGhost, saving && { opacity: 0.5 }]}>
              <Text style={styles.btnGhostText}>{saving ? t('saving') : t('insp_save')}</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={file} disabled={saving || !result}
              style={[styles.btn, styles.btnPrimary, (saving || !result) && { opacity: 0.5 }]}>
              <Text style={styles.btnPrimaryText}>{t('insp_complete')}</Text>
            </TouchableOpacity>
          </View>
        </>)}
      </ScrollView>
    </SafeAreaView>
  )
}

function Header({ onBack, title }: { onBack: () => void; title: string }) {
  const { t } = useLang()
  return (
    <View style={styles.header}>
      <TouchableOpacity onPress={onBack}><Text style={styles.back}>‹ {t('back')}</Text></TouchableOpacity>
      <Text style={styles.title}>🔍 {title}</Text>
      <View style={{ width: 54 }} />
    </View>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#F8FAFC' },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 16, paddingVertical: 12, backgroundColor: '#fff',
    borderBottomWidth: 1, borderBottomColor: '#E2E8F0',
  },
  back: { color: GOLD, fontSize: 15, fontWeight: '600', width: 54 },
  title: { fontSize: 17, fontWeight: '800', color: NAVY },

  center: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 24 },
  empty: { color: '#64748B', fontSize: 13, marginTop: 6, textAlign: 'center', lineHeight: 19 },
  emptyBig: { color: NAVY, fontSize: 15, fontWeight: '700', textAlign: 'center' },

  whyCard: {
    backgroundColor: '#fff', borderRadius: 12, borderWidth: 1, borderColor: '#E2E8F0',
    padding: 12, marginBottom: 18,
  },
  whyTitle: { fontSize: 14, fontWeight: '800', color: NAVY },
  whySub: { fontSize: 12, color: '#64748B', marginTop: 3, lineHeight: 17 },

  label: { fontSize: 14, fontWeight: '800', color: NAVY, marginBottom: 3 },
  hint: { fontSize: 12, color: '#64748B', lineHeight: 17, marginBottom: 8 },

  chipWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: {
    paddingHorizontal: 12, paddingVertical: 8, borderRadius: 999,
    borderWidth: 1, borderColor: '#E2E8F0', backgroundColor: '#fff',
  },
  chipOn: { borderColor: GOLD, backgroundColor: '#FDF6E3' },
  chipText: { fontSize: 12, fontWeight: '600', color: '#64748B' },
  chipTextOn: { color: NAVY, fontWeight: '800' },

  resultRow: {
    flexDirection: 'row', alignItems: 'flex-start', gap: 12,
    padding: 12, borderRadius: 10, borderWidth: 1, borderColor: '#E2E8F0',
    backgroundColor: '#fff', marginBottom: 8,
  },
  radio: {
    width: 20, height: 20, borderRadius: 10, borderWidth: 2, borderColor: '#CBD5E1',
    justifyContent: 'center', alignItems: 'center', marginTop: 1,
  },
  radioDot: { width: 10, height: 10, borderRadius: 5 },
  resultName: { fontSize: 14, fontWeight: '700', color: NAVY },
  resultDesc: { fontSize: 12, color: '#64748B', marginTop: 2, lineHeight: 17 },

  checkRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 6 },
  checkbox: {
    width: 24, height: 24, borderRadius: 6, borderWidth: 2, borderColor: '#CBD5E1',
    justifyContent: 'center', alignItems: 'center', backgroundColor: '#fff',
  },
  checkboxOn: { backgroundColor: AMBER, borderColor: AMBER },
  checkMark: { color: '#fff', fontSize: 14, fontWeight: '800' },
  checkLabel: { flex: 1, fontSize: 14, color: NAVY },
  minutesInput: {
    marginTop: 10, borderWidth: 1, borderColor: '#E2E8F0', borderRadius: 8,
    paddingHorizontal: 12, paddingVertical: 10, fontSize: 15, fontWeight: '700',
    color: NAVY, backgroundColor: '#fff',
  },

  notesInput: {
    borderWidth: 1, borderColor: '#E2E8F0', borderRadius: 10, padding: 12,
    fontSize: 14, color: NAVY, minHeight: 84, backgroundColor: '#fff',
    textAlignVertical: 'top',
  },

  unpaidCard: {
    marginBottom: 16, padding: 12, borderRadius: 10,
    backgroundColor: '#FFFBEB', borderWidth: 1, borderColor: '#FCD34D',
  },
  unpaidText: { color: '#92400E', fontSize: 13, fontWeight: '600', lineHeight: 18 },

  failCard: {
    marginTop: 12, padding: 12, borderRadius: 10,
    backgroundColor: '#FEF2F2', borderWidth: 1, borderColor: '#FECACA',
  },
  failText: { color: '#991B1B', fontSize: 13, fontWeight: '600', lineHeight: 18 },

  filedCard: {
    backgroundColor: '#fff', borderRadius: 12, borderWidth: 2, padding: 14,
  },
  filedText: { fontSize: 16, fontWeight: '800', color: NAVY },
  filedNotes: { fontSize: 13, color: '#475569', marginTop: 8, lineHeight: 19 },

  btn: { flex: 1, paddingVertical: 14, borderRadius: 10, alignItems: 'center' },
  btnGhost: { borderWidth: 1, borderColor: '#CBD5E1', backgroundColor: '#fff' },
  btnGhostText: { color: NAVY, fontWeight: '700', fontSize: 14 },
  btnPrimary: { backgroundColor: GOLD },
  btnPrimaryText: { color: '#fff', fontWeight: '800', fontSize: 14 },
})
