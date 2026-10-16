// 화면 상태(보기, 고른 세션, 열린 서랍·창). 보기는 주소 끝(#work 등)에 남겨 브라우저·마우스 뒤로가기로 돌아간다
import { useSyncExternalStore } from 'react'

export type Mode = 'work' | 'task' | 'all' | 'memo'
const MODES: Mode[] = ['work', 'task', 'all', 'memo']
const get = (k: string) => { try { return localStorage.getItem(k) } catch { return null } }
const set = (k: string, v: string) => { try { localStorage.setItem(k, v) } catch { /* 저장 못 해도 화면은 돈다 */ } }
const hashMode = () => (MODES as string[]).includes(location.hash.slice(1)) ? location.hash.slice(1) as Mode : null

interface UI {
  mode: Mode
  sel: string // 작업 보기에서 고른 세션(sid)
  pendingSel: string // 방금 연 웹 세션(tmux 이름). 목록에 나타나면 고른다
  openTask: string | null
  openSess: string | null
  newFor: string | null // 새 세션 창: null이면 닫힘, ''이면 업무 없이, 업무 id면 그 업무로
  addTask: boolean
  brief: boolean
  access: boolean
  settings: boolean
  view: 'chat' | 'term' // 웹 세션을 대화 화면으로 볼지, 터미널(Claude Code 화면 그대로)로 볼지
  detail: boolean // 작업 과정(도구 사용)을 하나하나 볼지, 한 줄로 접어 볼지
  layoutKey: number // 칸 경계를 기본값으로 되돌릴 때 올린다(경계 묶음은 처음 그릴 때만 저장값을 읽어서, 다시 그리게 한다)
}
let ui: UI = {
  mode: hashMode() || (get('hq-mode') as Mode) || 'work', sel: get('hq-sel') || '', pendingSel: '',
  openTask: null, openSess: null, newFor: null, addTask: false, brief: false, access: false,
  settings: false, view: get('hq-view') === 'term' ? 'term' : 'chat', detail: get('hq-detail') === '1', layoutKey: 0,
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
export function pickNew(tmux: string) {
  setUI({ pendingSel: tmux, sel: '', openTask: null, openSess: null })
  setMode('work')
}
export function setView(v: UI['view']) { set('hq-view', v); setUI({ view: v }) }
export function setDetail(v: boolean) { set('hq-detail', v ? '1' : '0'); setUI({ detail: v }) }
// 칸 경계(react-resizable-panels가 localStorage에 저장한 비율)를 지우고 기본값으로 다시 그린다. id: 'hq-side'(핀·메모·btw 높이), 'hq-work'(목록·즐겨찾기·대화 너비)
export function resetLayout(id: string) {
  try { Object.keys(localStorage).filter(k => k.startsWith('react-resizable-panels:' + id)).forEach(k => localStorage.removeItem(k)) } catch { /* 무시 */ }
  setUI({ layoutKey: ui.layoutKey + 1 })
}
export const rememberSel = (sid: string) => set('hq-sel', sid)
export const lastCwd = () => get('hq-cwd') || ''
export const rememberCwd = (cwd: string) => set('hq-cwd', cwd)
