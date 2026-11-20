export type Phase = '準備中' | '開放中' | '已結束'
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
  id: string
  title: string
  phase: Phase
  questions: Question[]
  code?: string
  groups?: { label: string; leader: string }[]
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
