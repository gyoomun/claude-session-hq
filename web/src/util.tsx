import { useNow } from './store'
import type { Session, Snapshot, Task, Wait } from './types'

export const M = 6e4, H = 36e5, D = 864e5

export const LABEL: Record<string, string> = {
  working: '작업중', compact: '압축 중', myturn: '내 차례', approval: '승인 필요', idle: '쉼',
  human: '남 기다림', empty: '세션 없음', open: '열림', closed: '닫힘',
}
// 상태 색은 Mantine 색 이름. 픽셀 그림에서도 같은 색을 쓴다
export const COLOR: Record<string, string> = {
  working: 'teal', compact: 'cyan', myturn: 'yellow', approval: 'red', idle: 'gray',
  human: 'grape', empty: 'gray', open: 'indigo', closed: 'gray',
}
export const cssColor = (state: string, shade = 6) => `var(--mantine-color-${COLOR[state] || 'gray'}-${shade})`
// 배경에 깔 옅은 상태 색. Mantine의 -light는 노랑이 너무 진해서 직접 섞는다
export const tint = (state: string, pct = 10) => `color-mix(in srgb, ${cssColor(state)} ${pct}%, var(--mantine-color-body))`

const RANK: Record<string, number> = { approval: 0, myturn: 1, working: 2, compact: 2, idle: 3 }
// 나를 기다리는 것이 위로, 기다린 지 오래된 것이 먼저. 쉬는 것은 최근 것이 먼저
export const bySt = (a: Session, b: Session) =>
  RANK[a.state] - RANK[b.state] || (a.state === 'idle' ? b.since - a.since : a.since - b.since)
export const waiting = (s: Session) => s.state === 'myturn' || s.state === 'approval'

export function fmt(ms: number) {
  ms = Math.max(0, ms)
  const m = Math.floor(ms / M)
  if (m < 1) return '<1분'
  if (m < 60) return m + '분'
  const h = Math.floor(m / 60)
  if (h < 24) return h + '시간' + (m % 60 ? ' ' + (m % 60) + '분' : '')
  const d = Math.floor(h / 24)
  return d + '일' + (h % 24 ? ' ' + (h % 24) + '시간' : '')
}
export function Since({ t, suf = '' }: { t: number; suf?: string }) {
  const n = useNow()
  return <>{fmt(n - t) + suf}</>
}
export const hhmm = (t: number) => new Date(t).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false })
export const base = (p: string) => String(p || '').split('/').pop() || p

export const taskOf = (S: Snapshot, id: string) => S.tasks.find(t => t.id === id)
export const tname = (S: Snapshot, id: string) => taskOf(S, id)?.name || '미배치'
export const sessOf = (S: Snapshot, t: Task) => S.sessions.filter(s => s.task === t.id).sort(bySt)
export const overdue = (w: Wait) => Date.now() - w.since > 4 * H
export const lastOf = (S: Snapshot, t: Task) => Math.max(t.updatedAt || 0, ...sessOf(S, t).map(s => s.since))
export const stale = (S: Snapshot, t: Task) => Date.now() - lastOf(S, t) > D && !sessOf(S, t).some(s => s.state === 'working')
export function taskStatus(S: Snapshot, t: Task) {
  const ss = sessOf(S, t)
  if (ss.some(s => s.state === 'approval')) return 'approval'
  if (ss.some(s => s.state === 'myturn')) return 'myturn'
  if (t.waits.length) return 'human'
  if (ss.some(s => s.state === 'working')) return 'working'
  return ss.length ? 'idle' : 'empty'
}
