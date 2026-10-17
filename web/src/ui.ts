// 화면 상태(보기, 고른 세션, 열린 서랍·창). 보기는 주소 끝(#work 등)에 남겨 브라우저·마우스 뒤로가기로 돌아간다
import { useSyncExternalStore } from 'react'
import { api, burst } from './store'

export const TOAST_POS = ['top-left', 'top-center', 'top-right', 'right-center', 'bottom-right', 'bottom-center', 'bottom-left', 'left-center'] as const
export type ToastPos = typeof TOAST_POS[number]
// 영역 단축키: 영역마다 키 하나. 이 브라우저에 남는다(localStorage hq-keys). 처음 값은 ⌥1~⌥6
// 대화는 넣지 않는다: 어느 영역에서든 Esc를 누르면 대화 입력칸으로 오므로 단축키가 필요 없다(사용자 요청)
export const AREAS = [['list', '세션 목록'], ['favs', '즐겨찾기'], ['pin', '핀'], ['memo', '메모'], ['btw', 'btw']] as const
export type Area = typeof AREAS[number][0] | 'chat'
// 영역이 아닌 동작 단축키(같은 녹화 버튼으로 바꾼다). view: 대화 칸을 UI(대화 화면)와 터미널 사이에서 바꾼다
export const ACTIONS = [['view', '터미널·UI 전환']] as const
export type KeyId = Area | typeof ACTIONS[number][0]
export const KEY_LABEL = Object.fromEntries([...AREAS, ...ACTIONS]) as Record<KeyId, string>
export type Combo = { code: string; ctrl: boolean; alt: boolean; shift: boolean; meta: boolean }
export const DEFAULT_KEYS = { ...Object.fromEntries(AREAS.map(([a], i) => [a, { code: `Digit${i + 1}`, ctrl: false, alt: true, shift: false, meta: false }])), view: { code: 'KeyT', ctrl: false, alt: true, shift: false, meta: false } } as Record<KeyId, Combo | null>
export type Mode = 'work' | 'task' | 'all' | 'memo'
const MODES: Mode[] = ['work', 'task', 'all', 'memo']
const get = (k: string) => { try { return localStorage.getItem(k) } catch { return null } }
const set = (k: string, v: string) => { try { localStorage.setItem(k, v) } catch { /* 저장 못 해도 화면은 돈다 */ } }
const hashMode = () => (MODES as string[]).includes(location.hash.slice(1)) ? location.hash.slice(1) as Mode : null

