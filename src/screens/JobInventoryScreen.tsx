import React, { useState, useEffect } from 'react'
import { View, Text, ScrollView, TouchableOpacity, StyleSheet, TextInput, ActivityIndicator, Alert } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { supabase } from '../lib/supabase'
import { useLang } from '../contexts/LangContext'
import { ti } from '../lib/i18n'
import { SLATE_DARK, GOLD } from '../lib/theme'

const NAVY = SLATE_DARK
const AMBER = '#F59E0B'
const GREEN = '#10B981'

interface Props {
  job: any
  user: any
  onBack: () => void
}

interface Item {
  id: string
  item_name: string
  category: string | null
  par_level: number | null
  unit: string | null
}

// qty_remaining is the cycle-count value entered at end of clean. NULL means
// crew didn't count this item — they may have only logged usage / a manual
// low flag. The DB trigger auto-flags needs_restock when qty_remaining drops
// below par, so crew don't need to mark it themselves on counted items.
type LogState = Record<string, { qty_used: number; qty_remaining: string; needs_restock: boolean; notes: string }>

export function JobInventoryScreen({ job, user, onBack }: Props) {
  const { t } = useLang()
  const addrId = (job.client_addresses as any)?.id || job.address_id
  // Prefer the logged-in crew's tenant_id — the dashboard query doesn't
  // select job.tenant_id, so reading from `user` is more reliable. A crew
  // can only see jobs in their own tenant anyway, so the values are
  // equivalent when both exist.
  const tenantId = user?.tenant_id || job.tenant_id

  const [items, setItems] = useState<Item[]>([])
  const [log, setLog] = useState<LogState>({})
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  useEffect(() => { load() }, [])

  async function load() {
    setLoading(true)
    const [invRes, logRes] = await Promise.all([
      supabase.from('address_inventory')
        .select('id, item_name, category, par_level, unit')
        .eq('address_id', addrId)
        .order('category', { nullsFirst: false })
        .order('item_name'),
      supabase.from('job_inventory_log')
        .select('inventory_id, qty_used, qty_remaining, needs_restock, notes')
        .eq('job_id', job.id),
    ])
    setItems(invRes.data ?? [])
    const map: LogState = {}
    ;(logRes.data ?? []).forEach((l: any) => {
      map[l.inventory_id] = {
        qty_used: l.qty_used ?? 0,
        qty_remaining: l.qty_remaining != null ? String(l.qty_remaining) : '',
        needs_restock: !!l.needs_restock,
        notes: l.notes ?? '',
      }
    })
    setLog(map)
    setLoading(false)
  }

  function ensureRow(id: string) {
    if (log[id]) return log[id]
    return { qty_used: 0, qty_remaining: '', needs_restock: false, notes: '' }
  }

  function setQty(id: string, delta: number) {
    const row = ensureRow(id)
    const nextQty = Math.max(0, row.qty_used + delta)
    setLog(prev => ({ ...prev, [id]: { ...row, qty_used: nextQty } }))
  }

  function setRemaining(id: string, raw: string) {
    // Numeric only, allow empty (= unrecorded). The DB trigger handles
    // auto-flagging restock when this value drops below par_level.
    const cleaned = raw.replace(/[^0-9]/g, '')
    setLog(prev => ({ ...prev, [id]: { ...ensureRow(id), qty_remaining: cleaned } }))
  }

  function toggleLow(id: string) {
    const row = ensureRow(id)
    setLog(prev => ({ ...prev, [id]: { ...row, needs_restock: !row.needs_restock } }))
  }

  function setNotes(id: string, notes: string) {
    const row = ensureRow(id)
    setLog(prev => ({ ...prev, [id]: { ...row, notes } }))
  }

  async function save() {
    setSaving(true)
    // Replace all rows for this job — same pattern as the web JobPanel
    // InventoryTab so the crew can edit and resave without duplicating.
    await supabase.from('job_inventory_log').delete().eq('job_id', job.id)
    const rows = Object.entries(log)
      .filter(([, v]) => v.qty_used > 0 || v.needs_restock || v.qty_remaining !== '')
      .map(([inventory_id, v]) => ({
        tenant_id: tenantId,
        job_id: job.id,
        inventory_id,
        item_name: items.find(i => i.id === inventory_id)?.item_name || '',
        qty_used: v.qty_used || 0,
        qty_remaining: v.qty_remaining === '' ? null : Number(v.qty_remaining),
        needs_restock: !!v.needs_restock,
        notes: v.notes?.trim() || null,
      }))
    if (rows.length > 0) {
      const { error } = await supabase.from('job_inventory_log').insert(rows)
      if (error) { setSaving(false); Alert.alert(t('could_not_save'), error.message); return }
    }
    setSaving(false); setSaved(true)
    setTimeout(() => setSaved(false), 2200)
  }

  const grouped = items.reduce<Record<string, Item[]>>((acc, it) => {
    const key = it.category || 'Other'
    if (!acc[key]) acc[key] = []
    acc[key].push(it)
    return acc
  }, {})
  // Mirror the DB trigger logic so the banner is accurate before save:
  // count anything manually flagged OR cycle-counted below par.
  function isBelowPar(item: Item, row: { qty_remaining: string }): boolean {
    if (row.qty_remaining === '' || item.par_level == null) return false
    return Number(row.qty_remaining) < item.par_level
  }
  const lowCount = items.reduce((n, item) => {
    const row = log[item.id]
    if (!row) return n
    return n + (row.needs_restock || isBelowPar(item, row) ? 1 : 0)
  }, 0)

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: '#F8FAFC' }}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity onPress={onBack}><Text style={styles.back}>‹ {t('back')}</Text></TouchableOpacity>
        <Text style={styles.title}>{t('supplies')}</Text>
        <TouchableOpacity onPress={save} disabled={saving} style={[styles.saveBtn, saving && { opacity: 0.5 }]}>
          <Text style={styles.saveBtnText}>{saving ? t('saving') : saved ? t('saved') : t('save')}</Text>
        </TouchableOpacity>
      </View>

      {loading ? (
        <View style={styles.center}><ActivityIndicator color={GOLD} /><Text style={styles.empty}>{t('loading_supplies')}</Text></View>
      ) : items.length === 0 ? (
        <View style={styles.center}>
          <Text style={styles.emptyBig}>{t('no_supplies_yet')}</Text>
          <Text style={styles.empty}>{t('ask_owner_setup')}</Text>
        </View>
      ) : (
        <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 40 }}>
          <Text style={styles.helper}>{t('supplies_helper')}</Text>
          {lowCount > 0 && (
            <View style={styles.lowBanner}>
              <Text style={styles.lowBannerText}>{ti(t('flagged_low'), { n: String(lowCount) })}</Text>
            </View>
          )}

          {Object.entries(grouped).map(([cat, rows]) => (
            <View key={cat} style={styles.categoryCard}>
              <Text style={styles.categoryHeader}>{cat}</Text>
              {rows.map(item => {
                const row = log[item.id] || { qty_used: 0, qty_remaining: '', needs_restock: false, notes: '' }
                const belowPar = isBelowPar(item, row)
                return (
                  <View key={item.id} style={styles.itemRow}>
                    <View style={styles.itemHead}>
                      <Text style={styles.itemName}>{item.item_name}</Text>
                      {item.par_level != null && (
                        <Text style={styles.itemMeta}>{t('par')}: {item.par_level}{item.unit ? ' ' + item.unit : ''}</Text>
                      )}
                    </View>
                    <View style={styles.itemControls}>
                      {/* Cycle count — primary action */}
                      <View style={styles.countGroup}>
                        <Text style={styles.countLabel}>{t('count_left')}</Text>
                        <TextInput
                          style={[styles.countInput, belowPar && styles.countInputLow]}
                          keyboardType="number-pad"
                          value={row.qty_remaining}
                          placeholder="—"
                          placeholderTextColor="#CBD5E1"
                          onChangeText={v => setRemaining(item.id, v)}
                          maxLength={4}
                        />
                      </View>
                      {/* Qty used — secondary, kept for crews who restock from the van */}
                      <View style={styles.qtyGroup}>
                        <Text style={styles.countLabel}>{t('used_short')}</Text>
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                          <TouchableOpacity style={styles.qtyBtn} onPress={() => setQty(item.id, -1)}><Text style={styles.qtyBtnText}>−</Text></TouchableOpacity>
                          <Text style={styles.qtyNum}>{row.qty_used}</Text>
                          <TouchableOpacity style={styles.qtyBtn} onPress={() => setQty(item.id, +1)}><Text style={styles.qtyBtnText}>+</Text></TouchableOpacity>
                        </View>
                      </View>
                      {/* Manual low toggle — for items the crew didn't count but knows are low */}
                      <TouchableOpacity
                        onPress={() => toggleLow(item.id)}
                        style={[styles.lowToggle, (row.needs_restock || belowPar) && styles.lowToggleOn]}
                        disabled={belowPar /* DB trigger will set this anyway */}
                      >
                        <Text style={[styles.lowToggleText, (row.needs_restock || belowPar) && { color: '#fff' }]}>
                          {belowPar ? t('low') : row.needs_restock ? t('low') : t('mark_low')}
                        </Text>
                      </TouchableOpacity>
                    </View>
                    {belowPar && (
                      <Text style={styles.belowParHint}>{t('below_par')}</Text>
                    )}
                  </View>
                )
              })}
            </View>
          ))}

          <View style={{ marginTop: 8, paddingHorizontal: 4 }}>
            <Text style={styles.helper}>{t('note_helper')}</Text>
            {items.filter(i => (log[i.id]?.needs_restock)).map(item => (
              <View key={`note-${item.id}`} style={styles.noteCard}>
                <Text style={styles.noteLabel}>{item.item_name}</Text>
                <TextInput
                  style={styles.noteInput}
                  placeholder={t('add_note_placeholder')}
                  placeholderTextColor="#94A3B8"
                  value={log[item.id]?.notes || ''}
                  onChangeText={v => setNotes(item.id, v)}
                  multiline
                />
              </View>
            ))}
          </View>
        </ScrollView>
      )}
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 16, paddingVertical: 12, backgroundColor: '#fff',
    borderBottomWidth: 1, borderBottomColor: '#E2E8F0',
  },
  back: { color: GOLD, fontSize: 15, fontWeight: '600' },
  title: { fontSize: 17, fontWeight: '800', color: NAVY },
  saveBtn: { backgroundColor: GOLD, paddingHorizontal: 14, paddingVertical: 8, borderRadius: 8 },
  saveBtnText: { color: '#fff', fontWeight: '800', fontSize: 13 },

  center: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 24 },
  empty: { color: '#64748B', fontSize: 13, marginTop: 6, textAlign: 'center' },
  emptyBig: { color: NAVY, fontSize: 15, fontWeight: '700', textAlign: 'center' },

  helper: { color: '#64748B', fontSize: 12, marginBottom: 12, lineHeight: 17 },

  lowBanner: {
    backgroundColor: '#FEF3C7', borderColor: '#FCD34D', borderWidth: 1,
    borderRadius: 10, padding: 10, marginBottom: 12,
  },
  lowBannerText: { color: '#92400E', fontSize: 13, fontWeight: '700' },

  categoryCard: {
    backgroundColor: '#fff', borderRadius: 12, borderWidth: 1, borderColor: '#E2E8F0',
    marginBottom: 12, overflow: 'hidden',
  },
  categoryHeader: {
    fontSize: 11, fontWeight: '800', color: GOLD, textTransform: 'uppercase',
    letterSpacing: 0.5, padding: 12, backgroundColor: '#F8FAFC',
    borderBottomWidth: 1, borderBottomColor: '#F1F5F9',
  },
  itemRow: {
    paddingHorizontal: 12, paddingVertical: 10,
    borderBottomWidth: 1, borderBottomColor: '#F1F5F9',
  },
  itemHead: { marginBottom: 8 },
  itemName: { fontSize: 14, fontWeight: '600', color: NAVY },
  itemMeta: { fontSize: 11, color: '#94A3B8', marginTop: 2 },
  itemControls: { flexDirection: 'row', alignItems: 'flex-end', gap: 12 },
  countGroup: { alignItems: 'flex-start' },
  countLabel: { fontSize: 10, fontWeight: '700', color: '#64748B', textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 4 },
  countInput: {
    width: 56, height: 36, borderRadius: 7, borderWidth: 1, borderColor: '#CBD5E1',
    paddingHorizontal: 8, fontSize: 15, fontWeight: '700', color: NAVY,
    textAlign: 'center', backgroundColor: '#fff',
  },
  countInputLow: { borderColor: AMBER, backgroundColor: '#FFFBEB' },
  qtyGroup: { alignItems: 'flex-start' },
  qtyBtn: {
    width: 28, height: 28, borderRadius: 6, borderWidth: 1, borderColor: '#E2E8F0',
    backgroundColor: '#F8FAFC', justifyContent: 'center', alignItems: 'center',
  },
  qtyBtnText: { fontSize: 18, color: NAVY, lineHeight: 20 },
  qtyNum: { minWidth: 18, textAlign: 'center', fontSize: 14, fontWeight: '700', color: NAVY },
  lowToggle: {
    marginLeft: 'auto', paddingHorizontal: 10, paddingVertical: 6, borderRadius: 6,
    borderWidth: 1, borderColor: '#FCD34D', backgroundColor: '#FFFBEB',
    alignSelf: 'flex-end',
  },
  lowToggleOn: { backgroundColor: AMBER, borderColor: AMBER },
  lowToggleText: { color: '#92400E', fontWeight: '700', fontSize: 11 },
  belowParHint: { fontSize: 10, color: '#92400E', fontWeight: '700', marginTop: 6, fontStyle: 'italic' },

  noteCard: {
    backgroundColor: '#fff', borderRadius: 10, borderWidth: 1, borderColor: '#E2E8F0',
    padding: 10, marginBottom: 8,
  },
  noteLabel: { fontSize: 12, fontWeight: '700', color: NAVY, marginBottom: 6 },
  noteInput: {
    borderWidth: 1, borderColor: '#E2E8F0', borderRadius: 8, padding: 8,
    fontSize: 13, color: NAVY, minHeight: 38,
  },
})
