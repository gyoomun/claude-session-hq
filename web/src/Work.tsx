// 작업 보기: 왼쪽 세션 목록(업무별로 묶음) | 즐겨찾기 | 고른 세션(머리 + 대화) | 핀·메모·btw
import { useEffect, useRef, useState } from 'react'
import { ActionIcon, Badge, Box, Button, HoverCard, Group, Loader, Modal, Paper, ScrollArea, SegmentedControl, Skeleton, Stack, Text, UnstyledButton } from '@mantine/core'
import { api, toast, useNow } from './store'
import { pick, setUI, setView, useUI } from './ui'
import type { Closed, Session, Snapshot } from './types'
import { COLOR, D, LABEL, Since, bySt, hhmm, cssColor, sessOf, withForks } from './util'
import { TerminalView } from './Terminal'
import { ChatView, SessionInfo, bgCount, bgText, copyName, stopSession, useFlash } from './Chat'
import { SidePanel, hasMemo } from './Memo'
import { IconCheck, IconCoin, IconCopy, IconPinFilled } from '@tabler/icons-react'
import { KeyRec, areaKeys } from './Keys'
import { Group as Split, Panel, Separator, useDefaultLayout } from 'react-resizable-panels'

// 목록·즐겨찾기의 세션 한 줄. 끌어서 즐겨찾기에 넣고 빼고, 즐겨찾기 안에서 자리를 옮긴다(HTML 끌어다 놓기, 넘기는 값은 대화 ID)
const DRAG = 'application/x-hq-sid'
const dragging = (e: React.DragEvent) => e.dataTransfer.types.includes(DRAG)
let dragSid = '' // 끄는 중에는 dataTransfer 값을 읽을 수 없어서(놓을 때만 된다) 따로 둔다. 제 자리는 빈 칸으로 본다
// 한 줄: 상태는 점 색으로만 보인다(글자 없음, 사용자 요청). 끝의 지난 시간은 올리면 이름 복사 버튼으로 바뀐다
function Item({ s, on, memo, boot }: { s: Session; on: boolean; memo: boolean; boot?: string }) {
  // 고른 세션은 목록에서 보이게 스크롤한다(새로고침·Ctrl+Tab·다른 데서 열기). 고른 순간에만 해서, 손으로 스크롤한 목록을 되돌리지 않는다
  const ref = useRef<HTMLButtonElement>(null)
  useEffect(() => { if (on) ref.current?.scrollIntoView({ block: 'nearest' }) }, [on])
  return <UnstyledButton ref={ref} data-on={on} data-name={s.name} draggable onDragStart={e => { dragSid = s.sid; e.dataTransfer.setData(DRAG, s.sid); e.dataTransfer.effectAllowed = 'move' }} onClick={() => pick(s.sid)} p="5px 4px" w="100%" className="hq-item"
    style={{ borderRadius: 8, background: on ? 'var(--mantine-color-indigo-light)' : undefined, boxShadow: on ? 'inset 0 0 0 1px var(--mantine-color-indigo-5)' : undefined }}>
    <Group gap={6} wrap="nowrap">
      {/* 모두 재시작 중: 끄고 띄우는 동안은 점 대신 도는 표시, 차례를 기다리면 흐린 점 */}
      {boot === 'kill' || boot === 'start' ? <span className="hq-spin hq-spin-dot" title="다시 띄우는 중" />
        : <Box w={8} h={8} className={'hq-dot' + (s.state === 'working' || s.state === 'compact' ? ' busy' : '')} style={{ borderRadius: 2, flex: 'none', background: cssColor(s.state), opacity: boot === 'wait' ? .35 : undefined }} title={LABEL[s.state]} />}
      <Text size="sm" lh={1.35} truncate title={s.title} style={{ minWidth: 0 }}>{s.title}</Text>
      {memo && <IconPinFilled size={12} style={{ flex: 'none', color: 'var(--mantine-color-orange-4)' }} aria-label="메모 있음" />}
      <Box style={{ flex: 1 }} />
      {bgCount(s) > 0 && <Text size="xs" c="teal.4" style={{ flex: 'none' }} title={bgText(s)}>뒤 {bgCount(s)}</Text>}
      {s.host !== 'web' && <Badge size="xs" variant="outline" color="gray" style={{ flex: 'none' }}>{s.host === 'orca' ? 'Orca' : '외부'}</Badge>}
      <Box className="hq-rowend"><Text size="xs" c="dimmed" className="hq-rowtime"><Since t={s.since} short /></Text><CopyName name={s.name} /></Box>
    </Group>
  </UnstyledButton>
}
const bootOf = (S: Snapshot, sid: string) => S.reboot?.items.find(x => x.sid === sid)?.phase
const limitEnd = (S: Snapshot, kind: string) => Date.parse(S.usage?.limits.find(l => l.kind === kind)?.resetsAt || '') || 0
// 사용량 칸 세션·주간 줄 끝의 동전: 누르면 떠 있는 세션 전체가 그 한도(5시간·주간)를 얼마나 썼는지 한꺼번에 조회한다. 올리면 요약 카드가 뜨고 '더보기'를 누르면 카드가 커져 순위(이번 창 기준)를 보여 준다
function AllCoin({ S, sids, kind }: { S: Snapshot; sids: string[]; kind: string }) {
  const [busy, setBusy] = useState(false)
  const [more, setMore] = useState(false)
  const end = limitEnd(S, kind), share = S.usageShare?.[kind] || {}, name = kind === 'seven_day' ? '주간' : '5시간'
  const got = sids.filter(x => share[x]?.windowEnd === end)
    .map(x => ({ s: S.sessions.find(y => y.sid === x), share: share[x].share })).sort((a, b) => b.share - a.share)
  const sum = Math.round(got.reduce((a, x) => a + x.share, 0) * 10) / 10
  const done = sids.length > 0 && got.length === sids.length
  return <HoverCard openDelay={0} closeDelay={100} position="bottom-start" withArrow shadow="md" onClose={() => setMore(false)}>
    <HoverCard.Target>
      <ActionIcon size="xs" variant="subtle" color={done ? 'yellow' : 'gray'} aria-label={`세션별 ${name} 한도 사용량 전체 조회`} disabled={!sids.length}
        onClick={async () => { if (busy) return; setBusy(true); await api('session/limit-share', { sids, kind }); setBusy(false) }}>
        <IconCoin size={16} stroke={1.6} />
      </ActionIcon>
    </HoverCard.Target>
    <HoverCard.Dropdown p={8} style={{ width: more ? 340 : 'auto' }}>
      <Text size="xs">{busy ? '계산 중…' : got.length ? `이번 ${name} 창 · ${got.length}/${sids.length}개 조회 · 합계 ${sum}% 사용` : `누르면 세션 ${sids.length}개가 ${name} 한도를 얼마나 썼는지 한꺼번에 조회`}</Text>
      {!!got.length && !more && <Button size="compact-xs" variant="subtle" mt={4} onClick={() => setMore(true)}>더보기</Button>}
      {more && <Stack gap={2} mt={6}>
        {got.map((x, i) => <UnstyledButton key={x.s?.sid ?? i} onClick={() => x.s && pick(x.s.sid)} className="hq-item" p="3px 4px" style={{ borderRadius: 6 }}>
          <Group gap={6} wrap="nowrap"><Text size="xs" c="dimmed" w={18}>{i + 1}</Text><Text size="xs" lineClamp={1} style={{ flex: 1 }}>{x.s?.title ?? '(닫힌 세션)'}</Text><Text size="xs" fw={600}>{x.share}%</Text></Group>
        </UnstyledButton>)}
      </Stack>}
    </HoverCard.Dropdown>
  </HoverCard>
}
// 줄 오른쪽의 세션 이름 복사(다른 Claude에게 이름을 알려 줄 일이 많아서). 줄을 고르지 않는다. 키보드로는 줄에서 ⌘C(Ctrl+C)
// 줄이 button이라 안에 button을 넣지 못해 span으로 만든다
function CopyName({ name }: { name: string }) {
  const [done, flash] = useFlash()
  useEffect(() => {
    const on = (e: Event) => { if ((e as CustomEvent).detail === name) flash() }
    addEventListener('hq-copied', on)
    return () => removeEventListener('hq-copied', on)
  }, [name])
  return <span role="button" tabIndex={-1} className={'hq-rowcopy' + (done ? ' done' : '')} title={done ? '복사됨' : `세션 이름 복사: ${name}`} aria-label="세션 이름 복사"
    onMouseDown={e => e.stopPropagation()} onClick={e => { e.stopPropagation(); e.preventDefault(); copyName(name) }}>
    {done ? <IconCheck size={18} stroke={2.2} /> : <IconCopy size={18} stroke={1.6} />}
  </span>
}

