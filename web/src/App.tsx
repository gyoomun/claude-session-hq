import { useEffect, useRef, useState } from 'react'
import { Alert, Badge, Box, Button, Center, Code, Group, Kbd, Loader, Paper, Popover, ScrollArea, SegmentedControl, SimpleGrid, Stack, Text, Title, UnstyledButton } from '@mantine/core'
import { notifications } from '@mantine/notifications'
import { api, serverNow, toast, useNow, useOffline, useSnapshot } from './store'
import { type Mode, pickNew, rememberSel, setMode, setUI, useUI } from './ui'
import type { CalEvent, Snapshot } from './types'
import { stale } from './util'
import { WorkView } from './Work'
import { copyText, useFlash } from './Chat'
import { isRecording, useAreaKeys } from './Keys'
import { BoardView } from './Board'
import { MemoView } from './Memo'
import { SessionDrawer, TaskDrawer } from './Drawers'
import { AddTaskModal, BriefModal, NewSessionModal } from './Modals'
import { SettingsWindow } from './Settings'
import { IconSettings } from '@tabler/icons-react'

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
  const [copied, flash] = useFlash()
  const a = S.access, primary = a.addresses[0] || ''
  const prev = useRef(primary)
  useEffect(() => {
    if (a.lan && prev.current && primary && prev.current !== primary)
      notifications.show({ title: '맥의 주소가 바뀌었습니다', message: `사내망에서는 이제 ${primary} 로 들어옵니다`, color: 'orange', autoClose: 15000 })
    prev.current = primary
  }, [primary, a.lan])
  if (!a.lan) return <Button size="xs" variant="subtle" color="gray" onClick={() => setUI({ settings: true, settingsPage: 'access' })}>사내망 접속 꺼짐</Button>
  return <Group gap={6} wrap="nowrap">
    <Text size="xs" c="dimmed">사내망 주소</Text>
    {/* 주소를 누르면 복사한다 */}
    <Code fz="sm" className={primary ? 'hq-copyable' : undefined} title={primary ? '누르면 복사' : undefined}
      onClick={async () => { if (primary && await copyText(primary)) flash() }}>{primary || '네트워크 없음'}</Code>
    {copied && <Text size="xs" c="teal.4">✓ 복사됨</Text>}
  </Group>
}

