// 업무별·세션 전체 보기 + 오른쪽 '내 차례' 큐와 이벤트
import { useState } from 'react'
import { Badge, Box, Button, Group, Paper, Stack, Text, UnstyledButton } from '@mantine/core'
import { api, toast } from './store'
import { pick, setUI } from './ui'
import type { Session, Snapshot, Task } from './types'
import { COLOR, LABEL, Since, base, bySt, cssColor, lastOf, sessOf, stale, taskStatus, tint, tname, waiting } from './util'
import { AssignSelect, FeedList, ReplyForm, StatePill, WaitRow } from './parts'
import { Desk } from './Desk'

// 끌어다 놓기: 책상을 업무 카드나 미배치 칸에 놓으면 그 업무로 배치한다
let dragging = ''
function useDrop(S: Snapshot) {
  const [over, setOver] = useState<string | null>(null)
  const zone = (task: string) => ({
    className: over === task ? 'hq-drop-over' : undefined,
    onDragOver: (e: React.DragEvent) => { if (dragging) { e.preventDefault(); setOver(task) } },
    onDragLeave: (e: React.DragEvent) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setOver(null) },
    onDrop: async (e: React.DragEvent) => {
      e.preventDefault(); setOver(null)
      const sid = dragging; dragging = ''
      if (!sid || S.sessions.find(s => s.sid === sid)?.task === task) return
      if (await api('assign', { sid, task })) toast(task ? `"${tname(S, task)}"에 배치했습니다.` : '미배치로 돌렸습니다.')
    },
  })
  return zone
}

