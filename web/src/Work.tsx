// 작업 보기: 왼쪽 세션 목록(업무별로 묶음) + 오른쪽 고른 세션의 터미널
import { useState } from 'react'
import { createPortal } from 'react-dom'
import { Badge, Box, Button, Group, Paper, ScrollArea, SegmentedControl, Stack, Switch, Text, UnstyledButton } from '@mantine/core'
import { api, toast } from './store'
import { pick, setUI, useUI } from './ui'
import type { Session, Snapshot } from './types'
import { COLOR, LABEL, Since, bySt, cssColor, sessOf } from './util'
import { AssignSelect } from './parts'
import { TerminalView } from './Terminal'
import { ChatView } from './Chat'
import { SidePanel, hasMemo } from './Memo'
import { IconPinFilled } from '@tabler/icons-react'

function Item({ s, on, memo }: { s: Session; on: boolean; memo: boolean }) {
  return <UnstyledButton onClick={() => pick(s.sid)} p="7px 8px" w="100%"
    style={{ borderRadius: 8, background: on ? 'var(--mantine-color-indigo-light)' : undefined, boxShadow: on ? 'inset 0 0 0 1px var(--mantine-color-indigo-5)' : undefined }}>
    <Group gap={8} wrap="nowrap" align="flex-start">
      <Box w={8} h={8} mt={6} style={{ borderRadius: 2, flex: 'none', background: cssColor(s.state) }} />
      <Stack gap={0} style={{ minWidth: 0 }}>
        <Text size="sm" fw={600} className="hq-wrap" lh={1.35}>{s.title}{memo && <IconPinFilled size={12} style={{ marginLeft: 4, verticalAlign: -1, color: 'var(--mantine-color-orange-4)' }} aria-label="메모 있음" />}</Text>
        <Text size="xs" c="dimmed"><Text span c={`${COLOR[s.state]}.5`} fw={600}>{LABEL[s.state]}</Text> <Since t={s.since} suf="째" />
          {s.host !== 'web' && <Badge size="xs" variant="outline" color="gray" ml={6}>{s.host === 'orca' ? 'Orca' : '외부'}</Badge>}</Text>
      </Stack>
    </Group>
  </UnstyledButton>
}

