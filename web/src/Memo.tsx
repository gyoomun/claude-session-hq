// 대화 옆 패널(핀·메모·곁가지 질문)과 메모 보기(F4).
// 핀: Claude 핀보드 모드가 올린 할 일·결정할 것(읽기만). 메모: Claude가 알 수 없는 사정을 내가 적거나, 내가 시킬 때 Claude가 적는다(skills/hq-memo)
import { useState } from 'react'
import { Badge, Box, Button, Checkbox, CloseButton, Group, Paper, ScrollArea, SimpleGrid, Stack, Tabs, Text, Textarea, UnstyledButton } from '@mantine/core'
import { api } from './store'
import { pick } from './ui'
import type { Memo, Session, Snapshot } from './types'
import { Since } from './util'
import { BtwTab } from './Btw'

const enter = (f: () => void) => (e: React.KeyboardEvent) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); f() }
}
export const hasMemo = (S: Snapshot, sid: string) => !!S.memos?.[sid]?.items.some(m => !m.done)

function MemoRow({ sid, m }: { sid: string; m: Memo }) {
  const [edit, setEdit] = useState<string | null>(null)
  const save = async () => { if (edit !== null && edit.trim() && edit !== m.text && !await api('memo/update', { sid, id: m.id, text: edit })) return; setEdit(null) }
  return <Group gap={8} wrap="nowrap" align="flex-start">
    <Checkbox size="xs" mt={3} checked={m.done} onChange={e => api('memo/update', { sid, id: m.id, done: e.currentTarget.checked })} aria-label="끝남 표시" />
    <Stack gap={2} style={{ flex: 1, minWidth: 0 }}>
      {edit !== null
        ? <Textarea size="xs" autosize minRows={1} maxRows={6} autoFocus value={edit} onChange={e => setEdit(e.currentTarget.value)} onBlur={save}
            onKeyDown={e => { if (e.key === 'Escape') setEdit(null); else enter(save)(e) }} aria-label="메모 고치기" />
        : <UnstyledButton onClick={() => setEdit(m.text)} title="눌러서 고치기">
            <Text size="sm" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', textDecoration: m.done ? 'line-through' : undefined }} c={m.done ? 'dimmed' : undefined}>{m.text}</Text>
          </UnstyledButton>}
      <Text fz={11} c="dimmed">{m.by === 'claude' && <Badge size="xs" variant="light" color="grape" mr={4}>Claude</Badge>}<Since t={m.at} suf=" 전" /></Text>
    </Stack>
    <CloseButton size="xs" aria-label="메모 지우기" onClick={() => api('memo/delete', { sid, id: m.id })} />
  </Group>
}

export function MemoList({ S, sid }: { S: Snapshot; sid: string }) {
  const items = S.memos?.[sid]?.items || []
  const [text, setText] = useState('')
  const add = async () => { if (text.trim() && await api('memo/add', { sid, text })) setText('') }
  return <Stack gap={10}>
    {items.map(m => <MemoRow key={m.id} sid={sid} m={m} />)}
    <Textarea size="sm" autosize minRows={1} maxRows={5} value={text} onChange={e => setText(e.currentTarget.value)} onKeyDown={enter(add)}
      placeholder="메모 적기 (Enter)" aria-label="메모 적기" />
  </Stack>
}

const MARK = { '>': ['▸', 'yellow.5'], ' ': ['○', undefined], 'x': ['✓', 'dimmed'], '?': ['?', 'orange.4'] } as const
function PinList({ s }: { s: Session }) {
  const decisions = s.pin.filter(p => p.mark === '?'), todos = s.pin.filter(p => p.mark !== '?')
  const done = todos.filter(p => p.mark === 'x').length
  if (!s.pin.length) return <Text size="sm" c="dimmed">핀보드가 비어 있습니다. Claude가 할 일·결정할 것을 핀에 올리면 여기에 보입니다.</Text>
  const row = (p: Session['pin'][number]) => <Group key={p.id} gap={8} wrap="nowrap" align="flex-start">
    <Text size="sm" c={MARK[p.mark][1]} w={12} ta="center" style={{ flex: 'none' }}>{MARK[p.mark][0]}</Text>
    <Text size="sm" style={{ overflowWrap: 'anywhere' }}>{p.text}</Text>
  </Group>
  return <Stack gap="md">
    <Stack gap={6}><Text size="xs" fw={600} c="dimmed">결정할 것 {decisions.length || ''}</Text>
      {decisions.length ? decisions.map(row) : <Text size="sm" c="dimmed">없음</Text>}</Stack>
    <Stack gap={6}><Text size="xs" fw={600} c="dimmed">할 일 {todos.length ? `${done}/${todos.length}` : ''}</Text>
      {todos.filter(p => p.mark !== 'x').map(row)}
      {done > 0 && <Text size="sm" c="dimmed">✓ {done}개 끝남</Text>}
      {!todos.length && <Text size="sm" c="dimmed">없음</Text>}</Stack>
    <Text fz={11} c="dimmed">Claude가 관리합니다. 바꾸려면 Claude에게 말하세요.</Text>
  </Stack>
}

