// 오른쪽 서랍: 세션 정보, 업무 정보(이름·메모·다음 할 일, 사람 대기, 세션 목록)
import { useEffect, useState } from 'react'
import { Box, Button, Drawer, Group, Paper, Stack, Text, TextInput, Textarea, UnstyledButton } from '@mantine/core'
import { api, toast } from './store'
import { pick, setUI, useUI } from './ui'
import type { Snapshot, Task } from './types'
import { COLOR, LABEL, Since, lastOf, sessOf, stale, taskStatus } from './util'
import { AssignSelect, FeedList, ReplyForm, StatePill, WaitRow } from './parts'
import { Desk } from './Desk'

const Box2 = ({ label, children }: { label: string; children: React.ReactNode }) =>
  <Paper withBorder p="sm"><span className="hq-pixel">{label}</span><Text size="sm" className="hq-msg" mah={320} style={{ overflow: 'auto' }}>{children}</Text></Paper>

export function SessionDrawer({ S }: { S: Snapshot }) {
  const ui = useUI()
  const s = S.sessions.find(x => x.sid === ui.openSess)
  return <Drawer opened={!!s} onClose={() => setUI({ openSess: null })} position="right" size={600}
    title={s && <Stack gap={0}><span className="hq-pixel">SESSION · {s.name}</span><Text fw={600} size="lg" className="hq-wrap">{s.title}</Text></Stack>}>
    {s && <Stack gap="md">
      <Text size="xs" c="dimmed">{s.cwd} · pid {s.pid} · 연 지 <Since t={s.startedAt} /></Text>
      <Group gap={8}><StatePill state={s.state} /><Text size="xs" c="dimmed"><Since t={s.since} suf="째" /></Text>{s.act && <Text size="xs" ff="monospace" c={`${COLOR.working}.5`}>{s.act}</Text>}</Group>
      <Box><Text size="xs" c="dimmed" mb={4}>업무 배치</Text><AssignSelect S={S} s={s} size="sm" /></Box>
      <Group gap={6}>
        <Button size="xs" variant="default" onClick={() => pick(s.sid)}>작업 보기에서 열기</Button>
        {s.state === 'myturn' && <Button size="xs" variant="subtle" color="gray" onClick={() => api('seen', { sid: s.sid })}>알겠어, 쉬어</Button>}
        {s.task && <Button size="xs" variant="subtle" color="gray" onClick={() => setUI({ openSess: null, openTask: s.task })}>업무 보기</Button>}
      </Group>
      <ReplyForm s={s} />
      {s.prompt && <Box2 label="LAST ORDER">{s.prompt}</Box2>}
      {s.msg && <Box2 label="LAST REPLY">{s.msg}</Box2>}
      <span className="hq-pixel">EVENTS</span>
      <FeedList S={S} items={S.feed.filter(e => e.sid === s.sid)} showTask={false} />
    </Stack>}
  </Drawer>
}

function TaskForm({ t }: { t: Task }) {
  const [v, setV] = useState({ name: t.name, memo: t.memo, next: t.next })
  const [confirm, setConfirm] = useState(false)
  useEffect(() => { setV({ name: t.name, memo: t.memo, next: t.next }) }, [t.id, t.updatedAt])
  return <form onSubmit={async e => { e.preventDefault(); if (await api('task/update', { id: t.id, ...v })) toast('저장했습니다.') }}>
    <Stack gap="xs">
      <TextInput label="업무 이름" value={v.name} maxLength={120} onChange={e => setV({ ...v, name: e.currentTarget.value })} />
      <TextInput label="관련 사람·메모" value={v.memo} maxLength={500} onChange={e => setV({ ...v, memo: e.currentTarget.value })} />
      <Textarea label="다음 할 일" autosize minRows={2} value={v.next} maxLength={500} onChange={e => setV({ ...v, next: e.currentTarget.value })} />
      <Group justify="space-between">
        <Button type="submit" size="xs">저장</Button>
        <Button size="xs" variant="outline" color="red" onBlur={() => setConfirm(false)} onClick={async () => {
          if (!confirm) { setConfirm(true); return }
          setUI({ openTask: null })
          if (await api('task/delete', { id: t.id })) toast('업무를 삭제했습니다. 배치됐던 세션은 미배치로 돌아갑니다.')
        }}>{confirm ? '한 번 더 누르면 삭제' : '업무 삭제'}</Button>
      </Group>
    </Stack>
  </form>
}