function DeskTile({ S, s, sel, showTask }: { S: Snapshot; s: Session; sel?: boolean; showTask?: boolean }) {
  const [drag, setDrag] = useState(false)
  return <Paper withBorder p="8px 10px" bg="var(--hq-floor)" draggable className={drag ? 'hq-dragging' : undefined}
    onDragStart={e => { dragging = s.sid; e.dataTransfer.setData('text/plain', s.sid); e.dataTransfer.effectAllowed = 'move'; setDrag(true) }}
    onDragEnd={() => { dragging = ''; setDrag(false) }}
    style={{ cursor: 'grab', borderColor: waiting(s) ? cssColor(s.state, 7) : undefined, minWidth: 0 }}>
    <UnstyledButton onClick={() => pick(s.sid)} w="100%" aria-label={`${s.title} 열기`}>
      <Group gap={10} wrap="nowrap" align="center">
        <Desk s={s} />
        <Stack gap={1} style={{ minWidth: 0 }}>
          <Text size="sm" fw={600} lh={1.35} className="hq-wrap">{s.title}</Text>
          <Text size="xs" c="dimmed"><Text span c={`${COLOR[s.state]}.5`} fw={600}>{LABEL[s.state]}</Text> <Since t={s.since} suf="째" /></Text>
          {s.act ? <Text size="xs" ff="monospace" c="teal.5" truncate title={s.act}>{s.act}</Text>
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

function TaskCard({ S, t, zone }: { S: Snapshot; t: Task; zone: ReturnType<typeof useDrop> }) {
  const st = taskStatus(S, t), ss = sessOf(S, t)
  return <Paper withBorder style={{ overflow: 'hidden' }} {...zone(t.id)}>
    <Stack gap={4} p="12px 14px 10px" bg={tint(st, 12)} style={{ borderBottom: '1px solid var(--mantine-color-default-border)' }}>
      <Group gap={8}><span className="hq-pixel">TASK</span>{stale(S, t) && <Badge color="pink" variant="light">정체 <Since t={lastOf(S, t)} /></Badge>}<Box ml="auto"><StatePill state={st} /></Box></Group>
      <UnstyledButton onClick={() => setUI({ openTask: t.id })}><Text fw={600} size="lg" className="hq-wrap">{t.name}</Text></UnstyledButton>
      <Text size="xs" c="dimmed">{t.memo ? t.memo + ' · ' : ''}마지막 진행 <Since t={lastOf(S, t)} suf=" 전" /></Text>
    </Stack>
    <Stack gap="sm" p="12px 14px 14px">
      <Group justify="space-between"><span className="hq-pixel">LIVE DESKS</span><Text size="xs" c="dimmed">세션 {ss.length} · 작업중 {ss.filter(s => s.state === 'working').length}</Text></Group>
      {ss.length ? <Box style={deskGrid}>{ss.map(s => <DeskTile key={s.sid} S={S} s={s} />)}</Box>
        : <Text size="sm" c="dimmed" ta="center" p="md" style={{ border: '1px dashed var(--mantine-color-default-border)', borderRadius: 9 }}>미배치 칸에서 세션을 끌어다 놓거나, 세션의 메뉴에서 이 업무를 고르세요.</Text>}
      {t.waits.map(w => <WaitRow key={w.id} t={t} w={w} />)}
      {t.next && <Group gap={8} wrap="nowrap" align="flex-start"><Badge variant="outline" color="gray" style={{ flex: 'none' }}>다음</Badge><Text size="sm">{t.next}</Text></Group>}
    </Stack>
  </Paper>
}

function Unassigned({ S, zone }: { S: Snapshot; zone: ReturnType<typeof useDrop> }) {
  const ss = S.sessions.filter(s => !s.task).sort(bySt), w = ss.filter(waiting).length
  return <Paper withBorder style={{ gridColumn: '1 / -1', borderStyle: 'dashed', overflow: 'hidden' }} {...zone('')}>
    <Stack gap={4} p="12px 14px 10px" style={{ borderBottom: '1px solid var(--mantine-color-default-border)' }}>
      <Group><span className="hq-pixel">UNASSIGNED</span><Box ml="auto"><StatePill state={w ? 'myturn' : 'idle'}>{ss.length}세션{w ? ` · 내 차례 ${w}` : ''}</StatePill></Box></Group>
      <Text fw={600} size="lg">미배치 세션</Text>
      <Text size="xs" c="dimmed">업무에 묶지 않은 세션입니다. 업무 카드로 끌어다 놓거나 메뉴에서 업무를 고르세요.</Text>
    </Stack>
    <Box p="12px 14px 14px">
      {ss.length ? <Box style={deskGrid}>{ss.map(s => <DeskTile key={s.sid} S={S} s={s} sel />)}</Box>
        : <Text size="sm" c="dimmed">모든 세션이 업무에 배치됐습니다.</Text>}
    </Box>
  </Paper>
}

function AllGroups({ S }: { S: Snapshot }) {
  if (!S.sessions.length) return <Paper withBorder p="md"><Text c="dimmed">열린 Claude 세션이 없습니다.</Text></Paper>
  return <Stack gap="md">{(['approval', 'myturn', 'working', 'idle'] as const).map(k => {
    const ss = S.sessions.filter(s => s.state === k).sort(bySt)
    if (!ss.length) return null
    return <Paper key={k} withBorder p="12px 14px 14px">
      <Group gap={8} mb={8}><Box w={8} h={8} style={{ borderRadius: 2, background: cssColor(k) }} /><Text fw={600} size="sm">{LABEL[k]}</Text><Text size="xs" c="dimmed">{ss.length}</Text></Group>
      <Box style={deskGrid}>{ss.map(s => <DeskTile key={s.sid} S={S} s={s} sel showTask />)}</Box>
    </Paper>
  })}</Stack>
}

function Queue({ S }: { S: Snapshot }) {
  const items = S.sessions.filter(waiting).sort(bySt)
  const ws = S.tasks.flatMap(t => t.waits.map(w => ({ t, w }))).sort((a, b) => a.w.since - b.w.since)
  return <Paper withBorder p="md">
    <Stack gap="sm">
      <Group gap={8}><Text fw={600} size="sm">지금 내 차례</Text><Text size="xs" c="dimmed" ff="monospace">{items.length}건</Text></Group>
      {items.length ? items.map(s => <Paper key={s.sid} p="10px 12px" bg={tint(s.state, 8)} style={{ border: `1px solid ${cssColor(s.state, 8)}` }}>
        <Stack gap={5}>
          <Group gap={8} wrap="nowrap"><StatePill state={s.state} /><Text size="xs" c="dimmed" truncate style={{ minWidth: 0 }}>{tname(S, s.task)}</Text>
            <Text size="xs" c="dimmed" ml="auto" style={{ flex: 'none' }}><Since t={s.since} suf="째" /></Text></Group>
          <UnstyledButton onClick={() => pick(s.sid)}><Text fw={600} size="sm" className="hq-wrap">{s.title}</Text></UnstyledButton>
          {s.msg && <Text size="xs" className="hq-msg" style={{ WebkitLineClamp: 5 }}>{s.msg}</Text>}
          <ReplyForm s={s} />
          <Group gap={6}>
            {s.host && <Button size="xs" variant="default" onClick={() => pick(s.sid)}>{s.host === 'web' ? '열기' : '웹으로 옮기기…'}</Button>}
            {s.state === 'myturn' && <Button size="xs" variant="subtle" color="gray" onClick={() => api('seen', { sid: s.sid })}>확인함 · 쉼으로</Button>}
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
  const zone = useDrop(S)
  return <Box style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 380px', gap: 16, alignItems: 'start' }} className="hq-board">
    <Box style={{ minWidth: 0 }}>
      {mode === 'task'
        ? <Box style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 390px), 1fr))', gap: 14 }}>
            {S.tasks.map(t => <TaskCard key={t.id} S={S} t={t} zone={zone} />)}
            <Unassigned S={S} zone={zone} />
          </Box>
        : <AllGroups S={S} />}
    </Box>
    <Stack gap="md">
      <Queue S={S} />
      <Paper withBorder p="md">
        <Group gap={8} mb="xs"><Text fw={600} size="sm">이벤트</Text><Text size="xs" c="dimmed">서버가 켜진 뒤 상태가 바뀐 순서</Text></Group>
        <FeedList S={S} items={S.feed} />
      </Paper>
    </Stack>
  </Box>
}
