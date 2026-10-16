// 회사 일정(구글 캘린더): 화면 왼쪽 빈 여백의 아래 카드(`.hq-aside`). 평소엔 오늘 것만 보인다. 오른쪽 › 를 누르면 위·옆으로 펼쳐져 이번 달 달력을 보이고
// (다른 화면을 덮어도 된다), 펼친 채로 › 를 또 누르면 달 고르기가 나온다. Esc나 바깥을 누르면 닫혀 오늘만 보인다(달 고르기가 떠 있으면 Esc는 그것만 닫는다).
// 일정 줄·날짜 칸을 누르면 구글 캘린더 웹의 그 달 화면을 연다. 캘린더를 안 이었으면 안 보인다(환경설정 '일정')
import { useEffect, useState } from 'react'
import { Group, Paper, Text, UnstyledButton } from '@mantine/core'
import { useClickOutside } from '@mantine/hooks'
import { IconChevronLeft, IconChevronRight } from '@tabler/icons-react'
import { api } from './store'
import type { CalEvent, Snapshot } from './types'

const hm = (t: number) => new Date(t).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false })
const monthUrl = (t: number) => { const d = new Date(t); return `https://calendar.google.com/calendar/r/month/${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}` }
const openMonth = (t: number) => window.open(monthUrl(t), '_blank', 'noopener')
const midnight = (y: number, m: number, d: number) => +new Date(y, m, d)
const WEEK = ['일', '월', '화', '수', '목', '금', '토']

export function CalendarCard({ S }: { S: Snapshot }) {
  const [month, setMonth] = useState<{ y: number; m: number } | null>(null) // 펼친 달(없으면 오늘만)
  const [pick, setPick] = useState(false)
  const close = () => { setMonth(null); setPick(false) }
  const ref = useClickOutside(close)
  useEffect(() => {
    if (!month) return
    // 대화 화면의 Esc(중단·되감기)보다 먼저 잡는다
    const on = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.isComposing) return
      e.preventDefault(); e.stopPropagation()
      if (pick) setPick(false); else close()
    }
    addEventListener('keydown', on, true)
    return () => removeEventListener('keydown', on, true)
  }, [month, pick])
  const c = S.calendar
  if (!c?.sources) return null
  const now = new Date(), today = midnight(now.getFullYear(), now.getMonth(), now.getDate())
  const more = () => { if (!month) setMonth({ y: now.getFullYear(), m: now.getMonth() }); else setPick(p => !p) }
  const list = c.events.filter(e => e.start < today + 864e5 && e.end > today)
  // 칸(slot)이 자리를 지키고 카드는 그 안에서 아래 왼쪽에 붙어 커진다(펼쳐도 위의 메일 카드를 밀지 않고 덮는다)
  return <div className="hq-cal-slot"><Paper ref={ref} withBorder className={'hq-cal' + (month ? ' open' : '')}>
    {month ? <Month y={month.y} m={month.m} today={today} />
      : <div className="hq-cal-today">
        <Text size="sm" fw={600} mb={4}>
          {now.toLocaleDateString('ko-KR', { month: 'numeric', day: 'numeric', weekday: 'short' })} · 오늘 일정
          {c.error && <Text span size="xs" c="red.4" ml={6} title={c.error}>일부 못 읽음</Text>}
        </Text>
        {list.map(e => <UnstyledButton key={e.id} className="hq-cal-row" title="구글 캘린더에서 열기" onClick={() => openMonth(today)}>
          <Text size="xs" ff="monospace" c={e.allDay ? 'yellow.5' : 'indigo.4'}>{e.allDay ? '종일' : `${hm(e.start)}~${hm(e.end)}`}</Text>
          <Text size="sm" className="hq-wrap">{e.title}</Text>
        </UnstyledButton>)}
        {!list.length && <Text size="xs" c="dimmed">일정 없음</Text>}
      </div>}
    {month && pick && <MonthPicker cur={month} onPick={v => { setMonth(v); setPick(false) }} />}
    <UnstyledButton className={'hq-cal-more' + (pick ? ' on' : '')} onClick={more} aria-label={month ? '달 고르기' : '이번 달 펼치기'} title={month ? '달 고르기' : '이번 달 펼치기 (닫기는 Esc)'}>
      <IconChevronRight size={16} />
    </UnstyledButton>
  </Paper></div>
}

// 한 달 달력(일요일부터). 앞뒤 달의 날도 흐리게 채운다. 일정은 고를 때마다 서버에서 그 범위만 받는다
function Month({ y, m, today }: { y: number; m: number; today: number }) {
  const first = new Date(y, m, 1), start = midnight(y, m, 1 - first.getDay())
  const weeks = Math.ceil((first.getDay() + new Date(y, m + 1, 0).getDate()) / 7)
  const days = Array.from({ length: weeks * 7 }, (_, i) => +new Date(y, m, 1 - first.getDay() + i))
  const end = midnight(y, m, 1 - first.getDay() + weeks * 7)
  const [events, setEvents] = useState<CalEvent[] | null>(null)
  useEffect(() => {
    let live = true
    setEvents(null)
    api<CalEvent[]>('calendar/range', { from: start, to: end }).then(r => { if (live) setEvents(r?.result || []) })
    return () => { live = false }
  }, [start, end])
  return <div className="hq-cal-month">
    <Text size="sm" fw={600} mb={6}>{y}년 {m + 1}월</Text>
    <div className="hq-cal-grid" style={{ gridTemplateRows: `auto repeat(${weeks}, minmax(0, 1fr))` }}>
      {WEEK.map((w, i) => <Text key={w} size="xs" c={i === 0 ? 'red.4' : i === 6 ? 'blue.4' : 'dimmed'} ta="center">{w}</Text>)}
      {days.map(t => {
        const d = new Date(t), out = d.getMonth() !== m
        const list = (events || []).filter(e => e.start < t + 864e5 && e.end > t)
        return <UnstyledButton key={t} className={'hq-cal-cell' + (t === today ? ' today' : '') + (out ? ' out' : '')} title={list.map(e => (e.allDay ? '' : hm(e.start) + ' ') + e.title).join('\n') || undefined} onClick={() => openMonth(t)}>
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
