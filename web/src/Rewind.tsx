// 되감기: Claude Code의 되감기(/rewind, 터미널에서 Esc 두 번)를 대화 화면 입력칸 자리에서 고른다(터미널처럼, 키보드만으로).
// 서버가 tmux 화면을 읽고 키를 보낸다(웹 세션만). ↑↓ 고르기 · Enter 정하기 · Esc 닫기, 확인 단계에서는 숫자 키로도 고른다
import { useEffect, useRef, useState } from 'react'
import { Box, Group, Kbd, Paper, Skeleton, Stack, Text } from '@mantine/core'
import { api } from './store'
import type { Session } from './types'

interface Item { k: number; text: string; detail: string }
interface Confirm { message: string; notes: string[]; options: { n: number; label: string }[] }

const LABEL: Record<string, string> = {
  'Restore code and conversation': '코드와 대화 되돌리기', 'Restore conversation': '대화 되돌리기', 'Restore code': '코드만 되돌리기',
  'Summarize from here': '여기부터 요약', 'Summarize up to here': '여기까지 요약', 'Never mind': '취소',
}
const NOTE: Record<string, string> = {
  'The conversation will be forked.': '대화는 이 말을 보내기 전으로 돌아가 새로 이어집니다.',
  'The code will be unchanged.': '코드는 그대로입니다.',
  '⚠ Rewinding does not affect files edited manually or via bash.': '직접 고치거나 bash로 바꾼 파일은 되돌리지 않습니다.',
}
const note = (n: string) => NOTE[n] || n.replace(/^The code will be restored (.+) in (.+)\.$/, '코드 되돌리기를 고르면 $2 파일도 되돌립니다($1).')
const DETAIL: Record<string, string> = { 'No code changes': '코드 변경 없음' }

