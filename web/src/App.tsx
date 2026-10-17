import { useEffect, useRef, useState } from 'react'
import { ActionIcon, Alert, Box, Button, Center, Code, Divider, Group, Kbd, Loader, Stack, Text, Title, Tooltip } from '@mantine/core'
import { notifications } from '@mantine/notifications'
import { api, serverNow, toast, useNow, useOffline, useSnapshot } from './store'
import { type Mode, SIDE_W, SLIM_W, pickNew, rememberSel, setMode, setSideW, setSlim, setUI, useUI } from './ui'
import type { Snapshot } from './types'
import { WorkView } from './Work'
import { CalendarCard } from './Calendar'
import { MailCard } from './Inbox'
import { FlowCard } from './Flow'
import { copyText, useFlash } from './Chat'
import { isRecording, useAreaKeys } from './Keys'
import { BoardView } from './Board'
import { MemoView } from './Memo'
import { SessionDrawer, TaskDrawer } from './Drawers'
import { AddTaskModal, BriefModal, CloseSessionModal, NewSessionModal } from './Modals'
import { SettingsWindow } from './Settings'
import { Group as Split, Panel, Separator, useDefaultLayout } from 'react-resizable-panels'
import { IconBuildingSkyscraper, IconCheck, IconFolderPlus, IconLayoutColumns, IconLayoutSidebarLeftCollapse, IconLayoutSidebarLeftExpand, IconListDetails, IconNetwork, IconNote, IconPlus, IconReport, IconSettings } from '@tabler/icons-react'

const Logo = () => <svg width="34" height="34" viewBox="0 0 8 8" shapeRendering="crispEdges" aria-hidden="true">
  <rect width="8" height="8" fill="var(--mantine-color-default)" /><rect x="1" y="1" width="2" height="2" fill="var(--mantine-color-teal-6)" />
  <rect x="5" y="1" width="2" height="2" fill="var(--mantine-color-yellow-6)" /><rect x="1" y="5" width="2" height="2" fill="var(--mantine-color-grape-5)" />
  <rect x="5" y="5" width="2" height="2" fill="var(--mantine-color-gray-6)" /><rect x="3" y="3" width="2" height="2" fill="var(--mantine-color-indigo-4)" /></svg>

function Clock({ slim }: { slim: boolean }) {
  useNow()
  const t = new Date(serverNow()).toLocaleTimeString('en-GB', { hour12: false })
  return <Text ff="monospace" size="xs" c="dimmed" ta={slim ? 'center' : undefined} title="server time">{slim ? t.slice(0, 5) : 'server time ' + t}</Text>
}