// 세션 제목: 누르면 그 자리에서 고친다(Enter·바깥 누르기 저장, Esc 취소). 저장하면 그 세션에 /rename을 넣어
// Claude Code 세션 이름(상태줄·다른 Claude가 부르는 이름)과 대화 제목이 함께 바뀐다. 반영될 때까지 새 이름을 먼저 보인다
function Title({ s }: { s: Session }) {
  const [edit, setEdit] = useState<string | null>(null)
  const [want, setWant] = useState('')
  useEffect(() => { if (want && s.title === want) setWant('') }, [s.title, want])
  useEffect(() => { setEdit(null); setWant('') }, [s.sid])
  const save = async () => {
    const v = (edit ?? '').replace(/\s+/g, ' ').trim()
    setEdit(null)
    if (!v || v === s.title) return
    setWant(v)
    if (!await api('session/rename', { pid: s.pid, name: v })) setWant('')
    else setTimeout(() => setWant(x => x === v ? '' : x), 8000)
  }
  if (edit !== null) return <input className="hq-title-edit" value={edit} autoFocus maxLength={60} aria-label="세션 이름"
    onFocus={e => e.currentTarget.select()} onChange={e => setEdit(e.currentTarget.value)} onBlur={save}
    onKeyDown={e => {
      if (e.nativeEvent.isComposing) return
      if (e.key === 'Enter') { e.preventDefault(); save() }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setEdit(null) } // 대화 화면의 Esc(중단·되감기)로 가지 않게
    }} />
  return <UnstyledButton className="hq-title" title="눌러서 이름 바꾸기" onClick={() => setEdit(want || s.title)}>
    <Text component="div" fw={600} size="lg" truncate title={want || s.title}>{want || s.title}</Text>
  </UnstyledButton>
}

