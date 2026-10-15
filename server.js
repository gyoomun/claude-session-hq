// claude-session-hq: 이 Mac에 열린 Claude Code 세션을 모아 한 페이지로 보여 주는 로컬 서버.
// 외부 라이브러리 없이 Node 기본 모듈만 쓴다. 127.0.0.1에서만 열린다.
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');

const HOME = os.homedir();
const PORT = +process.env.PORT || 7420;
const CLAUDE_DIR = path.join(HOME, '.claude');
const SESS_DIR = path.join(CLAUDE_DIR, 'sessions'); // Claude Code가 프로세스마다 <pid>.json을 쓴다
const PROJ_DIR = path.join(CLAUDE_DIR, 'projects'); // 대화 기록(<sessionId>.jsonl)
const BOARD_DIR = path.join(CLAUDE_DIR, 'board');
const HOOK_DIR = path.join(BOARD_DIR, 'hooks'); // hooks/hook.sh가 <pid>.json으로 마지막 이벤트를 남긴다
const DB_FILE = path.join(BOARD_DIR, 'hq.json');
const ORCA = '/Applications/Orca.app/Contents/Resources/bin/orca';
const PAGE = path.join(__dirname, 'public', 'index.html');
const SCAN_MS = 2000;
// 처음 보는 세션이 이만큼 넘게 쉬고 있었다면 '내 차례'가 아니라 '쉼'으로 시작한다
const SEEN_GRACE_MS = 30 * 60e3;

/* 저장소: 업무, 세션 배치, 확인 시각 */
let db = { tasks: [], assign: {}, seen: {}, nextId: 1 };
try { db = { ...db, ...JSON.parse(fs.readFileSync(DB_FILE, 'utf8')) }; } catch {}
function save() {
  fs.mkdirSync(BOARD_DIR, { recursive: true });
  fs.writeFileSync(DB_FILE + '.tmp', JSON.stringify(db, null, 1));
  fs.renameSync(DB_FILE + '.tmp', DB_FILE);
}

const readJSON = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const clip = (s, n) => (s && s.length > n ? s.slice(0, n - 1) + '…' : s || '');

function liveSessions() {
  let files = [];
  try { files = fs.readdirSync(SESS_DIR).filter(f => /^\d+\.json$/.test(f)); } catch {}
  return files.map(f => readJSON(path.join(SESS_DIR, f)))
    .filter(s => s && s.sessionId && (s.kind || 'interactive') === 'interactive' && alive(s.pid));
}

/* 대화 기록에서 제목, 마지막 지시, 마지막 답을 읽는다. 파일이 바뀔 때만 끝부분을 다시 읽는다. */
const tcache = new Map();
function findTranscript(s) {
  const guess = path.join(PROJ_DIR, s.cwd.replace(/[^A-Za-z0-9]/g, '-'), s.sessionId + '.jsonl');
  if (fs.existsSync(guess)) return guess;
  try {
    for (const d of fs.readdirSync(PROJ_DIR)) {
      const f = path.join(PROJ_DIR, d, s.sessionId + '.jsonl');
      if (fs.existsSync(f)) return f;
    }
  } catch {}
  return null;
}
function readTail(file, size, bytes) {
  const fd = fs.openSync(file, 'r');
  try {
    const len = Math.min(size, bytes);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    const s = buf.toString('utf8');
    return len < size ? s.slice(s.indexOf('\n') + 1) : s;
  } finally { fs.closeSync(fd); }
}
const textOf = c => typeof c === 'string' ? c : Array.isArray(c) ? c.filter(x => x.type === 'text').map(x => x.text).join('\n') : '';
function scanLines(text, info) {
  for (const line of text.split('\n')) {
    if (!line) continue;
    let d; try { d = JSON.parse(line); } catch { continue; }
    if (d.type === 'ai-title' && d.aiTitle) info.title = d.aiTitle;
    else if (d.type === 'custom-title' && d.customTitle) info.custom = d.customTitle;
    else if (d.isSidechain || d.isMeta) continue;
    else if (d.type === 'assistant') { const t = textOf(d.message?.content).trim(); if (t) info.lastText = t; }
    else if (d.type === 'user') {
      const t = textOf(d.message?.content).trim();
      if (t && !t.startsWith('<') && !t.startsWith('[Request interrupted')) info.lastPrompt = t;
    }
  }
}
function transcriptInfo(s) {
  let c = tcache.get(s.sessionId);
  if (!c) { c = { file: findTranscript(s), mtime: 0 }; tcache.set(s.sessionId, c); }
  if (!c.file) { c.file = findTranscript(s); if (!c.file) return c; }
  let st; try { st = fs.statSync(c.file); } catch { return c; }
  if (st.mtimeMs !== c.mtime) {
    // 처음에는 제목을 찾으려고 넉넉히, 이후에는 끝부분만 읽는다
    scanLines(readTail(c.file, st.size, c.mtime ? 1e6 : 8e6), c);
    c.mtime = st.mtimeMs;
  }
  return c;
}