interface UI {
  mode: Mode
  sel: string // 작업 보기에서 고른 세션(sid)
  closeFor: string // 종료 확인 창을 띄운 세션(sid), 없으면 ''. 머리 버튼과 ⌘W가 같이 쓴다
  pendingSel: string // 방금 연 웹 세션(tmux 이름). 목록에 나타나면 고른다. 그때까지 작업 보기는 뼈대(스켈레톤)를 보인다
  pendingTask: string // 그 세션이 들어갈 업무(목록의 뼈대 자리). ''는 미배치
  pendingCwd: string // 그 세션의 폴더(새 세션 창에서 고른 것). 뜨기 전에도 머리에 보인다
  pendingFav: string // 즐겨찾기의 이 세션(sid) 밑에 들어갈 것이면 그 sid. 뼈대 자리를 목록 대신 즐겨찾기에 둔다. 아니면 ''
  pendingWorking: boolean // 첫 지시를 줬으면 뜨자마자 일한다(작업중), 아니면 내 차례
  openTask: string | null
  openSess: string | null
  newFor: string | null // 새 세션 창: null이면 닫힘, ''이면 업무 없이, 업무 id면 그 업무로
  addTask: boolean
  brief: boolean
  settings: boolean
  settingsPage: string // 환경설정 창을 열 때 보일 분류(''이면 맨 위)
  view: 'chat' | 'term' // 웹 세션을 대화 화면으로 볼지, 터미널(Claude Code 화면 그대로)로 볼지
  detail: boolean // 작업 과정(도구 사용)을 하나하나 볼지, 한 줄로 접어 볼지
  motion: 'system' | 'on' // 움직임: 컴퓨터의 '동작 줄이기'를 따를지, 항상 켤지
  toast: ToastPos // 알림(토스트)이 뜨는 자리: 네 꼭짓점과 네 변의 가운데
  quick: string // 빠른 대답: 대화 입력칸에서 ⌘Enter로 보내는 정해 둔 말(환경설정에서 바꾼다. 이 브라우저에 남는다)
  keys: Record<KeyId, Combo | null>
  sideW: number // 펼친 사이드바 폭(px). 오른쪽 경계를 끌어 바꾼다(이 브라우저에 남는다)
  slimW: number // 접은 사이드바 폭(px). 펼친 폭과 따로 끌어 바꾼다
  slim: boolean // 왼쪽 사이드바를 아이콘만 남기고 접었는지(이 브라우저에 남는다)
  sideTab: 'memo' | 'btw' // 대화 오른쪽 아래 칸에서 보고 있는 탭(메모·btw를 한 칸에 탭으로 둔다. 이 브라우저에 남는다)
  layoutKey: number // 칸 경계를 기본값으로 되돌릴 때 올린다(경계 묶음은 처음 그릴 때만 저장값을 읽어서, 다시 그리게 한다)
}
export const QUICK = '커밋푸시 하고 다음거 진행해. 다음에 할 일이 없으면 다른 일을 찾거나 새로 벌이지 말고 "더 진행할 게 없습니다"라고만 답해.' // 빠른 대답 처음 값
export const SIDE_W = 164, SLIM_W = 68 // 사이드바 처음 폭(펼침·접힘)
const clampSide = (v: number) => Math.round(Math.min(360, Math.max(120, v)))
const clampSlim = (v: number) => Math.round(Math.min(110, Math.max(52, v)))
let ui: UI = {
  mode: hashMode() || (get('hq-mode') as Mode) || 'work', sel: get('hq-sel') || '', closeFor: '', pendingSel: '', pendingTask: '', pendingCwd: '', pendingFav: '', pendingWorking: false,
  openTask: null, openSess: null, newFor: null, addTask: false, brief: false,
  settings: false, settingsPage: '', view: get('hq-view') === 'term' ? 'term' : 'chat', detail: get('hq-detail') === '1', sideTab: get('hq-sidetab') === 'btw' ? 'btw' : 'memo', layoutKey: 0, keys: (() => { try { return { ...DEFAULT_KEYS, ...JSON.parse(get('hq-keys') || '{}') } } catch { return DEFAULT_KEYS } })(), toast: ((TOAST_POS as readonly string[]).includes(get('hq-toast') || '') ? get('hq-toast') : 'bottom-right') as ToastPos, motion: get('hq-motion') === 'on' ? 'on' : 'system', quick: get('hq-quick') || QUICK, slim: get('hq-slim') === '1', sideW: clampSide(Number(get('hq-sidew')) || SIDE_W), slimW: clampSlim(Number(get('hq-slimw')) || SLIM_W),
}
history.replaceState(null, '', '#' + ui.mode)
const subs = new Set<() => void>()
export const useUI = () => useSyncExternalStore(f => { subs.add(f); return () => { subs.delete(f) } }, () => ui)
export function setUI(p: Partial<UI>) { ui = { ...ui, ...p }; subs.forEach(f => f()) }

export const sideTab = () => ui.sideTab
export function setSideTab(t: UI['sideTab']) { set('hq-sidetab', t); setUI({ sideTab: t }) }

