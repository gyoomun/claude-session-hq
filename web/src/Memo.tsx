// 대화 오른쪽 칸(핀·메모·btw)과 메모 보기(F4).
// 핀: Claude 핀보드 모드가 올린 할 일·결정할 것(읽기만). 메모: Claude가 알 수 없는 사정을 내가 적거나, 내가 시킬 때 Claude가 적는다(skills/hq-memo)
import { useState } from 'react'
import { Badge, Box, Button, Checkbox, CloseButton, Group, Paper, ScrollArea, SimpleGrid, Skeleton, Stack, Text, Textarea, UnstyledButton } from '@mantine/core'
import { api } from './store'
import { pick, useUI } from './ui'
import type { Memo, Session, Snapshot } from './types'
import { Since } from './util'
import { BtwTab } from './Btw'
import { KeyRec, areaKeys } from './Keys'
import type { Area } from './ui'
import { Group as Split, Panel, Separator, useDefaultLayout } from 'react-resizable-panels'

const enter = (f: () => void) => (e: React.KeyboardEvent) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); f() }
}
export const hasMemo = (S: Snapshot, sid: string) => !!S.memos?.[sid]?.items.some(m => !m.done)

// 메모 한 줄. 키보드로: 스페이스 끝남 표시, Enter 고치기, ⌫ 두 번 지우기(↑↓ 옮기기는 MemoList)
function MemoRow({ sid, m }: { sid: string; m: Memo }) {
  const [edit, setEdit] = useState<string | null>(null)
  const [del, setDel] = useState(false)
  const save = async () => { if (edit !== null && edit.trim() && edit !== m.text && !await api('memo/update', { sid, id: m.id, text: edit })) return; setEdit(null) }
  const key = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return
    if (e.key === ' ') { e.preventDefault(); api('memo/update', { sid, id: m.id, done: !m.done }) }
    else if (e.key === 'Enter') { e.preventDefault(); setEdit(m.text) }
    else if (e.key === 'Backspace' || e.key === 'Delete') {
      e.preventDefault()
      if (!del) { setDel(true); return }
      // 지운 줄과 함께 커서가 사라지지 않게 다음 줄(없으면 앞 줄, 그다음 입력칸)로 옮긴다
      const stops = [...(e.currentTarget.parentElement?.querySelectorAll<HTMLElement>('.hq-memo-row, textarea[aria-label="메모 적기"]') || [])]
      const i = stops.indexOf(e.currentTarget)
      ;(stops[i + 1] || stops[i - 1])?.focus()
      api('memo/delete', { sid, id: m.id })
    }
  }
  return <Group gap={8} wrap="nowrap" align="flex-start" tabIndex={0} className={'hq-memo-row' + (del ? ' del' : '')} onKeyDown={key} onBlur={() => setDel(false)}
    title={del ? '한 번 더 누르면 지웁니다' : undefined}>
    <Checkbox size="xs" mt={3} checked={m.done} onChange={e => api('memo/update', { sid, id: m.id, done: e.currentTarget.checked })} aria-label="끝남 표시" />
    <Stack gap={2} style={{ flex: 1, minWidth: 0 }}>
      {edit !== null
        ? <Textarea size="xs" autosize minRows={1} maxRows={6} autoFocus value={edit} onChange={e => setEdit(e.currentTarget.value)} onBlur={save}
            onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); setEdit(null) } else enter(save)(e) }} aria-label="메모 고치기" />
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
  // ↑↓로 메모 줄과 입력칸 사이를 옮긴다(입력칸에서는 비었거나 커서가 맨 앞일 때만 위로)
  const nav = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return
    const t = e.target as HTMLElement
    if (t.tagName === 'TEXTAREA' && (e.key === 'ArrowDown' || (t as HTMLTextAreaElement).selectionStart > 0) || t.getAttribute('aria-label') === '메모 고치기') return
    const stops = [...e.currentTarget.querySelectorAll<HTMLElement>('.hq-memo-row, textarea[aria-label="메모 적기"]')]
    const i = stops.indexOf(t), next = stops[i + (e.key === 'ArrowUp' ? -1 : 1)]
    if (next) { e.preventDefault(); next.focus(); next.scrollIntoView({ block: 'nearest' }) }
  }
  return <Stack gap={10} onKeyDown={nav}>
    {items.map(m => <MemoRow key={m.id} sid={sid} m={m} />)}
    <Textarea size="sm" autosize minRows={1} maxRows={5} value={text} onChange={e => setText(e.currentTarget.value)} onKeyDown={enter(add)}
      placeholder="메모 적기 (Enter)" aria-label="메모 적기" />
  </Stack>
}

