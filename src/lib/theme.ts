// RinseBase Brand Theme — Slate/Gold
// Replace all TEAL/NAVY references with these

export const SLATE = '#1E293B'      // Deep slate — was NAVY (#0A1628)
export const SLATE_DARK = '#0F172A' // Darkest slate (headers, tab bar)
export const SLATE_MID = '#334155'  // Mid slate (cards, accents)
export const GOLD = '#D4A843'       // Brand gold — was TEAL (#00C9A7)
export const GOLD_LIGHT = '#F0C96A' // Light gold (hover states)
export const GOLD_MUTED = '#92750F' // Dark gold (text on light bg)

export const SURFACE = '#F8FAFC'    // Page background
export const CARD = '#FFFFFF'       // Card background
export const BORDER = '#E2E8F0'     // Subtle border
export const TEXT = '#0F172A'       // Primary text
export const TEXT_MUTED = '#64748B' // Secondary text
export const TEXT_LIGHT = '#94A3B8' // Tertiary / placeholder

// Role accent colors (unchanged — these are functional)
export const ROLE_COLORS: Record<string, string> = {
  owner:        '#8B5CF6',
  manager:      '#3B82F6',
  dispatcher:   '#F59E0B',
  lead_cleaner: '#10B981',
  cleaner:      GOLD,
  trainee:      '#9CA3AF',
}
