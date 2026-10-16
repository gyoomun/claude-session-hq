// 영역 단축키와 키보드로 영역 안을 다니기. 영역 = 세션 목록·즐겨찾기·대화·핀·메모·btw(화면에 data-area로 표시).
// 영역 이름 옆 ⌨를 누르고 키를 누르면 그 키로 정해져 바로 옆에 적힌다(안 까먹게). 환경설정 '단축키'에서도 같은 버튼으로 고친다
import { useEffect, useState } from 'react'
import { ActionIcon, Group, Kbd, Text, Tooltip } from '@mantine/core'
import { IconKeyboard } from '@tabler/icons-react'
import { toast } from './store'
import { copyText } from './Chat'
import { AREAS, type Area, type Combo, setKeys, setMode, useUI } from './ui'

const MAC = /Mac|iPhone|iPad/.test(navigator.platform)
const keyName = (code: string) => code.replace(/^Key|^Digit|^Numpad/, '').replace(/^Arrow(\w+)$/, (_, d) => ({ Up: '↑', Down: '↓', Left: '←', Right: '→' } as Record<string, string>)[d] || d)
export const comboText = (c: Combo) => [c.ctrl && (MAC ? '⌃' : 'Ctrl+'), c.alt && (MAC ? '⌥' : 'Alt+'), c.shift && (MAC ? '⇧' : 'Shift+'), c.meta && (MAC ? '⌘' : 'Win+'), keyName(c.code)].filter(Boolean).join('')
// 한글 입력 중에도 같은 키로 잡히게 글자(e.key) 대신 자판 위치(e.code)로 견준다
export const sameKey = (e: KeyboardEvent, c: Combo) => e.code === c.code && e.ctrlKey === c.ctrl && e.altKey === c.alt && e.shiftKey === c.shift && e.metaKey === c.meta

let recording = false // 녹화 중에는 다른 단축키(F1~F4, 영역 키)가 반응하지 않는다
export const isRecording = () => recording
const MODS = ['Shift', 'Control', 'Alt', 'Meta', 'CapsLock']
// 이미 쓰는 키: F1~F4 보기 전환, Cmd/Ctrl+T 새 세션, Ctrl+Tab 순회, Esc·Enter
const reserved = (c: Combo) => /^F[1-4]$/.test(c.code) || ((c.meta || c.ctrl) && c.code === 'KeyT') || (c.ctrl && c.code === 'Tab') || ['Escape', 'Enter', 'Tab'].includes(c.code)

// 영역 이름 옆: 지금 키와 녹화 버튼. 누르고 키를 누르면 정해진다. Esc 취소, ⌫ 지우기
export function KeyRec({ area }: { area: Area }) {
  const { keys } = useUI()
  const [rec, setRec] = useState(false)
  useEffect(() => {
    if (!rec) return
    recording = true
    const on = (e: KeyboardEvent) => {
      e.preventDefault(); e.stopPropagation()
      if (MODS.includes(e.key)) return
      const done = () => setRec(false)
      if (e.key === 'Escape' && !e.ctrlKey && !e.altKey && !e.metaKey) { done(); return }
      if (e.key === 'Backspace' || e.key === 'Delete') { setKeys({ ...keys, [area]: null }); done(); return }
      const c: Combo = { code: e.code, ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey, meta: e.metaKey }
      // 글자만 누른 키는 입력칸에 글을 칠 때 걸린다. Ctrl·⌥·⌘이 들어가거나 F5~F12여야 한다
      if (!(c.ctrl || c.alt || c.meta) && !/^F([5-9]|1[0-2])$/.test(c.code)) { toast('Ctrl·⌥(Alt)·⌘ 중 하나를 같이 누르거나 F5~F12를 쓰세요.', 'orange'); return }
      if (reserved(c)) { toast(`${comboText(c)}는 이미 쓰는 키입니다.`, 'orange'); return }
      const next = { ...keys, [area]: c }
      const taken = AREAS.find(([a]) => a !== area && keys[a] && comboText(keys[a]!) === comboText(c))
      if (taken) { next[taken[0]] = null; toast(`${comboText(c)}를 ${taken[1]}에서 떼어 이쪽에 붙였습니다.`) }
      setKeys(next); done()
    }
    addEventListener('keydown', on, true)
    return () => { recording = false; removeEventListener('keydown', on, true) }
  }, [rec, keys, area])
  const k = keys[area]
  return <Group gap={4} wrap="nowrap" style={{ flex: 'none' }}>
    {rec ? <Text size="xs" c="indigo.3" className="hq-recording">키를 누르세요 · Esc 취소 · ⌫ 지우기</Text>
      : k ? <Kbd size="xs">{comboText(k)}</Kbd> : <Text size="xs" c="dimmed">단축키 없음</Text>}
    <Tooltip label={rec ? '녹화 취소' : '단축키 녹화'} openDelay={300}>
      <ActionIcon size="sm" variant={rec ? 'filled' : 'subtle'} color={rec ? 'indigo' : 'gray'} aria-label={`${AREAS.find(([a]) => a === area)![1]} 단축키 녹화`}
        onClick={() => setRec(r => !r)} onMouseDown={e => e.preventDefault()}><IconKeyboard size={15} stroke={1.6} /></ActionIcon>
    </Tooltip>
  </Group>
}

