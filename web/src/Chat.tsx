// 대화 화면: 대화 기록을 읽어 웹 UI로 그리고, 아래 입력칸으로 그 세션에 바로 말한다.
// Orca 세션도 Claude를 하나 더 띄우지 않고, 이미 돌고 있는 그 Claude에 입력을 넣는다.
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Box, Button, Group, Kbd, Loader, Modal, Paper, ScrollArea, Stack, Text, Textarea } from '@mantine/core'
import { api, toast } from './store'
import { pickNew } from './ui'
import type { Session } from './types'

interface Item { id: string; at: number; t: 'user' | 'assistant' | 'tool' | 'result'; text: string; name?: string; toolId?: string; error?: boolean }

const Md = ({ text }: { text: string }) => <div className="hq-md"><ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown></div>

function Tool({ it, result }: { it: Item; result?: Item }) {
  return <details className={'hq-tool' + (result?.error ? ' err' : '')}>
    <summary><span className="name">{it.name}</span> <span className="arg">{it.text}</span>{!result && <Loader size={10} ml={6} />}</summary>
    {result && <pre>{result.text || '(출력 없음)'}</pre>}
  </details>
}

function useTranscript(sid: string) {
  const [items, setItems] = useState<Item[]>([])
  const [missing, setMissing] = useState(false)
  useEffect(() => {
    let stop = false, next = -1
    setItems([]); setMissing(false)
    const load = async () => {
      try {
        const r = await fetch(`/api/transcript?sid=${sid}${next >= 0 ? `&from=${next}` : ''}`, { cache: 'no-store' })
        if (r.status === 401) { location.href = '/login'; return }
        const d = await r.json()
        if (stop || d.error) return
        if (d.missing) { setMissing(true); return }
        next = d.next
        // 너무 길어지면 오래된 것부터 버린다(기록 파일에는 다 남아 있다)
        if (d.reset) setItems(d.items.slice(-800))
        else if (d.items.length) setItems(p => [...p, ...d.items].slice(-1500))
      } catch { /* 다음에 다시 */ }
    }
    load()
    const iv = setInterval(load, 1500)
    return () => { stop = true; clearInterval(iv) }
  }, [sid])
  return { items, missing }
}

function Composer({ s }: { s: Session }) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const send = async () => {
    if (!text.trim() || busy) return
    setBusy(true)
    const ok = await api('term/send', { pid: s.pid, text })
    setBusy(false)
    if (ok) setText('')
  }
  const key = (k: string) => api('term/key', { pid: s.pid, key: k })
  return <Paper withBorder p="sm">
    <Stack gap={8}>
      {s.state === 'approval' && <Group gap={6} wrap="wrap">
        <Text size="sm" c="red.4" fw={600}>실행 허락을 기다립니다</Text>
        <Button size="xs" color="teal" onClick={() => key('1')}>1 · 허용</Button>
        <Button size="xs" variant="default" onClick={() => key('2')}>2 · 이번 세션 동안 허용</Button>
        <Button size="xs" variant="outline" color="red" onClick={() => key('3')}>3 · 거부</Button>
      </Group>}
      <Textarea autosize minRows={2} maxRows={10} value={text} onChange={e => setText(e.currentTarget.value)}
        placeholder={`${s.title}에게 말하기`} aria-label="보낼 말"
        onKeyDown={e => {
          // 한글 입력 중(조합 중)의 Enter는 글자 확정이라 보내지 않는다
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send() }
        }} />
      <Group justify="space-between" gap={6}>
        <Text size="xs" c="dimmed"><Kbd size="xs">Enter</Kbd> 보내기 · <Kbd size="xs">Shift</Kbd>+<Kbd size="xs">Enter</Kbd> 줄바꿈</Text>
        <Group gap={6}>
          {(s.state === 'working' || s.state === 'approval') && <Button size="xs" variant="default" onClick={() => key('esc')}>중단 (Esc)</Button>}
          <Button size="xs" loading={busy} onClick={send}>보내기</Button>
        </Group>
      </Group>
    </Stack>
  </Paper>
}

// 다른 터미널에서 직접 띄운 세션: 입력을 넣을 방법이 없어서, 원하면 같은 대화를 웹에서도 띄운다
function NoInput({ s }: { s: Session }) {
  const [ask, setAsk] = useState(false)
  return <Paper withBorder p="sm">
    <Group justify="space-between" gap="sm">
      <Text size="sm" c="dimmed">다른 터미널에서 직접 띄운 세션이라 여기서 입력할 수 없습니다.</Text>
      <Button size="xs" variant="default" onClick={() => setAsk(true)}>웹에서도 열기</Button>
    </Group>
    <Modal opened={ask} onClose={() => setAsk(false)} title="같은 대화를 웹에서도 띄울까요?">
      <Stack>
        <Text size="sm">원래 터미널의 Claude는 그대로 두고, 같은 대화를 웹에서 하나 더 띄웁니다. 두 곳에서 동시에 말하면 서로 모르는 채 대화가 두 갈래로 엉킬 수 있습니다. 원래 터미널은 쓰지 않는 게 좋습니다.</Text>
        <Group justify="flex-end"><Button variant="default" onClick={() => setAsk(false)}>취소</Button>
          <Button color="orange" onClick={async () => {
            setAsk(false)
            const r = await api<string>('session/resume', { sid: s.sid, force: true })
            if (r) { pickNew(r.result); toast('웹에서도 열었습니다.') }
          }}>그래도 열기</Button></Group>
      </Stack>
    </Modal>
  </Paper>
}

export function ChatView({ s }: { s: Session }) {
  const { items, missing } = useTranscript(s.sid)
  const view = useRef<HTMLDivElement>(null)
  const stick = useRef(true) // 맨 아래를 보고 있으면 새 메시지가 올 때 따라 내려간다
  useLayoutEffect(() => { if (stick.current && view.current) view.current.scrollTop = view.current.scrollHeight }, [items, s.state])
  useEffect(() => { stick.current = true }, [s.sid])
  const results = new Map(items.filter(i => i.t === 'result').map(i => [i.toolId, i]))
  return <Stack gap={8} style={{ flex: 1, minHeight: 0 }}>
    <Paper withBorder style={{ flex: 1, minHeight: 0, display: 'flex' }}>
      <ScrollArea viewportRef={view} style={{ flex: 1 }} onScrollPositionChange={({ y }) => {
        const v = view.current
        if (v) stick.current = v.scrollHeight - (y + v.clientHeight) < 80
      }}>
        <Stack gap={10} p="md" maw={980} mx="auto">
          {missing && <Text c="dimmed">이 세션의 대화 기록을 찾지 못했습니다.</Text>}
          {!missing && !items.length && <Group gap={8}><Loader size="xs" /><Text c="dimmed" size="sm">대화를 불러오는 중입니다…</Text></Group>}
          {items.map(it => it.t === 'user' ? <Box key={it.id} className="hq-say me"><Text size="sm" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{it.text}</Text></Box>
            : it.t === 'assistant' ? <Box key={it.id} className="hq-say"><Md text={it.text} /></Box>
            : it.t === 'tool' ? <Tool key={it.id} it={it} result={results.get(it.toolId)} />
            : null)}
          {s.state === 'working' && <Group gap={8}><Loader size="xs" color="teal" /><Text size="sm" c="teal.4" ff="monospace">{s.act || '생각 중'}</Text></Group>}
        </Stack>
      </ScrollArea>
    </Paper>
    {s.host ? <Composer s={s} /> : <NoInput s={s} />}
  </Stack>
}
