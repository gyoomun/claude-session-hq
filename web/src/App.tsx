import { useEffect, useRef, useState } from 'react'
import { Alert, Box, Button, Center, Code, CopyButton, Group, Kbd, Loader, Paper, SegmentedControl, SimpleGrid, Stack, Text, Title } from '@mantine/core'
import { notifications } from '@mantine/notifications'
import { api, serverNow, toast, useNow, useOffline, useSnapshot } from './store'
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

// 사내망에서 들어올 주소. 맥의 네트워크(와이파이·유선)가 바뀌면 서버가 다음 갱신(2초) 때 새 주소를 주고, 바뀌었다고 알린다
function LanAddress({ S }: { S: Snapshot }) {
  const a = S.access, primary = a.addresses[0] || ''
  const prev = useRef(primary)
  useEffect(() => {
    if (a.lan && prev.current && primary && prev.current !== primary)
      notifications.show({ title: '맥의 주소가 바뀌었습니다', message: `사내망에서는 이제 ${primary} 로 들어옵니다`, color: 'orange', autoClose: 15000 })
    prev.current = primary
  }, [primary, a.lan])
  if (!a.lan) return <Button size="xs" variant="subtle" color="gray" onClick={() => setUI({ access: true })}>사내망 접속 꺼짐</Button>
  return <Group gap={6} wrap="nowrap">
    <Text size="xs" c="dimmed">사내망 주소</Text>
    <Code fz="sm">{primary || '네트워크 없음'}</Code>
    {primary && <CopyButton value={primary}>{({ copied, copy }) => <Button size="compact-xs" variant="subtle" onClick={copy}>{copied ? '복사됨' : '복사'}</Button>}</CopyButton>}
  </Group>
}

// 세션이 어디에 기대고 있는지 드러낸다: Orca에서 도는 세션은 Orca를 끄면 같이 꺼지고, 방금 한꺼번에 닫힌 세션은 웹에서 다시 연다
function Notices({ S }: { S: Snapshot }) {
  const orca = S.sessions.filter(s => s.host === 'orca')
  const movable = orca.filter(s => s.state !== 'working' && s.state !== 'approval').length
  const recent = S.closed.filter(c => Date.now() - c.closedAt < 30 * 60e3)
  const [busy, setBusy] = useState(false)
  // 화면을 연 뒤에 새 빌드가 나왔으면 새로고침하라고 알린다(데이터는 2초마다 오지만 화면 코드는 새로고침해야 바뀐다)
  const build = useRef(S.build)
  const stale = S.build && build.current && S.build !== build.current
  return <>
    {stale && <Alert color="indigo" variant="light" p="xs">
      <Group justify="space-between" gap="sm"><Text size="sm">새 버전이 나왔습니다. 새로고침하면 바뀐 화면이 보입니다.</Text>
        <Button size="xs" onClick={() => location.reload()}>새로고침</Button></Group>
    </Alert>}
    {orca.length > 0 && <Alert color="yellow" variant="light" p="xs">
      <Group justify="space-between" gap="sm">
        <Text size="sm">Orca 안에서 도는 세션이 {orca.length}개 있습니다. <b>Orca를 끄면 이 세션들도 같이 꺼집니다.</b> 웹으로 옮기면 Orca와 상관없이 계속 돕니다.{S.migrating && ' 옮기는 중…'}</Text>
        <Button size="xs" color="yellow" variant="filled" loading={S.migrating} disabled={!movable} title={!movable ? '일하는 중인 세션은 끝난 뒤에 옮깁니다' : undefined}
          onClick={async () => { const r = await api<number>('session/migrate-all'); if (r) toast(`${r.result}개를 차례로 옮깁니다. 일하는 중인 세션은 끝난 뒤에 다시 누르세요.`) }}>
          {movable < orca.length ? `옮길 수 있는 ${movable}개 웹으로 옮기기` : '모두 웹으로 옮기기'}</Button>
      </Group>
    </Alert>}
    {recent.length >= 2 && <Alert color="red" variant="light" p="xs">
      <Group justify="space-between" gap="sm">
        <Text size="sm">최근 30분 안에 세션 {recent.length}개가 닫혔습니다(Orca 종료 등). 대화는 남아 있어서 웹에서 같은 옵션으로 다시 열 수 있습니다.</Text>
        <Group gap={6}>
          <Button size="xs" color="red" loading={busy} onClick={async () => {
            setBusy(true); const r = await api<string[]>('session/reopen', { sids: recent.map(c => c.sid) }); setBusy(false)
            if (r) toast(`${r.result.length}개를 웹에서 다시 열었습니다.`)
          }}>모두 웹에서 다시 열기</Button>
          <Button size="xs" variant="subtle" color="gray" onClick={() => recent.forEach(c => api('session/forget-closed', { sid: c.sid }))}>무시</Button>
        </Group>
      </Group>
    </Alert>}
  </>
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
      <LanAddress S={S} />
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

  // F1·F2·F3으로 보기 전환. 터미널에 글을 쓰는 중에도 먹도록 가장 먼저(capture) 가로채고, 브라우저 기본 동작(도움말·찾기)은 막는다
  useEffect(() => {
    const keys: Record<string, Mode> = { F1: 'work', F2: 'task', F3: 'all' }
    const onKey = (e: KeyboardEvent) => {
      const m = keys[e.key]
      if (!m || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return
      e.preventDefault(); e.stopPropagation()
      setMode(m)
    }
    addEventListener('keydown', onKey, true)
    return () => removeEventListener('keydown', onKey, true)
  }, [])

  if (!S) return <Center h="100vh"><Loader /></Center>
  // 페이지 자체는 스크롤하지 않는다. 위쪽(머리·카운터·보기 전환)은 고정, 아래 내용 영역만 화면 높이를 채우고 그 안에서 스크롤한다
  return <Box px="md" py="md" maw={1600} mx="auto" h="100dvh" style={{ display: 'flex', flexDirection: 'column' }}>
    <Stack gap="md" style={{ flex: 1, minHeight: 0 }}>
      <Header S={S} />
      {offline && <Alert color="red" title="서버에 연결할 수 없습니다">서버(node server.js)가 실행 중인지 확인하세요. 다시 연결되면 자동으로 이어집니다.</Alert>}
      <Notices S={S} />
      <Counters S={S} />
      <Group justify="space-between">
        <SegmentedControl value={ui.mode} onChange={v => setMode(v as Mode)}
          data={[['작업', 'work', 'F1'], ['업무별', 'task', 'F2'], ['세션 전체', 'all', 'F3']].map(([label, value, key]) => ({
            value, label: <Group gap={6} wrap="nowrap">{label}<Kbd size="xs">{key}</Kbd></Group>,
          }))} />
        <Group gap="xs">
          <Button variant="default" onClick={() => setUI({ addTask: true })}>+ 업무 추가</Button>
          <Button onClick={() => setUI({ newFor: '' })}>+ 새 세션</Button>
        </Group>
      </Group>
      <Box style={{ flex: 1, minHeight: 0 }}>
        {ui.mode === 'work' ? <WorkView S={S} /> : <BoardView S={S} mode={ui.mode} />}
      </Box>
    </Stack>
    <SessionDrawer S={S} />
    <TaskDrawer S={S} />
    <NewSessionModal S={S} />
    <AddTaskModal />
    <BriefModal S={S} />
    <AccessModal S={S} />
  </Box>
}