// 영역으로 옮겨 커서를 둔다. 목록·즐겨찾기는 고른 세션(없으면 첫 줄), 핀은 스크롤 칸, 메모·btw·대화는 입력칸
export function focusArea(area: Area) {
  const box = document.querySelector<HTMLElement>(`[data-area="${area}"]`)
  if (!box) return false
  const target = area === 'list' || area === 'favs' ? box.querySelector<HTMLElement>('button.hq-item[data-on="true"]') || box.querySelector<HTMLElement>('button.hq-item')
    : area === 'pin' ? box.querySelector<HTMLElement>('.mantine-ScrollArea-viewport')
    : box.querySelector<HTMLElement>('textarea')
  ;(target || box).focus({ preventScroll: false })
  box.classList.remove('hq-flash'); void box.offsetWidth; box.classList.add('hq-flash')
  return true
}

// 영역 단축키: 작업 보기(F1)의 영역으로 옮긴다. 다른 보기면 작업 보기로 넘어간 뒤 옮긴다
export function useAreaKeys() {
  const { keys, settings } = useUI()
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (recording || settings || e.isComposing) return
      const hit = AREAS.find(([a]) => keys[a] && sameKey(e, keys[a]!))
      if (!hit) return
      e.preventDefault(); e.stopPropagation()
      if (!focusArea(hit[0])) { setMode('work'); setTimeout(() => focusArea(hit[0]), 120) }
    }
    addEventListener('keydown', on, true)
    return () => removeEventListener('keydown', on, true)
  }, [keys, settings])
}

// 영역 안에서: Esc는 대화 입력칸으로 돌아간다(Claude를 멈추지 않는다). 목록·즐겨찾기는 ↑↓·Home·End로 옮기고 Enter로 열고 입력칸으로 가며, ⌘C는 세션 이름 복사.
// 영역의 빈 곳을 누르면 영역 자체에 커서가 가고(tabIndex -1) 거기서 ↓를 누르면 첫 줄부터 다닌다
export function areaKeys(list = false) {
  return (e: React.KeyboardEvent<HTMLElement>) => {
    if (e.nativeEvent.isComposing) return
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); focusArea('chat'); return }
    if (!list) return
    const items = [...e.currentTarget.querySelectorAll<HTMLElement>('button.hq-item')]
    const i = items.indexOf(document.activeElement as HTMLElement)
    const go = (j: number) => { const t = items[Math.max(0, Math.min(items.length - 1, j))]; t?.focus(); t?.scrollIntoView({ block: 'nearest' }) }
    if (e.key === 'ArrowDown') go(i + 1)
    else if (e.key === 'ArrowUp') go(i < 0 ? 0 : i - 1)
    else if (e.key === 'Home') go(0)
    else if (e.key === 'End') go(items.length - 1)
    else if (e.key === 'Enter' && i >= 0) { items[i].click(); setTimeout(() => focusArea('chat'), 80) }
    else if ((e.metaKey || e.ctrlKey) && e.code === 'KeyC' && i >= 0 && items[i].dataset.name) { const n = items[i].dataset.name!; copyText(n).then(ok => ok && toast(`세션 이름 ${n}을 복사했습니다.`)) }
    else return
    e.preventDefault()
  }
}
