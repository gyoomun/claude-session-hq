// 회사 일정(구글 캘린더): 화면 왼쪽 빈 여백의 아래 카드(`.hq-aside`). 평소엔 오늘 것만 보이고, 오른쪽 화살표를 누르면 옆으로 펼쳐져 7일을 보인다
// (다른 화면을 덮어도 된다). Esc나 바깥을 누르면 닫힌다. 일정 줄을 누르면 구글 캘린더 웹의 그날 화면을 연다. 캘린더를 안 이었으면 안 보인다(환경설정 '일정')
import { useEffect, useState } from 'react'
import { Paper, Text, UnstyledButton } from '@mantine/core'
import { useClickOutside } from '@mantine/hooks'
import { IconChevronLeft, IconChevronRight } from '@tabler/icons-react'
import type { Snapshot } from './types'

const hm = (t: number) => new Date(t).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false })
const dayUrl = (t: number) => { const d = new Date(t); return `https://calendar.google.com/calendar/r/day/${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}` }

export function CalendarCard({ S }: { S: Snapshot }) {
  const [open, setOpen] = useState(false)
  const ref = useClickOutside(() => setOpen(false))
  useEffect(() => {
    if (!open) return
    // 대화 화면의 Esc(중단·되감기)보다 먼저 잡는다
    const on = (e: KeyboardEvent) => { if (e.key === 'Escape' && !e.isComposing) { e.preventDefault(); e.stopPropagation(); setOpen(false) } }
    addEventListener('keydown', on, true)
    return () => removeEventListener('keydown', on, true)
  }, [open])
  const c = S.calendar
  if (!c?.sources) return null
  const day = (n: number) => { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() + n); return +d }
  const days = Array.from({ length: open ? 7 : 1 }, (_, n) => ({ n, from: day(n), list: c.events.filter(e => e.start < day(n + 1) && e.end > day(n)) }))
  return <Paper ref={ref} withBorder className={'hq-cal' + (open ? ' open' : '')}>
    <div className="hq-cal-days">
      {days.map(d => <div key={d.n} className="hq-cal-day">
        <Text size="sm" fw={d.n ? 400 : 600} c={d.n ? 'dimmed' : undefined} mb={4}>
          {new Date(d.from).toLocaleDateString('ko-KR', { month: 'numeric', day: 'numeric', weekday: 'short' })}{d.n ? '' : ' · 오늘 일정'}
          {!d.n && c.error && <Text span size="xs" c="red.4" ml={6} title={c.error}>일부 못 읽음</Text>}
        </Text>
        {d.list.map(e => <UnstyledButton key={e.id} className="hq-cal-row" title="구글 캘린더에서 열기" onClick={() => window.open(dayUrl(d.from), '_blank', 'noopener')}>
          <Text size="xs" ff="monospace" c={e.allDay ? 'yellow.5' : 'indigo.4'}>{e.allDay ? '종일' : `${hm(e.start)}~${hm(e.end)}`}</Text>
          <Text size="sm" className="hq-wrap">{e.title}</Text>
        </UnstyledButton>)}
        {!d.list.length && <Text size="xs" c="dimmed">일정 없음</Text>}
      </div>)}
    </div>
    <UnstyledButton className="hq-cal-more" onClick={() => setOpen(o => !o)} aria-label={open ? '7일 일정 접기' : '7일 일정 펼치기'} title={open ? '접기 (Esc)' : '7일 펼치기'}>
      {open ? <IconChevronLeft size={16} /> : <IconChevronRight size={16} />}
    </UnstyledButton>
  </Paper>
}
