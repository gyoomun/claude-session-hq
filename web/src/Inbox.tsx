// 메일(받은편지함): 화면 왼쪽 빈 여백에서 일정 카드 위. 높이는 일정 카드와 같고, 이은 계정들을 합쳐 최근 순으로 보인다(넘치면 스크롤).
// 안 읽은 메일은 굵게. 줄을 누르면 Gmail 웹에서 그 메일(스레드)을 연다. 이은 메일이 없으면 안 보인다(환경설정 '메일')
import { Group, Paper, Text, UnstyledButton } from '@mantine/core'
import type { Snapshot } from './types'

const when = (t: number) => {
  const d = new Date(t), now = new Date()
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false })
  return d.toLocaleDateString('ko-KR', d.getFullYear() === now.getFullYear() ? { month: 'numeric', day: 'numeric' } : { year: '2-digit', month: 'numeric', day: 'numeric' })
}

export function MailCard({ S }: { S: Snapshot }) {
  const b = S.inbox
  if (!b?.accounts.length) return null
  const many = b.accounts.length > 1
  return <Paper withBorder className="hq-mail">
    <Group justify="space-between" gap={6} wrap="nowrap" px={12} pt={10} pb={4}>
      <Text size="sm" fw={600}>메일</Text>
      {b.error && <Text size="xs" c="red.4" title={b.error}>일부 못 읽음</Text>}
    </Group>
    <div className="hq-mail-list">
      {b.mails.map(m => <UnstyledButton key={m.id} className="hq-cal-row" title={`${m.from}\n${m.subject}\nGmail에서 열기`} onClick={() => window.open(m.url, '_blank', 'noopener')}>
        <Group justify="space-between" gap={6} wrap="nowrap">
          <Text size="xs" truncate fw={m.unread ? 700 : 400} c={m.unread ? undefined : 'dimmed'}>{m.from}{many && <Text span inherit c="dimmed" fw={400}> · {m.account.split('@')[0]}</Text>}</Text>
          <Text size="xs" c="dimmed" style={{ flex: 'none' }}>{when(m.at)}</Text>
        </Group>
        <Text size="sm" truncate fw={m.unread ? 600 : 400} c={m.unread ? undefined : 'dimmed'}>{m.subject}</Text>
      </UnstyledButton>)}
      {!b.mails.length && <Text size="xs" c="dimmed">{b.at ? '메일 없음' : '읽는 중…'}</Text>}
    </div>
  </Paper>
}
