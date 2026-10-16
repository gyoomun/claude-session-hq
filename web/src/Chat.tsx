// 대화 화면: 대화 기록을 읽어 웹 UI로 그리고, 아래 입력칸으로 그 세션에 바로 말한다.
// Orca 세션도 Claude를 하나 더 띄우지 않고, 이미 돌고 있는 그 Claude에 입력을 넣는다.
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Box, Button, CloseButton, Group, Kbd, Loader, Modal, Paper, ScrollArea, Stack, Text, Textarea } from '@mantine/core'
import { api, serverNow, toast } from './store'
import { pickNew } from './ui'
import type { Session } from './types'
import { COLOR } from './util'
import { RewindModal } from './Rewind'

interface Item { id: string; at: number; t: 'user' | 'assistant' | 'tool' | 'result'; text: string; name?: string; toolId?: string; error?: boolean }

// 링크는 새 탭에서 연다(이 화면을 떠나지 않게)
const NewTab = (p: React.AnchorHTMLAttributes<HTMLAnchorElement>) => <a {...p} target="_blank" rel="noopener noreferrer" />
// 마크다운 해석이 가장 무겁다. 같은 글은 다시 해석하지 않는다
const Md = memo(({ text }: { text: string }) => <div className="hq-md"><ReactMarkdown remarkPlugins={[remarkGfm]} components={{ a: NewTab }}>{text}</ReactMarkdown></div>)
// 내 말풍선은 마크다운이 아니라 그대로 보이되, 주소만 링크로
// 붙여넣은 긴 글(Claude Code가 <pasted_content>로 감싼 것)은 접을 수 있는 칸으로 따로 보인다. 짧으면 펼쳐 둔다
const PASTED = /<pasted_content(?: id="[^"]*")?>\n?([\s\S]*?)\n?<\/pasted_content(?: id="[^"]*")?>/
const UserText = ({ text }: { text: string }) => <>{text.split(PASTED).map((x, i) => {
  if (i % 2 === 0) { const t = x.replace(/^\n+|\n+$/g, ''); return t && <div key={i}><Linkify text={t} /></div> }
  const n = x.split('\n').length
  return <details key={i} className="hq-paste" open={n <= 10}><summary>붙여넣은 글 · {n}줄</summary><div><Linkify text={x} /></div></details>
})}</>
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
interface Paste { n: number; text: string }
export interface Sent { text: string; imgs: Img[]; pastes: Paste[]; at: number }
// 입력칸에 이미지·긴 글을 붙인 자리 표시. 터미널의 Claude Code처럼 [Image #N], [Pasted text #N +L lines]이고, 보낼 때 이 자리에 그대로 붙여넣는다.
// 번호는 이 메시지 안에서 1부터(이미지·글이 번호를 같이 쓴다, Claude Code처럼). Claude Code의 실제 번호는 붙여넣는 순간 정해져 미리 알 수 없다.
// 보낸 뒤 말풍선에는 Claude Code가 매긴 실제 번호가 보인다
const tok = (n: number) => `[Image #${n}]`
const ptok = (p: Paste) => { const l = p.text.split('\n').length - 1; return `[Pasted text #${p.n}${l ? ` +${l} lines` : ''}]` }
const TOK = /(\[Image #\d+\]|\[Pasted text #\d+(?: \+\d+ lines)?\])/
const NUM = /\[(?:Image|Pasted text) #(\d+)/g
// 붙여넣은 글을 접는 기준은 Claude Code와 같다(800자 넘거나 4줄 이상). 접은 글만 붙여넣기로 보내 Claude Code가 <pasted_content>로 감싼다.
// 짧은 글은 터미널에서도 친 글과 똑같이 들어가므로 그냥 입력칸에 넣는다
const bigPaste = (t: string) => t.length > 800 || t.split('\n').length > 3

async function upload(f: File) {
  const r = await fetch('/api/upload', { method: 'POST', headers: { 'x-hq': '1', 'Content-Type': f.type }, body: f })
  const d = await r.json()
  if (!r.ok) throw new Error(d.error || '이미지를 올리지 못했습니다')
  return d.path as string
}

// 보내기 전의 글과 붙여넣은 긴 글은 세션마다 남긴다. 다른 세션·보기를 다녀오거나 새로고침해도 이어 쓴다. 붙인 이미지는 이 화면이 열려 있는 동안만
const store = {
  get: (k: string) => { try { return localStorage.getItem(k) } catch { return null } },
  set: (k: string, v: string) => { try { if (v) localStorage.setItem(k, v); else localStorage.removeItem(k) } catch { /* 무시 */ } },
}
const draftImgs = new Map<string, Img[]>()

// 입력칸의 글·이미지·붙여넣은 긴 글. 끌어다 놓기는 대화 화면 전체에서 받으므로 ChatView가 만들어 Composer에 넘긴다
function useDraft(sid: string) {
  const [text, setTextState] = useState(() => store.get('hq-draft:' + sid) || '')
  const setText = (v: string | ((p: string) => string)) => setTextState(p => { const x = typeof v === 'function' ? v(p) : v; store.set('hq-draft:' + sid, x); return x })
  const [imgs, setImgs] = useState<Img[]>(() => draftImgs.get(sid) || [])
  useEffect(() => { draftImgs.set(sid, imgs) }, [sid, imgs])
  const [pastes, setPastesState] = useState<Paste[]>(() => { try { return JSON.parse(store.get('hq-draft-paste:' + sid) || '[]') } catch { return [] } })
  const setPastes = (v: Paste[] | ((p: Paste[]) => Paste[])) => setPastesState(p => { const x = typeof v === 'function' ? v(p) : v; store.set('hq-draft-paste:' + sid, x.length ? JSON.stringify(x) : ''); return x })
  const [uploading, setUploading] = useState(0)
  const next = () => Math.max(0, ...imgs.map(i => i.n), ...pastes.map(p => p.n), ...[...text.matchAll(NUM)].map(m => +m[1])) + 1
  const insert = (ins: string, at?: [number, number]) => setText(p => at ? p.slice(0, at[0]) + ins + p.slice(at[1]) : p + (p && !/\s$/.test(p) ? ' ' : '') + ins)
  // 이미지를 표시로 붙인 자리(at, 없으면 끝)에 넣고 올린다. 넣은 표시의 길이를 돌려준다(커서를 그 뒤로 옮기려고)
  const attach = (files: File[], at?: [number, number]) => {
    const list = files.filter(f => f.type.startsWith('image/'))
    if (!list.length) return 0
    let n = next() - 1
    const items = list.map(f => ({ f, n: ++n }))
    const ins = items.map(x => tok(x.n)).join(' ')
    insert(ins, at)
    for (const { f, n } of items) {
      setUploading(u => u + 1)
      upload(f).then(path => setImgs(p => [...p, { n, path, url: URL.createObjectURL(f) }]))
        .catch(e => { toast((e as Error).message, 'red'); setText(p => p.replace(tok(n), '')) })
        .finally(() => setUploading(u => u - 1))
    }
    return ins.length
  }
  const addPaste = (t: string, at: [number, number]) => {
    const p = { n: next(), text: t.replace(/\r\n?/g, '\n') }
    setPastes(x => [...x, p]); insert(ptok(p), at)
    return ptok(p).length
  }
  return { text, setText, imgs, setImgs, pastes, setPastes, uploading, attach, addPaste }
}
type Draft = ReturnType<typeof useDraft>

function Composer({ s, d, working, onSent, interrupt, onRewind }: {
  s: Session; d: Draft; working: boolean; onSent: (x: Sent, done: Promise<unknown>) => void; interrupt: () => void; onRewind: () => void
}) {
  const { text, setText, imgs, setImgs, pastes, setPastes, uploading, attach, addPaste } = d
  const [busy, setBusy] = useState(false)
  const box = useRef<HTMLTextAreaElement>(null)
  const shown = imgs.filter(i => text.includes(tok(i.n))) // 표시를 지운 이미지·글은 보내지 않는다
  const shownPastes = pastes.filter(p => text.includes(ptok(p)))
  const send = async () => {
    if (!text.trim() || busy || uploading) return
    // 쓴 순서대로 나눈다. 짝이 없는 표시(앞서 보낸 것을 글로 가리킨 것 등)는 글 그대로 보낸다
    const parts = text.split(TOK).flatMap((x, i): { text?: string; image?: string; paste?: string }[] => {
      const img = i % 2 ? imgs.find(m => tok(m.n) === x) : undefined
      const pa = i % 2 ? pastes.find(m => ptok(m) === x) : undefined
      return img ? [{ image: img.path }] : pa ? [{ paste: pa.text }] : x ? [{ text: x }] : []
    })
    const x = { text, imgs, pastes, at: serverNow() }
    setBusy(true)
    const req = api('term/send', { pid: s.pid, parts })
    onSent(x, req) // 보내는 중에도(글을 넣는 데 시간이 걸린다) 바로 '일하는 중'으로 본다
    const ok = await req
    setBusy(false)
    if (ok) { setText(''); setImgs([]); setPastes([]) }
  }
  const key = (k: string) => api('term/key', { pid: s.pid, key: k })
  const place = (len: number, at: number) => requestAnimationFrame(() => box.current?.setSelectionRange(at + len, at + len))
  return <Paper withBorder p="sm">
    <Stack gap={8}>
      {s.state === 'approval' && <Group gap={6} wrap="wrap">
        <Text size="sm" c="red.4" fw={600}>실행 허락을 기다립니다</Text>
        <Button size="xs" color="teal" onClick={() => key('1')}>1 · 허용</Button>
        <Button size="xs" variant="default" onClick={() => key('2')}>2 · 이번 세션 동안 허용</Button>
        <Button size="xs" variant="outline" color="red" onClick={() => key('3')}>3 · 거부</Button>
      </Group>}
      {(shown.length > 0 || shownPastes.length > 0) && <Group gap={6} align="flex-end">
        {shown.map(i => <Box key={i.n} pos="relative">
          <img src={i.url} alt={tok(i.n)} style={{ height: 64, borderRadius: 6, display: 'block', border: '1px solid var(--mantine-color-default-border)' }} />
          <Text fz={10} pos="absolute" bottom={2} left={4} px={4} style={{ background: 'rgba(0,0,0,.6)', color: '#fff', borderRadius: 4 }}>{i.n}</Text>
          <CloseButton size="xs" variant="filled" pos="absolute" top={2} right={2} aria-label="이미지 빼기" onClick={() => setText(p => p.replace(tok(i.n), ''))} />
        </Box>)}
        {shownPastes.map(p => <Group key={p.n} gap={4} wrap="nowrap" className="hq-paste-chip" title={p.text.slice(0, 600)}>
          <Text size="xs">{p.n} · 붙여넣은 글 {p.text.split('\n').length}줄</Text>
          <CloseButton size="xs" aria-label="붙여넣은 글 빼기" onClick={() => setText(x => x.replace(ptok(p), ''))} />
        </Group>)}
      </Group>}
      <Textarea ref={box} autosize minRows={2} maxRows={10} value={text} onChange={e => setText(e.currentTarget.value)}
        onPaste={e => {
          const el = e.currentTarget, at = el.selectionStart, sel: [number, number] = [at, el.selectionEnd]
          const files = [...e.clipboardData.files].filter(f => f.type.startsWith('image/'))
          if (files.length) { e.preventDefault(); place(attach(files, sel), at); return }
          const t = e.clipboardData.getData('text/plain')
          if (bigPaste(t)) { e.preventDefault(); place(addPaste(t, sel), at) }
        }}
        placeholder={`${s.title}에게 말하기`} aria-label="보낼 말"
        onKeyDown={e => {
          // 한글 입력 중(조합 중)의 Enter는 글자 확정이라 보내지 않는다
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send() }
        }} />
      <Group justify="space-between" gap={6}>
        <Text size="xs" c="dimmed"><Kbd size="xs">Enter</Kbd> 보내기 · <Kbd size="xs">Shift</Kbd>+<Kbd size="xs">Enter</Kbd> 줄바꿈 · 이미지는 붙여넣기나 끌어다 놓기</Text>
        <Group gap={6}>
          {working && <Button size="xs" variant="default" onClick={interrupt}>중단 (Esc)</Button>}
          {!working && s.host === 'web' && <Button size="xs" variant="subtle" color="gray" onClick={onRewind} title="Claude Code의 되감기(Esc 두 번)">되감기 (Esc Esc)</Button>}
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
      : it.t === 'user' ? <Box key={it.id} className="hq-say me"><Text component="div" size="sm" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}><UserText text={it.text} /></Text></Box>
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
  // 보낸 직후에는 상태가 '작업중'으로 바뀌기까지 1~2초 걸린다. 그 사이에도 중단할 수 있게, 보낸 뒤 상태가 아직 안 바뀌었으면 일하는 중으로 본다
  const sent = useRef<Sent | null>(null) // 이 화면에서 마지막으로 보낸 것(중단하면 그대로 되살린다)
  const [sentAt, setSentAt] = useState(0)
  const working = s.state === 'working' || s.state === 'compact' || s.state === 'approval' || (serverNow() - sentAt < 15000 && s.since < sentAt)
  // 버린 말 가리기: [from, to] 사이에 기록된 항목을 보이지 않는다. Claude Code는 중단·되감기 때 기록 파일에 아무것도 쓰지 않아서,
  // 다음 말이 와서 대화가 새로 그려질 때까지(서버 dropRewound) 화면에서 가린다. 그 뒤에 새로 보낸 말은 to보다 늦어 보인다
  const [cut, setCut] = useState<{ from: number; to: number } | null>(null)
  const shown = useMemo(() => cut ? items.filter(x => x.at < cut.from || x.at > cut.to) : items, [items, cut])
  const restore = (text: string) => {
    const x = sent.current
    // 이 화면에서 보낸 것이면 이미지·붙여넣은 글까지 그대로 되살린다. 아니면(다른 데서 보냄) Claude 입력칸에서 읽은 글로
    if (x && !draft.text.trim()) { draft.setText(x.text); draft.setImgs(x.imgs); draft.setPastes(x.pastes) }
    else draft.setText(p => text + (p ? '\n' + p : ''))
  }
  const sending = useRef<Promise<unknown> | null>(null)
  const interrupt = async () => {
    // 아직 보내는 중이면 다 들어간 뒤에 멈춘다(안 그러면 Esc가 먼저 가고 말은 그대로 보내진다)
    if (sending.current && !await sending.current) return
    const r = await api<{ restored?: string } | undefined>('term/key', { pid: s.pid, key: 'esc' })
    // 답을 시작하기 전에 멈추면 보낸 말이 돌아온다(터미널의 Claude Code와 같다). 웹 입력칸에 되살리고 대화에서는 가린다
    const back = r?.result?.restored
    if (!back) return
    if (sent.current) setCut({ from: sent.current.at - 3000, to: serverNow() + 1000 })
    restore(back); sent.current = null
    toast('중단했습니다. 보낸 말이 입력칸으로 돌아왔습니다.')
  }
  // 되감기: 고른 말부터 아래를 가린다
  const [rewind, setRewind] = useState(false)
  const rewound = (r: { restored: string; picked: string; label: string }) => {
    const flat = (t: string) => t.replace(/<\/?pasted_content[^>]*>/g, '').replace(/\s+/g, '')
    const head = flat(r.picked.replace(/…$/, '')).slice(0, 40)
    const hit = [...items].reverse().find(i => i.t === 'user' && flat(i.text).startsWith(head))
    if (!r.restored) { toast('되감기를 했습니다.'); return }
    if (hit) setCut({ from: hit.at, to: serverNow() + 1000 })
    sent.current = null; draft.setText(p => r.restored + (p ? '\n' + p : ''))
    toast('되감았습니다. 그때 보낸 말이 입력칸에 있습니다.')
  }
  // Esc 키: 일하는 중이면 중단. 쉬는 중에 두 번 빨리 누르면 되감기(터미널의 Claude Code와 같다). 쉬는 중 한 번은 아무것도 보내지 않는다.
  // 창(설정 등)이 떠 있으면 그 창을 닫는 Esc다
  const esc = useRef(() => {})
  const lastEsc = useRef(0)
  esc.current = () => {
    if (!s.host) return
    if (working) { interrupt(); return }
    if (s.host === 'web' && Date.now() - lastEsc.current < 600) { lastEsc.current = 0; setRewind(true) } else lastEsc.current = Date.now()
  }
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.isComposing || document.querySelector('.mantine-Modal-content, .mantine-Drawer-content')) return
      esc.current()
    }
    addEventListener('keydown', on)
    return () => removeEventListener('keydown', on)
  }, [])
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
          <Messages items={shown} detail={detail} />
          {(s.state === 'working' || s.state === 'compact') && <Group gap={8}><Loader size="xs" color={COLOR[s.state]} /><Text size="sm" c={`${COLOR[s.state]}.4`} ff="monospace">{s.act || '생각 중'}</Text></Group>}
        </Stack>
      </ScrollArea>
    </Paper>
    {s.host ? <Composer s={s} d={draft} working={working} onSent={(x, req) => { sent.current = x; sending.current = req; setSentAt(x.at); req.then(ok => { if (!ok) sent.current = null }) }} interrupt={interrupt} onRewind={() => setRewind(true)} /> : <NoInput s={s} />}
    {s.host === 'web' && <RewindModal s={s} opened={rewind} onClose={() => setRewind(false)} onDone={rewound} />}
  </Stack>
}
