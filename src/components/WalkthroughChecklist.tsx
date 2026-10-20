// The room-by-room inspection walkthrough, as the inspector works it.
//
// Sections in the owner's walk order. Each section has one "Looks good", which
// marks every line not yet answered OK. The inspector taps a line only when
// something is wrong: Not right, a few words, a photo. Lines can also ask for
// a photo every time, show the trash pickup day, or file something for the
// office when marked wrong (deep-clean request / maintenance order — the
// database does that, see fn_route_checklist_issue).
//
// Rendered on an inspection visit (JobInspectionScreen) and on a clean booked
// as the inspection service (JobDetailScreen), from the same rows: lines are
// job_checklist_items with sort_order >= 20000 (src/lib/walkthrough.ts).
//
// Lines missed at an earlier inspection of this home and not marked OK since
// (lib/carriedLines; the web migration 20261020123000_walkthrough_carried_lines)
// come first, in a "Missed last time" block: the earlier words and photo, and
// this visit's own answer buttons. In its section such a line is tagged and
// answered only up there, and "Looks good" leaves it: it is the line that
// keeps getting missed, so the inspector looks at it.
//
// Offline like the cleaning checklist: reads come from the cache with queued
// writes laid over them, and every answer goes through the outbox, so a dead
// spot in a basement never loses one. A real server refusal reverts the line
// and says so.

import React, { useEffect, useMemo, useRef, useState } from 'react'
import { View, Text, TouchableOpacity, TextInput, StyleSheet, Alert, ActivityIndicator, Image, Modal } from 'react-native'
import { writeThrough } from '../lib/outbox'
// The reads (the shared builders the offline day pack saves), and how soon the
// saved copy shows on a weak signal.
import { walkthroughCard, type WalkthroughView } from '../lib/walkthroughCard'
import { useLang } from '../contexts/LangContext'
import { ti, localeFor } from '../lib/i18n'
import { useMachineTranslation } from '../lib/machineTranslate'
import { groupWalkthrough, sectionState, pickupDaysLabel, type WalkthroughLine } from '../lib/walkthrough'
import { carriedItemIds, groupCarried, looksGoodIds, type CarriedLine } from '../lib/carriedLines'
import { fmtDate } from '../lib/timezone'
import { GOLD, SLATE_DARK } from '../lib/theme'

const GREEN = '#16A34A'
const RED = '#DC2626'
const MUTED = '#64748B'

interface Props {
  job: any
  user: any
  /** A filed inspection: shown, not editable. */
  readOnly?: boolean
  /** Open the photo screen for one line ({ title, jobItemId } links the photo to
   *  it; walkthrough: hidden from the client unless the inspector says so). */
  onAddPhoto: (line: { title: string; jobItemId: string; walkthrough?: boolean }) => void
  /** Bump to reload, e.g. after the photo screen closes. */
  refreshKey?: number
  /** Something was answered: the host screen may want to reload its own state. */
  onChanged?: () => void
}

