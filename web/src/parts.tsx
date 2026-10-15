// 여러 화면에서 같이 쓰는 작은 조각들
import { useState } from 'react'
import { Badge, Button, Group, NativeSelect, Stack, Text, TextInput } from '@mantine/core'
import { api, toast } from './store'
import type { FeedItem, Session, Snapshot, Task, Wait } from './types'
import { COLOR, LABEL, Since, hhmm, overdue, tname } from './util'

export const StatePill = ({ state, children }: { state: string; children?: React.ReactNode }) =>
  <Badge color={COLOR[state]} variant="light" radius="xl" style={{ flex: 'none' }}>{children ?? LABEL[state]}</Badge>

export function AssignSelect({ S, s, size = 'xs' }: { S: Snapshot; s: Session; size?: 'xs' | 'sm' }) {
  return <NativeSelect size={size} value={s.task} aria-label={`${s.title} 업무 배치`}
    data={[{ value: '', label: '미배치' }, ...S.tasks.map(t => ({ value: t.id, label: t.name }))]}
    onChange={async e => {
      const task = e.currentTarget.value
      if (await api('assign', { sid: s.sid, task })) toast(task ? `"${tname(S, task)}"에 배치했습니다.` : '미배치로 돌렸습니다.')
    }} />
}

// 세션에 짧은 답 보내기. 쓰던 글은 그 세션 칸이 살아 있는 동안 남는다
export function ReplyForm({ s }: { s: Session }) {
  const [text, setText] = useState('')
  if (!s.host) return null
  return <form style={{ width: '100%' }} onSubmit={async e => {
    e.preventDefault()
    if (!text.trim()) return
    if (await api('term/send', { pid: s.pid, text })) { setText(''); toast('보냈습니다.') }
  }}>
    <Group gap={6} wrap="nowrap">
      <TextInput size="xs" style={{ flex: 1 }} placeholder="이 세션에 답 보내기" value={text} onChange={e => setText(e.currentTarget.value)} autoComplete="off" />
      <Button size="xs" type="submit">보내기</Button>
    </Group>
  </form>
}

const PersonIcon = () => <svg width="12" height="14" viewBox="0 0 6 7" shapeRendering="crispEdges" aria-hidden="true" style={{ flex: 'none', marginTop: 3 }}>
  <rect x="2" y="0" width="2" height="2" fill="var(--mantine-color-grape-5)" /><rect x="1" y="3" width="4" height="4" fill="var(--mantine-color-grape-5)" /></svg>

export function WaitRow({ t, w, withTask }: { t: Task; w: Wait; withTask?: boolean }) {
  return <Group gap={9} wrap="nowrap" align="flex-start" p="6px 10px" bg="var(--mantine-color-grape-light)" style={{ borderRadius: 8 }}>
    <PersonIcon />
    <Stack gap={0} style={{ minWidth: 0, flex: 1 }}>
      <Text size="sm"><b>{w.who}</b> · {w.what}{withTask && <Text span c="dimmed" size="xs"> ({t.name})</Text>}</Text>
      <Text size="xs" c="dimmed"><Since t={w.since} suf="째" /></Text>
    </Stack>
    {overdue(w) && <Badge color="red" variant="light">재촉 필요</Badge>}
    <Button size="xs" variant="default" onClick={() => api('wait/done', { task: t.id, id: w.id })}>답 받음</Button>
  </Group>
}

export function FeedList({ S, items, showTask = true, max = 380 }: { S: Snapshot; items: FeedItem[]; showTask?: boolean; max?: number }) {
  if (!items.length) return <Text size="sm" c="dimmed">서버가 켜진 뒤 바뀐 상태가 없습니다.</Text>
  return <Stack gap={0} mah={max} style={{ overflow: 'auto' }}>
    {items.map((e, i) => <Group key={i} gap={8} wrap="nowrap" py={5} style={{ borderBottom: '1px dashed var(--mantine-color-default-border)' }}>
      <Text ff="monospace" size="xs" c="dimmed" w={40} style={{ flex: 'none' }}>{hhmm(e.at)}</Text>
      <StatePill state={e.to} />
      <Text size="sm" className="hq-wrap" style={{ minWidth: 0 }}>{e.title}{showTask && e.task && <Text span c="dimmed" size="xs"> · {tname(S, e.task)}</Text>}</Text>
    </Group>)}
  </Stack>
}