function Head({ S, s }: { S: Snapshot; s: Session }) {
  const busy = s.state === 'working' || s.state === 'compact' || s.state === 'approval'
  return <Box p="10px 12px">
    <Group gap="sm" wrap="wrap">
      <Stack gap={0} style={{ minWidth: 0, flex: '1 1 260px' }}>
        {/* 제목은 Claude가 정해서 아직 모른다. 같은 글줄 안에 반짝이를 넣어 높이를 똑같이 맞춘다 */}
        {s.sid ? <Title s={s} /> : <Text component="div" fw={600} size="lg"><Skeleton h="0.9em" w="38%" display="inline-block" style={{ verticalAlign: 'middle' }} /></Text>}
        {/* 제목 밑: 권한 모드·모델·effort(폴더·상태·세션 이름은 목록에 있어 뺐다: 사용자 요청) */}
        <SessionInfo s={s} />
      </Stack>
      <Group gap={6}>
                <Button size="xs" variant="subtle" color="gray" onClick={() => setUI({ openSess: s.sid })}>정보</Button>
        {s.host === 'web' && <ViewToggle />}
        {/* 중단: 늘 같은 자리에 두고 일하는 중에만 켠다(사용자 요청). Esc와 같다 */}
        {s.host === 'web' && <Button size="xs" variant={busy ? 'filled' : 'outline'} color={busy ? COLOR.working : 'gray'} disabled={!busy || !s.sid} onClick={() => stopSession(s)}>중단 (Esc)</Button>}
        {s.state === 'myturn' && <Button size="xs" variant="outline" color="sage" onClick={() => api('seen', { sid: s.sid })}>알겠어, 쉬어</Button>}
        {s.host === 'web' && <Button size="xs" variant="outline" color="orange" title="전역 CLAUDE.md·.zshrc 등을 바꾼 뒤. 같은 대화로 다시 띄워 이어집니다(일하는 중이어도 끊습니다)" onClick={async () => {
          if (await api('session/restart', { names: [s.tmux] })) toast('세션을 다시 띄웁니다. 대화는 그대로 이어집니다.')
        }}>세션 재시작</Button>}
        {s.host === 'web' && <Button size="xs" variant="outline" color="red" onClick={() => setUI({ closeFor: s.sid })}>세션 종료</Button>}
      </Group>
    </Group>
  </Box>
}

// 닫힌 세션 탭: 대화는 남아 있으니 누르면 바로 웹에서 같은 옵션으로 다시 연다.
// 다시 연 줄은 이 탭에 그대로 두고 표시만 바꾼다(여러 개를 이어서 열 때 줄이 사라지거나 탭이 바뀌면 번거로워서: 사용자 요청). 탭을 떠나면 held를 비워 빠진다
function ClosedList({ S, held, onOpen }: { S: Snapshot; held: Closed[]; onOpen: (c: Closed) => void }) {
  // 닫힐 때도 창이 사라지는 동안 같은 내용이 보이게 종류(kind)는 남겨 두고 열림만 끈다
  const [ask, setAsk] = useState<{ open: boolean; kind: 'reopen' | 'forget' }>({ open: false, kind: 'reopen' })
  const kind = ask.kind, hide = () => setAsk(a => ({ ...a, open: false }))
  const live = new Set(S.sessions.map(x => x.sid))
  const list = [...S.closed, ...held.filter(h => !S.closed.some(c => c.sid === h.sid))].sort((a, b) => b.closedAt - a.closedAt)
  if (!list.length) return <Text size="xs" c="dimmed" px={8}>닫힌 세션 없음</Text>
  return <Stack gap={2}>
    {S.closed.length > 0 && <Group gap={6} px={8} mb={6}>
      <Button size="compact-xs" variant="subtle" onClick={() => setAsk({ open: true, kind: 'reopen' })}>모두 다시 열기</Button>
      <Button size="compact-xs" variant="subtle" color="gray" onClick={() => setAsk({ open: true, kind: 'forget' })}>목록 비우기</Button>
    </Group>}
    {/* 두 버튼은 잘못 누르면 Claude가 한꺼번에 뜨거나 목록이 사라져서 묻는다. 기본 포커스는 취소(사용자 요청) */}
    <Modal opened={ask.open} onClose={hide} title={kind === 'reopen' ? '모두 다시 열기' : '목록 비우기'} size="sm" withCloseButton={false}>
      <Stack gap="sm">
        <Text size="sm">{kind === 'reopen' ? `닫힌 세션 ${S.closed.length}개를 모두 웹에서 다시 열까요?` : `닫힌 세션 ${S.closed.length}개를 목록에서 지울까요? 대화 기록은 남지만 여기서 다시 열 수 없게 됩니다.`}</Text>
        <Group justify="flex-end">
          <Button size="xs" variant="default" data-autofocus onClick={hide}>취소</Button>
          <Button size="xs" variant={kind === 'reopen' ? 'filled' : 'light'} color={kind === 'reopen' ? undefined : 'red'} onClick={async () => {
            hide()
            if (kind === 'forget') { api('session/forget-closed', {}); return }
            const r = await api<string[]>('session/reopen', { sids: S.closed.map(c => c.sid) }); if (r) toast(`${r.result.length}개를 다시 열었습니다.`)
          }}>{kind === 'reopen' ? '다시 열기' : '비우기'}</Button>
        </Group>
      </Stack>
    </Modal>
    {list.map(c => {
      const isHeld = held.some(h => h.sid === c.sid), isLive = live.has(c.sid)
      // 두 줄: 제목 · 닫은 시각(또는 다시 연 상태) / 폴더
      return <UnstyledButton key={c.sid} p="5px 4px" w="100%" className="hq-item" style={{ borderRadius: 8 }}
        title={isHeld ? (isLive ? '눌러서 보기' : '여는 중') : '눌러서 다시 열기'}
        onClick={() => isHeld ? isLive && pick(c.sid) : onOpen(c)}>
        <Group gap={6} wrap="nowrap">
          <Text size="sm" lh={1.35} truncate title={c.title} style={{ flex: 1, minWidth: 0 }} c={isHeld ? undefined : 'dimmed'}>{c.title}</Text>
          {/* 하루가 지나면 '며칠 전' 대신 닫은 날짜·시각 */}
          <Text size="xs" c="dimmed" style={{ flex: 'none' }}>{isHeld ? <Text span inherit c={isLive ? `${COLOR.myturn}.5` : 'dimmed'}>{isLive ? '다시 열림 · 누르면 보기' : '여는 중…'}</Text>
            : Date.now() - c.closedAt < D ? <Since t={c.closedAt} suf=" 전" /> : `${new Date(c.closedAt).getMonth() + 1}. ${new Date(c.closedAt).getDate()}. ${hhmm(c.closedAt)}`}</Text>
        </Group>
        <Text size="xs" c="dimmed" truncate title={c.cwd}>{c.cwd}</Text>
      </UnstyledButton>
    })}
  </Stack>
}

