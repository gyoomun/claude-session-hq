// 대화 화면: 대화 기록을 읽어 웹 UI로 그리고, 아래 입력칸으로 그 세션에 바로 말한다.
// Orca 세션도 Claude를 하나 더 띄우지 않고, 이미 돌고 있는 그 Claude에 입력을 넣는다.
import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Box, Button, CloseButton, Group, Kbd, Loader, Modal, Paper, ScrollArea, Stack, Text, Textarea } from '@mantine/core'
import { api, toast } from './store'
import { pickNew } from './ui'
import type { Session } from './types'
import { COLOR } from './util'

interface Item { id: string; at: number; t: 'user' | 'assistant' | 'tool' | 'result'; text: string; name?: string; toolId?: string; error?: boolean }

// 링크는 새 탭에서 연다(이 화면을 떠나지 않게)
const NewTab = (p: React.AnchorHTMLAttributes<HTMLAnchorElement>) => <a {...p} target="_blank" rel="noopener noreferrer" />
// 마크다운 해석이 가장 무겁다. 같은 글은 다시 해석하지 않는다
const Md = memo(({ text }: { text: string }) => <div className="hq-md"><ReactMarkdown remarkPlugins={[remarkGfm]} components={{ a: NewTab }}>{text}</ReactMarkdown></div>)
// 내 말풍선은 마크다운이 아니라 그대로 보이되, 주소만 링크로
const Linkify = ({ text }: { text: string }) => <>{text.split(/(https?:\/\/[^\s<>"')\]]*[^\s<>"')\].,])/).map((x, i) => i % 2 ? <NewTab key={i} href={x} className="hq-link">{x}</NewTab> : x)}</>

function Tool({ it, result }: { it: Item; result?: Item }) {
  return <details className={'hq-tool' + (result?.error ? ' err' : '')}>
    <summary><span className="name">{it.name}</span> <span className="arg">{it.text}</span>{!result && <Loader size={10} ml={6} />}</summary>
    {result && <pre>{result.text || '(출력 없음)'}</pre>}
  </details>
}

// 작업 과정을 접어 볼 때: 연달아 쓴 도구를 한 줄로 묶는다. 누르면 하나하나 펼친다
function ToolGroup({ tools, results }: { tools: Item[]; results: Map<string | undefined, Item> }) {
  const count = new Map<string, number>()
  tools.forEach(t => count.set(t.name!, (count.get(t.name!) || 0) + 1))
  const running = tools.some(t => !results.has(t.toolId))
  return <details className={'hq-tool' + (tools.some(t => results.get(t.toolId)?.error) ? ' err' : '')}>
    <summary>도구 {tools.length}번 · <span className="arg">{[...count].map(([n, c]) => c > 1 ? `${n} ${c}` : n).join(', ')}</span>{running && <Loader size={10} ml={6} />}</summary>
    <Stack gap={4} mt={4}>{tools.map(t => <Tool key={t.id} it={t} result={results.get(t.toolId)} />)}</Stack>
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
        setMissing(!!d.missing) // 새 세션은 첫 말을 보낸 뒤에야 기록 파일이 생긴다
        if (d.missing) return
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

interface Img { n: number; path: string; url: string }
// 입력칸에 이미지를 붙인 자리 표시. 터미널의 Claude Code처럼 [Image #N]이고, 보낼 때 이 자리에 이미지가 들어간다.
// 번호는 이 메시지 안에서 1부터. Claude Code의 실제 번호는 붙여넣는 순간 정해지고(긴 글 붙여넣기와 번호를 같이 써서) 미리 알 수 없다.
// 보낸 뒤 말풍선에는 Claude Code가 매긴 실제 번호가 보인다
const tok = (n: number) => `[Image #${n}]`
const TOK = /(\[Image #\d+\])/
const IMG_NO = /\[Image #(\d+)\]/g

async function upload(f: File) {
  const r = await fetch('/api/upload', { method: 'POST', headers: { 'x-hq': '1', 'Content-Type': f.type }, body: f })
  const d = await r.json()
  if (!r.ok) throw new Error(d.error || '이미지를 올리지 못했습니다')
  return d.path as string
}

// 보내기 전의 글은 세션마다 남긴다. 다른 세션·보기를 다녀오거나 새로고침해도 이어 쓴다. 붙인 이미지는 이 화면이 열려 있는 동안만
const draftKey = (sid: string) => 'hq-draft:' + sid
const loadDraft = (sid: string) => { try { return localStorage.getItem(draftKey(sid)) || '' } catch { return '' } }
const saveDraft = (sid: string, v: string) => { try { if (v) localStorage.setItem(draftKey(sid), v); else localStorage.removeItem(draftKey(sid)) } catch { /* 무시 */ } }
const draftImgs = new Map<string, Img[]>()

// 입력칸의 글과 붙인 이미지. 끌어다 놓기는 대화 화면 전체에서 받으므로 ChatView가 만들어 Composer에 넘긴다
function useDraft(sid: string) {
  const [text, setTextState] = useState(() => loadDraft(sid))
  const setText = (v: string | ((p: string) => string)) => setTextState(p => { const x = typeof v === 'function' ? v(p) : v; saveDraft(sid, x); return x })
  const [imgs, setImgs] = useState<Img[]>(() => draftImgs.get(sid) || [])
  useEffect(() => { draftImgs.set(sid, imgs) }, [sid, imgs])
  const [uploading, setUploading] = useState(0)
  // 이미지를 [이미지 N] 표시로 붙인 자리(at, 없으면 끝)에 넣고 올린다. 넣은 표시의 길이를 돌려준다(커서를 그 뒤로 옮기려고)
  const attach = (files: File[], at?: [number, number]) => {
    const list = files.filter(f => f.type.startsWith('image/'))
    if (!list.length) return 0
    let n = Math.max(0, ...imgs.map(i => i.n), ...[...text.matchAll(IMG_NO)].map(m => +m[1]))
    const items = list.map(f => ({ f, n: ++n }))
    const ins = items.map(x => tok(x.n)).join(' ')
    setText(p => at ? p.slice(0, at[0]) + ins + p.slice(at[1]) : p + (p && !/\s$/.test(p) ? ' ' : '') + ins)
    for (const { f, n } of items) {
      setUploading(u => u + 1)
      upload(f).then(path => setImgs(p => [...p, { n, path, url: URL.createObjectURL(f) }]))
        .catch(e => { toast((e as Error).message, 'red'); setText(p => p.replace(tok(n), '')) })
        .finally(() => setUploading(u => u - 1))
    }
    return ins.length
  }
  return { text, setText, imgs, setImgs, uploading, attach }
}
type Draft = ReturnType<typeof useDraft>

function Composer({ s, d }: { s: Session; d: Draft }) {
  const { text, setText, imgs, setImgs, uploading, attach } = d
  const [busy, setBusy] = useState(false)
  const box = useRef<HTMLTextAreaElement>(null)
  const shown = imgs.filter(i => text.includes(tok(i.n))) // 표시를 지운 이미지는 보내지 않는다
  const send = async () => {
    if (!text.trim() || busy || uploading) return
    // 글과 이미지를 쓴 순서대로 나눈다. 올린 이미지가 없는 표시(앞서 보낸 이미지를 글로 가리킨 것 등)는 글 그대로 보낸다
    const parts = text.split(TOK).flatMap((x, i): { text?: string; image?: string }[] => {
      const img = i % 2 ? imgs.find(m => tok(m.n) === x) : undefined
      return img ? [{ image: img.path }] : x ? [{ text: x }] : []
    })
    setBusy(true)
    const ok = await api('term/send', { pid: s.pid, parts })
    setBusy(false)
    if (ok) { setText(''); setImgs([]) }
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
      {shown.length > 0 && <Group gap={6}>{shown.map(i => <Box key={i.n} pos="relative">
        <img src={i.url} alt={tok(i.n)} style={{ height: 64, borderRadius: 6, display: 'block', border: '1px solid var(--mantine-color-default-border)' }} />
        <Text fz={10} pos="absolute" bottom={2} left={4} px={4} style={{ background: 'rgba(0,0,0,.6)', color: '#fff', borderRadius: 4 }}>{i.n}</Text>
        <CloseButton size="xs" variant="filled" pos="absolute" top={2} right={2} aria-label="이미지 빼기" onClick={() => setText(p => p.replace(tok(i.n), ''))} />
      </Box>)}</Group>}
      <Textarea ref={box} autosize minRows={2} maxRows={10} value={text} onChange={e => setText(e.currentTarget.value)}
        onPaste={e => {
          const files = [...e.clipboardData.files].filter(f => f.type.startsWith('image/'))
          if (!files.length) return
          e.preventDefault()
          const el = e.currentTarget, at = el.selectionStart
          const len = attach(files, [at, el.selectionEnd])
          requestAnimationFrame(() => box.current?.setSelectionRange(at + len, at + len))
        }}
        placeholder={`${s.title}에게 말하기`} aria-label="보낼 말"
        onKeyDown={e => {
          // 한글 입력 중(조합 중)의 Enter는 글자 확정이라 보내지 않는다
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send() }
        }} />
      <Group justify="space-between" gap={6}>
        <Text size="xs" c="dimmed"><Kbd size="xs">Enter</Kbd> 보내기 · <Kbd size="xs">Shift</Kbd>+<Kbd size="xs">Enter</Kbd> 줄바꿈 · 이미지는 붙여넣기나 끌어다 놓기</Text>
        <Group gap={6}>
          {(s.state === 'working' || s.state === 'compact' || s.state === 'approval') && <Button size="xs" variant="default" onClick={() => key('esc')}>중단 (Esc)</Button>}
          <Button size="xs" loading={busy || uploading > 0} onClick={send}>보내기</Button>
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

// 연달아 쓴 도구(사이의 결과 포함)를 한 묶음으로. 말이 나오면 묶음이 끊긴다
function grouped(items: Item[]) {
  const out: (Item | Item[])[] = []
  for (const it of items) {
    if (it.t === 'result') continue
    const last = out[out.length - 1]
    if (it.t === 'tool' && Array.isArray(last)) last.push(it)
    else out.push(it.t === 'tool' ? [it] : it)
  }
  return out
}

// 메시지 목록. 입력칸에 글을 칠 때나 2초마다 상태가 바뀔 때는 다시 그리지 않는다(items·detail이 바뀔 때만).
// 터미널처럼 최근 것만 그리고(처음 200개), 더 보려면 위에서 '이전 대화 더 보기'를 누른다
const PAGE = 200
const Messages = memo(function Messages({ items, detail }: { items: Item[]; detail: boolean }) {
  const [limit, setLimit] = useState(PAGE)
  const results = new Map(items.filter(i => i.t === 'result').map(i => [i.toolId, i]))
  const all = detail ? items.filter(i => i.t !== 'result') : grouped(items)
  const list = all.slice(-limit)
  return <>
    {all.length > list.length && <Button size="xs" variant="subtle" color="gray" onClick={() => setLimit(l => l + PAGE)}>이전 대화 더 보기 ({all.length - list.length}개 남음)</Button>}
    {list.map(it => Array.isArray(it) ? <ToolGroup key={it[0].id} tools={it} results={results} />
      : it.t === 'user' ? <Box key={it.id} className="hq-say me"><Text size="sm" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}><Linkify text={it.text} /></Text></Box>
      : it.t === 'assistant' ? <Box key={it.id} className="hq-say"><Md text={it.text} /></Box>
      : <Tool key={it.id} it={it} result={results.get(it.toolId)} />)}
  </>
})

export function ChatView({ s, detail }: { s: Session; detail: boolean }) {
  const { items, missing } = useTranscript(s.sid)
  const view = useRef<HTMLDivElement>(null)
  const stick = useRef(true) // 맨 아래를 보고 있으면 새 메시지가 올 때 따라 내려간다
  useLayoutEffect(() => { if (stick.current && view.current) view.current.scrollTop = view.current.scrollHeight }, [items, s.state])
  useEffect(() => { stick.current = true }, [s.sid])
  const draft = useDraft(s.sid)
  const [dropOver, setDropOver] = useState(false)
  const hasFiles = (e: React.DragEvent) => e.dataTransfer.types.includes('Files')
  return <Stack gap={8} style={{ flex: 1, minHeight: 0, position: 'relative' }}
    onDragOver={e => { if (s.host && hasFiles(e)) { e.preventDefault(); setDropOver(true) } }}
    onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropOver(false) }}
    onDrop={e => {
      if (!s.host || !hasFiles(e)) return
      e.preventDefault(); setDropOver(false)
      draft.attach([...e.dataTransfer.files])
    }}>
    {dropOver && <Box className="hq-dropzone"><Text fw={600}>여기에 놓으면 이미지를 붙입니다</Text></Box>}
    <Paper withBorder style={{ flex: 1, minHeight: 0, display: 'flex' }}>
      <ScrollArea viewportRef={view} style={{ flex: 1 }} onScrollPositionChange={({ y }) => {
        const v = view.current
        if (v) stick.current = v.scrollHeight - (y + v.clientHeight) < 80
      }}>
        <Stack gap={10} p="md" maw={980} mx="auto">
          {missing && <Text c="dimmed">이 세션의 대화 기록을 찾지 못했습니다.</Text>}
          {!missing && !items.length && <Group gap={8}><Loader size="xs" /><Text c="dimmed" size="sm">대화를 불러오는 중입니다…</Text></Group>}
          <Messages items={items} detail={detail} />
          {(s.state === 'working' || s.state === 'compact') && <Group gap={8}><Loader size="xs" color={COLOR[s.state]} /><Text size="sm" c={`${COLOR[s.state]}.4`} ff="monospace">{s.act || '생각 중'}</Text></Group>}
        </Stack>
      </ScrollArea>
    </Paper>
    {s.host ? <Composer s={s} d={draft} /> : <NoInput s={s} />}
  </Stack>
}