export function WalkthroughChecklist({ job, user, readOnly = false, onAddPhoto, refreshKey = 0, onChanged }: Props) {
  const { t, lang } = useLang()
  const [lines, setLines] = useState<WalkthroughLine[]>([])
  const [photoCount, setPhotoCount] = useState<Record<string, number>>({})
  const [pickupDays, setPickupDays] = useState<number[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [open, setOpen] = useState<Record<string, boolean>>({})
  const [lineOpen, setLineOpen] = useState<string | null>(null)
  const [notes, setNotes] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState<string | null>(null)
  const [carried, setCarried] = useState<CarriedLine[]>([])
  const [carriedFiles, setCarriedFiles] = useState<Record<string, string>>({})
  const [big, setBig] = useState<string | null>(null)
  // One per card: the newest load wins, and an answer from a load that began
  // before the inspector's last answer doesn't overwrite it (lib/walkthroughCard).
  const [card] = useState(() => walkthroughCard({ show, setLoading }))
  function show(v: WalkthroughView) {
    setLines(v.lines)
    setPhotoCount(v.photoCount)
    setPickupDays(v.pickupDays)
    setCarried(v.carried)
    setCarriedFiles(v.carriedFiles)
  }

  // The first load (mount) may show the saved copy first; a reload (back from
  // the photo screen) keeps what's on screen until the live answer comes.
  const loaded = useRef(false)
  useEffect(() => {
    card.load(job, { soon: !loaded.current }).catch(() => {})
    loaded.current = true
  }, [job.id, refreshKey])

  const sections = useMemo(() => groupWalkthrough(lines), [lines])
  const carriedIds = useMemo(() => carriedItemIds(carried), [carried])
  const carriedSections = useMemo(() => groupCarried(carried), [carried])
  const tx = useMachineTranslation(lang, [...sections.map(s => s.name), ...lines.map(l => l.task), ...carried.map(c => c.issue_note)])

  // The first section not finished starts open.
  useEffect(() => {
    if (loading || sections.length === 0 || Object.keys(open).length > 0) return
    const first = sections.find(s => !sectionState(s).done) ?? sections[0]
    setOpen({ [first.name]: true })
  }, [loading, sections, open])

  const patch = (ids: string[], fields: Partial<WalkthroughLine>) =>
    setLines(prev => prev.map(l => (ids.includes(l.id) ? { ...l, ...fields } : l)))

  async function looksGood(name: string) {
    if (readOnly) return
    const s = sections.find(x => x.name === name)
    if (!s) return
    // A line missed last time is left for the inspector to answer.
    const ids = looksGoodIds(sectionState(s).open, carriedIds)
    if (!ids.length) return
    setBusy(name)
    card.edited()
    patch(ids, { result: 'ok' })
    const { error } = await writeThrough({
      table: 'job_checklist_items', op: 'update',
      match: { job_id: job.id }, matchIn: { id: ids },
      values: { result: 'ok', completed_at: new Date().toISOString(), completed_by: user.id },
    })
    setBusy(null)
    if (error) {
      patch(ids, { result: null })
      Alert.alert(t('error'), t('could_not_save'))
      return
    }
    // Walk on: this section closes, the next unfinished one opens.
    const idx = sections.findIndex(x => x.name === name)
    const next = sections.slice(idx + 1).find(x => !sectionState(x).done)
    setOpen(o => ({ ...o, [name]: false, ...(next ? { [next.name]: true } : {}) }))
    onChanged?.()
  }

  async function answer(line: WalkthroughLine, result: 'ok' | 'issue' | 'na' | null) {
    if (readOnly) return
    const before = { result: line.result, issue_note: line.issue_note }
    const note = result === 'issue' ? ((notes[line.id] ?? line.issue_note ?? '').trim() || null) : null
    setBusy(line.id)
    card.edited()
    patch([line.id], { result, issue_note: note })
    const { error } = await writeThrough({
      table: 'job_checklist_items', op: 'update', match: { id: line.id },
      values: {
        result, issue_note: note,
        completed_at: result ? new Date().toISOString() : null,
        completed_by: result ? user.id : null,
      },
    })
    setBusy(null)
    if (error) {
      patch([line.id], before)
      Alert.alert(t('error'), t('could_not_save'))
      return
    }
    // Wrong: keep the line open for words and a photo. Otherwise close it.
    if (result !== 'issue') setLineOpen(null)
    onChanged?.()
  }

  async function saveNote(line: WalkthroughLine) {
    if (readOnly || line.result !== 'issue') return
    const note = (notes[line.id] ?? '').trim() || null
    if (note === (line.issue_note ?? null)) return
    card.edited()
    patch([line.id], { issue_note: note })
    const { error } = await writeThrough({
      table: 'job_checklist_items', op: 'update', match: { id: line.id }, values: { issue_note: note },
    })
    if (error) Alert.alert(t('error'), t('could_not_save'))
  }

  // OK / Not right / N/A / Photo for one line, and its note when it's wrong:
  // in its section, and for a line missed last time in the block on top.
  function controls(l: WalkthroughLine) {
    const photos = photoCount[l.id] || 0
    return (
      <>
        <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>
          {([['ok', t('wt_ok'), GREEN], ['issue', t('wt_not_right'), RED], ['na', t('wt_na'), MUTED]] as const).map(([v, label, c]) => {
            const on = l.result === v
            return (
              <TouchableOpacity key={v} disabled={busy === l.id}
                onPress={() => answer(l, on ? null : v)}
                style={[styles.chip, on && { backgroundColor: c, borderColor: c }]}>
                <Text style={[styles.chipText, on && { color: '#fff' }]}>{label}</Text>
              </TouchableOpacity>
            )
          })}
          <TouchableOpacity onPress={() => onAddPhoto({ title: l.task, jobItemId: l.id, walkthrough: true })} style={styles.chip}>
            <Text style={styles.chipText}>{t('wt_photo')}{photos ? ` · ${photos}` : ''}</Text>
          </TouchableOpacity>
        </View>
        {l.result === 'issue' && (
          <TextInput
            style={styles.note}
            value={notes[l.id] ?? l.issue_note ?? ''}
            onChangeText={v => setNotes(n => ({ ...n, [l.id]: v }))}
            onBlur={() => saveNote(l)}
            onSubmitEditing={() => saveNote(l)}
            placeholder={t('wt_note_ph')}
            placeholderTextColor="#94A3B8"
            returnKeyType="done"
            multiline
          />
        )}
      </>
    )
  }

  if (loading) return <View style={{ padding: 12 }}><ActivityIndicator color={GOLD} /></View>
  if (sections.length === 0) return null

  const answered = lines.filter(l => l.result != null).length
  const issues = lines.filter(l => l.result === 'issue').length
  const pickup = pickupDaysLabel(pickupDays, localeFor(lang), t('wt_and'))

  return (
    <View style={{ marginBottom: 16 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 2 }}>
        <Text style={styles.title}>{t('wt_title')}</Text>
        <Text style={styles.progress}>{ti(t('wt_progress'), { done: String(answered), total: String(lines.length) })}</Text>
        {issues > 0 && <Text style={styles.issueCount}>{ti(t('wt_not_right_count'), { n: String(issues) })}</Text>}
      </View>
      {!readOnly && <Text style={styles.hint}>{t('wt_hint')}</Text>}

      {carried.length > 0 && (
        <View style={styles.carried} testID="wt-carried">
          <Text style={styles.carriedTitle}>{ti(t('wt_carried_title'), { n: String(carried.length) })}</Text>
          <Text style={styles.carriedHint}>{readOnly ? t('wt_carried_hint_filed') : t('wt_carried_hint')}</Text>
          {carriedSections.map(cs => (
            <View key={cs.room} style={{ marginTop: 8 }}>
              <Text style={styles.carriedRoom}>{tx(cs.room)}</Text>
              {cs.lines.map(c => {
                const row = c.this_item_id ? lines.find(l => l.id === c.this_item_id) : undefined
                const when = fmtDate(c.missed_at, localeFor(lang), { weekday: 'short', month: 'short', day: 'numeric' })
                return (
                  <View key={c.missed_item_id} style={styles.carriedLine}>
                    <Text style={styles.lineText}>{tx(c.task)}</Text>
                    {!!c.issue_note && <Text style={[styles.flag, { color: RED, fontSize: 13 }]}>“{tx(c.issue_note)}”</Text>}
                    <Text style={styles.flag}>
                      {c.times_missed > 1 ? ti(t('wt_carried_run'), { n: String(c.times_missed) }) : t('wt_carried_once')} · {when}{c.inspector_name ? ` · ${c.inspector_name}` : ''}
                    </Text>
                    {c.photo_urls.length > 0 && (
                      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 6 }}>
                        {c.photo_urls.map(u => (
                          <TouchableOpacity key={u} onPress={() => setBig(carriedFiles[u] ?? u)}>
                            <Image source={{ uri: carriedFiles[u] ?? u }} style={styles.thumb} />
                          </TouchableOpacity>
                        ))}
                      </View>
                    )}
                    {!row ? (
                      <Text style={[styles.flag, { fontStyle: 'italic' }]}>{readOnly ? t('wt_carried_not_listed_filed') : t('wt_carried_not_listed')}</Text>
                    ) : readOnly ? (
                      <Text style={[styles.flag, { fontWeight: '800', color: row.result === 'ok' ? GREEN : row.result === 'issue' ? RED : MUTED }]}>
                        {row.result === 'ok' ? t('wt_carried_ok_filed') : row.result === 'issue' ? t('wt_carried_again') : t('wt_carried_unchecked')}
                      </Text>
                    ) : (
                      <View style={{ marginTop: 8 }}>
                        {controls(row)}
                        {row.result === 'ok' && <Text style={[styles.flag, { color: GREEN, fontWeight: '700' }]}>{t('wt_carried_ok')}</Text>}
                      </View>
                    )}
                  </View>
                )
              })}
            </View>
          ))}
        </View>
      )}
      <Modal visible={!!big} transparent animationType="fade" onRequestClose={() => setBig(null)}>
        <TouchableOpacity activeOpacity={1} onPress={() => setBig(null)} style={styles.viewer}>
          {!!big && <Image source={{ uri: big }} style={styles.full} resizeMode="contain" />}
          <Text style={styles.close}>✕</Text>
        </TouchableOpacity>
      </Modal>

      {sections.map(s => {
        const st = sectionState(s)
        const lgOpen = looksGoodIds(st.open, carriedIds).length
        const carriedOpen = st.open.length - lgOpen
        const isOpen = !!open[s.name]
        return (
          <View key={s.name} style={[styles.section, st.done && styles.sectionDone]}>
            <TouchableOpacity onPress={() => setOpen(o => ({ ...o, [s.name]: !isOpen }))} style={styles.sectionHead}>
              <Text style={[styles.sectionName, st.done && { color: GREEN }]} numberOfLines={1}>
                {st.done ? '✓ ' : ''}{tx(s.name)}
              </Text>
              {st.issues > 0 && <Text style={styles.sectionIssues}>⚠ {st.issues}</Text>}
              <Text style={styles.sectionCount}>{st.answered}/{st.total}</Text>
              <Text style={{ color: '#9CA3AF' }}>{isOpen ? '▾' : '▸'}</Text>
            </TouchableOpacity>

            {isOpen && (
              <View style={{ paddingHorizontal: 10, paddingBottom: 10 }}>
                {!readOnly && lgOpen > 0 && (
                  <TouchableOpacity onPress={() => looksGood(s.name)} disabled={busy === s.name}
                    style={[styles.looksGood, busy === s.name && { opacity: 0.6 }]}>
                    <Text style={styles.looksGoodText}>
                      {st.answered > 0 || carriedOpen > 0 ? ti(t('wt_looks_good_left'), { n: String(lgOpen) }) : t('wt_looks_good')}
                    </Text>
                  </TouchableOpacity>
                )}
                {!readOnly && carriedOpen > 0 && (
                  <Text style={[styles.flag, { color: RED, fontWeight: '700', marginBottom: 6 }]}>
                    {carriedOpen === 1 ? t('wt_carried_section_one') : ti(t('wt_carried_section_many'), { n: String(carriedOpen) })}
                  </Text>
                )}

                {s.lines.map(l => {
                  const isCarried = carriedIds.has(l.id)
                  // A line missed last time is answered in the block on top.
                  const expanded = lineOpen === l.id && !readOnly && !isCarried
                  const icon = l.result === 'ok' ? '✓' : l.result === 'issue' ? '⚠' : l.result === 'na' ? '–' : '○'
                  const color = l.result === 'ok' ? GREEN : l.result === 'issue' ? RED : MUTED
                  const photos = photoCount[l.id] || 0
                  return (
                    <View key={l.id} style={[styles.line, l.result === 'issue' && styles.lineIssue]}>
                      <TouchableOpacity onPress={() => !readOnly && !isCarried && setLineOpen(expanded ? null : l.id)} disabled={readOnly || isCarried}
                        style={{ flexDirection: 'row', gap: 8, alignItems: 'flex-start' }}>
                        <Text style={{ width: 18, textAlign: 'center', color, fontWeight: '800', fontSize: 15 }}>{icon}</Text>
                        <View style={{ flex: 1 }}>
                          <Text style={styles.lineText}>{tx(l.task)}</Text>
                          {isCarried && <Text style={styles.carriedTag}>{t('wt_carried_tag')}</Text>}
                          {l.photo_required && (
                            <Text style={[styles.flag, { color: photos ? GREEN : '#B45309' }]}>
                              {t('wt_photo_needed')}{photos ? ` · ${photos}` : ''}
                            </Text>
                          )}
                          {l.info_key === 'trash_day' && (
                            <Text style={styles.flag}>{pickup ? ti(t('wt_pickup'), { days: pickup }) : t('wt_pickup_unset')}</Text>
                          )}
                          {l.follow_up && (
                            <Text style={styles.flag}>{l.follow_up === 'deep_clean' ? t('wt_files_deep_clean') : t('wt_files_maintenance')}</Text>
                          )}
                          {l.result === 'issue' && !!l.issue_note && !expanded && (
                            <Text style={[styles.flag, { color: RED }]}>{l.issue_note}</Text>
                          )}
                          {!l.photo_required && photos > 0 && !expanded && <Text style={styles.flag}>📷 {photos}</Text>}
                        </View>
                      </TouchableOpacity>

                      {expanded && <View style={{ marginTop: 8, marginLeft: 26 }}>{controls(l)}</View>}
                    </View>
                  )
                })}
              </View>
            )}
          </View>
        )
      })}
    </View>
  )
}