// 새 세션을 여는 동안(Claude가 뜨는 데 2~3초) 목록에서 그 세션이 들어갈 자리
function ItemSkeleton({ state, since }: { state: Session['state']; since: number }) {
  return <Group gap={6} wrap="nowrap" p="5px 4px">
    <Box w={8} h={8} className="hq-dot" style={{ borderRadius: 2, flex: 'none', background: cssColor(state) }} />
    <Text component="div" size="sm" lh={1.35} style={{ flex: 1 }}><Skeleton h="0.9em" w="80%" display="inline-block" style={{ verticalAlign: 'middle' }} /></Text>
    <Text size="xs" c="dimmed" style={{ flex: 'none' }}><Since t={since} short /></Text>
  </Group>
}
// 새 세션을 여는 동안: 진짜 세션 화면을 빈 세션(ghost)으로 그리고 손만 못 대게 막는다(inert. disabled로 막으면 버튼 모양·크기가 바뀌어 뜰 때 움찔한다).
// 폴더·상태·버튼·칸 제목·입력칸은 그대로 보이고, 아직 모르는 제목·핀·대화만 반짝인다. 배치가 같아 세션이 뜰 때 튀지 않는다
// 머리 버튼 줄의 중단 왼쪽: 대화 화면(UI)과 터미널(Claude Code 화면 그대로) 바꾸기. 단축키는 옆 ⌨로 정한다(처음 ⌥T, 환경설정 '단축키'에도 있다). 웹 세션만(터미널을 띄울 수 있어서)
function ViewToggle() {
  const ui = useUI()
  return <Group gap={4} wrap="nowrap">
    <SegmentedControl size="xs" value={ui.view} onChange={v => setView(v as 'chat' | 'term')} data={[{ label: 'UI', value: 'chat' }, { label: '터미널', value: 'term' }]} />
    <KeyRec area="view" />
  </Group>
}
// 고른 세션: 카드 하나 안에 위 머리 / 아래 대화 | 핀·메모·btw. 칸 사이는 줄로만 나누고(사용자 요청), 대화|오른쪽 칸 너비와 핀|메모 높이는 줄을 끌어 바꾼다
function SessionArea({ S, s }: { S: Snapshot; s: Session }) {
  const ui = useUI()
  const { defaultLayout, onLayoutChanged } = useDefaultLayout({ id: 'hq-chat-side' })
  return <Paper withBorder h="100%" className={s.sid ? undefined : 'hq-fade'} style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
    <Head S={S} s={s} />
    <Box className="hq-rule" />
    <Split key={ui.layoutKey} orientation="horizontal" defaultLayout={defaultLayout} onLayoutChanged={onLayoutChanged} style={{ flex: 1, minHeight: 0 }}>
      <Panel id="chat" minSize={360}>
        <Box h="100%" style={{ minWidth: 0, display: 'flex', flexDirection: 'column', position: 'relative' }}>
          {s.sid && s.host === 'web' && ui.view === 'term' ? <Box style={{ flex: 1, minHeight: 0 }}><TerminalView key={s.tmux} name={s.tmux} /></Box> : <ChatView key={s.tmux || s.pid} s={s} detail={ui.detail} />}
        </Box>
      </Panel>
      <Separator className="hq-split-vline" />
      <Panel id="side" defaultSize={380} minSize={300} maxSize={640}><SidePanel S={S} s={s} /></Panel>
    </Split>
  </Paper>
}

// 즐겨찾기 칸 아래 사용량 칸(핀·메모·btw처럼 위아래로 나누고 경계를 끌어 높이를 바꾼다). 즐겨찾기가 높이를 다 채울 일은 드물어서
function FavColumn({ S, sel, ghost }: { S: Snapshot; sel: string; ghost: Session | null }) {
  const { defaultLayout, onLayoutChanged } = useDefaultLayout({ id: 'hq-work-favcol' })
  return <Split orientation="vertical" defaultLayout={defaultLayout} onLayoutChanged={onLayoutChanged} style={{ height: '100%' }}>
    <Panel id="favlist" minSize={160}><Favs S={S} sel={sel} ghost={ghost} /></Panel>
    <Separator className="hq-split" />
    <Panel id="usage" defaultSize={110} minSize={84}><UsagePanel S={S} /></Panel>
  </Split>
}

