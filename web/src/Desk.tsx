// 세션 하나를 픽셀 책상과 사람으로 그린다. 작업중이면 화면이 깜빡이고, 내 차례면 손을 들고, 승인 필요면 자물쇠, 쉬면 빈 의자
import type { Session } from './types'
import { cssColor } from './util'

const SKIN = ['#f2c9a1', '#d8a073', '#a96c47', '#7b4b2f']
const HAIR = ['#2a1c15', '#5b3b22', '#1d2433', '#8b5b2c', '#c9c2b8']
const SHIRT = ['#5b82f0', '#df6f59', '#3fb48a', '#ae7be0', '#e0ae3b', '#4cb3c9']
export const hash = (s: string) => { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h }

const r = (x: number, y: number, w: number, h: number, fill: string) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${fill}"/>`
const GLYPH: Record<string, string> = {
  bang: r(3, 1, 1, 2, 'var(--hq-bg)') + r(3, 4, 1, 1, 'var(--hq-bg)'),
  lock: r(2, 1, 3, 1, 'var(--hq-bg)') + r(2, 2, 1, 1, 'var(--hq-bg)') + r(4, 2, 1, 1, 'var(--hq-bg)') + r(1, 3, 5, 2, 'var(--hq-bg)'),
  z: r(2, 1, 3, 1, 'var(--hq-bg)') + r(4, 2, 1, 1, 'var(--hq-bg)') + r(3, 3, 1, 1, 'var(--hq-bg)') + r(2, 4, 3, 1, 'var(--hq-bg)'),
}

// 사람 모양만 따로: 책상에 앉은 사람과 로비에 서 있는 사람이 같이 쓴다
function personSvg(seed: string, hand: boolean, legs: boolean) {
  const k = hash(seed), sk = SKIN[k % 4], hr = HAIR[(k >> 3) % 5], sh = SHIRT[(k >> 6) % 6]
  let g = r(1, 7, 7, 6, sh) + r(2, 1, 5, 6, sk) + r(2, 0, 5, 2, hr) + r(1, 1, 1, 3, hr)
  if (hand) g += `<g class="arm">${r(8, 0, 2, 8, sh)}${r(8, -2, 2, 2, sk)}</g>`
  if (legs) g += r(2, 13, 2, 3, '#2b2f45') + r(5, 13, 2, 3, '#2b2f45')
  return g
}
const raised = (s: Session) => s.state === 'myturn' || s.state === 'approval'

// 머리 위 말풍선: 내 차례 !, 승인 필요 자물쇠, 쉼 z
function bubbleSvg(s: Session) {
  const st = s.state
  const b = st === 'myturn' ? [cssColor('myturn'), 'bang'] : st === 'approval' ? [cssColor('approval'), 'lock'] : st === 'idle' ? [cssColor('idle', 5), 'z'] : null
  return b ? `<g transform="translate(13 0)">${r(0, 0, 7, 6, b[0])}${r(2, 6, 1, 1, b[0])}${GLYPH[b[1]]}</g>` : ''
}

export function deskSvg(s: Session) {
  const st = s.state
  const scr = st === 'working' || st === 'compact' || st === 'myturn' || st === 'approval' ? cssColor(st) : 'var(--hq-screen-off)'
  let g = r(21, 9, 9, 7, 'var(--hq-chair)')
  if (st !== 'idle') g += `<g transform="translate(21 4)">${personSvg(s.sid, raised(s), false)}</g>`
  g += r(6, 4, 13, 10, 'var(--hq-mon)') + r(7, 5, 11, 8, scr)
  if (st === 'working') g += `<g class="code">${r(8, 6, 6, 1, 'var(--hq-bg)')}${r(8, 8, 8, 1, 'var(--hq-bg)')}${r(10, 10, 5, 1, 'var(--hq-bg)')}</g>`
  g += r(11, 14, 3, 2, 'var(--hq-mon)') + r(2, 16, 30, 3, 'var(--hq-desk)') + r(2, 19, 30, 1, 'var(--hq-desk-edge)') + r(4, 20, 2, 5, 'var(--hq-desk-edge)') + r(28, 20, 2, 5, 'var(--hq-desk-edge)')
  return `${bubbleSvg(s)}<g transform="translate(0 6)">${g}</g>`
}

// 미배치(로비) 세션: 책상 없이 서 있는 사람
export function standSvg(s: Session) {
  return `${bubbleSvg(s)}<g transform="translate(12 11)">${personSvg(s.sid, raised(s), true)}</g>`
}

export function Desk({ s, size = 52 }: { s: Session; size?: number }) {
  return <svg viewBox="0 0 34 32" width={size} height={size * 32 / 34} shapeRendering="crispEdges" aria-hidden="true"
    style={{ display: 'block', flex: 'none' }} dangerouslySetInnerHTML={{ __html: deskSvg(s) }} />
}
