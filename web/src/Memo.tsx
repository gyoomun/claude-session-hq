// 대화 오른쪽 칸(핀·메모·btw)과 메모 보기(F4).
// 핀: Claude 핀보드 모드가 올린 할 일·결정할 것(읽기만). 메모: Claude가 알 수 없는 사정을 내가 적거나, 내가 시킬 때 Claude가 덧붙인다(skills/hq-memo)
import { useEffect, useRef, useState } from 'react'
import { Badge, Box, Button, Group, Modal, Paper, ScrollArea, SegmentedControl, SimpleGrid, Skeleton, Stack, Text, Textarea } from '@mantine/core'
import { api } from './store'
import { pick, setSideTab, useUI } from './ui'
import type { Session, Snapshot } from './types'
import { BtwTab, RECAP, askRecap } from './Btw'
import { KeyRec, areaKeys } from './Keys'
import type { Area } from './ui'
import { Group as Split, Panel, Separator, useDefaultLayout } from 'react-resizable-panels'

export const hasMemo = (S: Snapshot, sid: string) => !!S.memos?.[sid]?.text.trim()

// 메모 칸: 세션마다 글 하나를 그냥 고친다(줄 목록이 아니다: 사용자 요청). 치는 동안 잠깐 멈추면, 그리고 칸을 떠나면 남긴다.
// 남긴 값이 서버에서 돌아올 때까지는 친 글을 그대로 보인다(되돌아가 깜빡이지 않게). 세션을 바꾸면 key로 새로 그린다
export function MemoBox({ S, sid, fill }: { S: Snapshot; sid: string; fill?: boolean }) {
  const saved = S.memos?.[sid]?.text || ''
  const [draft, setDraft] = useState<string | null>(null)
  const timer = useRef(0), focused = useRef(false), latest = useRef<string | null>(null)
  latest.current = draft
  const save = (v: string) => { clearTimeout(timer.current); timer.current = 0; if (v !== saved) api('memo/set', { sid, text: v }) }
  useEffect(() => { if (draft !== null && !focused.current && saved === draft) setDraft(null) }, [saved, draft])
  useEffect(() => () => { if (timer.current && latest.current !== null) api('memo/set', { sid, text: latest.current }) }, [sid]) // 남기기 전에 세션을 바꿔도 잃지 않게
  return <Textarea value={draft ?? saved} placeholder="메모 (Claude가 알 수 없는 사정 등. 그냥 적으면 남습니다)" aria-label="메모"
    onChange={e => { const v = e.currentTarget.value; setDraft(v); clearTimeout(timer.current); timer.current = window.setTimeout(() => save(v), 800) }}
    onFocus={() => { focused.current = true }} onBlur={() => { focused.current = false; if (draft !== null) save(draft) }}
    {...(fill ? { styles: { root: { flex: 1, display: 'flex', flexDirection: 'column' }, wrapper: { flex: 1 }, input: { height: '100%', resize: 'none' } } } : { autosize: true, minRows: 3, maxRows: 16 })} />
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
  return <Paper h="100%" style={{ display: 'flex', flexDirection: 'column' }} data-area={area} tabIndex={-1} onKeyDown={areaKeys()}>
    <Group p="8px 12px 2px" gap={6} wrap="nowrap"><Text fw={600} size="sm">{title}</Text>{sub && <Text size="xs" c="dimmed">{sub}</Text>}<Box ml="auto"><KeyRec area={area} /></Box></Group>
    <ScrollArea style={{ flex: 1, minHeight: 0 }} viewportProps={{ tabIndex: 0, className: 'hq-scrollfocus' }}><Box p="6px 12px 12px">{children}</Box></ScrollArea>
  </Paper>
}

// 대화 오른쪽 칸: 위 핀, 아래 메모·btw 한 칸(탭으로 오간다: 둘 다 따로 두기엔 좁아서, 사용자 요청). 사이 경계를 끌어 높이를 바꾸고, 바꾼 비율은 이 브라우저에 남는다.
// 탭 칸의 data-area는 보이는 탭이고, 영역 단축키로 안 보이는 탭을 부르면 탭이 바뀐다(Keys.tsx focusArea)
export function SidePanel({ S, s }: { S: Snapshot; s: Session }) {
  const { defaultLayout, onLayoutChanged } = useDefaultLayout({ id: 'hq-side2' })
  const { layoutKey, sideTab: tab } = useUI()
  const [askClear, setAskClear] = useState(false) // btw 비우기는 되돌릴 수 없어 한 번 묻는다. 기본 포커스는 비우기(사용자 요청)
  return <Split key={layoutKey} orientation="vertical" defaultLayout={defaultLayout} onLayoutChanged={onLayoutChanged} style={{ height: '100%' }}>
    <Panel id="pin" defaultSize="30" minSize={70}><Section area="pin" title="핀" sub="Claude 핀보드"><PinList s={s} /></Section></Panel>
    <Separator className="hq-split-line" />
    <Panel id="notes" minSize={200}>
      <Paper h="100%" style={{ display: 'flex', flexDirection: 'column' }} data-area={tab} data-side-tabs tabIndex={-1} onKeyDown={areaKeys()}>
        <Group p="6px 12px 0" gap={6} wrap="nowrap">
          <SegmentedControl size="xs" value={tab} onChange={v => setSideTab(v as 'memo' | 'btw')}
            data={[{ value: 'memo', label: hasMemo(S, s.sid) ? '메모 •' : '메모' }, { value: 'btw', label: 'btw' }]} />
          <Group ml="auto" gap={6} wrap="nowrap">
            {tab === 'btw' && (S.btw?.[s.sid] || []).length > 0 && <Button size="compact-xs" variant="subtle" color="gray" onClick={() => setAskClear(true)}>비우기</Button>}
            {tab === 'btw' && s.host === 'web' && <Button size="compact-xs" variant="subtle" color="gray" disabled={!s.sid || (S.btw?.[s.sid] || []).some(x => x.state === 'asking')} title={RECAP} onClick={() => askRecap(s.sid)}>한 일</Button>}
            <KeyRec area={tab} />
          </Group>
        </Group>
        {tab === 'memo'
          ? <Box p="8px 12px 12px" style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>{s.sid ? <MemoBox key={s.sid} S={S} sid={s.sid} fill /> : <Skeleton h={11} w="60%" />}</Box>
          : <BtwTab S={S} s={s} />}
        <Modal opened={askClear} onClose={() => setAskClear(false)} title="btw 비우기" size="sm" withCloseButton={false}>
          <Stack gap="sm">
            <Text size="sm">이 세션의 btw 질문과 답을 모두 지울까요?</Text>
            <Group justify="flex-end">
              <Button size="xs" variant="default" onClick={() => setAskClear(false)}>취소</Button>
              <Button size="xs" variant="light" color="red" data-autofocus onClick={() => { setAskClear(false); api('btw/clear', { sid: s.sid }) }}>비우기</Button>
            </Group>
          </Stack>
        </Modal>
      </Paper>
    </Panel>
  </Split>
}

// 메모 보기(F4): 메모가 있는 세션을 모아 본다. 닫힌 대화의 메모도 남아 있다
export function MemoView({ S }: { S: Snapshot }) {
  const list = Object.entries(S.memos || {}).filter(([, m]) => m.text.trim()).sort(([, a], [, b]) => b.at - a.at)
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
          <MemoBox key={sid} S={S} sid={sid} />
        </Paper>
      })}
    </SimpleGrid>
  </ScrollArea>
}