// 사내망에서 들어올 주소. 맥의 네트워크(와이파이·유선)가 바뀌면 서버가 다음 갱신(2초) 때 새 주소를 주고, 바뀌었다고 알린다
function LanAddress({ S, slim }: { S: Snapshot; slim: boolean }) {
  const [copied, flash] = useFlash()
  const a = S.access, primary = a.addresses[0] || ''
  const prev = useRef(primary)
  useEffect(() => {
    if (a.lan && prev.current && primary && prev.current !== primary)
      notifications.show({ title: '맥의 주소가 바뀌었습니다', message: `사내망에서는 이제 ${primary} 로 들어옵니다`, color: 'orange', autoClose: 15000 })
    prev.current = primary
  }, [primary, a.lan])
  const copy = async () => { if (primary && await copyText(primary)) flash() }
  const off = () => setUI({ settings: true, settingsPage: 'access' })
  if (slim) return <Tooltip label={!a.lan ? '사내망 접속 꺼짐' : copied ? '✓ 복사됨' : `사내망 주소 ${primary || '네트워크 없음'} · 누르면 복사`} position="right">
    <ActionIcon size="lg" variant="subtle" color={copied ? 'teal' : 'gray'} onClick={a.lan ? copy : off} aria-label="사내망 주소">{copied ? <IconCheck size={18} /> : <IconNetwork size={18} />}</ActionIcon>
  </Tooltip>
  if (!a.lan) return <Button size="xs" variant="subtle" color="gray" onClick={off}>사내망 접속 꺼짐</Button>
  return <Stack gap={2}>
    <Text size="xs" c="dimmed">사내망 주소 {copied && <Text span inherit c="teal.4">✓ 복사됨</Text>}</Text>
    {/* 주소를 누르면 복사한다 */}
    <Code fz="xs" className={primary ? 'hq-copyable' : undefined} title={primary ? '누르면 복사' : undefined} onClick={copy} style={{ overflowWrap: 'anywhere' }}>{primary.replace(/^https?:\/\//, '') || '네트워크 없음'}</Code>
  </Stack>
}

// 세션이 어디에 기대고 있는지 드러낸다: Orca에서 도는 세션은 Orca를 끄면 같이 꺼지고, 방금 한꺼번에 닫힌 세션은 웹에서 다시 연다
function Notices({ S }: { S: Snapshot }) {
  const orca = S.sessions.filter(s => s.host === 'orca')
  const movable = orca.filter(s => s.state !== 'working' && s.state !== 'compact' && s.state !== 'approval').length
  const recent = S.closed.filter(c => !c.quiet && Date.now() - c.closedAt < 30 * 60e3)
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
        <Text size="sm">최근 30분 안에 웹 세션 {recent.length}개가 닫혔습니다. 대화는 남아 있어서 웹에서 같은 옵션으로 다시 열 수 있습니다.</Text>
        <Group gap={6}>
          <Button size="xs" color="red" loading={busy} onClick={async () => {
            setBusy(true); const r = await api<string[]>('session/reopen', { sids: recent.map(c => c.sid) }); setBusy(false)
            if (r) toast(`${r.result.length}개를 웹에서 다시 열었습니다.`)
          }}>모두 웹에서 다시 열기</Button>
          <Button size="xs" variant="subtle" color="gray" onClick={() => api('session/quiet-closed', { sids: recent.map(c => c.sid) })}>무시</Button>
        </Group>
      </Group>
    </Alert>}
  </>
}

// 왼쪽 사이드바: 로고, 보기 전환(F1~F4), 새 세션·업무 추가·브리핑, 아래에 사내망 주소·시각·환경설정·접기.
// 위쪽 높이를 일정·메일 카드에 주려고 버튼들을 여기로 모았다(사용자 요청: 노트북 화면에서도 일정·메일을 보려고). 접으면 아이콘만 남는다
const VIEWS: [Mode, string, string, typeof IconLayoutColumns][] = [['work', '작업', 'F1', IconLayoutColumns], ['task', '업무별', 'F2', IconBuildingSkyscraper], ['all', '세션 전체', 'F3', IconListDetails], ['memo', '메모', 'F4', IconNote]]
function Sidebar({ S }: { S: Snapshot }) {
  const ui = useUI(), slim = ui.slim
  const mine = S.sessions.filter(s => s.state === 'myturn' || s.state === 'approval').length
  useEffect(() => { document.title = (mine ? `(${mine}) ` : '') + 'Claude Session HQ' }, [mine])
  // 펼치면 글자 버튼, 접으면 아이콘과 풍선 도움말
  const item = (key: string, Icon: typeof IconLayoutColumns, label: string, onClick: () => void, o: { on?: boolean; kbd?: string; primary?: boolean } = {}) => slim
    ? <Tooltip key={key} label={label + (o.kbd ? ` (${o.kbd})` : '')} position="right">
      <ActionIcon size="lg" variant={o.primary ? 'filled' : o.on ? 'light' : 'subtle'} color={o.primary || o.on ? 'indigo' : 'gray'} onClick={onClick} aria-label={label}><Icon size={18} /></ActionIcon>
    </Tooltip>
    : <Button key={key} fullWidth justify="flex-start" variant={o.primary ? 'filled' : o.on ? 'light' : 'subtle'} color={o.primary || o.on ? 'indigo' : 'gray'}
      leftSection={<Icon size={16} />} rightSection={o.kbd && <Kbd size="xs">{o.kbd}</Kbd>} onClick={onClick} aria-label={label}
      px={10} styles={{ label: { flex: 1 }, section: { marginInlineEnd: 8 }, root: o.on || o.primary ? undefined : { color: 'var(--mantine-color-text)' } }}>{label}</Button>
  // 오른쪽 경계를 끌어 폭을 바꾼다(놓을 때 저장, 펼침·접힘 따로). 두 번 누르면 처음 폭
  const grip = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    const el = e.currentTarget, shell = el.closest('.hq-shell')
    el.setPointerCapture(e.pointerId); shell?.classList.add('dragging')
    const move = (m: PointerEvent) => setSideW(m.clientX)
    const up = (m: PointerEvent) => { setSideW(m.clientX, true); shell?.classList.remove('dragging'); el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up) }
    el.addEventListener('pointermove', move); el.addEventListener('pointerup', up)
  }
  return <div className="hq-sidebar-wrap">
  <div className="hq-side-grip" onPointerDown={grip} onDoubleClick={() => setSideW(slim ? SLIM_W : SIDE_W, true)} title="끌어서 폭 바꾸기 · 두 번 누르면 처음 폭" />
  <Stack className="hq-sidebar" gap="xs" align={slim ? 'center' : 'stretch'}>
    <Group gap={10} wrap="nowrap" mb="sm" title="Claude Session HQ">
      <Logo />
      {!slim && <Title order={1} size={18} lh={1.15} fw={400} className="hq-display">Claude Session HQ</Title>}
    </Group>
    {VIEWS.map(([m, label, kbd, Icon]) => item(m, Icon, label, () => setMode(m), { on: ui.mode === m, kbd }))}
    <Divider my={4} w="100%" />
    {item('new', IconPlus, '새 세션', () => setUI({ newFor: '' }), { primary: true, kbd: '⌘T' })}
    {item('task', IconFolderPlus, '업무 추가', () => setUI({ addTask: true }))}
    {item('brief', IconReport, '지금 상황 브리핑', () => setUI({ brief: true }))}
    <Box style={{ flex: 1 }} />
    <LanAddress S={S} slim={slim} />
    <Clock slim={slim} />
    {item('settings', IconSettings, '환경설정', () => setUI({ settings: true }))}
    {item('slim', slim ? IconLayoutSidebarLeftExpand : IconLayoutSidebarLeftCollapse, slim ? '사이드바 펼치기' : '사이드바 접기', () => setSlim(!slim))}
  </Stack>
  </div>
}