const MARK = { '>': ['▸', 'yellow.5'], ' ': ['○', undefined], 'x': ['✓', 'dimmed'], '?': ['?', 'orange.4'] } as const
function PinList({ s }: { s: Session }) {
  const decisions = s.pin.filter(p => p.mark === '?'), todos = s.pin.filter(p => p.mark !== '?')
  const done = todos.filter(p => p.mark === 'x').length
  if (!s.sid) return <Stack gap={8}><Skeleton h={11} w="70%" /><Skeleton h={11} w="52%" /></Stack> // 새 세션을 여는 중
  if (!s.pin.length) return <Text size="sm" c="dimmed">비어 있습니다. Claude가 할 일·결정할 것을 핀에 올리면 보입니다.</Text>
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

// 오른쪽 칸 하나: 이름 옆에 영역 단축키(녹화 버튼). 안의 스크롤 칸은 키보드로도 스크롤된다(↑↓)
function Section({ area, title, sub, children }: { area: Area; title: string; sub?: string; children: React.ReactNode }) {
  return <Paper withBorder h="100%" style={{ display: 'flex', flexDirection: 'column' }} data-area={area} tabIndex={-1} onKeyDown={areaKeys()}>
    <Group p="8px 12px 2px" gap={6} wrap="nowrap"><Text fw={600} size="sm">{title}</Text>{sub && <Text size="xs" c="dimmed">{sub}</Text>}<Box ml="auto"><KeyRec area={area} /></Box></Group>
    <ScrollArea style={{ flex: 1, minHeight: 0 }} viewportProps={{ tabIndex: 0, className: 'hq-scrollfocus' }}><Box p="6px 12px 12px">{children}</Box></ScrollArea>
  </Paper>
}

// 대화 오른쪽 칸: 핀·메모·btw를 위아래로 늘 펼쳐 둔다. 사이 경계를 끌어 높이를 바꾸고, 바꾼 비율은 이 브라우저에 남는다
export function SidePanel({ S, s }: { S: Snapshot; s: Session }) {
  const { defaultLayout, onLayoutChanged } = useDefaultLayout({ id: 'hq-side' })
  const { layoutKey } = useUI()
  return <Split key={layoutKey} orientation="vertical" defaultLayout={defaultLayout} onLayoutChanged={onLayoutChanged} style={{ height: '100%' }}>
    <Panel id="pin" defaultSize="25" minSize={70}><Section area="pin" title="핀" sub="Claude 핀보드"><PinList s={s} /></Section></Panel>
    <Separator className="hq-split" />
    <Panel id="memo" defaultSize="30" minSize={70}><Section area="memo" title="메모"><MemoList S={S} sid={s.sid} /></Section></Panel>
    <Separator className="hq-split" />
    <Panel id="btw" minSize={200}>
      <Paper withBorder h="100%" style={{ display: 'flex', flexDirection: 'column' }} data-area="btw" tabIndex={-1} onKeyDown={areaKeys()}>
        <Group p="8px 12px 0" gap={6} wrap="nowrap"><Text fw={600} size="sm">btw</Text><Box ml="auto"><KeyRec area="btw" /></Box></Group>
        <BtwTab S={S} s={s} />
      </Paper>
    </Panel>
  </Split>
}

// 메모 보기(F4): 메모가 있는 세션을 모아 본다. 닫힌 대화의 메모도 남아 있다
export function MemoView({ S }: { S: Snapshot }) {
  const list = Object.entries(S.memos || {}).filter(([, m]) => m.items.length)
    .sort(([, a], [, b]) => Number(b.items.some(x => !x.done)) - Number(a.items.some(x => !x.done)) || Math.max(...b.items.map(x => x.at)) - Math.max(...a.items.map(x => x.at)))
  if (!list.length) return <Paper withBorder p="xl" style={{ borderStyle: 'dashed' }}>
    <Text c="dimmed">아직 메모가 없습니다. 작업 보기에서 대화 옆 메모 칸에 적거나, Claude에게 "이거 메모해 둬"라고 시키세요.</Text>
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