// Claude 사용량 한도: 세션(5시간)·주간 창이 얼마나 찼고 언제 초기화되는지. 플러그인 hq-usage가 응답마다 남긴 값(계정 단위)
const LIMIT: Record<string, string> = { five_hour: '세션', seven_day: '주간', spend_limit: '사용 한도' }
const left = (ms: number) => {
  const m = Math.max(0, Math.round(ms / 60e3)), d = Math.floor(m / 1440), h = Math.floor(m % 1440 / 60)
  return d ? `${d}일 ${h}시간` : h ? `${h}시간 ${m % 60}분` : `${m}분`
}
function UsagePanel({ S }: { S: Snapshot }) {
  useNow()
  const u = S.usage
  const old = u && Date.now() - u.at > 3 * 3600e3 // 오래 응답이 없어 낡은 값
  const sids = S.sessions.map(x => x.sid)
  return <Paper withBorder p="8px 10px" h="100%" style={{ display: 'flex', flexDirection: 'column', gap: 2, overflow: 'hidden' }}>
    <Group justify="space-between" gap={4} wrap="nowrap"><Text size="xs" fw={600} c="dimmed">계정</Text>
      {old && <Text size="xs" c="dimmed" title={new Date(u.at).toLocaleString('ko-KR')}><Since t={u.at} suf=" 전 값" /></Text>}</Group>
    {S.account && <UnstyledButton className="hq-item" p="2px 4px" m="-2px -4px" style={{ borderRadius: 6 }} title="누르면 브라우저가 열립니다. 거기서 로그인하면 끝나고, 이미 떠 있는 세션도 새 계정을 씁니다"
      onClick={() => api('account/login')}>
      <Group gap={6} wrap="nowrap"><Text size="xs" fw={600} w={40} style={{ flex: 'none' }}>이메일</Text><Text size="xs" c="dimmed" lineClamp={1} style={{ flex: 1 }}>{S.account.email.split('@')[0]}</Text>{S.login && <Loader size={12} style={{ flex: 'none' }} />}</Group>
    </UnstyledButton>}
    {S.account?.plan && <Group gap={6} wrap="nowrap"><Text size="xs" fw={600} w={40} style={{ flex: 'none' }}>요금제</Text><Text size="xs" c="dimmed">{S.account.plan}</Text></Group>}
    {!u?.limits?.length ? <Text size="xs" c="dimmed">세션에서 답을 한 번 받으면 보입니다(hq-usage 플러그인)</Text>
      : u.limits.map(l => {
        const rest = Math.max(0, 100 - Math.round(l.percentUsed)) // 남은 양
        const color = rest <= 10 ? 'red' : rest <= 30 ? 'yellow' : 'teal'
        const reset = l.resetsAt ? Date.parse(l.resetsAt) : 0
        return <Group key={l.kind} gap={6} wrap="nowrap" style={{ opacity: old ? .55 : 1 }}>
          <Text size="xs" fw={600} w={40} style={{ flex: 'none' }}>{LIMIT[l.kind] || l.kind}</Text>
          {S.usageStale ? <Box title="새 계정 값을 받는 중(아무 세션이 한 번 답하면 들어옵니다)" style={{ display: 'flex' }}><Loader size={12} /></Box> : <>
            <Text size="xs" ff="monospace" c={`${color}.4`} style={{ flex: 'none' }} title="남은 양">{rest}%</Text>
            {reset > 0 && <Text size="xs" c="dimmed" lineClamp={1} title={`${new Date(reset).toLocaleString('ko-KR')} 초기화`}>· {left(reset - Date.now())}</Text>}
            {(l.kind === 'five_hour' || l.kind === 'seven_day') && <AllCoin S={S} sids={sids} kind={l.kind} />}
          </>}
        </Group>
      })}
  </Paper>
}

// 일반 목록에 남는 즐겨찾기 세션의 자리: 흐린 한 줄. 누르면 그 세션을 연다(고른 표시는 즐겨찾기 칸에)
function FavGhost({ s, on }: { s: Session; on: boolean }) {
  return <UnstyledButton onClick={() => pick(s.sid)} p="4px 8px" w="100%" className="hq-item hq-favghost" style={{ borderRadius: 8, opacity: on ? .8 : .45 }} title="즐겨찾기에 있습니다">
    <Group gap={8} wrap="nowrap"><Text size="xs" c="yellow.5" style={{ flex: 'none' }}>★</Text><Text size="xs" truncate style={{ minWidth: 0 }}>{s.title}</Text><Text size="xs" c="dimmed" style={{ flex: 'none' }}>즐겨찾기</Text></Group>
  </UnstyledButton>
}

