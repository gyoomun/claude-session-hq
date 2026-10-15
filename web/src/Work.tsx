// 작업 보기: 왼쪽 세션 목록(업무별로 묶음) + 오른쪽 고른 세션의 터미널
import { useState } from 'react'
import { Badge, Box, Button, Group, Paper, ScrollArea, SegmentedControl, Stack, Text, UnstyledButton } from '@mantine/core'
import { api, toast } from './store'
import { pick, setUI, useUI } from './ui'
import type { Session, Snapshot } from './types'
import { COLOR, LABEL, Since, bySt, cssColor, sessOf } from './util'
import { AssignSelect } from './parts'
import { TerminalView } from './Terminal'
import { ChatView } from './Chat'
import { BtwPanel } from './Btw'

function Item({ s, on }: { s: Session; on: boolean }) {
  return <UnstyledButton onClick={() => pick(s.sid)} p="7px 8px" w="100%"
    style={{ borderRadius: 8, background: on ? 'var(--mantine-color-indigo-light)' : undefined, boxShadow: on ? 'inset 0 0 0 1px var(--mantine-color-indigo-5)' : undefined }}>
    <Group gap={8} wrap="nowrap" align="flex-start">
      <Box w={8} h={8} mt={6} style={{ borderRadius: 2, flex: 'none', background: cssColor(s.state) }} />
      <Stack gap={0} style={{ minWidth: 0 }}>
        <Text size="sm" fw={600} className="hq-wrap" lh={1.35}>{s.title}</Text>
        <Text size="xs" c="dimmed"><Text span c={`${COLOR[s.state]}.5`} fw={600}>{LABEL[s.state]}</Text> <Since t={s.since} suf="째" />
          {s.host !== 'web' && <Badge size="xs" variant="outline" color="gray" ml={6}>{s.host === 'orca' ? 'Orca' : '외부'}</Badge>}</Text>
      </Stack>
    </Group>
  </UnstyledButton>
}

function Head({ S, s, btw, onBtw }: { S: Snapshot; s: Session; btw: boolean; onBtw: () => void }) {
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
        <Button size="xs" variant={btw ? 'light' : 'subtle'} color={btw ? 'indigo' : 'gray'} onClick={onBtw}>곁가지 질문{(S.btw?.[s.sid] || []).some(x => x.state === 'asking') ? ' …' : ''}</Button>
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

export function WorkView({ S }: { S: Snapshot }) {
  const ui = useUI()
  const groups = [...S.tasks.map(t => ({ id: t.id, name: t.name, ss: sessOf(S, t) })),
    { id: '', name: '미배치', ss: S.sessions.filter(s => !s.task).sort(bySt) }]
  const s = S.sessions.find(x => x.sid === ui.sel)
  // 기본은 웹 대화 화면. 웹 세션은 터미널 화면으로도 볼 수 있다(Claude Code의 화면이 그대로 필요할 때)
  const [view, setView] = useState(() => { try { return localStorage.getItem('hq-view') || 'chat' } catch { return 'chat' } })
  const [btw, setBtw] = useState(() => { try { return localStorage.getItem('hq-btw') === '1' } catch { return false } })
  const toggleBtw = () => setBtw(v => { try { localStorage.setItem('hq-btw', v ? '0' : '1') } catch { /* 무시 */ } return !v })
  return <Box style={{ display: 'grid', gridTemplateColumns: 'minmax(220px, 290px) minmax(0, 1fr)', gap: 12, height: 'calc(100vh - 250px)', minHeight: 460 }}>
    <Paper withBorder p={6} style={{ minHeight: 0, display: 'flex' }}>
      <ScrollArea style={{ flex: 1 }}>
        <Stack gap="md" p={4}>
          {groups.map(g => <Stack key={g.id || 'none'} gap={2}>
            <UnstyledButton px={8} onClick={g.id ? () => setUI({ openTask: g.id }) : undefined} style={{ cursor: g.id ? 'pointer' : 'default' }}>
              <Group justify="space-between"><Text size="xs" fw={600} c="dimmed">{g.name}</Text><Text size="xs" c="dimmed">{g.ss.length}</Text></Group>
            </UnstyledButton>
            {g.ss.map(x => <Item key={x.sid} s={x} on={x.sid === ui.sel} />)}
            {!g.ss.length && <Text size="xs" c="dimmed" px={8}>세션 없음</Text>}
          </Stack>)}
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
        <Head S={S} s={s} btw={btw} onBtw={toggleBtw} />
        {s.host === 'web' && <SegmentedControl size="xs" value={view} onChange={v => { setView(v); try { localStorage.setItem('hq-view', v) } catch { /* 무시 */ } }}
          data={[{ label: '대화', value: 'chat' }, { label: '터미널', value: 'term' }]} style={{ alignSelf: 'flex-start' }} />}
        <Box style={{ flex: 1, minHeight: 0, display: 'grid', gridTemplateColumns: btw ? 'minmax(0, 1fr) 340px' : 'minmax(0, 1fr)', gap: 8 }}>
          <Box style={{ minHeight: 0, display: 'flex', flexDirection: 'column' }}>
            {s.host === 'web' && view === 'term' ? <Box style={{ flex: 1, minHeight: 0 }}><TerminalView key={s.tmux} name={s.tmux} /></Box> : <ChatView key={s.sid} s={s} />}
          </Box>
          {btw && <BtwPanel S={S} s={s} onClose={toggleBtw} />}
        </Box>
      </>}
    </Stack>
  </Box>
}
