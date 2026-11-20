export type Phase = '準備中' | '開放中' | '已結束'
export const validLeader = (value: string) => /^1[0-9]{8}$/.test(value.trim())
export interface ActivitySelection {
  id: string
  version: number
}
export interface ActivityItem extends ActivitySelection {
  title: string
  code: string
  phase: Phase
  reason: string
  expiresAt: number | null
}
export interface OperationResult {
  id: string
  message: string
  code?: string
  groups?: { label: string; code: string }[]
}
export interface Question {
  q: string
  label: string
  winner?: string | null
  winningAnswer?: string
  ownAnswer?: string | null
  submissions?: { label: string; answer: string; rank: number }[]
  progress?: string
  published?: boolean
}
export interface Snapshot {
  version?: number
  id: string
  title: string
  phase: Phase
  questions: Question[]
  code?: string
  groups?: { label: string; leader: string; joinCode?: string }[]
  group?: string
  joinCode?: string
  ready?: boolean
  source?: { book: string; tab: number; title: string; tabTitle: string }
}
export interface Slot {
  address: string
  range: string
  expected: string
  value: Record<string, string | number | boolean> | null
}
export interface Preview {
  key: string
  slots: Slot[]
  bookTitle: string
  tabTitle: string
}