// 즐겨찾기 칸. 비어 있어도 칸은 늘 있다(끌어다 놓을 자리).
// 자동 정렬: 넣은 순서대로 위부터 빈틈없이, 놓은 높이에 끼워 넣는다. 자유 배치: 바탕화면 아이콘처럼 원하는 높이의 칸(SLOT)에 놓고, 찬 칸이면 가장 가까운 빈 칸으로 간다(겹치지 않는다)
const SLOT = 32 // 자유 배치의 칸 높이. 항목이 한 줄이라 그 높이에 맞춘다
type Fav = Snapshot['favs']['items'][number]
export const favSids = (S: Snapshot) => {
  const live = new Set(S.sessions.map(s => s.sid)), f = S.favs || { mode: 'auto', items: [] }
  const items = f.items.filter(x => live.has(x.sid))
  return (f.mode === 'free' ? [...items].sort((a, b) => a.slot - b.slot) : items).map(x => x.sid)
}
function Favs({ S, sel, ghost }: { S: Snapshot; sel: string; ghost: Session | null }) {
  // 즐겨찾기의 세션을 보다가 연 새 세션은 뜨면 그 세션 밑에 들어간다(서버 favBelow). 뜨기 전에도 그 자리에 뼈대를 둔다(목록 대신)
  const { pendingFav } = useUI(), favGhost = ghost && pendingFav ? ghost : null
  const f = S.favs || { mode: 'auto' as const, items: [] }
  const byId = new Map(S.sessions.map(s => [s.sid, s]))
  const live = f.items.filter(x => byId.has(x.sid)) // 닫힌 세션은 목록에 남겨 두고(다시 열면 돌아온다) 보이지만 않는다
  const box = useRef<HTMLDivElement>(null)
  const [hover, setHover] = useState<number | null>(null) // 자동: 끼워 넣을 자리, 자유: 놓을 칸
  const save = (items: Fav[], mode = f.mode) => api('favs', { mode, items })
  const freeSlot = (want: number, sid: string) => {
    const used = new Set(live.filter(x => x.sid !== sid).map(x => x.slot))
    for (let d = 0; ; d++) { if (!used.has(want + d)) return want + d; if (want - d >= 0 && !used.has(want - d)) return want - d }
  }
  const target = (e: React.DragEvent, sid: string) => {
    if (f.mode === 'free') return freeSlot(Math.max(0, Math.floor((e.clientY - box.current!.getBoundingClientRect().top) / SLOT)), sid)
    return [...box.current!.querySelectorAll<HTMLElement>('[data-fav]')].filter(k => k.dataset.fav !== sid)
      .filter(k => { const r = k.getBoundingClientRect(); return e.clientY > r.top + r.height / 2 }).length
  }
  const drop = (e: React.DragEvent) => {
    const sid = e.dataTransfer.getData(DRAG)
    setHover(null)
    if (!sid) return
    e.preventDefault()
    const at = target(e, sid), rest = f.items.filter(x => x.sid !== sid)
    if (f.mode === 'free') return save([...rest, { sid, slot: at }])
    const others = live.filter(x => x.sid !== sid), used = new Set(rest.map(x => x.slot))
    let slot = f.items.find(x => x.sid === sid)?.slot ?? 0
    if (!f.items.some(x => x.sid === sid)) while (used.has(slot)) slot++
    // 자동 정렬은 배열 순서가 곧 보이는 순서다. at은 보이는(살아 있는) 것들 사이의 자리
    const before = others[at]?.sid
    const i = before ? rest.findIndex(x => x.sid === before) : rest.length
    save([...rest.slice(0, i), { sid, slot }, ...rest.slice(i)])
  }
  const mode = (m: string) => {
    if (m === f.mode) return
    // 자유 배치로 바꾸면 지금 보이는 순서대로 칸을 채우고, 자동 정렬로 바꾸면 칸 순서를 그대로 순서로 쓴다
    const order = m === 'free' ? f.items : [...f.items].sort((a, b) => a.slot - b.slot)
    save(order.map((x, i) => ({ sid: x.sid, slot: m === 'free' ? i : x.slot })), m as 'auto' | 'free')
  }
  const rows = f.mode === 'free' ? Math.max(0, ...live.map(x => x.slot + 1), (hover ?? -1) + 1) : 0
  return <Paper withBorder p={6} h="100%" style={{ minHeight: 0, display: 'flex', flexDirection: 'column', gap: 6 }}
    data-area="favs" tabIndex={-1} onKeyDown={areaKeys(true)}
    onDragOver={e => { if (!dragging(e)) return; e.preventDefault(); setHover(target(e, dragSid)) }}
    onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setHover(null) }} onDrop={drop}>
    <Group justify="space-between" px={4} gap={4} wrap="wrap">
      <Group gap={6} wrap="nowrap"><Text size="xs" fw={600} c="dimmed">즐겨찾기</Text><KeyRec area="favs" /></Group>
      <SegmentedControl size="xs" value={f.mode} onChange={mode} data={[{ label: '자동 정렬', value: 'auto' }, { label: '자유 배치', value: 'free' }]} />
    </Group>
    <ScrollArea scrollbarSize={4} style={{ flex: 1 }}>
      <Box ref={box} pos="relative" style={{ minHeight: f.mode === 'free' ? (rows + 1) * SLOT : undefined }}>
        {!live.length && hover === null && <Text size="xs" c="dimmed" p={8}>목록에서 대화를 끌어다 놓으세요. 빼려면 목록으로 다시 끌어다 놓습니다.</Text>}
        {f.mode === 'free'
          ? <>
              {hover !== null && <Box className="hq-fav-ghost" style={{ top: hover * SLOT, height: SLOT }} />}
              {live.map(x => <Box key={x.sid} data-fav={x.sid} pos="absolute" left={0} right={0} className="hq-slide" style={{ top: x.slot * SLOT, height: SLOT }}>
                <Item s={byId.get(x.sid)!} on={x.sid === sel} memo={hasMemo(S, x.sid)} boot={bootOf(S, x.sid)} />
              </Box>)}
              {favGhost && (() => {
                // 서버 favBelow와 같은 칸: 그 세션 바로 아래부터 비어 있는 칸
                const used = new Set(f.items.map(x => x.slot)); let slot = (f.items.find(x => x.sid === pendingFav)?.slot ?? -1) + 1
                while (used.has(slot)) slot++
                return <Box pos="absolute" left={0} right={0} style={{ top: slot * SLOT, height: SLOT }}><ItemSkeleton state={favGhost.state} since={favGhost.since} /></Box>
              })()}
            </>
          : <Stack gap={2}>
              {live.filter(x => x.sid !== dragSid || hover === null).map((x, i) => <Box key={x.sid} data-fav={x.sid}>
                {hover === i && <Box className="hq-fav-line" />}
                <Item s={byId.get(x.sid)!} on={x.sid === sel} memo={hasMemo(S, x.sid)} boot={bootOf(S, x.sid)} />
                {favGhost && x.sid === pendingFav && <ItemSkeleton state={favGhost.state} since={favGhost.since} />}
              </Box>)}
              {hover !== null && hover >= live.length && <Box className="hq-fav-line" />}
            </Stack>}
      </Box>
    </ScrollArea>
  </Paper>
}