function Head({ S, s, side, onSide }: { S: Snapshot; s: Session; side: boolean; onSide: () => void }) {
  const [confirm, setConfirm] = useState(false)
  return <Paper withBorder p="10px 12px">
    <Group gap="sm" wrap="wrap">
      <Stack gap={0} style={{ minWidth: 0, flex: '1 1 260px' }}>
        <Text fw={600} size="lg" className="hq-wrap">{s.title}</Text>
        <Text size="xs" c="dimmed">{s.cwd} · <Text span c={`${COLOR[s.state]}.5`} fw={600}>{LABEL[s.state]}</Text> <Since t={s.since} suf="째" />
          {s.act && <Text span ff="monospace" c="teal.5"> · {s.act}</Text>}</Text>
      </Stack>
      <Group gap={6}>
        <AssignSelect S={S} s={s} />
        {s.state === 'myturn' && <Button size="xs" variant="subtle" color="gray" onClick={() => api('seen', { sid: s.sid })}>확인함</Button>}
        <Button size="xs" variant="subtle" color="gray" onClick={onSide}>{side ? '오른쪽 칸 접기' : '핀·메모·질문 펼치기'}</Button>
        <Button size="xs" variant="subtle" color="gray" onClick={() => setUI({ openSess: s.sid })}>정보</Button>
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

// right: 화면이 넓을 때 App이 내주는 오른쪽 여백. 있으면 핀·메모·곁가지 질문을 거기에 놓고, 없으면 대화 옆 셋째 칸에 놓는다
export function WorkView({ S, right }: { S: Snapshot; right: HTMLElement | null }) {
  const ui = useUI()
  const groups = [...S.tasks.map(t => ({ id: t.id, name: t.name, ss: sessOf(S, t) })),
    { id: '', name: '미배치', ss: S.sessions.filter(s => !s.task).sort(bySt) }]
  const s = S.sessions.find(x => x.sid === ui.sel)
  // 기본은 웹 대화 화면. 웹 세션은 터미널 화면으로도 볼 수 있다(Claude Code의 화면이 그대로 필요할 때)
  const [view, setView] = useState(() => { try { return localStorage.getItem('hq-view') || 'chat' } catch { return 'chat' } })
  // 작업 과정(도구 사용)을 하나하나 볼지, 한 줄로 접어 볼지
  const [detail, setDetail] = useState(() => { try { return localStorage.getItem('hq-detail') === '1' } catch { return false } })
  // 오른쪽 칸(핀·메모·곁가지 질문). 기본으로 펼쳐 두고, 좁은 화면에서는 접는다
  const [side, setSide] = useState(() => { try { return localStorage.getItem('hq-side-open') !== '0' } catch { return true } })
  const toggleSide = () => setSide(v => { try { localStorage.setItem('hq-side-open', v ? '0' : '1') } catch { /* 무시 */ } return !v })
  const cols = 'minmax(220px, 290px) minmax(0, 1fr)' + (s && side && !right ? ' minmax(300px, 380px)' : '')
  return <Box style={{ display: 'grid', gridTemplateColumns: cols, gap: 12, height: '100%' }}>
    <Paper withBorder p={6} style={{ minHeight: 0, display: 'flex' }}>
      <ScrollArea style={{ flex: 1 }}>
        <Stack gap="md" p={4}>
          {groups.map(g => <Stack key={g.id || 'none'} gap={2}>
            <UnstyledButton px={8} onClick={g.id ? () => setUI({ openTask: g.id }) : undefined} style={{ cursor: g.id ? 'pointer' : 'default' }}>
              <Group justify="space-between"><Text size="xs" fw={600} c="dimmed">{g.name}</Text><Text size="xs" c="dimmed">{g.ss.length}</Text></Group>
            </UnstyledButton>
            {g.ss.map(x => <Item key={x.pid} s={x} on={x.sid === ui.sel} memo={hasMemo(S, x.sid)} />)}
            {!g.ss.length && <Text size="xs" c="dimmed" px={8}>세션 없음</Text>}
          </Stack>)}
          <ClosedList S={S} />
        </Stack>
      </ScrollArea>
    </Paper>
    <Stack gap={8} style={{ minWidth: 0, minHeight: 0 }}>
      {!s ? <Paper withBorder p="xl" style={{ flex: 1, borderStyle: 'dashed' }}>
        <Stack align="flex-start">
          <Text>{ui.pendingSel ? '세션을 여는 중입니다…' : '왼쪽에서 세션을 고르거나, 새 세션으로 일을 시작하세요.'}</Text>
          {!ui.pendingSel && <Button onClick={() => setUI({ newFor: '' })}>+ 새 세션</Button>}
        </Stack>
      </Paper> : <>
        <Head S={S} s={s} side={side} onSide={toggleSide} />
        <Group gap="md">
          {s.host === 'web' && <SegmentedControl size="xs" value={view} onChange={v => { setView(v); try { localStorage.setItem('hq-view', v) } catch { /* 무시 */ } }}
            data={[{ label: '대화', value: 'chat' }, { label: '터미널', value: 'term' }]} />}
          {(s.host !== 'web' || view === 'chat') && <Switch size="xs" label="작업 과정 자세히" checked={detail}
            onChange={e => { const v = e.currentTarget.checked; setDetail(v); try { localStorage.setItem('hq-detail', v ? '1' : '0') } catch { /* 무시 */ } }} />}
        </Group>
        <Box style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          {s.host === 'web' && view === 'term' ? <Box style={{ flex: 1, minHeight: 0 }}><TerminalView key={s.tmux} name={s.tmux} /></Box> : <ChatView key={s.pid} s={s} detail={detail} />}
        </Box>
      </>}
    </Stack>
    {s && side && (right ? createPortal(<SidePanel S={S} s={s} />, right) : <SidePanel S={S} s={s} />)}
  </Box>
}
