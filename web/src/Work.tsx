// 작업 보기: 왼쪽 세션 목록(업무별로 묶음) | 즐겨찾기 | 고른 세션(머리 + 대화) | 핀·메모·btw
import { useEffect, useRef, useState } from 'react'
import { Badge, Box, Button, Group, Paper, ScrollArea, SegmentedControl, Skeleton, Stack, Text, UnstyledButton } from '@mantine/core'
import { api, toast } from './store'
import { pick, setUI, useUI } from './ui'
import type { Session, Snapshot } from './types'
import { COLOR, LABEL, Since, bySt, cssColor, sessOf } from './util'
import { AssignSelect } from './parts'
import { TerminalView } from './Terminal'
import { ChatView, copyText } from './Chat'
import { SidePanel, hasMemo } from './Memo'
import { IconPinFilled } from '@tabler/icons-react'
import { Group as Split, Panel, Separator, useDefaultLayout } from 'react-resizable-panels'

// 목록·즐겨찾기의 세션 한 줄. 끌어서 즐겨찾기에 넣고 빼고, 즐겨찾기 안에서 자리를 옮긴다(HTML 끌어다 놓기, 넘기는 값은 대화 ID)
const DRAG = 'application/x-hq-sid'
const dragging = (e: React.DragEvent) => e.dataTransfer.types.includes(DRAG)
let dragSid = '' // 끄는 중에는 dataTransfer 값을 읽을 수 없어서(놓을 때만 된다) 따로 둔다. 제 자리는 빈 칸으로 본다
function Item({ s, on, memo, clamp }: { s: Session; on: boolean; memo: boolean; clamp?: boolean }) {
  // 고른 세션은 목록에서 보이게 스크롤한다(새로고침·Ctrl+Tab·다른 데서 열기). 고른 순간에만 해서, 손으로 스크롤한 목록을 되돌리지 않는다
  const ref = useRef<HTMLButtonElement>(null)
  useEffect(() => { if (on) ref.current?.scrollIntoView({ block: 'nearest' }) }, [on])
  return <UnstyledButton ref={ref} draggable onDragStart={e => { dragSid = s.sid; e.dataTransfer.setData(DRAG, s.sid); e.dataTransfer.effectAllowed = 'move' }} onClick={() => pick(s.sid)} p="7px 8px" w="100%" className="hq-item"
    style={{ borderRadius: 8, background: on ? 'var(--mantine-color-indigo-light)' : undefined, boxShadow: on ? 'inset 0 0 0 1px var(--mantine-color-indigo-5)' : undefined }}>
    <Group gap={8} wrap="nowrap" align="flex-start">
      <Box w={8} h={8} mt={6} className={'hq-dot' + (s.state === 'working' || s.state === 'compact' ? ' busy' : '')} style={{ borderRadius: 2, flex: 'none', background: cssColor(s.state) }} />
      <Stack gap={0} style={{ minWidth: 0 }}>
        <Text size="sm" fw={600} className="hq-wrap" lh={1.35} lineClamp={clamp ? 2 : undefined} title={clamp ? s.title : undefined}>{s.title}{memo && <IconPinFilled size={12} style={{ marginLeft: 4, verticalAlign: -1, color: 'var(--mantine-color-orange-4)' }} aria-label="메모 있음" />}</Text>
        <Text size="xs" c="dimmed"><Text span c={`${COLOR[s.state]}.5`} fw={600}>{LABEL[s.state]}</Text> <Since t={s.since} suf="째" />
          {s.host !== 'web' && <Badge size="xs" variant="outline" color="gray" ml={6}>{s.host === 'orca' ? 'Orca' : '외부'}</Badge>}</Text>
      </Stack>
    </Group>
  </UnstyledButton>
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
    <Text component="div" fw={600} size="lg" className="hq-wrap">{want || s.title}</Text>
  </UnstyledButton>
}