/* 훅이 남긴 마지막 이벤트. 큰 입력은 잘려 있어 JSON이 깨질 수 있으므로 필요한 값은 정규식으로도 꺼낸다. */
function hookInfo(s) {
  const f = path.join(HOOK_DIR, s.pid + '.json');
  let st; try { st = fs.statSync(f); } catch { return null; }
  let raw; try { raw = fs.readFileSync(f, 'utf8'); } catch { return null; }
  let d = null; try { d = JSON.parse(raw); } catch {}
  const get = k => d ? d[k] : (raw.match(new RegExp('"' + k + '"\\s*:\\s*"([^"]*)"')) || [])[1];
  if (get('session_id') && get('session_id') !== s.sessionId) return null;
  return { event: get('hook_event_name'), tool: get('tool_name'), input: d && d.tool_input, raw, at: st.mtimeMs };
}
function toolLine(h) {
  if (!h || !h.tool) return '';
  const i = h.input || {};
  let x = i.command || i.file_path || i.pattern || i.url || i.description || i.query || '';
  if (!h.input) { const m = h.raw.match(/"(?:command|file_path|pattern|url|description)"\s*:\s*"((?:[^"\\]|\\.){0,200})/); x = m ? m[1] : ''; }
  const tool = h.tool.replace(/^mcp__(.+?)__/, '$1:');
  return clip((tool + (x ? ' · ' + x : '')).replace(/\s+/g, ' '), 160);
}

function stateOf(s, h, now) {
  const at = s.statusUpdatedAt || s.startedAt || now;
  const fresh = h && h.at >= at - 2000;
  if (fresh && h.event === 'PermissionRequest') return ['approval', h.at];
  if (fresh && h.event === 'PreToolUse' && h.tool === 'AskUserQuestion') return ['myturn', h.at];
  if (s.status === 'busy') return ['working', at];
  if (s.status && s.status !== 'idle') return ['working', at];
  return [at > (db.seen[s.sessionId] || 0) ? 'myturn' : 'idle', at];
}

/* Orca 터미널 핸들: claude 프로세스의 환경 변수에 있다. 프로세스마다 한 번만 읽는다. */
const handles = new Map();
function loadHandles(pids) {
  const need = pids.filter(p => !handles.has(p));
  if (!need.length) return;
  need.forEach(p => handles.set(p, null));
  execFile('/bin/ps', ['-E', '-ww', '-o', 'pid=,command=', '-p', need.join(',')], { maxBuffer: 64e6 }, (err, out) => {
    need.forEach(p => handles.set(p, ''));
    for (const line of (out || '').split('\n')) {
      const m = line.match(/^\s*(\d+)\s/);
      const h = line.match(/ORCA_TERMINAL_HANDLE=(\S+)/);
      if (m && h) handles.set(+m[1], h[1]);
    }
  });
}

