import { useEffect, useRef, useState } from 'react'
import { ActionIcon, Alert, Box, Button, Center, Code, Divider, Group, Kbd, Loader, Stack, Text, Title, Tooltip } from '@mantine/core'
import { notifications } from '@mantine/notifications'
import { api, serverNow, toast, useNow, useOffline, useSnapshot } from './store'
import { type Mode, pickNew, rememberSel, setMode, setSlim, setUI, useUI } from './ui'
import type { Snapshot } from './types'
import { WorkView } from './Work'
import { CalendarCard } from './Calendar'
import { MailCard } from './Inbox'
import { copyText, useFlash } from './Chat'
import { isRecording, useAreaKeys } from './Keys'
import { BoardView } from './Board'
import { MemoView } from './Memo'
import { SessionDrawer, TaskDrawer } from './Drawers'
import { AddTaskModal, BriefModal, NewSessionModal } from './Modals'
import { SettingsWindow } from './Settings'
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
      styles={{ label: { flex: 1 }, root: o.on || o.primary ? undefined : { color: 'var(--mantine-color-text)' } }}>{label}</Button>
  return <Stack className="hq-sidebar" gap="xs" align={slim ? 'center' : 'stretch'}>
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
  // 사이드바는 창 맨 왼쪽에 붙고, 본문은 나머지 폭의 가운데에 놓는다(좌우 여백이 같다). 본문 폭은 모든 보기에서 같다(작업 보기의 세 칸 기준 2032px. 보기마다 다르면 넘길 때 화면이 움찔한다).
  // 본문은 위에서부터 알림 · 메인 내용 · (줄) 일정·메일. 페이지 자체는 스크롤하지 않고 메인 내용이 남은 높이를 채운다
  const side = ui.slim ? 68 : 224
  return <Box h="100dvh" className="hq-shell" style={{ gridTemplateColumns: `${side}px minmax(0, 1fr)` }}>
    <Sidebar S={S} />
    <Box h="100dvh" py="md" px="md" w="100%" maw={2032} mx="auto" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--mantine-spacing-md)', minWidth: 0, minHeight: 0 }}>
      {offline && <Alert color="red" title="서버에 연결할 수 없습니다">서버(node server.js)가 실행 중인지 확인하세요. 다시 연결되면 자동으로 이어집니다.</Alert>}
      <Notices S={S} />
      <Box key={ui.mode} className="hq-fade" style={{ flex: 1, minHeight: 0, minWidth: 0 }}>
        {ui.mode === 'work' ? <WorkView S={S} /> : ui.mode === 'memo' ? <MemoView S={S} /> : <BoardView S={S} mode={ui.mode} />}
      </Box>
      {/* 아래 줄: 일정·메일. 메인 내용과 줄로 나눈다. 카드가 없어도 높이는 둔다 */}
      <div className="hq-sub"><CalendarCard S={S} /><MailCard S={S} /></div>
    </Box>
    <SessionDrawer S={S} />
    <TaskDrawer S={S} />
    <NewSessionModal S={S} />
    <AddTaskModal />
    <BriefModal S={S} />
    <SettingsWindow S={S} />
  </Box>
}