function Head({ S, s }: { S: Snapshot; s: Session }) {
  const [confirm, setConfirm] = useState(false)
  return <Paper withBorder p="10px 12px">
    <Group gap="sm" wrap="wrap">
      <Stack gap={0} style={{ minWidth: 0, flex: '1 1 260px' }}>
        {/* 제목은 Claude가 정해서 아직 모른다. 같은 글줄 안에 반짝이를 넣어 높이를 똑같이 맞춘다 */}
        {s.sid ? <Title s={s} /> : <Text component="div" fw={600} size="lg"><Skeleton h="0.9em" w="38%" display="inline-block" style={{ verticalAlign: 'middle' }} /></Text>}
        <Text size="xs" c="dimmed">{s.cwd && `${s.cwd} · `}<Text span c={`${COLOR[s.state]}.5`} fw={600}>{LABEL[s.state]}</Text> <Since t={s.since} suf="째" />
          {/* 세션 이름: 상태줄에 보이고 다른 Claude가 이 세션을 부르는 이름. 제목과 다를 때만(이름을 안 바꾼 세션) 보이고 누르면 복사한다 */}
          {s.sid && s.name && s.name !== s.title && <UnstyledButton component="span" className="hq-name" title="세션 이름(다른 Claude가 부르는 이름). 누르면 복사" onClick={async () => { if (await copyText(s.name)) toast(`세션 이름 ${s.name}을 복사했습니다.`) }}> · @{s.name}</UnstyledButton>}
          {s.act && <Text span ff="monospace" c="teal.5"> · {s.act}</Text>}</Text>
      </Stack>
      <Group gap={6}>
        <AssignSelect S={S} s={s} />
        {s.state === 'myturn' && <Button size="xs" variant="subtle" color="gray" onClick={() => api('seen', { sid: s.sid })}>확인함</Button>}
        <Button size="xs" variant="subtle" color="gray" onClick={() => setUI({ openSess: s.sid })}>정보</Button>
        {s.host === 'web' && <Button size="xs" variant="outline" color="orange" title="전역 CLAUDE.md·.zshrc 등을 바꾼 뒤. 같은 대화로 다시 띄워 이어집니다(일하는 중이어도 끊습니다)" onClick={async () => {
          if (await api('session/restart', { names: [s.tmux] })) toast('세션을 다시 띄웁니다. 대화는 그대로 이어집니다.')
        }}>세션 재시작</Button>}
        {s.host === 'web' && <Button size="xs" variant="outline" color="red" onBlur={() => setConfirm(false)} onClick={async () => {
          if (!confirm) { setConfirm(true); return }
          setConfirm(false)
          if (await api('session/close', { name: s.tmux })) toast('세션을 종료했습니다. 대화 기록은 남아 있습니다.')
        }}>{confirm ? '한 번 더 누르면 종료' : '세션 종료'}</Button>}
      </Group>
    </Group>
  </Paper>
}

// 최근 닫힌 세션: 대화는 남아 있으니 웹에서 같은 옵션으로 다시 연다
function ClosedList({ S }: { S: Snapshot }) {
  const [open, setOpen] = useState(false)
  if (!S.closed.length) return null
  return <Stack gap={2}>
    <UnstyledButton px={8} onClick={() => setOpen(o => !o)}>
      <Group justify="space-between"><Text size="xs" fw={600} c="dimmed">{open ? '▾' : '▸'} 최근 닫힌 세션</Text><Text size="xs" c="dimmed">{S.closed.length}</Text></Group>
    </UnstyledButton>
    {open && <>
      {S.closed.map(c => <Group key={c.sid} gap={6} wrap="nowrap" px={8} py={4} align="flex-start">
        <Stack gap={0} style={{ minWidth: 0, flex: 1 }}>
          <Text size="sm" className="hq-wrap" lh={1.35} c="dimmed">{c.title}</Text>
          <Text size="xs" c="dimmed">{c.cwd} · <Since t={c.closedAt} suf=" 전" /></Text>
        </Stack>
        <Button size="compact-xs" variant="light" onClick={async () => { if (await api('session/reopen', { sid: c.sid })) toast('웹에서 다시 열었습니다.') }}>다시 열기</Button>
      </Group>)}
      <Group gap={6} px={8}>
        <Button size="compact-xs" variant="subtle" onClick={async () => { const r = await api<string[]>('session/reopen', { sids: S.closed.map(c => c.sid) }); if (r) toast(`${r.result.length}개를 다시 열었습니다.`) }}>모두 다시 열기</Button>
        <Button size="compact-xs" variant="subtle" color="gray" onClick={() => api('session/forget-closed', {})}>목록 비우기</Button>
      </Group>
    </>}
  </Stack>
}

