// 플로우 안 읽음: 서브 칸(`MainSplit`)에서 메일 카드 오른쪽. 위는 안 읽은 채팅방(마지막 메시지·안읽음 수), 아래는 안 읽은 알림(글·댓글·멘션).
// 서버가 30초마다 ~/.claude/flow.py inbox-json 으로 읽는다(읽음 처리하지 않는다). 줄을 누르면 이 맥에서 플로우 앱을 띄운다(플로우 링크는 웹에서 열리지 않는다)
import { Badge, Group, Paper, Text, UnstyledButton } from '@mantine/core'
import { api } from './store'
import type { Snapshot } from './types'

const when = (t: number) => {
  const d = new Date(t), now = new Date()
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false })
  return d.toLocaleDateString('ko-KR', { month: 'numeric', day: 'numeric' })
}
const open = () => api('flow/open')

export function FlowCard({ S }: { S: Snapshot }) {
  const b = S.flow
  if (!b) return <div className="hq-mail" />
  const empty = !b.chats.length && !b.alarms.length
  return <Paper withBorder className="hq-mail">
    <Group justify="space-between" gap={6} wrap="nowrap" px={12} pt={10} pb={4}>
      <Text size="sm" fw={600}>플로우</Text>
      <Group gap={8} wrap="nowrap">
        {b.error && <Text size="xs" c="red.4" title={b.error}>못 읽음</Text>}
        {b.at > 0 && <Text size="xs" c="dimmed" title="마지막으로 읽은 시각(30초마다 다시 읽는다)">{new Date(b.at).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false })} 불러옴</Text>}
      </Group>
    </Group>
    <div className="hq-mail-list">
      {b.chats.map(c => <UnstyledButton key={'c' + c.room} className="hq-cal-row" title={`${c.name}\n${c.from}: ${c.text}\n플로우 앱 열기`} onClick={open}>
        <Group gap={8} wrap="nowrap">
          <Text size="xs" c="dimmed" ff="monospace" style={{ flex: 'none' }}>{when(c.at)}</Text>
          <Text size="sm" truncate fw={600} style={{ flex: 1 }}><Text span inherit fw={700} c="teal.4">{c.name}</Text><Text span inherit c="dimmed"> │ </Text>{c.from !== c.name && <Text span inherit c="dimmed">{c.from}: </Text>}{c.text}</Text>
          {c.mention && <Badge size="xs" color="orange" variant="light" style={{ flex: 'none' }}>멘션</Badge>}
          <Badge size="xs" color="red" style={{ flex: 'none' }}>{c.unread}</Badge>
        </Group>
      </UnstyledButton>)}
      {b.alarms.map(a => <UnstyledButton key={'a' + a.id} className="hq-cal-row" title={`${a.message}\n${a.text}\n플로우 앱 열기`} onClick={open}>
        <Group gap={8} wrap="nowrap">
          <Text size="xs" c="dimmed" ff="monospace" style={{ flex: 'none' }}>{when(a.at)}</Text>
          <Text size="sm" truncate style={{ flex: 1 }}><Text span inherit fw={700} c="indigo.4">알림</Text><Text span inherit c="dimmed"> │ </Text>{a.message}<Text span inherit c="dimmed"> {a.text}</Text></Text>
          {a.mention && <Badge size="xs" color="orange" variant="light" style={{ flex: 'none' }}>멘션</Badge>}
        </Group>
      </UnstyledButton>)}
      {empty && <Text size="xs" c="dimmed">{b.at ? '안 읽은 것 없음' : '읽는 중…'}</Text>}
    </div>
  </Paper>
}