// 오른쪽: 메인(알림·보기의 내용) | 서브(일정·메일 같은 카드들). 서브는 사이드바 바로 옆부터 왼쪽으로 붙여 놓고, 카드마다 너비를 끌어 바꾼다
// (비율은 localStorage react-resizable-panels:hq-sub. 앞으로 서브에 들이는 카드도 같은 규칙). 마지막 빈 칸이 남는 폭을 받는다
function MainSplit({ S, offline }: { S: Snapshot; offline: boolean }) {
  const ui = useUI()
  const main = useDefaultLayout({ id: 'hq-main' }), sub = useDefaultLayout({ id: 'hq-sub' })
  return <Split key={ui.layoutKey} orientation="vertical" defaultLayout={main.defaultLayout} onLayoutChanged={main.onLayoutChanged} style={{ height: '100dvh', overflow: 'visible' }}>
    <Panel id="main" minSize={300}>
      <Box h="100%" p="md" pb={4} w="100%" maw={2032} mx="auto" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--mantine-spacing-md)', minWidth: 0, minHeight: 0 }}>
        {offline && <Alert color="red" title="서버에 연결할 수 없습니다">서버(node server.js)가 실행 중인지 확인하세요. 다시 연결되면 자동으로 이어집니다.</Alert>}
        <Notices S={S} />
        <Box key={ui.mode} className="hq-fade" style={{ flex: 1, minHeight: 0, minWidth: 0 }}>
          {ui.mode === 'work' ? <WorkView S={S} /> : ui.mode === 'memo' ? <MemoView S={S} /> : <BoardView S={S} mode={ui.mode} />}
        </Box>
      </Box>
    </Panel>
    {/* 메인과 서브를 가르는 줄. 창 폭 전체로 긋고, 끌면 서브 높이가 바뀐다 */}
    <Separator className="hq-split-line" />
    <Panel id="sub" defaultSize={218} minSize={110} maxSize="60" style={{ overflow: 'visible' }}>
      <div className="hq-sub">
        <Split key={ui.layoutKey} orientation="horizontal" defaultLayout={sub.defaultLayout} onLayoutChanged={sub.onLayoutChanged} style={{ overflow: 'visible' }}>
          <Panel id="cal" defaultSize={360} minSize={220} style={{ overflow: 'visible' }}><CalendarCard S={S} /></Panel>
          <Separator className="hq-split-v" />
          <Panel id="mail" defaultSize={480} minSize={240}><MailCard S={S} /></Panel>
          <Separator className="hq-split-v" />
          <Panel id="flow" defaultSize={480} minSize={240}><FlowCard S={S} /></Panel>
          <Separator className="hq-split-v" />
          <Panel id="rest" minSize={0}><div /></Panel>
        </Split>
      </div>
    </Panel>
  </Split>
}

export function App() {
  const S = useSnapshot()
  const offline = useOffline()
  const ui = useUI()
  const latest = useRef({ S, ui })
  latest.current = { S, ui }
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
      // Cmd+W(윈도우는 Ctrl+W): 고른 웹 세션의 종료 확인 창. 확인 버튼에 포커스가 있어 스페이스바로 종료한다
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'w') {
        e.preventDefault(); e.stopPropagation()
        const { S, ui } = latest.current
        const s = S?.sessions.find(x => x.sid === ui.sel)
        if (!s || s.host !== 'web') return
        setUI({ closeFor: s.sid })
        return
      }
      const m = keys[e.key]
      if (!m || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return
      e.preventDefault(); e.stopPropagation()
      setMode(m)
    }
    addEventListener('keydown', onKey, true)
    return () => removeEventListener('keydown', onKey, true)
  }, [])

  if (!S) return <Center h="100vh"><Loader /></Center>
  // 사이드바는 창 맨 왼쪽에 붙고, 오른쪽은 위아래 두 칸(메인 | 서브)이며 사이 경계를 끌어 서브 높이를 바꾼다(비율은 localStorage react-resizable-panels:hq-main).
  // 메인 내용은 나머지 폭의 가운데에 놓는다(좌우 여백이 같다). 본문 폭은 모든 보기에서 같다(작업 보기의 세 칸 기준 2032px. 보기마다 다르면 넘길 때 화면이 움찔한다).
  // 페이지 자체는 스크롤하지 않는다
  const side = ui.slim ? ui.slimW : ui.sideW
  return <Box h="100dvh" className="hq-shell" style={{ gridTemplateColumns: `${side}px minmax(0, 1fr)`, '--side': side + 'px' } as React.CSSProperties}>
    <Sidebar S={S} />
    <MainSplit S={S} offline={offline} />
    <SessionDrawer S={S} />
    <TaskDrawer S={S} />
    <NewSessionModal S={S} />
    <AddTaskModal />
    <CloseSessionModal S={S} />
    <BriefModal S={S} />
    <SettingsWindow S={S} />
  </Box>
}