/* Orca 탭 제목: 사용자가 Orca에서 보는 이름과 같게 맞춘다. 10초마다 새로 읽는다. */
const orcaTitles = new Map();
let orcaTitlesAt = 0;
function loadOrcaTitles(now) {
  if (now - orcaTitlesAt < 10000 || !fs.existsSync(ORCA)) return;
  orcaTitlesAt = now;
  execFile(ORCA, ['terminal', 'list', '--json'], { timeout: 8000, maxBuffer: 16e6 }, (err, out) => {
    if (err) return;
    try {
      orcaTitles.clear();
      for (const t of JSON.parse(out).result.terminals) {
        const title = String(t.title || '').replace(/^[^\p{L}\p{N}]+/u, '').trim();
        if (title && title !== 'Claude Code') orcaTitles.set(t.handle, title);
      }
    } catch {}
  });
}

/* 2초마다 전체 상태를 만들고, 상태가 바뀐 세션은 이벤트로 남긴다 */
let snapshot = { now: Date.now(), sessions: [], tasks: [], feed: [] };
const prev = new Map();
const feed = [];
let firstScan = true;
function pushFeed(e) { feed.unshift(e); if (feed.length > 300) feed.length = 300; }
function scan() {
  const now = Date.now();
  const live = liveSessions();
  loadHandles(live.map(s => s.pid));
  loadOrcaTitles(now);
  let dirty = false;
  const sessions = live.map(s => {
    if (!(s.sessionId in db.seen)) {
      const at = s.statusUpdatedAt || s.startedAt || now;
      db.seen[s.sessionId] = s.status === 'idle' && now - at > SEEN_GRACE_MS ? at : 0;
      dirty = true;
    }
    const h = hookInfo(s);
    const t = transcriptInfo(s);
    const [state, since] = stateOf(s, h, now);
    const toolNow = h && h.at >= (s.statusUpdatedAt || 0) - 2000 && /^(PreToolUse|PostToolUse|PermissionRequest)$/.test(h.event);
    let msg = clip(t.lastText, 600);
    if (state === 'approval') msg = '실행 허락을 기다립니다 · ' + toolLine(h);
    else if (state === 'myturn' && h && h.tool === 'AskUserQuestion' && h.input) msg = clip(h.input.questions?.[0]?.question || msg, 600);
    return {
      pid: s.pid, sid: s.sessionId, name: s.name, title: t.custom || orcaTitles.get(handles.get(s.pid)) || t.title || s.name,
      cwd: s.cwd.replace(HOME, '~'), state, since, startedAt: s.startedAt,
      act: state === 'working' ? (toolNow ? toolLine(h) : '생각 중') : '',
      msg, prompt: clip(t.lastPrompt, 400), task: db.assign[s.sessionId] || '', term: !!handles.get(s.pid),
    };
  });
  const ids = new Set(sessions.map(s => s.sid));
  for (const s of sessions) {
    const p = prev.get(s.sid);
    if (!firstScan && p !== s.state) pushFeed({ at: now, sid: s.sid, title: s.title, task: s.task, from: p || 'open', to: s.state });
    prev.set(s.sid, s.state);
  }
  for (const [sid, st] of prev) if (!ids.has(sid)) {
    prev.delete(sid);
    pushFeed({ at: now, sid, title: snapshot.sessions.find(x => x.sid === sid)?.title || sid, task: db.assign[sid] || '', from: st, to: 'closed' });
  }
  for (const sid of Object.keys(db.seen)) if (!ids.has(sid)) { delete db.seen[sid]; dirty = true; }
  if (dirty) save();
  firstScan = false;
  snapshot = { now, sessions, tasks: db.tasks, feed: feed.slice(0, 120), orca: fs.existsSync(ORCA) };
}