// 새 세션을 여는 동안(Claude가 뜨는 데 2~3초) 목록에서 그 세션이 들어갈 자리
function ItemSkeleton({ state, since }: { state: Session['state']; since: number }) {
  return <Group gap={8} wrap="nowrap" align="flex-start" p="7px 8px">
    <Box w={8} h={8} mt={6} className="hq-dot" style={{ borderRadius: 2, flex: 'none', background: cssColor(state) }} />
    <Stack gap={0} style={{ flex: 1, minWidth: 0 }}><Text component="div" size="sm" fw={600} lh={1.35}><Skeleton h="0.9em" w="80%" display="inline-block" style={{ verticalAlign: 'middle' }} /></Text>
      <Text size="xs" c="dimmed"><Text span c={`${COLOR[state]}.5`} fw={600}>{LABEL[state]}</Text> <Since t={since} suf="째" /></Text></Stack>
  </Group>
}
// 새 세션을 여는 동안: 진짜 세션 화면을 빈 세션(ghost)으로 그리고 손만 못 대게 막는다(inert. disabled로 막으면 버튼 모양·크기가 바뀌어 뜰 때 움찔한다).
// 폴더·상태·버튼·칸 제목·입력칸은 그대로 보이고, 아직 모르는 제목·핀·대화만 반짝인다. 배치가 같아 세션이 뜰 때 튀지 않는다
function WorkSkeleton({ S, ghost }: { S: Snapshot; ghost: Session }) {
  return <Box inert className="hq-ghost" aria-busy="true"><SessionArea S={S} s={ghost} /></Box>
}
// 고른 세션: 위 머리(두 칸에 걸침) / 아래 대화 | 핀·메모·btw. 오른쪽 칸은 대화창과 같은 높이에서 시작한다
function SessionArea({ S, s }: { S: Snapshot; s: Session }) {
  const ui = useUI()
  return <Box className={s.sid ? undefined : 'hq-fade'} style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(300px, 420px)', gridTemplateRows: 'auto minmax(0, 1fr)', gap: 12, height: '100%' }}>
    <Box style={{ gridColumn: '1 / -1', minWidth: 0 }}><Head S={S} s={s} /></Box>
    <Box style={{ gridColumn: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      {s.sid && s.host === 'web' && ui.view === 'term' ? <Box style={{ flex: 1, minHeight: 0 }}><TerminalView key={s.tmux} name={s.tmux} /></Box> : <ChatView key={s.pid} s={s} detail={ui.detail} />}
    </Box>
    <Box style={{ gridColumn: 2, gridRow: 2, minHeight: 0 }}><SidePanel S={S} s={s} /></Box>
  </Box>
}

// 일반 목록에 남는 즐겨찾기 세션의 자리: 흐린 한 줄. 누르면 그 세션을 연다(고른 표시는 즐겨찾기 칸에)
function FavGhost({ s, on }: { s: Session; on: boolean }) {
  return <UnstyledButton onClick={() => pick(s.sid)} p="4px 8px" w="100%" className="hq-item hq-favghost" style={{ borderRadius: 8, opacity: on ? .8 : .45 }} title="즐겨찾기에 있습니다">
    <Group gap={8} wrap="nowrap"><Text size="xs" c="yellow.5" style={{ flex: 'none' }}>★</Text><Text size="xs" truncate style={{ minWidth: 0 }}>{s.title}</Text><Text size="xs" c="dimmed" style={{ flex: 'none' }}>즐겨찾기</Text></Group>
  </UnstyledButton>
}

// 즐겨찾기 칸. 비어 있어도 칸은 늘 있다(끌어다 놓을 자리).
// 자동 정렬: 넣은 순서대로 위부터 빈틈없이, 놓은 높이에 끼워 넣는다. 자유 배치: 바탕화면 아이콘처럼 원하는 높이의 칸(SLOT)에 놓고, 찬 칸이면 가장 가까운 빈 칸으로 간다(겹치지 않는다)
const SLOT = 66 // 자유 배치의 칸 높이. 제목은 두 줄까지 보이고 넘치면 잘라 칸을 넘지 않는다
type Fav = Snapshot['favs']['items'][number]
export const favSids = (S: Snapshot) => {
  const live = new Set(S.sessions.map(s => s.sid)), f = S.favs || { mode: 'auto', items: [] }
  const items = f.items.filter(x => live.has(x.sid))
  return (f.mode === 'free' ? [...items].sort((a, b) => a.slot - b.slot) : items).map(x => x.sid)
}
function Favs({ S, sel }: { S: Snapshot; sel: string }) {
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
    onDragOver={e => { if (!dragging(e)) return; e.preventDefault(); setHover(target(e, dragSid)) }}
    onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setHover(null) }} onDrop={drop}>
    <Group justify="space-between" px={4} gap={4} wrap="nowrap">
      <Text size="xs" fw={600} c="dimmed">즐겨찾기</Text>
      <SegmentedControl size="xs" value={f.mode} onChange={mode} data={[{ label: '자동 정렬', value: 'auto' }, { label: '자유 배치', value: 'free' }]} />
    </Group>
    <ScrollArea style={{ flex: 1 }}>
      <Box ref={box} pos="relative" style={{ minHeight: f.mode === 'free' ? (rows + 1) * SLOT : undefined }}>
        {!live.length && hover === null && <Text size="xs" c="dimmed" p={8}>목록에서 대화를 끌어다 놓으세요. 빼려면 목록으로 다시 끌어다 놓습니다.</Text>}
        {f.mode === 'free'
          ? <>
              {hover !== null && <Box className="hq-fav-ghost" style={{ top: hover * SLOT, height: SLOT }} />}
              {live.map(x => <Box key={x.sid} data-fav={x.sid} pos="absolute" left={0} right={0} className="hq-slide" style={{ top: x.slot * SLOT, height: SLOT }}>
                <Item s={byId.get(x.sid)!} on={x.sid === sel} memo={hasMemo(S, x.sid)} clamp />
              </Box>)}
            </>
          : <Stack gap={2}>
              {live.filter(x => x.sid !== dragSid || hover === null).map((x, i) => <Box key={x.sid} data-fav={x.sid}>
                {hover === i && <Box className="hq-fav-line" />}
                <Item s={byId.get(x.sid)!} on={x.sid === sel} memo={hasMemo(S, x.sid)} />
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
  const groups = [...S.tasks.map(t => ({ id: t.id, name: t.name, all: sessOf(S, t) })), { id: '', name: '미배치', all: S.sessions.filter(s => !s.task).sort(bySt) }]
    .map(g => ({ ...g, ss: g.all.filter(x => !inFav.has(x.sid)), favs: g.all.filter(x => inFav.has(x.sid)) }))
  const s = S.sessions.find(x => x.sid === ui.sel)
  // 새 세션을 여는 동안 쓸 빈 세션. 뜰 때의 상태(첫 지시가 있으면 작업중, 없으면 내 차례)와 폴더를 미리 안다
  const [opened] = useState(() => new Map<string, number>())
  if (ui.pendingSel && !opened.has(ui.pendingSel)) opened.set(ui.pendingSel, Date.now())
  const ghost: Session | null = ui.pendingSel ? { pid: 0, sid: '', name: '', title: '', cwd: ui.pendingCwd, dir: '', state: ui.pendingWorking ? 'working' : 'myturn',
    since: opened.get(ui.pendingSel)!, startedAt: 0, act: '', msg: '', prompt: '', task: ui.pendingTask, host: 'web', tmux: ui.pendingSel, pin: [] } : null
  // Ctrl+Tab / Ctrl+Shift+Tab: 지금 세션이 즐겨찾기에 있으면 즐겨찾기 안에서, 아니면 목록 안에서 다음·이전으로(끝에서 처음으로 돈다).
  // 크롬은 일반 탭에서 이 키를 탭 전환에 먼저 쓴다. '앱으로 설치'한 창에서는 브라우저가 키를 가져가지 않아 여기로 온다
  const order = useRef({ favs, normal: [] as string[], sel: '' })
  order.current = { favs, normal: groups.flatMap(g => g.ss.map(x => x.sid)), sel: ui.sel }
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (e.key !== 'Tab' || !e.ctrlKey || e.altKey || e.metaKey) return
      e.preventDefault(); e.stopPropagation()
      const { favs, normal, sel } = order.current, list = favs.includes(sel) ? favs : normal
      if (!list.length) return
      const i = list.indexOf(sel)
      pick(list[i < 0 ? 0 : (i + (e.shiftKey ? -1 : 1) + list.length) % list.length])
    }
    addEventListener('keydown', on, true)
    return () => removeEventListener('keydown', on, true)
  }, [])
  const [unfav, setUnfav] = useState(false) // 즐겨찾기를 목록 위로 끌고 왔을 때
  // 목록 | 즐겨찾기 | 나머지(머리·대화·핀) 사이 경계를 끌어 너비를 바꾼다. 바꾼 비율은 이 브라우저에 남는다(핀·메모·btw 높이와 같은 방식)
  const { defaultLayout, onLayoutChanged } = useDefaultLayout({ id: 'hq-work' })
  return <Split key={ui.layoutKey} orientation="horizontal" defaultLayout={defaultLayout} onLayoutChanged={onLayoutChanged} style={{ height: '100%' }}>
    <Panel id="list" defaultSize={290} minSize={180} maxSize={560}>
    <Paper withBorder p={6} h="100%" className={unfav ? 'hq-drop-over' : undefined} style={{ minHeight: 0, display: 'flex' }}
      onDragOver={e => { if (!dragging(e)) return; e.preventDefault(); setUnfav(true) }}
      onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setUnfav(false) }}
      onDrop={e => {
        setUnfav(false)
        const sid = e.dataTransfer.getData(DRAG)
        if (!sid || !inFav.has(sid)) return
        e.preventDefault()
        api('favs', { mode: S.favs.mode, items: S.favs.items.filter(x => x.sid !== sid) })
      }}>
      <ScrollArea style={{ flex: 1 }}>
        <Stack gap="md" p={4}>
          {groups.map(g => <Stack key={g.id || 'none'} gap={2}>
            <UnstyledButton px={8} onClick={g.id ? () => setUI({ openTask: g.id }) : undefined} style={{ cursor: g.id ? 'pointer' : 'default' }}>
              <Group justify="space-between"><Text size="xs" fw={600} c="dimmed">{g.name}</Text><Text size="xs" c="dimmed">{g.ss.length}</Text></Group>
            </UnstyledButton>
            {ghost && ghost.task === g.id && <ItemSkeleton state={ghost.state} since={ghost.since} />}
            {g.ss.map(x => <Item key={x.pid} s={x} on={x.sid === ui.sel} memo={hasMemo(S, x.sid)} />)}
            {g.favs.map(x => <FavGhost key={x.pid} s={x} on={x.sid === ui.sel} />)}
            {!g.ss.length && !g.favs.length && !(ghost && ghost.task === g.id) && <Text size="xs" c="dimmed" px={8}>세션 없음</Text>}
          </Stack>)}
          <ClosedList S={S} />
        </Stack>
      </ScrollArea>
    </Paper>
    </Panel>
    <Separator className="hq-split-v" />
    <Panel id="favs" defaultSize={240} minSize={210} maxSize={480}><Favs S={S} sel={ui.sel} /></Panel>
    <Separator className="hq-split-v" />
    <Panel id="main" minSize={480}>
    {/* 나머지: 2행 격자. 위: 세션 머리(두 칸에 걸침) / 아래: 대화 | 핀·메모·btw. 오른쪽 칸이 대화창과 같은 높이에서 시작한다 */}
    {!s && ghost ? <WorkSkeleton S={S} ghost={ghost} /> : !s ? <Paper withBorder p="xl" h="100%" style={{ borderStyle: 'dashed' }}>
      <Stack align="flex-start">
        <Text>왼쪽에서 세션을 고르거나, 새 세션으로 일을 시작하세요.</Text>
        <Button onClick={() => setUI({ newFor: '' })}>+ 새 세션</Button>
      </Stack>
    </Paper> : <SessionArea S={S} s={s} />}
    </Panel>
  </Split>
}
