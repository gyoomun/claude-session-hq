// 화면 상태(보기, 고른 세션, 열린 서랍·창). 보기는 주소 끝(#work 등)에 남겨 브라우저·마우스 뒤로가기로 돌아간다
import { useSyncExternalStore } from 'react'
import { burst } from './store'

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
  openTask: string | null
  openSess: string | null
  newFor: string | null // 새 세션 창: null이면 닫힘, ''이면 업무 없이, 업무 id면 그 업무로
  addTask: boolean
  brief: boolean
  settings: boolean
  settingsPage: string // 환경설정 창을 열 때 보일 분류('all'이면 맨 위)
  view: 'chat' | 'term' // 웹 세션을 대화 화면으로 볼지, 터미널(Claude Code 화면 그대로)로 볼지
  detail: boolean // 작업 과정(도구 사용)을 하나하나 볼지, 한 줄로 접어 볼지
  motion: 'system' | 'on' // 움직임: 컴퓨터의 '동작 줄이기'를 따를지, 항상 켤지
  layoutKey: number // 칸 경계를 기본값으로 되돌릴 때 올린다(경계 묶음은 처음 그릴 때만 저장값을 읽어서, 다시 그리게 한다)
}
let ui: UI = {
  mode: hashMode() || (get('hq-mode') as Mode) || 'work', sel: get('hq-sel') || '', pendingSel: '', pendingTask: '',
  openTask: null, openSess: null, newFor: null, addTask: false, brief: false,
  settings: false, settingsPage: 'all', view: get('hq-view') === 'term' ? 'term' : 'chat', detail: get('hq-detail') === '1', layoutKey: 0, motion: get('hq-motion') === 'on' ? 'on' : 'system',
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
export function pickNew(tmux: string, task = '') {
  setUI({ pendingSel: tmux, pendingTask: task, sel: '', openTask: null, openSess: null })
  burst()
  setMode('work')
}
export function setView(v: UI['view']) { set('hq-view', v); setUI({ view: v }) }
export function setMotion(v: UI['motion']) { set('hq-motion', v === 'on' ? 'on' : ''); document.documentElement.dataset.motion = v; setUI({ motion: v }) }
document.documentElement.dataset.motion = ui.motion
export function setDetail(v: boolean) { set('hq-detail', v ? '1' : '0'); setUI({ detail: v }) }
// 칸 경계(react-resizable-panels가 localStorage에 저장한 비율)를 지우고 기본값으로 다시 그린다. id: 'hq-side'(핀·메모·btw 높이), 'hq-work'(목록·즐겨찾기·대화 너비)
export function resetLayout(id: string) {
  try { Object.keys(localStorage).filter(k => k.startsWith('react-resizable-panels:' + id)).forEach(k => localStorage.removeItem(k)) } catch { /* 무시 */ }
  setUI({ layoutKey: ui.layoutKey + 1 })
}
export const rememberSel = (sid: string) => set('hq-sel', sid)
export const lastCwd = () => get('hq-cwd') || ''
export const rememberCwd = (cwd: string) => set('hq-cwd', cwd)
