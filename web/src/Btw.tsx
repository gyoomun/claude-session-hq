// 곁가지 질문(btw): 메인 작업을 시켜 둔 채 같은 맥락으로 궁금한 것을 묻는다. 원래 대화에는 남지 않는다
import { useLayoutEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Box, Button, Group, Loader, ScrollArea, Stack, Text, Textarea } from '@mantine/core'
import { api } from './store'
import type { Session, Snapshot } from './types'
import { Since } from './util'

// 대화 오른쪽 칸의 한 칸(Memo.tsx의 SidePanel)
export function BtwTab({ S, s }: { S: Snapshot; s: Session }) {
  const list = S.btw?.[s.sid] || []
  const [q, setQ] = useState('')
  const [busy, setBusy] = useState(false)
  const view = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => { if (view.current) view.current.scrollTop = view.current.scrollHeight }, [list.length, list[list.length - 1]?.state])
  const ask = async () => {
    if (!q.trim() || busy) return
    setBusy(true)
    if (await api('btw/ask', { sid: s.sid, question: q })) setQ('')
    setBusy(false)
  }
  return <>
    <Group justify="space-between" p="6px 10px" gap={4} wrap="nowrap">
      <Text size="xs" c="dimmed">이 세션의 맥락으로 답하고, 원래 대화에는 남지 않습니다</Text>
      {list.length > 0 && <Button size="compact-xs" variant="subtle" color="gray" onClick={() => api('btw/clear', { sid: s.sid })}>비우기</Button>}
    </Group>
    <ScrollArea viewportRef={view} style={{ flex: 1 }}>
      <Stack gap="sm" p="sm">
        {!list.length && <Text size="sm" c="dimmed">메인 작업을 시켜 둔 동안 궁금한 것을 물어보세요. 예: "지금 어디까지 했어?", "아까 그 설정 파일 위치가 어디였지?"</Text>}
        {list.map(it => <Stack key={it.id} gap={4}>
          <Box className="hq-say me" style={{ maxWidth: '100%' }}><Text size="sm" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{it.q}</Text></Box>
          {it.state === 'asking'
            ? <Group gap={6}><Loader size="xs" /><Text size="xs" c="dimmed">답을 만드는 중… <Since t={it.at} /></Text></Group>
            : <Box c={it.state === 'error' ? 'red.4' : undefined}><div className="hq-md" style={{ fontSize: 13 }}><ReactMarkdown remarkPlugins={[remarkGfm]}>{it.a}</ReactMarkdown></div></Box>}
        </Stack>)}
      </Stack>
    </ScrollArea>
    <Box p="sm" style={{ borderTop: '1px solid var(--mantine-color-default-border)' }}>
      <Textarea autosize minRows={2} maxRows={6} value={q} onChange={e => setQ(e.currentTarget.value)} placeholder="곁가지로 물어보기" aria-label="곁가지 질문"
        onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); ask() } }} />
      <Group justify="flex-end" mt={6}><Button size="xs" variant="light" loading={busy} onClick={ask}>묻기</Button></Group>
    </Box>
  </>
}