export function setMode(m: Mode) {
  if (m === ui.mode) return
  history.pushState(null, '', '#' + m)
  set('hq-mode', m)
  setUI({ mode: m })
}
addEventListener('popstate', () => {
  const m = hashMode()
  if (m && m !== ui.mode) { set('hq-mode', m); setUI({ mode: m, openTask: null, openSess: null }) }
})
// 세션 하나를 작업 보기에서 연다
export function pick(sid: string) {
  set('hq-sel', sid)
  setUI({ sel: sid, openTask: null, openSess: null })
  setMode('work')
}
export function pickNew(tmux: string, o: { task?: string; cwd?: string; working?: boolean; fav?: string } = {}) {
  setUI({ pendingSel: tmux, pendingTask: o.task || '', pendingCwd: o.cwd || '', pendingFav: o.fav || '', pendingWorking: !!o.working, sel: '', openTask: null, openSess: null })
  burst()
  setMode('work')
}
export function setView(v: UI['view']) { disarm(); set('hq-view', v); setUI({ view: v }) }
// 터미널 보기로 /model·/effort 창을 띄운 뒤, 창이 모두 닫혀 보통 입력칸으로 돌아오면(effort는 Enter 뒤에 확인 창이 한 번 더 뜬다) 대화 화면으로 되돌린다.
// 키가 아니라 서버가 화면을 보고 판단한다. 창이 한 번 보인 뒤에만 닫힘으로 친다. 이미 터미널 보기였으면 그대로 두고, 사용자가 먼저 보기를 바꾸면 되돌리지 않는다
let menuTimer = 0
export function openMenuView(pid: number) {
  if (ui.view === 'term') return
  setView('term')
  let seenOpen = false
  const t0 = Date.now()
  menuTimer = window.setInterval(async () => {
    if (Date.now() - t0 > 10 * 60e3) return disarm()
    const r = await api<boolean>('session/prompt-ready', { pid })
    if (!menuTimer || !r) return
    if (!r.result) seenOpen = true
    else if (seenOpen) { disarm(); setTimeout(() => setView('chat'), 200) }
  }, 400)
}
function disarm() { clearInterval(menuTimer); menuTimer = 0 }
// 지금 모양(펼침·접힘)의 폭을 바꾼다. 두 폭은 따로 남는다
export function setSideW(v: number, save = false) {
  if (ui.slim) { v = clampSlim(v); if (save) set('hq-slimw', String(v)); setUI({ slimW: v }) }
  else { v = clampSide(v); if (save) set('hq-sidew', String(v)); setUI({ sideW: v }) }
}
export function setSlim(v: boolean) { set('hq-slim', v ? '1' : ''); setUI({ slim: v }) }
export function setMotion(v: UI['motion']) { set('hq-motion', v === 'on' ? 'on' : ''); document.documentElement.dataset.motion = v; setUI({ motion: v }) }
document.documentElement.dataset.motion = ui.motion
document.documentElement.dataset.toast = ui.toast
export function setKeys(k: Record<KeyId, Combo | null>) { set('hq-keys', JSON.stringify(k)); setUI({ keys: k }) }
export function setToast(v: ToastPos) { set('hq-toast', v); document.documentElement.dataset.toast = v; setUI({ toast: v }) }
export function setQuick(v: string) { set('hq-quick', v); setUI({ quick: v }) }
export function setDetail(v: boolean) { set('hq-detail', v ? '1' : '0'); setUI({ detail: v }) }
// 칸 경계(react-resizable-panels가 localStorage에 저장한 비율)를 지우고 기본값으로 다시 그린다. id: 'hq-side'(핀·메모·btw 높이), 'hq-work'(목록·즐겨찾기·대화 너비)
export function resetLayout(id: string) {
  try { Object.keys(localStorage).filter(k => k.startsWith('react-resizable-panels:' + id)).forEach(k => localStorage.removeItem(k)) } catch { /* 무시 */ }
  setUI({ layoutKey: ui.layoutKey + 1 })
}
export const rememberSel = (sid: string) => set('hq-sel', sid)
export const lastCwd = () => get('hq-cwd') || ''
export const rememberCwd = (cwd: string) => set('hq-cwd', cwd)
