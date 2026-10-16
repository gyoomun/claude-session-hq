// 되감기 창: Claude Code의 되감기(/rewind, 터미널에서 Esc 두 번)를 웹에서 고른다. 서버가 tmux 화면을 읽고 키를 보낸다(웹 세션만)
import { useEffect, useRef, useState } from 'react'
import { Alert, Box, Button, Group, Loader, Modal, ScrollArea, Stack, Text, UnstyledButton } from '@mantine/core'
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
export function RewindModal({ s, opened, onClose, onDone }: {
  s: Session; opened: boolean; onClose: () => void; onDone: (r: { restored: string; picked: string; label: string }) => void
}) {
  const [items, setItems] = useState<Item[] | null>(null)
  const [picked, setPicked] = useState<Item | null>(null)
  const [confirm, setConfirm] = useState<Confirm | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const done = useRef(false)
  const live = useRef(false) // 목록을 읽는 사이에 창을 닫았으면, 다 열린 뒤에 Claude 쪽 되감기 창도 닫는다
  const view = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!opened) return
    done.current = false; live.current = true
    setItems(null); setPicked(null); setConfirm(null); setError('')
    fetch('/api/rewind/open', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-hq': '1' }, body: JSON.stringify({ pid: s.pid }) })
      .then(r => r.json()).then(d => { if (!live.current) api('rewind/cancel', { pid: s.pid }); else if (d.error) setError(d.error); else setItems(d.result) })
      .catch(() => setError('서버에 연결할 수 없습니다'))
  }, [opened, s.pid])
  useEffect(() => { if (items && view.current) view.current.scrollTop = view.current.scrollHeight }, [items])
  const close = () => { live.current = false; if (!done.current) api('rewind/cancel', { pid: s.pid }); onClose() }
  const pick = async (it: Item) => {
    setBusy(true); setError('')
    const r = await api<Confirm>('rewind/pick', { pid: s.pid, k: it.k, text: it.text })
    setBusy(false)
    if (r) { setPicked(it); setConfirm(r.result) } else onClose()
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
  return <Modal opened={opened} onClose={close} title="되감기" size="lg">
    {error ? <Alert color="red" variant="light">{error}</Alert>
      : !items ? <Group gap={8}><Loader size="xs" /><Text size="sm" c="dimmed">되감을 수 있는 말을 읽는 중입니다…</Text></Group>
      : !confirm ? <Stack gap="xs">
          <Text size="sm" c="dimmed">고른 말을 보내기 전으로 돌아갑니다. 위가 오래된 말입니다{items.length >= 50 ? ' (최근 50개)' : ''}.</Text>
          {!items.length && <Text size="sm">되감을 말이 없습니다.</Text>}
          <ScrollArea.Autosize mah="60vh" viewportRef={view}>
            <Stack gap={4}>{items.map(it => <UnstyledButton key={it.k} disabled={busy} onClick={() => pick(it)} p="8px 10px" className="hq-rewind-item">
              <Text size="sm" className="hq-wrap">{it.text}</Text>
              <Text size="xs" c="dimmed">{DETAIL[it.detail] || it.detail}</Text>
            </UnstyledButton>)}</Stack>
          </ScrollArea.Autosize>
          {busy && <Group gap={8}><Loader size="xs" /><Text size="sm" c="dimmed">고르는 중…</Text></Group>}
        </Stack>
      : <Stack gap="sm">
          <Text size="sm">이 말을 보내기 전으로 돌아갑니다.</Text>
          <Box className="hq-say me" style={{ alignSelf: 'stretch', maxWidth: '100%' }}><Text size="sm" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{confirm.message}</Text></Box>
          {confirm.notes.map(n => <Text key={n} size="xs" c="dimmed">{note(n)}</Text>)}
          <Group gap="xs">{confirm.options.map(o => <Button key={o.n} size="xs" loading={busy && o.label !== 'Never mind'} disabled={busy}
            variant={o.label === 'Never mind' ? 'default' : o.n === 1 ? 'filled' : 'light'} onClick={() => choose(o)}>{LABEL[o.label] || o.label}</Button>)}</Group>
        </Stack>}
  </Modal>
}
