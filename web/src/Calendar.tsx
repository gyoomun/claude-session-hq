// 회사 일정(구글 캘린더): 서브 칸(`MainSplit`)의 첫 카드. 평소엔 오늘 것만 보인다.
// - 오른쪽 › : 옆으로 펼쳐져 이번 달(오늘이 속한 달)을 하루 한 칸으로 보인다. 처음엔 오늘 칸이 맨 앞(보기만. 다른 달은 못 본다)
// - 오른쪽 아래 돋보기: 한 달 달력. 연월 양옆 ‹ › 로 앞뒤 달, 연월을 누르면 달 고르기
// 펼치면 위·옆으로 커져 다른 화면을 덮는다. Esc나 바깥을 누르면 닫혀 오늘만 보인다(달 고르기가 떠 있으면 Esc는 그것만 닫는다).
// 일정 줄·날짜 칸을 누르면 구글 캘린더 웹의 그 달 화면을 연다. 캘린더를 안 이었으면 안 보인다(환경설정 '일정')
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Group, Paper, Text, UnstyledButton } from '@mantine/core'
import { useClickOutside } from '@mantine/hooks'
import { IconChevronLeft, IconChevronRight, IconSearch } from '@tabler/icons-react'
import { api } from './store'
import type { CalEvent, Snapshot } from './types'

const hm = (t: number) => new Date(t).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false })
const monthUrl = (t: number) => { const d = new Date(t); return `https://calendar.google.com/calendar/r/month/${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}` }
const openMonth = (t: number) => window.open(monthUrl(t), '_blank', 'noopener')
const midnight = (y: number, m: number, d: number) => +new Date(y, m, d)
const dayLabel = (t: number) => new Date(t).toLocaleDateString('ko-KR', { month: 'numeric', day: 'numeric', weekday: 'short' })
const WEEK = ['일', '월', '화', '수', '목', '금', '토']
const DAY = 864e5

// 그 범위의 일정을 서버에서 받는다(받아 둔 캘린더를 펼치기만 해서 가볍다)
function useRange(from: number, to: number) {
  const [events, setEvents] = useState<CalEvent[] | null>(null)
  useEffect(() => {
    let live = true
    setEvents(null)
    api<CalEvent[]>('calendar/range', { from, to }).then(r => { if (live) setEvents(r?.result || []) })
    return () => { live = false }
  }, [from, to])
  return events
}
const on = (list: CalEvent[] | null, t: number) => (list || []).filter(e => e.start < t + DAY && e.end > t)

function Row({ e, t }: { e: CalEvent; t: number }) {
  return <UnstyledButton className="hq-cal-row" title="구글 캘린더에서 열기" onClick={() => openMonth(t)}>
    <Text size="xs" ff="monospace" c={e.allDay ? 'yellow.5' : 'indigo.4'}>{e.allDay ? '종일' : `${hm(e.start)}~${hm(e.end)}`}</Text>
    <Text size="sm" className="hq-wrap">{e.title}</Text>
  </UnstyledButton>
}

export function CalendarCard({ S }: { S: Snapshot }) {
  const [mode, setMode] = useState<'' | 'strip' | 'month'>('')
  const [pick, setPick] = useState(false)
  const close = () => { setMode(''); setPick(false) }
  const ref = useClickOutside(close)
  useEffect(() => {
    if (!mode) return
    // 대화 화면의 Esc(중단·되감기)보다 먼저 잡는다
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.isComposing) return
      e.preventDefault(); e.stopPropagation()
      if (pick) setPick(false); else close()
    }
    addEventListener('keydown', key, true)
    return () => removeEventListener('keydown', key, true)
  }, [mode, pick])
  const c = S.calendar
  if (!c?.sources) return <div className="hq-cal-slot" />
  const now = new Date(), today = midnight(now.getFullYear(), now.getMonth(), now.getDate())
  const toggle = (m: 'strip' | 'month') => { setPick(false); setMode(x => x === m ? '' : m) }
  return <div className="hq-cal-slot"><Paper ref={ref} withBorder className={'hq-cal' + (mode ? ' open ' + mode : '')}>
    {mode === 'month' ? <Month today={today} pick={pick} setPick={setPick} />
      : mode === 'strip' ? <Strip today={today} />
      : <div className="hq-cal-today">
        <Text size="sm" fw={600} mb={4}>
          {dayLabel(today)} · 오늘 일정
          {c.error && <Text span size="xs" c="red.4" ml={6} title={c.error}>일부 못 읽음</Text>}
        </Text>
        {on(c.events, today).map(e => <Row key={e.id} e={e} t={today} />)}
        {!on(c.events, today).length && <Text size="xs" c="dimmed">일정 없음</Text>}
      </div>}
    <UnstyledButton className={'hq-cal-zoom' + (mode === 'month' ? ' on' : '')} onClick={() => toggle('month')} aria-label="한 달 달력" title="한 달 달력 (닫기는 Esc)">
      <IconSearch size={15} />
    </UnstyledButton>
    <UnstyledButton className={'hq-cal-more' + (mode === 'strip' ? ' on' : '')} onClick={() => toggle('strip')} aria-label="한 달 펼쳐 보기" title="오늘부터 한 달 펼쳐 보기 (닫기는 Esc)">
      <IconChevronRight size={16} />
    </UnstyledButton>
  </Paper></div>
}

