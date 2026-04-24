import React, { useState, useEffect } from 'react'
import { View, Text, ScrollView, TouchableOpacity, StyleSheet, TextInput, ActivityIndicator, Alert } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { supabase } from '../lib/supabase'
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

type LogState = Record<string, { qty_used: number; needs_restock: boolean; notes: string }>

export function JobInventoryScreen({ job, user, onBack }: Props) {
  const addrId = (job.client_addresses as any)?.id || job.address_id
  const tenantId = job.tenant_id

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
        .select('inventory_id, qty_used, needs_restock, notes')
        .eq('job_id', job.id),
    ])
    setItems(invRes.data ?? [])
    const map: LogState = {}
    ;(logRes.data ?? []).forEach((l: any) => {
      map[l.inventory_id] = {
        qty_used: l.qty_used ?? 0,
        needs_restock: !!l.needs_restock,
        notes: l.notes ?? '',
      }
    })
    setLog(map)
    setLoading(false)
  }

  function ensureRow(id: string) {
    if (log[id]) return log[id]
    return { qty_used: 0, needs_restock: false, notes: '' }
  }

  function setQty(id: string, delta: number) {
    const row = ensureRow(id)
    const nextQty = Math.max(0, row.qty_used + delta)
    setLog(prev => ({ ...prev, [id]: { ...row, qty_used: nextQty } }))
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
      .filter(([, v]) => v.qty_used > 0 || v.needs_restock)
      .map(([inventory_id, v]) => ({
        tenant_id: tenantId,
        job_id: job.id,
        inventory_id,
        item_name: items.find(i => i.id === inventory_id)?.item_name || '',
        qty_used: v.qty_used || 0,
        needs_restock: !!v.needs_restock,
        notes: v.notes?.trim() || null,
      }))
    if (rows.length > 0) {
      const { error } = await supabase.from('job_inventory_log').insert(rows)
      if (error) { setSaving(false); Alert.alert('Could not save', error.message); return }
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
  const lowCount = Object.values(log).filter(v => v.needs_restock).length

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: '#F8FAFC' }}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity onPress={onBack}><Text style={styles.back}>‹ Back</Text></TouchableOpacity>
        <Text style={styles.title}>Supplies</Text>
        <TouchableOpacity onPress={save} disabled={saving} style={[styles.saveBtn, saving && { opacity: 0.5 }]}>
          <Text style={styles.saveBtnText}>{saving ? 'Saving...' : saved ? 'Saved' : 'Save'}</Text>
        </TouchableOpacity>
      </View>

      {loading ? (
        <View style={styles.center}><ActivityIndicator color={GOLD} /><Text style={styles.empty}>Loading supplies...</Text></View>
      ) : items.length === 0 ? (
        <View style={styles.center}>
          <Text style={styles.emptyBig}>No supplies list for this property yet.</Text>
          <Text style={styles.empty}>Ask the owner or homeowner to set one up in the client portal.</Text>
        </View>
      ) : (
        <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 40 }}>
          <Text style={styles.helper}>
            Mark anything running low so it shows up on the homeowner's portal. Add a qty used if you restocked from the van.
          </Text>
          {lowCount > 0 && (
            <View style={styles.lowBanner}>
              <Text style={styles.lowBannerText}>{lowCount} item{lowCount === 1 ? '' : 's'} flagged as low</Text>
            </View>
          )}

          {Object.entries(grouped).map(([cat, rows]) => (
            <View key={cat} style={styles.categoryCard}>
              <Text style={styles.categoryHeader}>{cat}</Text>
              {rows.map(item => {
                const row = log[item.id] || { qty_used: 0, needs_restock: false, notes: '' }
                return (
                  <View key={item.id} style={styles.itemRow}>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.itemName}>{item.item_name}</Text>
                      {item.par_level != null && (
                        <Text style={styles.itemMeta}>Par: {item.par_level} {item.unit || ''}</Text>
                      )}
                    </View>
                    <View style={styles.qtyGroup}>
                      <TouchableOpacity style={styles.qtyBtn} onPress={() => setQty(item.id, -1)}><Text style={styles.qtyBtnText}>−</Text></TouchableOpacity>
                      <Text style={styles.qtyNum}>{row.qty_used}</Text>
                      <TouchableOpacity style={styles.qtyBtn} onPress={() => setQty(item.id, +1)}><Text style={styles.qtyBtnText}>+</Text></TouchableOpacity>
                    </View>
                    <TouchableOpacity
                      onPress={() => toggleLow(item.id)}
                      style={[styles.lowToggle, row.needs_restock && styles.lowToggleOn]}>
                      <Text style={[styles.lowToggleText, row.needs_restock && { color: '#fff' }]}>
                        {row.needs_restock ? 'Low' : 'Mark low'}
                      </Text>
                    </TouchableOpacity>
                  </View>
                )
              })}
            </View>
          ))}

          <View style={{ marginTop: 8, paddingHorizontal: 4 }}>
            <Text style={styles.helper}>
              Add a note for the owner (optional) — e.g. "Almost out, only 1 roll left"
            </Text>
            {items.filter(i => (log[i.id]?.needs_restock)).map(item => (
              <View key={`note-${item.id}`} style={styles.noteCard}>
                <Text style={styles.noteLabel}>{item.item_name}</Text>
                <TextInput
                  style={styles.noteInput}
                  placeholder="Add a note..."
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
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingHorizontal: 12, paddingVertical: 10,
    borderBottomWidth: 1, borderBottomColor: '#F1F5F9',
  },
  itemName: { fontSize: 14, fontWeight: '600', color: NAVY },
  itemMeta: { fontSize: 11, color: '#94A3B8', marginTop: 2 },
  qtyGroup: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  qtyBtn: {
    width: 28, height: 28, borderRadius: 6, borderWidth: 1, borderColor: '#E2E8F0',
    backgroundColor: '#F8FAFC', justifyContent: 'center', alignItems: 'center',
  },
  qtyBtnText: { fontSize: 18, color: NAVY, lineHeight: 20 },
  qtyNum: { minWidth: 18, textAlign: 'center', fontSize: 14, fontWeight: '700', color: NAVY },
  lowToggle: {
    paddingHorizontal: 10, paddingVertical: 6, borderRadius: 6,
    borderWidth: 1, borderColor: '#FCD34D', backgroundColor: '#FFFBEB',
  },
  lowToggleOn: { backgroundColor: AMBER, borderColor: AMBER },
  lowToggleText: { color: '#92400E', fontWeight: '700', fontSize: 11 },

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
