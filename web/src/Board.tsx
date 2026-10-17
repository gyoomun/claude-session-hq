// 업무별·세션 전체 보기 + 오른쪽 '내 차례' 큐와 이벤트
import { Box, Button, Group, Paper, Stack, Text, UnstyledButton } from '@mantine/core'
import { api } from './store'
import { pick } from './ui'
import type { Session, Snapshot } from './types'
import { COLOR, LABEL, Since, base, bySt, cssColor, tint, tname, waiting } from './util'
import { AssignSelect, FeedList, ReplyForm, StatePill, WaitRow } from './parts'
import { Desk } from './Desk'
import { Office } from './Office'

function DeskTile({ S, s, sel, showTask }: { S: Snapshot; s: Session; sel?: boolean; showTask?: boolean }) {
  return <Paper withBorder p="8px 10px" bg="var(--hq-floor)" style={{ borderColor: waiting(s) ? cssColor(s.state, 7) : undefined, minWidth: 0 }}>
    <UnstyledButton onClick={() => pick(s.sid)} w="100%" aria-label={`${s.title} 열기`}>
      <Group gap={10} wrap="nowrap" align="center">
        <Desk s={s} />
        <Stack gap={1} style={{ minWidth: 0 }}>
          <Text size="sm" fw={600} lh={1.35} className="hq-wrap">{s.title}</Text>
          <Text size="xs" c="dimmed"><Text span c={`${COLOR[s.state]}.5`} fw={600}>{LABEL[s.state]}</Text> <Since t={s.since} suf="째" /></Text>
          {s.act ? <Text size="xs" ff="monospace" c={`${COLOR.working}.5`} truncate title={s.act}>{s.act}</Text>
            : <Text size="xs" ff="monospace" c="dimmed" truncate title={s.cwd}>{base(s.cwd)}</Text>}
          {showTask && <Text size="xs" c={s.task ? 'indigo.4' : 'dimmed'} truncate>{tname(S, s.task)}</Text>}
        </Stack>
      </Group>
    </UnstyledButton>
    {sel && <Box mt={6}><AssignSelect S={S} s={s} /></Box>}
  </Paper>
}

// 책상 칸은 이름이 잘리지 않게 230px 이상으로, 들어가는 만큼 나란히
const deskGrid = { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(230px, 1fr))', gap: 8 } as const

function AllGroups({ S }: { S: Snapshot }) {
  if (!S.sessions.length) return <Paper withBorder p="md"><Text c="dimmed">열린 Claude 세션이 없습니다.</Text></Paper>
  return <Stack gap="md">{(['approval', 'myturn', 'working', 'compact', 'idle'] as const).map(k => {
    const ss = S.sessions.filter(s => s.state === k).sort(bySt)
    if (!ss.length) return null
    return <Paper key={k} withBorder p="12px 14px 14px">
      <Group gap={8} mb={8}><Box w={8} h={8} style={{ borderRadius: 2, background: cssColor(k) }} /><Text fw={600} size="sm">{LABEL[k]}</Text><Text size="xs" c="dimmed">{ss.length}</Text></Group>
      <Box style={deskGrid}>{ss.map(s => <DeskTile key={s.pid} S={S} s={s} sel showTask />)}</Box>
    </Paper>
  })}</Stack>
}

function Queue({ S }: { S: Snapshot }) {
  const items = S.sessions.filter(waiting).sort(bySt)
  const ws = S.tasks.flatMap(t => t.waits.map(w => ({ t, w }))).sort((a, b) => a.w.since - b.w.since)
  return <Paper withBorder p="md">
    <Stack gap="sm">
      <Group gap={8}><Text fw={600} size="sm">지금 내 차례</Text><Text size="xs" c="dimmed" ff="monospace">{items.length}건</Text></Group>
      {items.length ? items.map(s => <Paper key={s.pid} p="10px 12px" bg={tint(s.state, 8)} style={{ border: `1px solid ${cssColor(s.state, 8)}` }}>
        <Stack gap={5}>
          <Group gap={8} wrap="nowrap"><StatePill state={s.state} /><Text size="xs" c="dimmed" truncate style={{ minWidth: 0 }}>{tname(S, s.task)}</Text>
            <Text size="xs" c="dimmed" ml="auto" style={{ flex: 'none' }}><Since t={s.since} suf="째" /></Text></Group>
          <UnstyledButton onClick={() => pick(s.sid)}><Text fw={600} size="sm" className="hq-wrap">{s.title}</Text></UnstyledButton>
          {s.msg && <Text size="xs" className="hq-msg" style={{ WebkitLineClamp: 5 }}>{s.msg}</Text>}
          <ReplyForm s={s} />
          <Group gap={6}>
            <Button size="xs" variant="default" onClick={() => pick(s.sid)}>열기</Button>
            {s.state === 'myturn' && <Button size="xs" variant="subtle" color="gray" onClick={() => api('seen', { sid: s.sid })}>알겠어, 쉬어</Button>}
          </Group>
        </Stack>
      </Paper>) : <Text size="sm" c="dimmed">나를 기다리는 세션이 없습니다.</Text>}
      <Box h={1} bg="var(--mantine-color-default-border)" />
      <Group gap={8}><Text fw={600} size="sm">남 기다리는 중</Text><Text size="xs" c="dimmed" ff="monospace">{ws.length}건</Text></Group>
      {ws.length ? ws.map(({ t, w }) => <WaitRow key={w.id} t={t} w={w} withTask />) : <Text size="sm" c="dimmed">기다리는 사람이 없습니다. 업무를 열어 추가할 수 있습니다.</Text>}
    </Stack>
  </Paper>
}

export function BoardView({ S, mode }: { S: Snapshot; mode: 'task' | 'all' }) {
  // 왼쪽(사무실·세션 전체)과 오른쪽(내 차례·이벤트)이 각자 자기 영역 안에서 스크롤한다
  return <Box className="hq-board" style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 380px', gap: 16, height: '100%' }}>
    <Box className="hq-pane">
      {mode === 'task' ? <Office S={S} /> : <AllGroups S={S} />}
    </Box>
    <Stack gap="md" className="hq-pane">
      <Queue S={S} />
      <Paper withBorder p="md">
        <Group gap={8} mb="xs"><Text fw={600} size="sm">이벤트</Text><Text size="xs" c="dimmed">서버가 켜진 뒤 상태가 바뀐 순서</Text></Group>
        <FeedList S={S} items={S.feed} max={10000} />
      </Paper>
    </Stack>
  </Box>
}
