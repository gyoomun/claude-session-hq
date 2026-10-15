// 서버(/api/state)가 보내는 모양
export type SessionState = 'working' | 'myturn' | 'approval' | 'idle'

export interface Session {
  pid: number
  sid: string
  name: string
  title: string
  cwd: string
  dir: string
  state: SessionState
  since: number
  startedAt: number
  act: string
  msg: string
  prompt: string
  task: string
  host: 'web' | 'orca' | ''
  tmux: string
}

export interface Wait { id: string; who: string; what: string; since: number }

export interface Task {
  id: string
  name: string
  memo: string
  next: string
  waits: Wait[]
  createdAt: number
  updatedAt: number
}

export interface FeedItem { at: number; sid: string; title: string; task: string; from: string; to: string }

export interface Login { id: string; label: string; ip: string; pc?: string; device: string; createdAt: number; lastSeenAt: number }

export interface Access { lan: boolean; mail: string; mailFile: string; addresses: string[]; me: string; logins: Login[] }

export interface Snapshot {
  now: number
  sessions: Session[]
  tasks: Task[]
  feed: FeedItem[]
  orca: boolean
  worktrees: { path: string; name: string }[]
  focus: { name: string; at: number } | null
  access: Access
  layout: Record<string, { x: number; y: number }> // 가상 사무실의 책상 위치(방 안 0~1 비율)
  btw: Record<string, BtwItem[]> // 세션별 곁가지 질문
  closed: Closed[] // 최근 닫힌 세션(웹에서 다시 열 수 있음)
  migrating: boolean // Orca 세션을 웹으로 옮기는 중
}

export interface Closed { sid: string; title: string; dir: string; cwd: string; args: string[]; host: string; closedAt: number }

export interface BtwItem { id: string; q: string; a: string; state: 'asking' | 'done' | 'error'; at: number; doneAt?: number }