const getTab = () => { try { return localStorage.getItem('hq-side') || 'memo' } catch { return 'memo' } }
export function SidePanel({ S, s, onClose }: { S: Snapshot; s: Session; onClose: () => void }) {
  const [tab, setTab] = useState(getTab)
  const asking = (S.btw?.[s.sid] || []).some(x => x.state === 'asking')
  return <Paper withBorder style={{ display: 'flex', flexDirection: 'column', minHeight: 0, height: '100%' }}>
    <Tabs value={tab} onChange={v => { const t = v || 'memo'; setTab(t); try { localStorage.setItem('hq-side', t) } catch { /* 무시 */ } }}
      style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
      <Group gap={0} wrap="nowrap" pr={6} style={{ borderBottom: '1px solid var(--mantine-color-default-border)' }}>
        <Tabs.List style={{ flex: 1, borderBottom: 0 }}>
          <Tabs.Tab value="pin">핀{s.pin.some(p => p.mark === '?') ? ' ?' : ''}</Tabs.Tab>
          <Tabs.Tab value="memo">메모</Tabs.Tab>
          <Tabs.Tab value="btw">곁가지 질문{asking ? ' …' : ''}</Tabs.Tab>
        </Tabs.List>
        <CloseButton size="sm" onClick={onClose} aria-label="옆 패널 닫기" />
      </Group>
      {tab === 'btw' ? <BtwTab S={S} s={s} />
        : <ScrollArea style={{ flex: 1 }}><Box p="sm">{tab === 'pin' ? <PinList s={s} /> : <MemoList S={S} sid={s.sid} />}</Box></ScrollArea>}
    </Tabs>
  </Paper>
}

// 메모 보기(F4): 메모가 있는 세션을 모아 본다. 닫힌 대화의 메모도 남아 있다
export function MemoView({ S }: { S: Snapshot }) {
  const list = Object.entries(S.memos || {}).filter(([, m]) => m.items.length)
    .sort(([, a], [, b]) => Number(b.items.some(x => !x.done)) - Number(a.items.some(x => !x.done)) || Math.max(...b.items.map(x => x.at)) - Math.max(...a.items.map(x => x.at)))
  if (!list.length) return <Paper withBorder p="xl" style={{ borderStyle: 'dashed' }}>
    <Text c="dimmed">아직 메모가 없습니다. 작업 보기에서 대화 옆 패널의 메모 탭에 적거나, Claude에게 "이거 메모해 둬"라고 시키세요.</Text>
  </Paper>
  return <ScrollArea h="100%">
    <SimpleGrid cols={{ base: 1, md: 2, xl: 3 }} spacing="md" pb="md">
      {list.map(([sid, m]) => {
        const live = S.sessions.find(x => x.sid === sid)
        return <Paper key={sid} withBorder p="md">
          <Group justify="space-between" gap="xs" mb="sm" wrap="nowrap" align="flex-start">
            <Text fw={600} className="hq-wrap" style={{ minWidth: 0 }}>{live?.title || m.title}</Text>
            {live ? <Button size="compact-xs" variant="light" style={{ flex: 'none' }} onClick={() => pick(sid)}>열기</Button>
              : <Badge size="sm" variant="outline" color="gray" style={{ flex: 'none' }}>닫힌 대화</Badge>}
          </Group>
          <MemoList S={S} sid={sid} />
        </Paper>
      })}
    </SimpleGrid>
  </ScrollArea>
}