// restored: 되돌린 뒤 Claude 입력칸에 돌아온 그때의 말. picked: 고른 말(목록의 첫 줄)
export function RewindPanel({ s, onClose, onDone }: {
  s: Session; onClose: () => void; onDone: (r: { restored: string; picked: string; label: string }) => void
}) {
  const [items, setItems] = useState<Item[] | null>(null)
  const [sel, setSel] = useState(0)
  const [picked, setPicked] = useState<Item | null>(null)
  const [confirm, setConfirm] = useState<Confirm | null>(null)
  const [opt, setOpt] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const root = useRef<HTMLDivElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const live = useRef(true) // 목록을 읽는 사이에 닫았으면, 다 열린 뒤에 Claude 쪽 되감기 창도 닫는다
  const done = useRef(false)
  useEffect(() => {
    root.current?.focus()
    fetch('/api/rewind/open', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-hq': '1' }, body: JSON.stringify({ pid: s.pid }) })
      .then(r => r.json()).then(d => {
        if (!live.current) { api('rewind/cancel', { pid: s.pid }); return }
        if (d.error) setError(d.error); else { setItems(d.result); setSel(d.result.length - 1) } // 터미널처럼 가장 최근 말에서 시작
      }).catch(() => setError('서버에 연결할 수 없습니다'))
    return () => { live.current = false }
  }, [s.pid])
  useEffect(() => { list.current?.querySelector('.on')?.scrollIntoView({ block: 'nearest' }) }, [sel, items])
  useEffect(() => { root.current?.focus() }, [confirm])
  const close = () => { live.current = false; if (!done.current) api('rewind/cancel', { pid: s.pid }); onClose() }
  const pick = async (it: Item) => {
    setBusy(true)
    const r = await api<Confirm>('rewind/pick', { pid: s.pid, k: it.k, text: it.text })
    setBusy(false)
    if (!r) { onClose(); return }
    setPicked(it); setConfirm(r.result); setOpt(0)
  }
  const choose = async (o: Confirm['options'][number]) => {
    if (o.label === 'Never mind') { close(); return }
    setBusy(true)
    const r = await api<{ restored: string }>('rewind/confirm', { pid: s.pid, n: o.n })
    setBusy(false)
    done.current = true
    if (r) onDone({ restored: r.result.restored || '', picked: picked!.text, label: o.label })
    onClose()
  }
  const key = (e: React.KeyboardEvent) => {
    if (e.nativeEvent.isComposing) return
    const n = confirm ? confirm.options.length : items?.length || 0
    const setI = confirm ? setOpt : setSel
    const k = e.key
    if (k === 'Escape') close()
    else if (busy) return
    else if (k === 'ArrowUp' || k === 'ArrowDown') setI(i => Math.max(0, Math.min(n - 1, i + (k === 'ArrowUp' ? -1 : 1))))
    else if (k === 'Home' || k === 'End') setI(k === 'Home' ? 0 : n - 1)
    else if (k === 'Enter') { if (confirm) choose(confirm.options[opt]); else if (items?.[sel]) pick(items[sel]) }
    else if (confirm && /^[1-9]$/.test(k)) { const o = confirm.options.find(x => x.n === +k); if (o) choose(o) }
    else return
    e.preventDefault(); e.stopPropagation()
  }
  const hint = (keys: string[], what: string) => <Group gap={4} wrap="nowrap">{keys.map(x => <Kbd key={x} size="xs">{x}</Kbd>)}<Text size="xs" c="dimmed">{what}</Text></Group>
  return <Paper withBorder p="sm" className="hq-rewind hq-in" ref={root} tabIndex={-1} onKeyDown={key} style={{ outline: 'none' }}>
    <Group justify="space-between" mb={8} wrap="nowrap">
      <Text size="sm" fw={600}>되감기 <Text span size="xs" c="dimmed" fw={400}>{confirm ? '이 말을 보내기 전으로 돌아갑니다' : '고른 말을 보내기 전으로 돌아갑니다'}</Text></Text>
      <Group gap="md" wrap="nowrap">{hint(['↑', '↓'], '고르기')}{confirm && hint(['1~' + confirm.options.length], '바로')}{hint(['Enter'], busy ? '처리 중…' : '정하기')}{hint(['Esc'], '닫기')}</Group>
    </Group>
    {error ? <Text size="sm" c="red.4">{error}</Text>
      : !items ? <Stack gap={6}>{[70, 55, 80, 45].map((w, i) => <Group key={i} gap={8} wrap="nowrap" px={8} py={4}><Skeleton h={12} w={`${w}%`} /><Skeleton h={10} w={70} ml="auto" /></Group>)}</Stack>
      : !confirm ? <Box ref={list} className="hq-rewind-list">
          {!items.length && <Text size="sm" c="dimmed" px={8}>되감을 말이 없습니다.</Text>}
          {items.map((it, i) => <Group key={it.k} gap={8} wrap="nowrap" className={'hq-rewind-row' + (i === sel ? ' on' : '')} onMouseEnter={() => setSel(i)} onClick={() => !busy && pick(it)}>
            <Text size="sm" w={12} c="indigo.4" style={{ flex: 'none' }}>{i === sel ? '❯' : ''}</Text>
            <Text size="sm" truncate style={{ flex: 1, minWidth: 0 }}>{it.text}</Text>
            <Text size="xs" c={it.detail === 'No code changes' ? 'dimmed' : 'teal.4'} style={{ flex: 'none' }}>{DETAIL[it.detail] || it.detail}</Text>
          </Group>)}
          {items.length >= 50 && <Text size="xs" c="dimmed" px={8} pt={4}>최근 50개까지 보입니다</Text>}
        </Box>
      : <Stack gap={8}>
          <Box className="hq-say me" style={{ alignSelf: 'stretch', maxWidth: '100%' }}><Text size="sm" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{confirm.message}</Text></Box>
          {confirm.notes.map(n => <Text key={n} size="xs" c="dimmed">{note(n)}</Text>)}
          <Box>{confirm.options.map((o, i) => <Group key={o.n} gap={8} wrap="nowrap" className={'hq-rewind-row' + (i === opt ? ' on' : '')} onMouseEnter={() => setOpt(i)} onClick={() => !busy && choose(o)}>
            <Text size="sm" w={12} c="indigo.4">{i === opt ? '❯' : ''}</Text>
            <Text size="sm">{o.n}. {LABEL[o.label] || o.label}</Text>
          </Group>)}</Box>
        </Stack>}
  </Paper>
}