function AddWait({ t }: { t: Task }) {
  const [who, setWho] = useState(''), [what, setWhat] = useState('')
  return <form onSubmit={async e => {
    e.preventDefault()
    if (!who.trim() || !what.trim()) { toast('누구와 무엇을 둘 다 적어 주세요.', 'red'); return }
    if (await api('wait/add', { task: t.id, who, what })) { setWho(''); setWhat('') }
  }}>
    <Group gap={6} wrap="wrap">
      <TextInput size="xs" placeholder="누구 (예: 박과장)" value={who} onChange={e => setWho(e.currentTarget.value)} style={{ flex: '1 1 120px' }} />
      <TextInput size="xs" placeholder="무엇을 기다리나 (예: 테스트 결과 회신)" value={what} onChange={e => setWhat(e.currentTarget.value)} style={{ flex: '2 1 200px' }} />
      <Button size="xs" variant="default" type="submit">대기 추가</Button>
    </Group>
  </form>
}

export function TaskDrawer({ S }: { S: Snapshot }) {
  const ui = useUI()
  const t = S.tasks.find(x => x.id === ui.openTask)
  const ss = t ? sessOf(S, t) : []
  return <Drawer opened={!!t} onClose={() => setUI({ openTask: null })} position="right" size={600}
    title={t && <Stack gap={0}><span className="hq-pixel">TASK</span><Text fw={600} size="lg" className="hq-wrap">{t.name}</Text></Stack>}>
    {t && <Stack gap="md">
      <Group gap={8}><StatePill state={taskStatus(S, t)} />{stale(S, t) && <StatePill state="closed">정체</StatePill>}
        <Text size="xs" c="dimmed">마지막 진행 <Since t={lastOf(S, t)} suf=" 전" /></Text></Group>
      <TaskForm t={t} />
      <Group justify="space-between"><span className="hq-pixel">SESSIONS · {ss.length}</span><Button size="xs" variant="default" onClick={() => setUI({ openTask: null, newFor: t.id })}>+ 이 업무로 새 세션</Button></Group>
      {ss.length ? ss.map(s => <UnstyledButton key={s.pid} onClick={() => pick(s.sid)}>
        <Paper withBorder p="8px 10px"><Group gap="sm" wrap="nowrap">
          <Desk s={s} size={56} />
          <Stack gap={1} style={{ minWidth: 0 }}>
            <Text fw={600} size="sm" className="hq-wrap">{s.title}</Text>
            <Text size="xs" c="dimmed"><Text span c={`${COLOR[s.state]}.5`} fw={600}>{LABEL[s.state]}</Text> <Since t={s.since} suf="째" /></Text>
            {s.msg && <Text size="xs" className="hq-msg" style={{ WebkitLineClamp: 2 }}>{s.msg}</Text>}
          </Stack>
        </Group></Paper>
      </UnstyledButton>) : <Text size="sm" c="dimmed">배치된 세션이 없습니다. 미배치 칸에서 끌어다 놓으세요.</Text>}
      <span className="hq-pixel">PEOPLE</span>
      {t.waits.length ? t.waits.map(w => <WaitRow key={w.id} t={t} w={w} />) : <Text size="sm" c="dimmed">이 업무에서 기다리는 사람은 없습니다.</Text>}
      <AddWait t={t} />
      <span className="hq-pixel">EVENTS</span>
      <FeedList S={S} items={S.feed.filter(e => e.task === t.id)} showTask={false} />
    </Stack>}
  </Drawer>
}
