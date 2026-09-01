// Display name for a property_rooms row — the same derivation the JobDetailScreen
// room accordion and JobInventoryScreen use, kept in one place so an incident
// filed "in Bathroom 2" reads the same everywhere.
export function roomLabel(rm: any): string {
  return (rm.name || '').trim() || (
    rm.room_type === 'bedroom' ? (rm.instance_no === 1 ? 'Primary Bedroom' : `Bedroom ${rm.instance_no}`)
    : rm.room_type === 'bathroom' ? `Bathroom ${rm.instance_no}`
    : rm.room_type === 'final' ? 'Final Guest-Ready Check'
    : rm.room_type === 'living' ? 'Living Room'
    : String(rm.room_type || 'Room').replace(/_/g, ' ').replace(/\b\w/g, (c: string) => c.toUpperCase()) + (rm.instance_no > 1 ? ` ${rm.instance_no}` : ''))
}