const styles = StyleSheet.create({
  title: { fontSize: 14, fontWeight: '800', color: SLATE_DARK },
  progress: { fontSize: 12, color: MUTED, fontWeight: '600' },
  issueCount: { fontSize: 12, color: RED, fontWeight: '800' },
  hint: { fontSize: 12, color: MUTED, lineHeight: 17, marginBottom: 8 },
  section: { borderWidth: 1, borderColor: '#E5E7EB', borderRadius: 10, marginBottom: 6, overflow: 'hidden', backgroundColor: '#fff' },
  sectionDone: { backgroundColor: '#F0FDF4', borderColor: '#BBF7D0' },
  sectionHead: { flexDirection: 'row', alignItems: 'center', gap: 8, padding: 11 },
  sectionName: { flex: 1, fontSize: 14, fontWeight: '800', color: '#111827' },
  sectionIssues: { fontSize: 12, fontWeight: '800', color: RED },
  sectionCount: { fontSize: 11, color: MUTED },
  looksGood: { backgroundColor: GREEN, borderRadius: 10, paddingVertical: 13, alignItems: 'center', marginBottom: 8 },
  looksGoodText: { color: '#fff', fontWeight: '800', fontSize: 15 },
  line: { paddingVertical: 8, borderTopWidth: 1, borderTopColor: '#F1F5F9' },
  lineIssue: { backgroundColor: '#FEF2F2', borderRadius: 8, paddingHorizontal: 4 },
  lineText: { fontSize: 14, color: '#1F2937', lineHeight: 19 },
  flag: { fontSize: 11, color: MUTED, marginTop: 2 },
  chip: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: 999, borderWidth: 1, borderColor: '#E2E8F0', backgroundColor: '#fff' },
  chipText: { fontSize: 13, fontWeight: '700', color: SLATE_DARK },
  carried: { borderWidth: 2, borderColor: '#FCA5A5', backgroundColor: '#FEF2F2', borderRadius: 10, padding: 11, marginBottom: 10 },
  carriedTitle: { fontSize: 12, fontWeight: '800', color: '#B91C1C', letterSpacing: 0.5, textTransform: 'uppercase' },
  carriedHint: { fontSize: 12, color: MUTED, marginTop: 3, lineHeight: 17 },
  carriedRoom: { fontSize: 13, fontWeight: '800', color: '#111827' },
  carriedLine: { borderLeftWidth: 3, borderLeftColor: '#FCA5A5', paddingLeft: 10, paddingVertical: 6, marginTop: 4 },
  carriedTag: { alignSelf: 'flex-start', marginTop: 3, fontSize: 11, fontWeight: '800', color: '#B91C1C', backgroundColor: '#FEE2E2', paddingHorizontal: 7, paddingVertical: 1, borderRadius: 999, overflow: 'hidden' },
  thumb: { width: 72, height: 72, borderRadius: 8, borderWidth: 1, borderColor: '#FCA5A5', backgroundColor: '#fff' },
  viewer: { flex: 1, backgroundColor: 'rgba(0,0,0,0.92)', alignItems: 'center', justifyContent: 'center' },
  full: { width: '100%', height: '80%' },
  close: { position: 'absolute', top: 54, right: 24, color: '#fff', fontSize: 26, fontWeight: '700' },
  note: {
    marginTop: 8, borderWidth: 1, borderColor: '#FECACA', borderRadius: 8, padding: 10,
    fontSize: 14, color: SLATE_DARK, backgroundColor: '#fff', minHeight: 60, textAlignVertical: 'top',
  },
})
