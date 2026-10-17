// 서버(/api/state)가 보내는 모양
export type SessionState = 'working' | 'compact' | 'myturn' | 'approval' | 'idle' // compact: 대화 압축 중(일이 아님)

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
  ask?: { tool: string; what: string; why: string; questions?: { question: string; header?: string; multiSelect?: boolean; options: { label: string; description?: string }[] }[] } | null // 허락을 기다리는 도구(state가 approval일 때)
  prompt: string
  task: string
  host: 'web' | 'orca' | ''
  tmux: string
  forkOf?: string // 포크본이면 원본 대화 ID(서버 db.forks)
  browser?: { title: string; url: string; busy: boolean } | null // hq-browser로 연 크롬 탭(가장 최근 것). busy면 지금 조종 중. 없으면 null
  pin: PinItem[] // Claude 핀보드(대화 기록의 마지막 상태)
  model: string // 마지막 답을 만든 모델 ID(claude-opus-5-5 등). 아직 답이 없으면 ''
  effort: string // 그 답의 effort(low·medium·high·xhigh·max)
  mode: string // 권한 모드(bypassPermissions·acceptEdits·plan·default·auto). 모르면 ''
  bg: { shells: number; agents: string[] } // 뒤에서 도는 셸 수와 하위 에이전트(설명). 웹 세션만 안다
  next?: string[] // next-steps-multi 플러그인이 터미널에 띄운 다음 말 제안(화면의 짧은 라벨). 웹 세션만 안다
}

export interface PinItem { id: string; mark: ' ' | '>' | 'x' | '?'; text: string }

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
  usage: { at: number; limits: { kind: string; percentUsed: number; resetsAt: string | null }[] } | null // Claude 사용량 한도(플러그인 hq-usage가 남김)
  account: { email: string; plan: string } | null // 이 맥의 Claude 로그인 계정(~/.claude.json)
  usageStale: boolean // 계정을 바꾼 뒤 사용량이 아직 이전 계정 값인지(서버가 usage.json이 써질 때의 계정을 기억한다)
  login: boolean // 계정 줄로 띄운 로그인 창(tmux 'login')이 떠 있는지
  usageShare: Record<string, Record<string, { share: number; windowEnd: number; at: number }>> // 한도 종류(five_hour·seven_day) -> 대화 ID -> 동전으로 조회한 세션별 한도 사용 추정(%p)
  calendar: { at: number; error: string; sources: number; events: CalEvent[] } // 회사 일정(구글 캘린더, 오늘부터 7일)
  inbox: { at: number; error: string; accounts: string[]; mails: Mail[] } // 받은편지함(계정들을 합쳐 최근 순)
  flow: { at: number; error: string; chats: FlowChat[]; alarms: FlowAlarm[] } // 플로우 안 읽은 채팅방·알림(최근 순)
  notice: { text: string; color: string; at: number } | null // 서버가 한 번 띄우는 알림(세션 하나 재시작이 끝났을 때 등)
  reboot: { at: number; end: number; items: { sid: string; title: string; phase: 'wait' | 'kill' | 'start' | 'ok' | 'fail'; ms: number }[] } | null // 모두 재시작 진행(오른쪽 아래 부팅 패널)
  favs: { mode: 'auto' | 'free'; items: { sid: string; slot: number }[] } // 즐겨찾기: 순서(자동 정렬)와 칸 번호(자유 배치)
  rooms: Record<string, Rect> // 가상 사무실의 방 자리·크기(칸 단위). 키는 업무 id 또는 'lobby'
  btw: Record<string, BtwItem[]> // 세션별 곁가지 질문
  memos: Record<string, { title: string; text: string; at: number }> // 세션(대화 ID)별 메모(글 하나)
  closed: Closed[] // 닫힌 세션(웹에서 다시 열 수 있음)
  migrating: boolean // Orca 세션을 웹으로 옮기는 중
  build: number // 서버가 내주는 화면의 빌드 시각
}

export interface Closed { sid: string; title: string; dir: string; cwd: string; args: string[]; host: string; closedAt: number; quiet?: boolean }

export interface BtwItem { id: string; q: string; a: string; state: 'asking' | 'done' | 'error'; at: number; doneAt?: number }

export interface Rect { x: number; y: number; w: number; h: number }

export interface CalEvent { id: string; title: string; start: number; end: number; allDay: boolean; cal: string }

export interface FlowChat { room: string; name: string; from: string; text: string; at: number; unread: number; mention: boolean }
export interface FlowAlarm { id: string; from: string; message: string; text: string; at: number; mention: boolean }
export interface Mail { id: string; account: string; from: string; subject: string; at: number; unread: boolean; url: string }