// 옆으로 펼친 이번 달: 1일부터 말일까지 하루 한 칸(가로 스크롤). 처음엔 오늘 칸이 맨 앞에 오게 둔다. 더 보려면 돋보기
function Strip({ today }: { today: number }) {
  const d = new Date(today), y = d.getFullYear(), m = d.getMonth()
  const days = Array.from({ length: new Date(y, m + 1, 0).getDate() }, (_, i) => midnight(y, m, i + 1))
  const events = useRange(days[0], days[days.length - 1] + DAY)
  const box = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => { const el = box.current?.querySelector<HTMLElement>('.today'); if (el && box.current) box.current.scrollLeft = el.offsetLeft }, [])
  return <div className="hq-cal-strip" ref={box}>
    {days.map(t => <div key={t} className={'hq-cal-day' + (t === today ? ' today' : '')}>
      <Text size="sm" fw={t === today ? 600 : 400} c={t === today ? undefined : 'dimmed'} mb={4}>{dayLabel(t)}{t === today ? ' · 오늘' : ''}</Text>
      {on(events, t).map(e => <Row key={e.id} e={e} t={t} />)}
      {events && !on(events, t).length && <Text size="xs" c="dimmed">일정 없음</Text>}
    </div>)}
  </div>
}

// 한 달 달력(일요일부터). 앞뒤 달의 날도 흐리게 채운다
function Month({ today, pick, setPick }: { today: number; pick: boolean; setPick: (v: boolean | ((p: boolean) => boolean)) => void }) {
  const [ym, setYm] = useState(() => { const d = new Date(today); return { y: d.getFullYear(), m: d.getMonth() } })
  const { y, m } = ym
  const first = new Date(y, m, 1)
  const weeks = Math.ceil((first.getDay() + new Date(y, m + 1, 0).getDate()) / 7)
  const days = Array.from({ length: weeks * 7 }, (_, i) => midnight(y, m, 1 - first.getDay() + i))
  const events = useRange(days[0], days[days.length - 1] + DAY)
  const go = (n: number) => { const d = new Date(y, m + n, 1); setYm({ y: d.getFullYear(), m: d.getMonth() }) }
  return <div className="hq-cal-month">
    <Group gap={4} mb={6} wrap="nowrap">
      <UnstyledButton className="hq-cal-yr" onClick={() => go(-1)} aria-label="앞 달"><IconChevronLeft size={16} /></UnstyledButton>
      <UnstyledButton className={'hq-cal-title' + (pick ? ' on' : '')} onClick={() => setPick(p => !p)} title="달 고르기">{y}년 {m + 1}월</UnstyledButton>
      <UnstyledButton className="hq-cal-yr" onClick={() => go(1)} aria-label="다음 달"><IconChevronRight size={16} /></UnstyledButton>
    </Group>
    {pick && <MonthPicker cur={ym} onPick={v => { setYm(v); setPick(false) }} />}
    <div className="hq-cal-grid" style={{ gridTemplateRows: `auto repeat(${weeks}, minmax(0, 1fr))` }}>
      {WEEK.map((w, i) => <Text key={w} size="xs" c={i === 0 ? 'red.4' : i === 6 ? 'blue.4' : 'dimmed'} ta="center">{w}</Text>)}
      {days.map(t => {
        const d = new Date(t), list = on(events, t)
        return <UnstyledButton key={t} className={'hq-cal-cell' + (t === today ? ' today' : '') + (d.getMonth() !== m ? ' out' : '')} title={list.map(e => (e.allDay ? '' : hm(e.start) + ' ') + e.title).join('\n') || undefined} onClick={() => openMonth(t)}>
          <Text size="xs" fw={t === today ? 700 : 500} c={t === today ? 'indigo.3' : d.getDay() === 0 ? 'red.4' : d.getDay() === 6 ? 'blue.4' : undefined}>{d.getDate()}</Text>
          {list.map(e => <Text key={e.id} size="xs" truncate className={'hq-cal-ev' + (e.allDay ? ' all' : '')}>{e.allDay ? '' : hm(e.start) + ' '}{e.title}</Text>)}
        </UnstyledButton>
      })}
    </div>
  </div>
}

// 달 고르기: 해를 ‹ › 로 넘기고 달을 누른다
function MonthPicker({ cur, onPick }: { cur: { y: number; m: number }; onPick: (v: { y: number; m: number }) => void }) {
  const [y, setY] = useState(cur.y)
  const now = new Date()
  return <Paper withBorder shadow="md" p="sm" className="hq-cal-pick">
    <Group justify="space-between" mb={8} wrap="nowrap">
      <UnstyledButton className="hq-cal-yr" onClick={() => setY(y - 1)} aria-label="앞 해"><IconChevronLeft size={16} /></UnstyledButton>
      <Text size="sm" fw={600}>{y}년</Text>
      <UnstyledButton className="hq-cal-yr" onClick={() => setY(y + 1)} aria-label="다음 해"><IconChevronRight size={16} /></UnstyledButton>
    </Group>
    <div className="hq-cal-months">
      {Array.from({ length: 12 }, (_, m) => <UnstyledButton key={m} onClick={() => onPick({ y, m })}
        className={'hq-cal-mon' + (y === cur.y && m === cur.m ? ' on' : '') + (y === now.getFullYear() && m === now.getMonth() ? ' now' : '')}>{m + 1}월</UnstyledButton>)}
    </div>
  </Paper>
}
