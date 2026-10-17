// btw: Claude Code의 /btw로 묻는다(서버가 그 세션에 쳐 넣고 답 상자를 읽는다). 하던 일을 끊지 않고, 원래 대화에는 남지 않는다
import { useLayoutEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Box, Group, Loader, ScrollArea, Stack, Text, Textarea } from '@mantine/core'
import { api } from './store'
import type { Session, Snapshot } from './types'
import { Since } from './util'

// '한 일' 버튼: 이 세션을 닫아도 되는지 보려고 사용자가 가장 자주 묻는 말(사용자 요청). /btw는 도구를 못 써서 커밋 여부 등은 그 세션의 기억으로 답한다
export const RECAP = '이 대화에서 나와 한 일을 시간 순으로 짧게 정리해 줘. 일마다 끝났는지 / 남은 게 있는지(커밋·푸시 안 함, 확인 못 함, 내 답 기다림 등) 표시하고, 마지막 줄에 "이 세션 닫아도 됨" 또는 "닫으면 안 됨: 이유" 한 줄로.'

// 탭 줄 오른쪽의 '한 일' 버튼(Memo.tsx SidePanel)
export const askRecap = (sid: string) => api('btw/ask', { sid, question: RECAP })
// 대화 오른쪽 아래 칸의 btw 탭(Memo.tsx의 SidePanel)
export function BtwTab({ S, s }: { S: Snapshot; s: Session }) {
  const list = S.btw?.[s.sid] || []
  const [q, setQ] = useState('')
  const [busy, setBusy] = useState(false)
  const view = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => { if (view.current) view.current.scrollTop = view.current.scrollHeight }, [list.length, list[list.length - 1]?.state])
  const ask = async (question = q) => {
    if (!question.trim() || busy) return
    setBusy(true)
    if (await api('btw/ask', { sid: s.sid, question }) && question === q) setQ('')
    setBusy(false)
  }
  return <>
    {s.host !== 'web' && s.sid && <Text size="xs" c="dimmed" p="6px 10px">웹에서 띄운 세션에서만 쓸 수 있습니다</Text>}
    <ScrollArea viewportRef={view} style={{ flex: 1 }} viewportProps={{ tabIndex: 0, className: 'hq-scrollfocus' }}>
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
    <Box p="sm">
      <Textarea autosize minRows={2} maxRows={6} value={q} onChange={e => setQ(e.currentTarget.value)} placeholder="Enter 묻기 · Shift+Enter 줄바꿈" aria-label="btw 질문"
        onKeyDown={e => {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); ask() }
          else if (e.key === 'ArrowUp' && !q) { e.preventDefault(); view.current?.focus() } // 비었으면 위의 지난 답으로 올라가 ↑↓로 스크롤
        }} />
    </Box>
  </>
}