/* 화면에서 오는 요청 */
const task = id => db.tasks.find(t => t.id === id);
const str = (v, n = 300) => String(v ?? '').trim().slice(0, n);
const routes = {
  'task/add': b => {
    const name = str(b.name, 120); if (!name) throw new Error('업무 이름이 필요합니다');
    const now = Date.now();
    db.tasks.push({ id: 't' + db.nextId++, name, memo: str(b.memo), next: '', waits: [], createdAt: now, updatedAt: now });
  },
  'task/update': b => {
    const t = task(b.id); if (!t) throw new Error('없는 업무입니다');
    for (const k of ['name', 'memo', 'next']) if (k in b) t[k] = str(b[k], k === 'name' ? 120 : 500);
    if (!t.name) throw new Error('업무 이름이 필요합니다');
    t.updatedAt = Date.now();
  },
  'task/delete': b => {
    db.tasks = db.tasks.filter(t => t.id !== b.id);
    for (const [sid, tid] of Object.entries(db.assign)) if (tid === b.id) delete db.assign[sid];
  },
  'assign': b => {
    if (b.task && !task(b.task)) throw new Error('없는 업무입니다');
    if (b.task) { db.assign[b.sid] = b.task; task(b.task).updatedAt = Date.now(); } else delete db.assign[b.sid];
  },
  'seen': b => { db.seen[b.sid] = Date.now(); },
  'wait/add': b => {
    const t = task(b.task); const who = str(b.who, 60), what = str(b.what);
    if (!t || !who || !what) throw new Error('누구와 무엇을 둘 다 적어 주세요');
    t.waits.push({ id: 'w' + db.nextId++, who, what, since: Date.now() }); t.updatedAt = Date.now();
  },
  'wait/done': b => {
    const t = task(b.task); if (!t) throw new Error('없는 업무입니다');
    t.waits = t.waits.filter(w => w.id !== b.id); t.updatedAt = Date.now();
  },
  'term/switch': b => orca(b.pid, ['terminal', 'switch']),
  'term/send': b => {
    const text = str(b.text, 4000); if (!text) throw new Error('보낼 내용이 없습니다');
    return orca(b.pid, ['terminal', 'send', '--text', text, '--enter']);
  },
};
function orca(pid, args) {
  const h = handles.get(+pid);
  if (!h) throw new Error('이 세션은 Orca 터미널이 아니어서 열 수 없습니다');
  return new Promise((ok, fail) => execFile(ORCA, [...args, '--terminal', h, '--json'], { timeout: 15000 },
    (err, out, errOut) => err ? fail(new Error(clip((errOut || err.message).trim(), 300))) : ok()));
}

/* HTTP */
function send(res, code, type, body) {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(body);
}
const json = (res, code, obj) => send(res, code, 'application/json; charset=utf-8', JSON.stringify(obj));
http.createServer((req, res) => {
  // 다른 사이트가 localhost로 요청을 보내지 못하게 Host와 전용 헤더를 확인한다
  if (!/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(req.headers.host || '')) return json(res, 403, { error: 'forbidden' });
  const url = req.url.split('?')[0];
  if (req.method === 'GET' && url === '/') return fs.readFile(PAGE, (e, b) => e ? json(res, 500, { error: e.message }) : send(res, 200, 'text/html; charset=utf-8', b));
  if (req.method === 'GET' && url === '/api/state') return json(res, 200, snapshot);
  const route = req.method === 'POST' && url.startsWith('/api/') && routes[url.slice(5)];
  if (!route) return json(res, 404, { error: 'not found' });
  if (req.headers['x-hq'] !== '1') return json(res, 403, { error: 'forbidden' });
  let body = '';
  req.on('data', c => { body += c; if (body.length > 1e5) req.destroy(); });
  req.on('end', async () => {
    try {
      await route(JSON.parse(body || '{}'));
      save(); scan();
      json(res, 200, snapshot);
    } catch (e) { json(res, 400, { error: e.message }); }
  });
}).listen(PORT, '127.0.0.1', () => console.log(`claude-session-hq: http://127.0.0.1:${PORT}`));

scan();
setInterval(scan, SCAN_MS);
