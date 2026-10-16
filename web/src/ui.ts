// 화면 상태(보기, 고른 세션, 열린 서랍·창). 보기는 주소 끝(#work 등)에 남겨 브라우저·마우스 뒤로가기로 돌아간다
import { useSyncExternalStore } from 'react'
import { burst } from './store'

export const TOAST_POS = ['top-left', 'top-center', 'top-right', 'right-center', 'bottom-right', 'bottom-center', 'bottom-left', 'left-center'] as const
export type ToastPos = typeof TOAST_POS[number]
// 영역 단축키: 영역마다 키 하나. 이 브라우저에 남는다(localStorage hq-keys). 처음 값은 ⌥1~⌥6
export const AREAS = [['list', '세션 목록'], ['favs', '즐겨찾기'], ['chat', '대화'], ['pin', '핀'], ['memo', '메모'], ['btw', 'btw']] as const
export type Area = typeof AREAS[number][0]
export type Combo = { code: string; ctrl: boolean; alt: boolean; shift: boolean; meta: boolean }
export const DEFAULT_KEYS = Object.fromEntries(AREAS.map(([a], i) => [a, { code: `Digit${i + 1}`, ctrl: false, alt: true, shift: false, meta: false }])) as Record<Area, Combo | null>
export type Mode = 'work' | 'task' | 'all' | 'memo'
const MODES: Mode[] = ['work', 'task', 'all', 'memo']
const get = (k: string) => { try { return localStorage.getItem(k) } catch { return null } }
const set = (k: string, v: string) => { try { localStorage.setItem(k, v) } catch { /* 저장 못 해도 화면은 돈다 */ } }
const hashMode = () => (MODES as string[]).includes(location.hash.slice(1)) ? location.hash.slice(1) as Mode : null

interface UI {
  mode: Mode
  sel: string // 작업 보기에서 고른 세션(sid)
  pendingSel: string // 방금 연 웹 세션(tmux 이름). 목록에 나타나면 고른다. 그때까지 작업 보기는 뼈대(스켈레톤)를 보인다
  pendingTask: string // 그 세션이 들어갈 업무(목록의 뼈대 자리). ''는 미배치
  pendingCwd: string // 그 세션의 폴더(새 세션 창에서 고른 것). 뜨기 전에도 머리에 보인다
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
  keys: Record<Area, Combo | null>
  slim: boolean // 왼쪽 사이드바를 아이콘만 남기고 접었는지(이 브라우저에 남는다)
  layoutKey: number // 칸 경계를 기본값으로 되돌릴 때 올린다(경계 묶음은 처음 그릴 때만 저장값을 읽어서, 다시 그리게 한다)
}
let ui: UI = {
  mode: hashMode() || (get('hq-mode') as Mode) || 'work', sel: get('hq-sel') || '', pendingSel: '', pendingTask: '', pendingCwd: '', pendingWorking: false,
  openTask: null, openSess: null, newFor: null, addTask: false, brief: false,
  settings: false, settingsPage: '', view: get('hq-view') === 'term' ? 'term' : 'chat', detail: get('hq-detail') === '1', layoutKey: 0, keys: (() => { try { return { ...DEFAULT_KEYS, ...JSON.parse(get('hq-keys') || '{}') } } catch { return DEFAULT_KEYS } })(), toast: ((TOAST_POS as readonly string[]).includes(get('hq-toast') || '') ? get('hq-toast') : 'bottom-right') as ToastPos, motion: get('hq-motion') === 'on' ? 'on' : 'system', slim: get('hq-slim') === '1',
}
history.replaceState(null, '', '#' + ui.mode)
const subs = new Set<() => void>()
export const useUI = () => useSyncExternalStore(f => { subs.add(f); return () => { subs.delete(f) } }, () => ui)
export function setUI(p: Partial<UI>) { ui = { ...ui, ...p }; subs.forEach(f => f()) }

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
export function pickNew(tmux: string, o: { task?: string; cwd?: string; working?: boolean } = {}) {
  setUI({ pendingSel: tmux, pendingTask: o.task || '', pendingCwd: o.cwd || '', pendingWorking: !!o.working, sel: '', openTask: null, openSess: null })
  burst()
  setMode('work')
}
export function setView(v: UI['view']) { set('hq-view', v); setUI({ view: v }) }
export function setSlim(v: boolean) { set('hq-slim', v ? '1' : ''); setUI({ slim: v }) }
export function setMotion(v: UI['motion']) { set('hq-motion', v === 'on' ? 'on' : ''); document.documentElement.dataset.motion = v; setUI({ motion: v }) }
document.documentElement.dataset.motion = ui.motion
document.documentElement.dataset.toast = ui.toast
export function setKeys(k: Record<Area, Combo | null>) { set('hq-keys', JSON.stringify(k)); setUI({ keys: k }) }
export function setToast(v: ToastPos) { set('hq-toast', v); document.documentElement.dataset.toast = v; setUI({ toast: v }) }
export function setDetail(v: boolean) { set('hq-detail', v ? '1' : '0'); setUI({ detail: v }) }
// 칸 경계(react-resizable-panels가 localStorage에 저장한 비율)를 지우고 기본값으로 다시 그린다. id: 'hq-side'(핀·메모·btw 높이), 'hq-work'(목록·즐겨찾기·대화 너비)
export function resetLayout(id: string) {
  try { Object.keys(localStorage).filter(k => k.startsWith('react-resizable-panels:' + id)).forEach(k => localStorage.removeItem(k)) } catch { /* 무시 */ }
  setUI({ layoutKey: ui.layoutKey + 1 })
}
export const rememberSel = (sid: string) => set('hq-sel', sid)
export const lastCwd = () => get('hq-cwd') || ''
export const rememberCwd = (cwd: string) => set('hq-cwd', cwd)
