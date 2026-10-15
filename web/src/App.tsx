import { useEffect, useRef } from 'react'
import { Alert, Box, Button, Center, Group, Loader, Paper, SegmentedControl, SimpleGrid, Stack, Text, Title } from '@mantine/core'
import { serverNow, useNow, useOffline, useSnapshot } from './store'
import { type Mode, pickNew, rememberSel, setMode, setUI, useUI } from './ui'
import type { Snapshot } from './types'
import { stale } from './util'
import { WorkView } from './Work'
import { BoardView } from './Board'
import { SessionDrawer, TaskDrawer } from './Drawers'
import { AccessModal, AddTaskModal, BriefModal, NewSessionModal } from './Modals'

const Logo = () => <svg width="34" height="34" viewBox="0 0 8 8" shapeRendering="crispEdges" aria-hidden="true">
  <rect width="8" height="8" fill="var(--mantine-color-default)" /><rect x="1" y="1" width="2" height="2" fill="var(--mantine-color-teal-6)" />
  <rect x="5" y="1" width="2" height="2" fill="var(--mantine-color-yellow-6)" /><rect x="1" y="5" width="2" height="2" fill="var(--mantine-color-grape-5)" />
  <rect x="5" y="5" width="2" height="2" fill="var(--mantine-color-gray-6)" /><rect x="3" y="3" width="2" height="2" fill="var(--mantine-color-indigo-4)" /></svg>

function Clock() {
  useNow()
  return <Text ff="monospace" size="sm" c="dimmed">server time {new Date(serverNow()).toLocaleTimeString('en-GB', { hour12: false })}</Text>
}

function Header({ S }: { S: Snapshot }) {
  const un = S.sessions.filter(s => !s.task).length, waits = S.tasks.flatMap(t => t.waits).length
  const mine = S.sessions.filter(s => s.state === 'myturn' || s.state === 'approval').length
  useEffect(() => { document.title = (mine ? `(${mine}) ` : '') + 'Claude Session HQ' }, [mine])
  return <Group justify="space-between" wrap="wrap" gap="sm">
    <Group gap="sm" wrap="nowrap">
      <Logo />
      <div>
        <Title order={1} size={24} fw={400} className="hq-display">Claude Session HQ</Title>
        <Text size="xs" c="dimmed">업무 {S.tasks.length} · 열린 세션 {S.sessions.length} (미배치 {un}) · 사람 대기 {waits}</Text>
      </div>
    </Group>
    <Group gap="xs">
      <Clock />
      <Button variant="default" onClick={() => setUI({ access: true })}>접속</Button>
      <Button onClick={() => setUI({ brief: true })}>지금 상황 브리핑</Button>
    </Group>
  </Group>
}

function Counters({ S }: { S: Snapshot }) {
  const c = (st: string) => S.sessions.filter(s => s.state === st).length
  const items: [string, string, number, string, boolean][] = [
    ['열린 세션', 'SESSIONS', S.sessions.length, 'indigo', false],
    ['내 차례', 'MY TURN', c('myturn'), 'yellow', true],
    ['승인 필요', 'APPROVE', c('approval'), 'red', true],
    ['남 기다림', 'WAITING', S.tasks.flatMap(t => t.waits).length, 'grape', false],
    ['작업중', 'WORKING', c('working'), 'teal', false],
    ['쉼', 'IDLE', c('idle'), 'gray', false],
    ['정체 업무', 'STALLED', S.tasks.filter(t => stale(S, t)).length, 'pink', true],
  ]
  return <SimpleGrid cols={{ base: 2, xs: 4, md: 7 }} spacing="sm">
    {items.map(([k, e, v, col, hot]) => <Paper key={k} withBorder p="10px 14px"
      bg={hot && v ? `color-mix(in srgb, var(--mantine-color-${col}-6) 10%, var(--mantine-color-body))` : undefined} style={hot && v ? { borderColor: `var(--mantine-color-${col}-7)` } : undefined}>
      <Group justify="space-between" gap={4}><Text size="sm" c="dimmed">{k}</Text><span className="hq-pixel" style={{ fontSize: 9 }}>{e}</span></Group>
      <Text className="hq-display" fz={30} lh={1.1} c={`${col}.5`} style={{ fontVariantNumeric: 'tabular-nums' }}>{String(v).padStart(2, '0')}</Text>
    </Paper>)}
  </SimpleGrid>
}

export function App() {
  const S = useSnapshot()
  const offline = useOffline()
  const ui = useUI()
  // 화면 밖(웹 안의 Claude 등)에서 세션을 열면 그 세션으로 넘어간다. 이 화면을 연 뒤에 생긴 요청만
  const focusSeen = useRef(Date.now())
  useEffect(() => {
    if (S?.focus && S.focus.at > focusSeen.current) { focusSeen.current = S.focus.at; pickNew(S.focus.name) }
  }, [S?.focus?.at])
  // 방금 연 웹 세션이 목록에 나타나면 고른다
  useEffect(() => {
    const s = S && ui.pendingSel ? S.sessions.find(x => x.tmux === ui.pendingSel) : null
    if (s) { rememberSel(s.sid); setUI({ sel: s.sid, pendingSel: '' }) }
  }, [S, ui.pendingSel])

  if (!S) return <Center h="100vh"><Loader /></Center>
  return <Box px="md" py="md" maw={1600} mx="auto">
    <Stack gap="md">
      <Header S={S} />
      {offline && <Alert color="red" title="서버에 연결할 수 없습니다">서버(node server.js)가 실행 중인지 확인하세요. 다시 연결되면 자동으로 이어집니다.</Alert>}
      <Counters S={S} />
      <Group justify="space-between">
        <SegmentedControl value={ui.mode} onChange={v => setMode(v as Mode)}
          data={[{ label: '작업', value: 'work' }, { label: '업무별', value: 'task' }, { label: '세션 전체', value: 'all' }]} />
        <Group gap="xs">
          <Button variant="default" onClick={() => setUI({ addTask: true })}>+ 업무 추가</Button>
          <Button onClick={() => setUI({ newFor: '' })}>+ 새 세션</Button>
        </Group>
      </Group>
      {ui.mode === 'work' ? <WorkView S={S} /> : <BoardView S={S} mode={ui.mode} />}
    </Stack>
    <SessionDrawer S={S} />
    <TaskDrawer S={S} />
    <NewSessionModal S={S} />
    <AddTaskModal />
    <BriefModal S={S} />
    <AccessModal S={S} />
  </Box>
}
