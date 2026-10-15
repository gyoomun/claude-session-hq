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
}
