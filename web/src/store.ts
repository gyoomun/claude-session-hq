// 서버 상태를 2초마다 받아 두고, 화면 어디서든 꺼내 쓴다. 바뀐 게 없으면 다시 그리지 않는다.
import { useSyncExternalStore } from 'react'
import { notifications } from '@mantine/notifications'
import type { Snapshot } from './types'

let snap: Snapshot | null = null
let text = ''
let offline = false
let skew = 0 // 서버 시각 - 이 브라우저 시각. 다른 PC에서 봐도 맥(서버) 시각을 보여 주려고 쓴다
const subs = new Set<() => void>()
const emit = () => subs.forEach(f => f())
const subscribe = (f: () => void) => { subs.add(f); return () => { subs.delete(f) } }

export const HDR = { 'Content-Type': 'application/json', 'x-hq': '1' }

async function poll() {
  try {
    const r = await fetch('/api/state', { cache: 'no-store' })
    if (r.status === 401) { location.href = '/login'; return }
    const d = Date.parse(r.headers.get('Date') || '')
    if (d) skew = d - Date.now()
    const t = await r.text()
    if (offline) { offline = false; emit() }
    if (t !== text) { text = t; snap = JSON.parse(t); emit() }
  } catch {
    if (!offline) { offline = true; emit() }
  }
}
// 평소엔 2초마다, 새 세션을 연 직후처럼 곧 바뀔 게 있을 때(burst)는 잠깐 0.3초마다 읽는다
let fastUntil = 0, timer = 0
const tick = async () => { await poll(); timer = window.setTimeout(tick, Date.now() < fastUntil ? 300 : 2000) }
tick()
export function burst(ms = 8000) { fastUntil = Date.now() + ms; window.clearTimeout(timer); tick() }

export const useSnapshot = () => useSyncExternalStore(subscribe, () => snap)
export const useOffline = () => useSyncExternalStore(subscribe, () => offline)
export const serverNow = () => Date.now() + skew

export function toast(message: string, color = 'indigo') {
  notifications.show({ message, color, autoClose: 3500 })
}

// 쓰기 요청. 성공하면 서버가 돌려준 새 상태로 바로 바꾼다
export async function api<T = unknown>(path: string, body?: object): Promise<{ result: T } | null> {
  try {
    const r = await fetch('/api/' + path, { method: 'POST', headers: HDR, body: JSON.stringify(body || {}) })
    if (r.status === 401) { location.href = '/login'; return null }
    const d = await r.json()
    if (!r.ok) throw new Error(d.error || '요청이 실패했습니다')
    const { result, ...s } = d
    text = JSON.stringify(s)
    snap = s
    emit()
    return { result }
  } catch (e) {
    toast((e as Error).message, 'red')
    return null
  }
}

/* 1초마다 도는 시계. 경과 시간을 보여 주는 곳만 다시 그린다 */
let now = Date.now()
const ticks = new Set<() => void>()
setInterval(() => { now = Date.now(); ticks.forEach(f => f()) }, 1000)
export const useNow = () => useSyncExternalStore(f => { ticks.add(f); return () => { ticks.delete(f) } }, () => now)