// 세션이 어디에 기대고 있는지 드러낸다: Orca에서 도는 세션은 Orca를 끄면 같이 꺼지고, 방금 한꺼번에 닫힌 세션은 웹에서 다시 연다
function Notices({ S }: { S: Snapshot }) {
  const orca = S.sessions.filter(s => s.host === 'orca')
  const movable = orca.filter(s => s.state !== 'working' && s.state !== 'compact' && s.state !== 'approval').length
  const recent = S.closed.filter(c => Date.now() - c.closedAt < 30 * 60e3)
  const [busy, setBusy] = useState(false)
  // 화면을 연 뒤에 새 빌드가 나왔으면 새로고침하라고 알린다(데이터는 2초마다 오지만 화면 코드는 새로고침해야 바뀐다)
  const build = useRef(S.build)
  const stale = !!(S.build && build.current && S.build !== build.current)
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

// 오늘 회사 일정(구글 캘린더): 머리에 한 줄. 누르면 이번 7일을 날짜별로 본다. 캘린더를 안 이었으면 안 보인다(환경설정 '일정')
const hm = (t: number) => new Date(t).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false })
const evText = (e: CalEvent) => e.allDay ? e.title : `${hm(e.start)} ${e.title}`
function Today({ S }: { S: Snapshot }) {
  const c = S.calendar
  if (!c || !c.sources) return null
  const day = (n: number) => { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() + n); return +d }
  const today = c.events.filter(e => e.start < day(1) && e.end > day(0))
  const days = Array.from({ length: 7 }, (_, n) => ({ n, from: day(n), list: c.events.filter(e => e.start < day(n + 1) && e.end > day(n)) }))
  return <Popover width={440} position="bottom" shadow="md" withArrow>
    <Popover.Target>
      <UnstyledButton className="hq-today" title="이번 7일 일정 보기">
        <Group gap={6} wrap="nowrap">
          <Text size="xs" c="dimmed" style={{ flex: 'none' }}>오늘</Text>
          {c.error && <Text size="xs" c="red.4" style={{ flex: 'none' }} title={c.error}>일정을 다 읽지 못함</Text>}
          {today.length ? today.slice(0, 4).map(e => <Badge key={e.id} variant="light" color={e.allDay ? 'yellow' : 'indigo'} radius="sm" tt="none" fw={500} maw={220}>{evText(e)}</Badge>)
            : <Text size="xs" c="dimmed">일정 없음</Text>}
          {today.length > 4 && <Text size="xs" c="dimmed">+{today.length - 4}</Text>}
        </Group>
      </UnstyledButton>
    </Popover.Target>
    <Popover.Dropdown>
      <ScrollArea.Autosize mah="60vh">
        <Stack gap="sm">
          {days.map(d => <Stack key={d.n} gap={4}>
            <Text size="xs" fw={600} c={d.n ? 'dimmed' : undefined}>{new Date(d.from).toLocaleDateString('ko-KR', { month: 'numeric', day: 'numeric', weekday: 'short' })}{d.n === 0 ? ' · 오늘' : ''}</Text>
            {d.list.length ? d.list.map(e => <Group key={e.id} gap={8} wrap="nowrap" pl={6}>
              <Text size="xs" ff="monospace" c="dimmed" w={42} style={{ flex: 'none' }}>{e.allDay ? '종일' : hm(e.start)}</Text>
              <Text size="sm" style={{ flex: 1, minWidth: 0 }} className="hq-wrap">{e.title}</Text>
              {e.cal && <Text size="xs" c="dimmed" style={{ flex: 'none' }}>{e.cal}</Text>}
            </Group>) : <Text size="xs" c="dimmed" pl={6}>없음</Text>}
          </Stack>)}
        </Stack>
      </ScrollArea.Autosize>
    </Popover.Dropdown>
  </Popover>
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
    <Today S={S} />
    <Group gap="xs">
      <LanAddress S={S} />
      <Clock />
      <Button variant="default" leftSection={<IconSettings size={16} />} onClick={() => setUI({ settings: true })}>환경설정</Button>
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
  // 서버 알림(모두 재시작이 끝났을 때 등): 이 화면을 연 뒤에 생긴 것만 한 번 띄운다
  const noticeSeen = useRef(Date.now())
  useEffect(() => {
    if (S?.notice && S.notice.at > noticeSeen.current) { noticeSeen.current = S.notice.at; toast(S.notice.text, S.notice.color) }
  }, [S?.notice?.at])
  // 방금 연 웹 세션이 목록에 나타나면 고른다
  useEffect(() => {
    const s = S && ui.pendingSel ? S.sessions.find(x => x.tmux === ui.pendingSel) : null
    if (s) { rememberSel(s.sid); setUI({ sel: s.sid, pendingSel: '' }) }
  }, [S, ui.pendingSel])

  useAreaKeys() // 영역 단축키(⌥1~⌥6 등, 영역 이름 옆에서 녹화)
  // F1~F4로 보기 전환. 터미널에 글을 쓰는 중에도 먹도록 가장 먼저(capture) 가로채고, 브라우저 기본 동작(도움말·찾기)은 막는다
  useEffect(() => {
    const keys: Record<string, Mode> = { F1: 'work', F2: 'task', F3: 'all', F4: 'memo' }
    const onKey = (e: KeyboardEvent) => {
      if (isRecording()) return // 단축키를 녹화하는 중
      // Cmd+T(윈도우는 Ctrl+T): 새 세션. 브라우저·터미널에서 새 탭 열던 손버릇 그대로. 크롬 일반 탭에서는 크롬이 먼저 가져가고, 앱 창에서는 여기로 온다
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 't') { e.preventDefault(); e.stopPropagation(); setUI({ newFor: '' }); return }
      const m = keys[e.key]
      if (!m || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return
      e.preventDefault(); e.stopPropagation()
      setMode(m)
    }
    addEventListener('keydown', onKey, true)
    return () => removeEventListener('keydown', onKey, true)
  }, [])

  if (!S) return <Center h="100vh"><Loader /></Center>
  // 화면 전체를 한 덩어리로 가운데에 놓는다(좌우 여백이 같다). 폭은 모든 보기에서 같다(작업 보기의 세 칸 기준. 보기마다 다르면 넘길 때 화면이 움찔한다).
  // 격자 2행: 위(머리·카운터·보기 전환) / 아래(내용). 페이지 자체는 스크롤하지 않고 아래 내용 영역이 화면 높이를 채운다
  return <Box h="100dvh" py="md" px="md" maw={2032} mx="auto"
    style={{ display: 'grid', gridTemplateRows: 'auto minmax(0, 1fr)', rowGap: 'var(--mantine-spacing-md)' }}>
    <Stack gap="md" style={{ minWidth: 0 }}>
      <Header S={S} />
      {offline && <Alert color="red" title="서버에 연결할 수 없습니다">서버(node server.js)가 실행 중인지 확인하세요. 다시 연결되면 자동으로 이어집니다.</Alert>}
      <Notices S={S} />
      <Counters S={S} />
      <Group justify="space-between">
        <SegmentedControl value={ui.mode} onChange={v => setMode(v as Mode)}
          data={[['작업', 'work', 'F1'], ['업무별', 'task', 'F2'], ['세션 전체', 'all', 'F3'], ['메모', 'memo', 'F4']].map(([label, value, key]) => ({
            value, label: <Group gap={6} wrap="nowrap">{label}<Kbd size="xs">{key}</Kbd></Group>,
          }))} />
        <Group gap="xs">
          <Button variant="default" onClick={() => setUI({ addTask: true })}>+ 업무 추가</Button>
          <Button onClick={() => setUI({ newFor: '' })}>+ 새 세션</Button>
        </Group>
      </Group>
    </Stack>
    <Box key={ui.mode} className="hq-fade" style={{ minHeight: 0, minWidth: 0 }}>
      {ui.mode === 'work' ? <WorkView S={S} /> : ui.mode === 'memo' ? <MemoView S={S} /> : <BoardView S={S} mode={ui.mode} />}
    </Box>
    <SessionDrawer S={S} />
    <TaskDrawer S={S} />
    <NewSessionModal S={S} />
    <AddTaskModal />
    <BriefModal S={S} />
    <SettingsWindow S={S} />
  </Box>
}