// 세 덩어리: 세션 목록 | 즐겨찾기 | 나머지(위: 세션 머리 / 아래: 대화 | 핀·메모·btw). 덩어리 사이 너비는 끌어서 바꾼다
export function WorkView({ S }: { S: Snapshot }) {
  const ui = useUI()
  const favs = favSids(S), inFav = new Set(favs)
  // 즐겨찾기에 넣은 세션은 목록에서 빠지고, 빼면 원래 업무 묶음의 원래 순서 자리로 돌아간다
  // 즐겨찾기로 간 세션은 원래 업무 자리에 흐린 줄(FavGhost)로 남는다(어느 업무 것인지, 어디로 갔는지 보이게). 순회·끌기에는 넣지 않는다
  const groups = [...S.tasks.map(t => ({ id: t.id, name: t.name, all: withForks(sessOf(S, t)) })), { id: '', name: '미배치', all: withForks(S.sessions.filter(s => !s.task).sort(bySt)) }]
    .map(g => ({ ...g, ss: g.all.filter(x => !inFav.has(x.sid)), favs: g.all.filter(x => inFav.has(x.sid)) }))
  const s = S.sessions.find(x => x.sid === ui.sel)
  // 새 세션을 여는 동안 쓸 빈 세션. 뜰 때의 상태(첫 지시가 있으면 작업중, 없으면 내 차례)와 폴더를 미리 안다
  const [opened] = useState(() => new Map<string, number>())
  if (ui.pendingSel && !opened.has(ui.pendingSel)) opened.set(ui.pendingSel, Date.now())
  const ghost: Session | null = ui.pendingSel ? { pid: 0, sid: '', name: '', title: '', cwd: ui.pendingCwd, dir: '', state: ui.pendingWorking ? 'working' : 'myturn',
    since: opened.get(ui.pendingSel)!, startedAt: 0, act: '', msg: '', prompt: '', task: ui.pendingTask, host: 'web', tmux: ui.pendingSel, pin: [], model: '', effort: '', mode: '', bg: { shells: 0, agents: [] } } : null
  // Ctrl+Tab / Ctrl+Shift+Tab: 지금 세션이 즐겨찾기에 있으면 즐겨찾기 안에서, 아니면 목록 안에서 다음·이전으로(끝에서 처음으로 돈다).
  // 크롬은 일반 탭에서 이 키를 탭 전환에 먼저 쓴다. '앱으로 설치'한 창에서는 브라우저가 키를 가져가지 않아 여기로 온다
  const order = useRef({ favs, normal: [] as string[], sel: '' })
  order.current = { favs, normal: groups.flatMap(g => g.ss.map(x => x.sid)), sel: ui.sel }
  // 보고 있던 세션이 닫히면(⌘W·세션 종료·/exit) 그 자리에 올라오는 세션, 곧 직전 순서에서 바로 아래(맨 아래였으면 바로 위) 세션을 고른다(사용자 요청)
  const prev = useRef<string[]>([])
  useEffect(() => {
    const { favs, normal, sel } = order.current, i = prev.current.indexOf(sel)
    if (sel && !s && !ui.pendingSel && i >= 0) {
      const live = new Set([...favs, ...normal])
      const next = [...prev.current.slice(i + 1), ...prev.current.slice(0, i).reverse()].find(x => live.has(x))
      if (next) pick(next)
    }
    prev.current = favs.includes(sel) ? favs : normal
  })
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      // ⌘↓·⌘↑도 같은 순회다(노트북에서 Ctrl+Tab이 불편하다: 사용자 요청). 입력칸의 맨 앞·끝 이동은 못 쓰게 된다
      const tab = e.key === 'Tab' && e.ctrlKey && !e.altKey && !e.metaKey
      const arrow = (e.key === 'ArrowDown' || e.key === 'ArrowUp') && e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey
      if (!tab && !arrow) return
      e.preventDefault(); e.stopPropagation()
      const back = tab ? e.shiftKey : e.key === 'ArrowUp'
      const { favs, normal, sel } = order.current, list = favs.includes(sel) ? favs : normal
      if (!list.length) return
      const i = list.indexOf(sel)
      pick(list[i < 0 ? 0 : (i + (back ? -1 : 1) + list.length) % list.length])
    }
    addEventListener('keydown', on, true)
    return () => removeEventListener('keydown', on, true)
  }, [])
  const [listTab, setListTab] = useState<'open' | 'closed'>('open'), [held, setHeld] = useState<Closed[]>([])
  const [unfav, setUnfav] = useState(false) // 즐겨찾기를 목록 위로 끌고 왔을 때
  // 목록 | 즐겨찾기 | 나머지(머리·대화·핀) 사이 경계를 끌어 너비를 바꾼다. 바꾼 비율은 이 브라우저에 남는다(핀·메모·btw 높이와 같은 방식)
  const { defaultLayout, onLayoutChanged } = useDefaultLayout({ id: 'hq-work' })
  return <Split key={ui.layoutKey} orientation="horizontal" defaultLayout={defaultLayout} onLayoutChanged={onLayoutChanged} style={{ height: '100%' }}>
    <Panel id="list" defaultSize={290} minSize={180} maxSize={560}>
    <Paper withBorder p={6} h="100%" className={unfav ? 'hq-drop-over' : undefined} style={{ minHeight: 0, display: 'flex', flexDirection: 'column', gap: 6 }}
      data-area="list" tabIndex={-1} onKeyDown={areaKeys(true)}
      onDragOver={e => { if (!dragging(e)) return; e.preventDefault(); setUnfav(true) }}
      onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setUnfav(false) }}
      onDrop={e => {
        setUnfav(false)
        const sid = e.dataTransfer.getData(DRAG)
        if (!sid || !inFav.has(sid)) return
        e.preventDefault()
        api('favs', { mode: S.favs.mode, items: S.favs.items.filter(x => x.sid !== sid) })
      }}>
      <Group justify="space-between" px={4} gap={4} wrap="nowrap">
        <SegmentedControl size="xs" value={listTab} onChange={v => { setListTab(v as 'open' | 'closed'); setHeld([]) }}
          data={[{ value: 'open', label: '세션 목록' }, { value: 'closed', label: '닫힌 세션' }]} />
        <KeyRec area="list" />
      </Group>
      <ScrollArea scrollbarSize={4} style={{ flex: 1 }}>
        {listTab === 'closed' ? <Box p={4}><ClosedList S={S} held={held} onOpen={async c => { setHeld(h => [...h, c]); if (!await api('session/reopen', { sid: c.sid })) setHeld(h => h.filter(x => x.sid !== c.sid)) }} /></Box>
        : <Stack gap="md" p={4}>
          {groups.map(g => <Stack key={g.id || 'none'} gap={2}>
            <UnstyledButton px={8} onClick={g.id ? () => setUI({ openTask: g.id }) : undefined} style={{ cursor: g.id ? 'pointer' : 'default' }}>
              <Group justify="space-between"><Text size="xs" fw={600} c="dimmed">{g.name}</Text><Text size="xs" c="dimmed">{g.ss.length}</Text></Group>
            </UnstyledButton>
            {ghost && !ui.pendingFav && ghost.task === g.id && <ItemSkeleton state={ghost.state} since={ghost.since} />}
            {g.ss.map(x => <Item key={x.pid} s={x} on={x.sid === ui.sel} memo={hasMemo(S, x.sid)} boot={bootOf(S, x.sid)} />)}
            {g.favs.map(x => <FavGhost key={x.pid} s={x} on={x.sid === ui.sel} />)}
            {!g.ss.length && !g.favs.length && !(ghost && !ui.pendingFav && ghost.task === g.id) && <Text size="xs" c="dimmed" px={8}>세션 없음</Text>}
          </Stack>)}
        </Stack>}
      </ScrollArea>
    </Paper>
    </Panel>
    <Separator className="hq-split-v" />
    <Panel id="favs" defaultSize={240} minSize={210} maxSize={480}><FavColumn S={S} sel={ui.sel} ghost={ghost} /></Panel>
    <Separator className="hq-split-v" />
    <Panel id="main" minSize={480}>
    {/* 새 세션을 여는 동안은 빈 세션(ghost)을 같은 자리·같은 모양으로 그리고 손만 못 대게 막는다(inert). 뜨면 같은 화면을 그대로 이어 쓴다:
        다른 요소로 바꿔 그리면 대화·입력칸이 처음부터 다시 그려져 한 번 깜박였다 */}
    {s || ghost ? <Box inert={!s} className="hq-ghost" aria-busy={!s || undefined}><SessionArea S={S} s={(s || ghost)!} /></Box> : <Paper withBorder p="xl" h="100%" style={{ borderStyle: 'dashed' }}>
      <Stack align="flex-start">
        <Text>왼쪽에서 세션을 고르거나, 새 세션으로 일을 시작하세요.</Text>
        <Button onClick={() => setUI({ newFor: '' })}>+ 새 세션</Button>
      </Stack>
    </Paper>}
    </Panel>
  </Split>
}
