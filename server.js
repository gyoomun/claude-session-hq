// claude-session-hq: 이 Mac의 Claude Code 세션을 모아 보고, 웹 안의 터미널로 직접 일하게 하는 로컬 서버.
// 웹에서 연 세션은 전용 tmux 서버 안에서 돌아 이 서버가 꺼져도 살아 있다. 이 맥 밖(사내망)에서는 메일 인증으로 로그인해야 쓴다(auth.js).
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFile, spawn } = require('child_process');
const pty = require('node-pty');

const HOME = os.homedir();
const PORT = +process.env.PORT || 7420;
const CLAUDE_DIR = path.join(HOME, '.claude');
const SESS_DIR = path.join(CLAUDE_DIR, 'sessions'); // Claude Code가 프로세스마다 <pid>.json을 쓴다
const PROJ_DIR = path.join(CLAUDE_DIR, 'projects'); // 대화 기록(<sessionId>.jsonl)
const BOARD_DIR = path.join(CLAUDE_DIR, 'board');
const HOOK_DIR = path.join(BOARD_DIR, 'hooks'); // hooks/hook.sh가 <pid>.json으로 마지막 이벤트를 남긴다
const DB_FILE = path.join(BOARD_DIR, 'hq.json');
const ORCA = '/Applications/Orca.app/Contents/Resources/bin/orca';
const DIST = path.join(__dirname, 'dist'); // 화면(web/)을 npm run build로 만든 결과
const SCAN_MS = 2000;
// 처음 보는 세션이 이만큼 넘게 쉬고 있었다면 '내 차례'가 아니라 '쉼'으로 시작한다
const SEEN_GRACE_MS = 30 * 60e3;

/* tmux: 사용자가 따로 쓰는 tmux와 섞이지 않게 전용 소켓과 설정 파일을 쓴다 */
const TMUX = fs.existsSync('/opt/homebrew/bin/tmux') ? '/opt/homebrew/bin/tmux' : 'tmux';
const TMUX_ARGS = ['-L', 'claude-hq', '-f', path.join(__dirname, 'tmux.conf'), '-u'];
const SHELL = os.userInfo().shell || '/bin/zsh';
// tmux와 그 안의 셸이 받을 환경. launchd나 Orca의 변수(ORCA_*, CLAUDECODE 등)가 새 세션에 섞이지 않게 새로 만든다
const TERM_ENV = {
  HOME, USER: os.userInfo().username, LOGNAME: os.userInfo().username, SHELL, TMPDIR: os.tmpdir(),
  PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin',
  LANG: process.env.LANG || 'en_US.UTF-8', TERM: 'xterm-256color', COLORTERM: 'truecolor',
};

/* 저장소: 업무, 세션 배치, 확인 시각, 웹 세션 목록(재부팅 뒤 복구용) */
let db = { tasks: [], assign: {}, seen: {}, web: [], layout: {}, rooms: {}, btw: {}, memos: {}, closed: [], claudeArgs: ['--dangerously-skip-permissions'], nextId: 1 };
try { db = { ...db, ...JSON.parse(fs.readFileSync(DB_FILE, 'utf8')) }; } catch {}
// 서버가 꺼지면서 끊긴 곁가지 질문은 실패로 표시한다
for (const list of Object.values(db.btw || {})) for (const it of list) if (it.state === 'asking') { it.state = 'error'; it.a = '서버가 다시 시작돼 답을 받지 못했습니다.'; }
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
// "t1 [>] 할 일" / "d1 [?] 결정할 것" 줄을 항목으로. 표시: ' ' 할 일, '>' 하는 중, 'x' 끝남, '?' 결정할 것
const pinItems = text => text.split('\n').map(l => l.match(/^(\w+) \[(.)\] (.*)$/)).filter(Boolean).map(m => ({ id: m[1], mark: m[2], text: m[3] }));
const textOf = c => typeof c === 'string' ? c : Array.isArray(c) ? c.filter(x => x.type === 'text').map(x => x.text).join('\n') : '';
function scanLines(text, info) {
  for (const line of text.split('\n')) {
    if (!line) continue;
    let d; try { d = JSON.parse(line); } catch { continue; }
    if (d.type === 'ai-title' && d.aiTitle) info.title = d.aiTitle;
    else if (d.type === 'custom-title' && d.customTitle) info.custom = d.customTitle;
    else if (d.isSidechain || d.isMeta || d.isCompactSummary) continue; // 자동 압축 요약은 Claude Code가 넣은 글이라 내 말로 치지 않는다
    else if (d.type === 'assistant') { const t = textOf(d.message?.content).trim(); if (t) info.lastText = t; }
    else if (d.type === 'user') {
      // 핀보드 플러그인은 바꿀 때마다 보드 전체를 도구 결과로 남긴다("Pinboard now: …"). 그 마지막 것이 지금 보드다
      for (const x of Array.isArray(d.message?.content) ? d.message.content : []) {
        const r = x.type === 'tool_result' ? textOf(x.content) : '';
        if (/^Pinboard (now:|is empty\.)/.test(r)) info.pin = { text: r, at: Date.parse(d.timestamp) || 0 };
      }
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

const quiet = new Map(); // sid -> 마지막으로 본 쉬는 상태(idle/myturn). 압축이 끝난 뒤 되돌릴 때 쓴다
function stateOf(s, h, now) {
  const at = s.statusUpdatedAt || s.startedAt || now;
  const fresh = h && h.at >= at - 2000;
  if (fresh && h.event === 'PermissionRequest') return ['approval', h.at];
  if (fresh && h.event === 'PreToolUse' && h.tool === 'AskUserQuestion') return ['myturn', h.at];
  // 대화 압축(PreCompact 훅 직후의 busy)은 일이 아니므로 따로 '압축 중'으로 보인다
  if (s.status && s.status !== 'idle') return [fresh && h.event === 'PreCompact' ? 'compact' : 'working', at];
  let st = at > (db.seen[s.sessionId] || 0) ? 'myturn' : 'idle';
  // Claude Code는 쉬는 동안 스스로 대화를 압축한다(PreCompact 훅이 마지막 이벤트). 끝나면 상태 시각만 바뀌고 새로 할 말은 없으니 압축 전 상태로 둔다
  if (st === 'myturn' && h && h.event === 'PreCompact' && quiet.get(s.sessionId) === 'idle') { db.seen[s.sessionId] = at; st = 'idle'; }
  quiet.set(s.sessionId, st);
  return [st, at];
}

/* 세션이 어디서 돌고 있나: claude 프로세스의 환경 변수로 안다. 웹 세션은 HQ_TMUX, Orca는 ORCA_TERMINAL_HANDLE. 프로세스마다 한 번만 읽는다. */
const handles = new Map(); // pid -> { tmux, orca }
const argsByPid = new Map(); // pid -> 다시 띄울 때 쓸 원래 옵션(--dangerously-skip-permissions 등)
function loadHandles(pids) {
  const need = pids.filter(p => !handles.has(p));
  if (!need.length) return;
  need.forEach(p => handles.set(p, {}));
  execFile('/bin/ps', ['-ww', '-o', 'pid=,command=', '-p', need.join(',')], (err, out) => {
    for (const line of (out || '').split('\n')) {
      const m = line.match(/^\s*(\d+)\s+(.*)$/);
      if (m) argsByPid.set(+m[1], keepFlags(m[2].trim().split(/\s+/).slice(1)));
    }
  });
  execFile('/bin/ps', ['-E', '-ww', '-o', 'pid=,command=', '-p', need.join(',')], { maxBuffer: 64e6 }, (err, out) => {
    for (const line of (out || '').split('\n')) {
      const m = line.match(/^\s*(\d+)\s/);
      if (!m) continue;
      const t = line.match(/ HQ_TMUX=(hq-[a-z0-9]+)/), o = line.match(/ ORCA_TERMINAL_HANDLE=(\S+)/);
      // tmux 안에서 돈다면 웹 세션이다. Orca 변수가 남아 있어도 무시한다
      handles.set(+m[1], t ? { tmux: t[1] } : o ? { orca: o[1] } : {});
    }
  });
}

/* tmux */
const q = a => "'" + String(a).replace(/'/g, "'\\''") + "'";
function tmux(args) {
  return new Promise((ok, fail) => execFile(TMUX, [...TMUX_ARGS, ...args], { env: TERM_ENV, timeout: 10000 },
    (err, out, errOut) => err ? fail(new Error(clip((errOut || err.message).trim(), 300))) : ok(out)));
}
// 로그인 셸로 claude를 띄운다(.zshrc의 PATH를 쓰려고). claude가 끝나면 tmux 세션도 끝난다
function startTmux(name, cwd, args) {
  return tmux(['new-session', '-d', '-s', name, '-c', cwd, '-x', '200', '-y', '50', '-e', 'HQ_TMUX=' + name,
    SHELL, '-lic', 'exec claude ' + args.map(q).join(' ')]);
}
const tmuxPanes = new Map(); // tmux 세션 이름 -> 탭 제목(Claude가 정한 제목)
let tmuxAlive = false;
function loadTmuxPanes() {
  execFile(TMUX, [...TMUX_ARGS, 'list-panes', '-a', '-F', '#{session_name}\t#{pane_title}'], { env: TERM_ENV, timeout: 5000 }, (err, out) => {
    tmuxAlive = !err;
    tmuxPanes.clear();
    for (const line of (out || '').split('\n')) {
      const [name, title] = line.split('\t');
      if (name) tmuxPanes.set(name, String(title || '').replace(/^[^\p{L}\p{N}]+/u, '').trim());
    }
  });
}
// 서버가 켜질 때: 목록에 있는데 tmux에 없는 웹 세션(재부팅 등으로 죽은 것)을 같은 명령으로 다시 띄운다
async function restoreWeb() {
  let names = [];
  try { names = (await tmux(['list-sessions', '-F', '#{session_name}'])).split('\n'); } catch {}
  const openSids = new Set(liveSessions().map(x => x.sessionId));
  for (const w of db.web) {
    if (names.includes(w.name) || !w.sid) continue;
    // 그 대화가 이미 다른 곳(Orca 등)에서 열려 있으면 다시 띄우지 않는다. 같은 대화가 둘로 돌면 엉킨다
    if (openSids.has(w.sid)) { console.log('복구 건너뜀(다른 곳에서 열려 있음):', w.name, w.sid); w.sid = ''; w.createdAt = 0; continue; }
    // 꺼지기 전에 나를 기다리던 세션만 '내 차례'로 남기고, 나머지는 다시 띄운 것만으로 '내 차례'가 되지 않게 한다
    if (w.state !== 'myturn' && w.state !== 'approval') db.seen[w.sid] = Date.now() + 30e3;
    try { await startTmux(w.name, w.cwd, [...w.args, '--resume', w.sid]); console.log('복구:', w.name, w.sid); }
    catch (e) { console.error('복구 실패:', w.name, e.message); }
  }
  db.web = db.web.filter(w => w.sid || Date.now() - w.createdAt < 60e3);
  save();
}
function keepFlags(tokens) {
  // 원래 실행 옵션 중 이어 띄울 때도 의미 있는 것만 남긴다
  const out = [];
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] === '--dangerously-skip-permissions') out.push(tokens[i]);
    else if (['--permission-mode', '--model', '--add-dir'].includes(tokens[i]) && tokens[i + 1]) out.push(tokens[i], tokens[++i]);
  }
  return out;
}
const run = (cmd, args) => new Promise((ok, fail) => execFile(cmd, args, { timeout: 15000 }, (e, out, err) => e ? fail(new Error(clip((err || e.message).trim(), 300))) : ok(out)));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const newName = () => 'hq-' + Date.now().toString(36) + crypto.randomBytes(2).toString('hex');

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

/* 새 세션을 열 수 있는 폴더: Orca 워크스페이스 목록. 1분마다 새로 읽는다. */
let worktrees = [];
let worktreesAt = 0;
function loadWorktrees(now) {
  if (now - worktreesAt < 60000 || !fs.existsSync(ORCA)) return;
  worktreesAt = now;
  execFile(ORCA, ['worktree', 'list', '--json'], { timeout: 8000, maxBuffer: 16e6 }, (err, out) => {
    if (err) return;
    try {
      worktrees = JSON.parse(out).result.worktrees.map(w => ({ path: w.path, name: w.displayName || path.basename(w.path) }))
        .sort((a, b) => a.name.localeCompare(b.name, 'ko', { numeric: true }));
    } catch {}
  });
}
// 화면에서 연 세션: tmux 이름으로 기억해 두었다가 세션이 나타나면 고른 업무에 배치한다
const pendingAssign = new Map();
// 화면 밖에서(예: 웹 안의 Claude가) 세션을 열었을 때, 열려 있는 화면이 그 세션으로 넘어가게 하는 신호
let focusReq = null;

/* 2초마다 전체 상태를 만들고, 상태가 바뀐 세션은 이벤트로 남긴다 */
let snapshot = { now: Date.now(), sessions: [], tasks: [], feed: [] };
const prev = new Map();
const feed = [];
let firstScan = true;
function pushFeed(e) { feed.unshift(e); if (feed.length > 300) feed.length = 300; }
function scan() {
  const now = Date.now();
  const live = liveSessions().filter(s => !btwPids.has(s.pid));
  loadHandles(live.map(s => s.pid));
  loadOrcaTitles(now);
  loadWorktrees(now);
  loadTmuxPanes();
  let dirty = false;
  const sessions = live.map(s => {
    const where = handles.get(s.pid) || {};
    if (where.tmux) {
      const task = pendingAssign.get(where.tmux);
      if (task) {
        pendingAssign.delete(where.tmux);
        if (db.tasks.some(t => t.id === task)) { db.assign[s.sessionId] = task; dirty = true; }
      }
      const w = db.web.find(x => x.name === where.tmux);
      if (w && w.sid !== s.sessionId) { w.sid = s.sessionId; dirty = true; }
    }
    if (!(s.sessionId in db.seen)) {
      const at = s.statusUpdatedAt || s.startedAt || now;
      // 닫혔다가 다시 열린 대화는 닫히기 전 상태를 따른다(다시 띄운 것만으로 '내 차례'가 되지 않게)
      const c = db.closed.find(x => x.sid === s.sessionId);
      db.seen[s.sessionId] = c ? (c.state === 'myturn' || c.state === 'approval' ? 0 : now + 30e3)
        : s.status === 'idle' && now - at > SEEN_GRACE_MS ? at : 0;
      dirty = true;
    }
    const h = hookInfo(s);
    const t = transcriptInfo(s);
    const [state, since] = stateOf(s, h, now);
    const toolNow = h && h.at >= (s.statusUpdatedAt || 0) - 2000 && /^(PreToolUse|PostToolUse|PermissionRequest)$/.test(h.event);
    let msg = clip(t.lastText, 600);
    if (state === 'approval') msg = '실행 허락을 기다립니다 · ' + toolLine(h);
    else if (state === 'myturn' && h && h.tool === 'AskUserQuestion' && h.input) msg = clip(h.input.questions?.[0]?.question || msg, 600);
    const web = where.tmux && db.web.find(x => x.name === where.tmux);
    if (web && web.state !== state) { web.state = state; dirty = true; }
    const tabTitle = where.tmux ? tmuxPanes.get(where.tmux) : orcaTitles.get(where.orca);
    return {
      pid: s.pid, sid: s.sessionId, name: s.name, title: t.custom || (tabTitle && tabTitle !== 'Claude Code' ? tabTitle : '') || t.title || s.name,
      cwd: s.cwd.replace(HOME, '~'), dir: s.cwd, state, since, startedAt: s.startedAt,
      act: state === 'working' ? (toolNow ? toolLine(h) : '생각 중') : state === 'compact' ? '대화 압축 중' : '',
      msg, prompt: clip(t.lastPrompt, 400), task: db.assign[s.sessionId] || '',
      // 핀보드는 Claude 프로세스 메모리에만 있어 다시 띄우면 비워진다. 이 프로세스가 뜬 뒤의 기록만 믿는다
      pin: t.pin && t.pin.at >= s.startedAt ? pinItems(t.pin.text) : [],
      host: where.tmux ? 'web' : where.orca ? 'orca' : '', tmux: where.tmux || '',
    };
  });
  // 웹 세션이 스스로 끝났으면(/exit 등) 목록에서 뺀다. 다시 띄우지 않는다
  if (tmuxAlive) {
    const before = db.web.length;
    db.web = db.web.filter(w => tmuxPanes.has(w.name) || now - w.createdAt < 30e3);
    if (db.web.length !== before) dirty = true;
  }
  const ids = new Set(sessions.map(s => s.sid));
  for (const s of sessions) {
    const p = prev.get(s.sid);
    if (!firstScan && p !== s.state) pushFeed({ at: now, sid: s.sid, title: s.title, task: s.task, from: p || 'open', to: s.state });
    prev.set(s.sid, s.state);
  }
  for (const [sid, st] of prev) if (!ids.has(sid)) {
    prev.delete(sid);
    const was = snapshot.sessions.find(x => x.sid === sid);
    pushFeed({ at: now, sid, title: was?.title || sid, task: db.assign[sid] || '', from: st, to: 'closed' });
    // 최근 닫힌 세션: Orca가 꺼지는 등으로 한꺼번에 사라져도 웹에서 같은 명령으로 다시 열 수 있게 남긴다
    if (was && !restarting.has(sid)) {
      db.closed = [{ sid, title: was.title, dir: was.dir, cwd: was.cwd, args: argsByPid.get(was.pid) || [], host: was.host, state: was.state, closedAt: now },
        ...db.closed.filter(c => c.sid !== sid)].slice(0, 60);
      dirty = true;
    }
  }
  // 다시 열린 대화와 7일 지난 기록은 목록에서 뺀다
  const keep = db.closed.filter(c => !ids.has(c.sid) && now - c.closedAt < 7 * 864e5);
  if (keep.length !== db.closed.length) { db.closed = keep; dirty = true; }
  // 닫힌 세션의 확인 기록은 지운다. 웹 세션은 다시 뜨는 중일 수 있으니 남긴다
  for (const sid of Object.keys(db.seen)) if (!ids.has(sid) && !db.web.some(w => w.sid === sid)) { delete db.seen[sid]; dirty = true; }
  if (dirty) save();
  firstScan = false;
  snapshot = { now, sessions, tasks: db.tasks, feed: feed.slice(0, 120), orca: fs.existsSync(ORCA), worktrees, focus: focusReq, layout: db.layout, rooms: db.rooms, btw: db.btw, memos: db.memos, closed: db.closed, migrating,
    // 화면 빌드 시각: 열려 있는 화면이 자기보다 새 빌드가 나왔는지 알아채게 한다
    build: (() => { try { return fs.statSync(path.join(DIST, 'index.html')).mtimeMs; } catch { return 0; } })() };
}

/* 대화 화면: 대화 기록(jsonl)을 웹에서 그릴 수 있는 메시지로 바꾼다. 처음엔 끝부분만, 이후엔 늘어난 만큼만 읽는다 */
const cut = (v, n) => { const t = typeof v === 'string' ? v : JSON.stringify(v); return t && t.length > n ? t.slice(0, n) + '…' : (t || ''); };
function toolInput(name, i = {}) {
  return cut(i.command || i.file_path || i.pattern || i.url || i.query || i.description || i.prompt || i.skill || (Object.keys(i).length ? i : ''), 400);
}
// 붙여넣은 긴 글은 Claude Code가 <pasted_content id="…">로 감싼다. 시스템 문구(<로 시작)인지는 태그를 벗기고 본다. 태그는 남겨 화면이 붙여넣은 칸으로 그린다
const unwrapPaste = t => t.replace(/<\/?pasted_content(?: id="[^"]*")?>/g, '').trim();
function chatItems(entries) {
  const out = [];
  for (const d of entries) {
    // 자동 압축 요약(isCompactSummary)은 Claude Code가 내 말처럼 넣은 긴 글이라 보이지 않는다(터미널에서도 접혀 있다)
    if (d.isSidechain || d.isMeta || d.isCompactSummary || (d.type !== 'user' && d.type !== 'assistant')) continue;
    const c = d.message && d.message.content, at = Date.parse(d.timestamp) || 0, id = d.uuid || String(out.length);
    if (d.type === 'user') {
      if (typeof c === 'string') {
        const u = unwrapPaste(c);
        const cmd = c.match(/<command-name>([^<]*)<\/command-name>(?:[\s\S]*<command-args>([^<]*)<\/command-args>)?/);
        if (cmd) out.push({ id, at, t: 'user', text: (cmd[1] + ' ' + (cmd[2] || '')).trim() });
        else if (u && !u.startsWith('<')) out.push({ id, at, t: 'user', text: c.trim() });
        continue;
      }
      // 한 메시지의 글과 이미지는 말풍선 하나로. 이미지는 글 속 [Image #N]이 자리를 표시하므로, 글이 없을 때만 따로 적는다
      const texts = (c || []).filter(x => x.type === 'text' && (u => u && !u.startsWith('<'))(unwrapPaste(x.text))).map(x => x.text.trim());
      const imgs = (c || []).filter(x => x.type === 'image').length;
      if (texts.length || imgs) out.push({ id, at, t: 'user', text: texts.join('\n') || `[이미지 ${imgs}장]` });
      for (const [k, x] of (c || []).entries()) {
        if (x.type === 'tool_result') {
          const r = Array.isArray(x.content) ? x.content.filter(y => y.type === 'text').map(y => y.text).join('\n') : x.content;
          out.push({ id: id + k, at, t: 'result', toolId: x.tool_use_id, text: cut(r, 3000), error: !!x.is_error });
        }
      }
    } else {
      for (const [k, x] of (c || []).entries()) {
        if (x.type === 'text' && x.text.trim()) out.push({ id: id + k, at, t: 'assistant', text: x.text });
        else if (x.type === 'tool_use') out.push({ id: id + k, at, t: 'tool', toolId: x.id, name: x.name.replace(/^mcp__(.+?)__/, '$1:'), text: toolInput(x.name, x.input) });
      }
    }
  }
  return out;
}
// 되감기(rewind)나 '답 전에 Esc → 고쳐서 다시 보내기'를 하면 버린 말도 파일에 남고, 새 말은 그 앞 지점(parentUuid)에 이어 붙는다.
// 그래서 내가 친 말의 부모가 그보다 앞서 친 말보다 앞에 있으면, 그 사이(버린 갈래)는 보이지 않는다.
// parentUuid 사슬 전체를 따라가면 안 된다: 병렬 도구 결과 등 사슬 밖에 있는 정상 항목이 많다
const typed = d => d.type === 'user' && !d.isMeta && !d.isCompactSummary && !d.isSidechain &&
  (typeof d.message?.content === 'string' || !(d.message?.content || []).some(x => x.type === 'tool_result'));
function dropRewound(entries) {
  const at = new Map(entries.map((d, i) => [d.uuid, i]));
  const hidden = new Set();
  entries.forEach((d, i) => {
    const from = at.get(d.parentUuid);
    if (!typed(d) || from === undefined) return;
    for (let j = from + 1; j < i; j++) if (typed(entries[j]) && !hidden.has(j)) { for (let k = j; k < i; k++) hidden.add(k); break; }
  });
  return entries.filter((_, i) => !hidden.has(i));
}
// 마지막으로 친 말부터 끝까지의 uuid. 이어 읽을 때 새로 친 말의 부모가 여기 없으면 갈래가 바뀐 것이다(처음부터 다시 그린다)
const sinceTyped = (entries, set = new Set()) => { for (const d of entries) { if (typed(d)) set.clear(); if (d.uuid) set.add(d.uuid); } return set; };
const turns = new Map(); // `${sid}:${next}` -> sinceTyped
const parseLines = text => text.split('\n').flatMap(l => { if (!l) return []; try { return [JSON.parse(l)]; } catch { return []; } });

function transcript(params) {
  const sid = params.get('sid') || '';
  if (!/^[0-9a-f-]{36}$/.test(sid)) throw new Error('대화 ID 형식이 아닙니다');
  const live = liveSessions().find(x => x.sessionId === sid);
  const file = findTranscript({ cwd: live ? live.cwd : '', sessionId: sid });
  if (!file) return { next: 0, items: [], missing: true };
  const size = fs.statSync(file).size;
  const read = (from, first) => {
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(size - from);
      fs.readSync(fd, buf, 0, buf.length, from);
      // 처음 읽을 때는 잘린 첫 줄을 버리고, 끝의 덜 써진 줄은 다음에 읽는다(바이트 기준이라 한글이 잘리지 않는다)
      const start = first && from > 0 ? buf.indexOf(10) + 1 : 0;
      const end = Math.max(start, buf.lastIndexOf(10) + 1);
      return { end: from + end, entries: parseLines(buf.subarray(start, end).toString('utf8')) };
    } finally { fs.closeSync(fd); }
  };
  const reply = (end, entries, turn, reset) => {
    turns.set(sid + ':' + end, turn);
    if (turns.size > 200) turns.delete(turns.keys().next().value); // 닫힌 화면이 남긴 것
    return { next: end, items: chatItems(reset ? dropRewound(entries) : entries), reset };
  };
  let from = Number(params.get('from'));
  const turn = turns.get(sid + ':' + from);
  turns.delete(sid + ':' + from);
  if (from >= 0 && from <= size && turn) {
    const { end, entries } = read(from, false);
    const branched = entries.some(d => {
      const off = typed(d) && d.parentUuid && !turn.has(d.parentUuid);
      sinceTyped([d], turn);
      return off;
    });
    if (!branched) return reply(end, entries, turn, false);
  }
  const { end, entries } = read(Math.max(0, size - 3e6), true); // 처음(또는 갈래가 바뀌면) 끝부분 3MB를 새로 그린다
  return reply(end, entries, sinceTyped(entries), true);
}

/* 이미지 올리기: 대화 화면에 붙여넣거나 끌어다 놓은 이미지를 파일로 저장하고, 그 경로를 Claude에 붙여넣는다(Claude Code는 붙여넣은 이미지 경로를 이미지로 받는다) */
const UPLOAD_DIR = path.join(BOARD_DIR, 'uploads');
const IMAGE_EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };
function upload(req, res) {
  const ext = IMAGE_EXT[String(req.headers['content-type'] || '').split(';')[0]];
  if (!ext) return json(res, 400, { error: 'png, jpg, gif, webp 이미지만 올릴 수 있습니다' });
  const chunks = []; let size = 0;
  req.on('data', c => { size += c.length; if (size > 20e6) { req.destroy(); } else chunks.push(c); });
  req.on('end', () => {
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
    const f = path.join(UPLOAD_DIR, `${new Date().toISOString().slice(0, 10)}-${crypto.randomBytes(6).toString('hex')}.${ext}`);
    fs.writeFileSync(f, Buffer.concat(chunks), { mode: 0o600 });
    json(res, 200, { path: f });
  });
}
const isUpload = f => typeof f === 'string' && path.resolve(f).startsWith(UPLOAD_DIR + path.sep) && fs.existsSync(f);

/* 곁가지 질문(btw): 세션의 대화를 복사(--fork-session)해 질문 하나에만 답하게 한다.
   원래 대화에는 아무것도 남지 않고, 기본 권한 모드라 파일을 고치지 못한다. 답을 받으면 복사본 기록은 지운다 */
let btwRunning = 0;
// 곁가지 질문용으로 띄운 claude(복사본)의 pid. 세션 목록에 다른 세션처럼 나타나지 않게 뺀다(exec라 셸 pid = claude pid)
const btwPids = new Set();
function lastResult(out) {
  // 로그인 셸이 앞뒤로 찍는 잡음 사이에서 type=result인 JSON 객체를 찾는다
  for (let i = out.lastIndexOf('{'); i >= 0; i = out.lastIndexOf('{', i - 1)) {
    try { const o = JSON.parse(out.slice(i).trim()); if (o && o.type === 'result') return o; } catch {}
  }
  return null;
}
function askBtw(sid, cwd, item) {
  const prompt = '(곁가지 질문입니다. 하던 작업은 이어 하지 말고, 파일도 고치지 말고, 아래 질문에만 짧게 답하세요.)\n\n' + item.q;
  const args = ['-p', '--resume', sid, '--fork-session', '--output-format', 'json', '--permission-mode', 'default', prompt];
  const p = spawn(SHELL, ['-lic', 'exec claude ' + args.map(q).join(' ')], { cwd, env: TERM_ENV });
  btwRunning++;
  btwPids.add(p.pid);
  let out = '';
  p.stdout.on('data', d => { out += d; });
  const timer = setTimeout(() => p.kill(), 10 * 60e3);
  p.on('close', () => {
    btwRunning--; clearTimeout(timer); btwPids.delete(p.pid);
    const r = lastResult(out);
    item.state = r && !r.is_error ? 'done' : 'error';
    item.a = r ? String(r.result || '').slice(0, 20000) : '답을 받지 못했습니다(시간 초과 또는 실행 오류).';
    item.doneAt = Date.now();
    if (r && r.session_id) try { const f = findTranscript({ cwd, sessionId: r.session_id }); if (f) fs.unlinkSync(f); } catch {}
    save(); scan();
  });
}

let migrating = false;
const restarting = new Set(); // 다시 띄우는 중인 대화: 잠깐 사라져도 '최근 닫힌 세션'에 넣지 않는다
async function migrateOne(pid) {
  // Orca 세션을 웹으로: Orca 쪽 claude를 /exit로 끝내고, 원래 옵션 그대로 --resume으로 이어 띄운다
  const s = snapshot.sessions.find(x => x.pid === pid);
  const where = handles.get(pid) || {};
  if (!s || !where.orca) throw new Error('Orca에서 도는 세션만 옮길 수 있습니다');
  if (s.state === 'working' || s.state === 'compact' || s.state === 'approval') throw new Error('일하는 중에는 옮길 수 없습니다. 끝난 뒤에 옮겨 주세요');
  const args = argsByPid.get(pid) || keepFlags((await run('/bin/ps', ['-o', 'command=', '-p', String(pid)])).trim().split(/\s+/).slice(1));
  await run(ORCA, ['terminal', 'send', '--terminal', where.orca, '--text', '/exit', '--enter', '--json']);
  for (let i = 0; i < 40 && alive(pid); i++) await sleep(500);
  if (alive(pid)) throw new Error('Orca 쪽 Claude가 끝나지 않았습니다. Orca에서 직접 /exit 해 주세요');
  const name = newName();
  await startTmux(name, s.dir, [...args, '--resume', s.sid]);
  db.web.push({ name, cwd: s.dir, args, sid: s.sid, createdAt: Date.now() });
  if (db.assign[s.sid]) pendingAssign.set(name, db.assign[s.sid]);
  db.closed = db.closed.filter(x => x.sid !== s.sid);
  run(ORCA, ['terminal', 'close', '--terminal', where.orca, '--json']).catch(() => {});
  return name;
}

/* 화면에서 오는 요청 */
const task = id => db.tasks.find(t => t.id === id);
const str = (v, n = 300) => String(v ?? '').trim().slice(0, n);
const routes = {
  'task/add': b => {
    const name = str(b.name, 120); if (!name) throw new Error('업무 이름이 필요합니다');
    const now = Date.now();
    const id = 't' + db.nextId++;
    db.tasks.push({ id, name, memo: str(b.memo), next: '', waits: [], createdAt: now, updatedAt: now });
    return id;
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
    delete db.rooms[b.id];
  },
  'assign': b => {
    if (b.task && !task(b.task)) throw new Error('없는 업무입니다');
    if (b.task) { db.assign[b.sid] = b.task; task(b.task).updatedAt = Date.now(); } else delete db.assign[b.sid];
  },
  'seen': b => { db.seen[b.sid] = Date.now(); },
  // 가상 사무실에서 책상을 옮겼을 때: 방 안 위치(0~1 비율)를 남기고, 다른 방(업무)으로 옮겼으면 배치도 바꾼다
  'layout': b => {
    const n = v => Math.min(0.97, Math.max(0.03, Number(v) || 0.5));
    if (!b.sid || typeof b.sid !== 'string') throw new Error('세션이 없습니다');
    if (b.reset) { delete db.layout[b.sid]; return; } // 자동 배치로 되돌리기
    if ('task' in b) routes.assign({ sid: b.sid, task: b.task || '' });
    db.layout[b.sid] = { x: n(b.x), y: n(b.y) };
  },
  // 가상 사무실의 방(업무 id 또는 'lobby') 자리와 크기. 칸(24px) 단위. 하나를 옮겨도 나머지가 밀리지 않게 화면에 보이는 방 전부를 한꺼번에 받는다
  'rooms': b => {
    if (b.reset) { db.rooms = {}; return; } // 자동 배치로 되돌리기
    const i = (v, lo) => Math.min(400, Math.max(lo, Math.round(Number(v) || 0)));
    for (const [id, r] of Object.entries(b.rooms || {})) {
      if (id !== 'lobby' && !task(id)) continue;
      db.rooms[id] = { x: i(r.x, 0), y: i(r.y, 0), w: i(r.w, 10), h: i(r.h, 6) };
    }
  },
  'wait/add': b => {
    const t = task(b.task); const who = str(b.who, 60), what = str(b.what);
    if (!t || !who || !what) throw new Error('누구와 무엇을 둘 다 적어 주세요');
    t.waits.push({ id: 'w' + db.nextId++, who, what, since: Date.now() }); t.updatedAt = Date.now();
  },
  'wait/done': b => {
    const t = task(b.task); if (!t) throw new Error('없는 업무입니다');
    t.waits = t.waits.filter(w => w.id !== b.id); t.updatedAt = Date.now();
  },
  'session/new': async b => {
    // 웹 세션을 연다. 첫 지시는 claude 인자로 넘기고, 복구할 때는 첫 지시 없이 --resume으로 이어 띄운다
    const cwd = path.resolve(String(b.cwd || '').replace(/^~(?=\/|$)/, HOME));
    if (!(cwd === HOME || cwd.startsWith(HOME + '/')) || !fs.statSync(cwd, { throwIfNoEntry: false })?.isDirectory())
      throw new Error('홈 폴더 아래에 있는 폴더를 골라 주세요');
    if (b.task && !task(b.task)) throw new Error('없는 업무입니다');
    const prompt = str(b.prompt, 8000);
    const name = newName();
    await startTmux(name, cwd, prompt ? [...db.claudeArgs, prompt] : db.claudeArgs);
    db.web.push({ name, cwd, args: db.claudeArgs, sid: '', createdAt: Date.now() });
    if (b.task) pendingAssign.set(name, b.task);
    return name;
  },
  'session/migrate': b => migrateOne(+b.pid),
  // Orca에서 도는 세션을 모두 웹(tmux)으로 옮긴다. 일하는 중인 것은 건너뛴다. 오래 걸리므로 뒤에서 하나씩 한다
  'session/migrate-all': () => {
    if (migrating) throw new Error('이미 옮기는 중입니다');
    const list = snapshot.sessions.filter(x => x.host === 'orca' && x.state !== 'working' && x.state !== 'compact' && x.state !== 'approval');
    if (!list.length) throw new Error('지금 옮길 수 있는 Orca 세션이 없습니다(일하는 중인 것은 끝난 뒤에 옮깁니다)');
    migrating = true;
    (async () => {
      for (const x of list) { try { await migrateOne(x.pid); } catch (e) { console.error('옮기기 실패:', x.title, e.message); } }
      migrating = false; save(); scan();
    })();
    return list.length;
  },
  // 최근 닫힌 세션을 웹에서 같은 옵션으로 다시 연다(하나 또는 여러 개)
  'session/reopen': async b => {
    const sids = Array.isArray(b.sids) ? b.sids : [b.sid];
    const names = [];
    for (const sid of sids) {
      const c = db.closed.find(x => x.sid === sid);
      if (!c) continue;
      if (snapshot.sessions.some(x => x.sid === sid)) { db.closed = db.closed.filter(x => x !== c); continue; }
      const cwd = fs.existsSync(c.dir) ? c.dir : HOME;
      const args = c.args.length ? c.args : db.claudeArgs;
      const name = newName();
      await startTmux(name, cwd, [...args, '--resume', sid]);
      db.web.push({ name, cwd, args, sid, createdAt: Date.now() });
      db.closed = db.closed.filter(x => x !== c);
      names.push(name);
    }
    if (!names.length) throw new Error('다시 열 세션이 없습니다');
    if (names.length === 1) focusReq = { name: names[0], at: Date.now() };
    return names;
  },
  'session/forget-closed': b => { db.closed = b.sid ? db.closed.filter(x => x.sid !== b.sid) : []; },
  'session/resume': async b => {
    // 닫힌 대화를 웹에서 다시 연다. 보통 웹 안의 Claude가 대화 기록을 뒤져 찾은 뒤 이 API를 부른다(skills/hq-open)
    const sid = String(b.sid || '');
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(sid)) throw new Error('대화 ID 형식이 아닙니다');
    if (b.task && !task(b.task)) throw new Error('없는 업무입니다');
    const open = snapshot.sessions.find(x => x.sid === sid);
    if (open && open.host === 'web') { focusReq = { name: open.tmux, at: Date.now() }; return open.tmux; }
    // 다른 곳에서 열려 있으면 막는다. 사용자가 경고를 보고 그래도 열겠다고 하면(force) 같은 대화를 하나 더 띄운다
    if (open && !b.force) throw new Error(`이 대화는 ${open.host === 'orca' ? 'Orca' : '다른 터미널'}에서 열려 있습니다. 거기서 /exit 한 뒤 다시 여세요`);
    const file = findTranscript({ cwd: '', sessionId: sid });
    if (!file) throw new Error('그 대화 기록을 찾지 못했습니다');
    const m = readTail(file, Math.min(fs.statSync(file).size, 262144), 262144).match(/"cwd":"((?:[^"\\]|\\.)*)"/);
    const cwd = m && fs.existsSync(JSON.parse(`"${m[1]}"`)) ? JSON.parse(`"${m[1]}"`) : HOME;
    const name = newName();
    await startTmux(name, cwd, [...db.claudeArgs, '--resume', sid]);
    db.web.push({ name, cwd, args: db.claudeArgs, sid, createdAt: Date.now() });
    if (b.task) db.assign[sid] = b.task;
    focusReq = { name, at: Date.now() };
    return name;
  },
  'btw/ask': b => {
    const question = str(b.question, 4000);
    if (!question) throw new Error('질문을 적어 주세요');
    if (btwRunning >= 3) throw new Error('곁가지 질문은 동시에 3개까지 됩니다. 앞의 답을 기다려 주세요');
    const live = liveSessions().find(x => x.sessionId === b.sid);
    if (!live) throw new Error('열려 있는 세션에만 물을 수 있습니다');
    const list = db.btw[b.sid] = (db.btw[b.sid] || []).slice(-19);
    const item = { id: crypto.randomBytes(4).toString('hex'), q: question, a: '', state: 'asking', at: Date.now() };
    list.push(item);
    askBtw(b.sid, live.cwd, item);
  },
  'btw/clear': b => { delete db.btw[b.sid]; },
  // 세션 메모: 내가 적거나, 내가 시킬 때 Claude가 적는다(skills/hq-memo). 대화 ID에 붙어 있어 닫았다 다시 열어도 남는다
  'memo/add': b => {
    const text = str(b.text, 2000); if (!text) throw new Error('메모 내용을 적어 주세요');
    if (!/^[0-9a-f-]{36}$/.test(String(b.sid))) throw new Error('대화 ID 형식이 아닙니다');
    const live = snapshot.sessions.find(x => x.sid === b.sid), c = db.closed.find(x => x.sid === b.sid);
    const m = db.memos[b.sid] = db.memos[b.sid] || { title: '', items: [] };
    m.title = live?.title || c?.title || m.title || b.sid.slice(0, 8);
    const id = crypto.randomBytes(4).toString('hex');
    m.items.push({ id, text, by: b.by === 'claude' ? 'claude' : 'me', done: false, at: Date.now() });
    return id;
  },
  'memo/update': b => {
    const it = db.memos[b.sid]?.items.find(x => x.id === b.id); if (!it) throw new Error('없는 메모입니다');
    if ('text' in b) { const t = str(b.text, 2000); if (!t) throw new Error('메모 내용을 적어 주세요'); it.text = t; }
    if ('done' in b) it.done = !!b.done;
  },
  'memo/delete': b => {
    const m = db.memos[b.sid]; if (!m) return;
    m.items = m.items.filter(x => x.id !== b.id);
    if (!m.items.length) delete db.memos[b.sid];
  },
  // 웹 세션 다시 띄우기(전역 CLAUDE.md·.zshrc를 바꾼 뒤 등): 일하는 중이어도 바로 끄고, 같은 tmux 이름·옵션으로 --resume 해서 이어 띄운다.
  // 응답부터 보내고 뒤에서 한다. 이 요청을 보낸 세션(웹 안의 Claude)도 같이 다시 뜬다
  'session/restart': b => {
    const list = db.web.filter(w => !Array.isArray(b.names) || b.names.includes(w.name))
      .map(w => ({ w, s: snapshot.sessions.find(x => x.tmux === w.name) })).filter(x => x.s);
    if (!list.length) throw new Error('다시 띄울 웹 세션이 없습니다');
    (async () => {
      for (const { w, s } of list) {
        restarting.add(s.sid);
        w.sid = s.sid; w.createdAt = Date.now(); // 끈 사이에 목록에서 빠지지 않게
        if (s.state !== 'myturn' && s.state !== 'approval') db.seen[s.sid] = Date.now() + 30e3;
        try {
          await tmux(['kill-session', '-t', w.name]).catch(() => {});
          for (let i = 0; i < 20 && alive(s.pid); i++) await sleep(250);
          await startTmux(w.name, w.cwd, [...w.args, '--resume', s.sid]);
        } catch (e) { console.error('다시 띄우기 실패:', w.name, e.message); }
      }
      save();
      setTimeout(() => list.forEach(({ s }) => restarting.delete(s.sid)), 30e3);
    })();
    return list.length;
  },
  'session/close': async b => {
    const w = db.web.find(x => x.name === b.name);
    if (!w) throw new Error('웹에서 연 세션만 여기서 닫을 수 있습니다');
    await tmux(['kill-session', '-t', w.name]).catch(() => {});
    db.web = db.web.filter(x => x !== w);
  },
  'term/switch': b => orca(b.pid, ['terminal', 'switch']),
  'term/send': async b => {
    // 글과 이미지를 쓴 순서대로 받는다: [{ text }, { image: 올린 파일 경로 }, …]. 이미지를 붙인 자리가 Claude에게도 그대로 간다
    const parts = (Array.isArray(b.parts) ? b.parts : [{ text: b.text }]).slice(0, 60)
      .map(x => isUpload(x && x.image) ? { image: x.image }
        : typeof (x && x.paste) === 'string' ? { paste: x.paste.replace(/\r\n?/g, '\n').slice(0, 500000) } // 붙여넣은 긴 글: 붙여넣기로 넣는다
        : { text: String((x && x.text) ?? '').replace(/\r\n?/g, '\n').slice(0, 20000) });
    const first = parts[0], last = parts[parts.length - 1];
    if (first && 'text' in first) first.text = first.text.trimStart();
    if (last && 'text' in last) last.text = last.text.trimEnd();
    const list = parts.filter(x => x.image || x.text || x.paste);
    if (!list.length) throw new Error('보낼 내용이 없습니다');
    if (list.filter(x => x.image).length > 10) throw new Error('이미지는 한 번에 10장까지 보낼 수 있습니다');
    const text = list.length === 1 && list[0].text;
    const where = handles.get(+b.pid) || {};
    if (!where.tmux && !where.orca) throw new Error('이 세션에는 입력을 넣을 수 없습니다');
    // 되감기 창이 떠 있으면 친 글과 Enter가 그 창의 항목을 고른다(되감기가 실행될 수 있다)
    if (where.tmux && await rewindScreen(where.tmux)) throw new Error('Claude 쪽에 되감기 창이 열려 있습니다. 되감기를 마치거나 취소한 뒤 보내세요');
    // 친 글은 친 것처럼 넣고(줄바꿈은 Ctrl-J), 이미지 경로와 붙여넣은 긴 글만 붙여넣기로 넣는다(터미널에서 붙여넣은 것과 똑같이).
    // 친 글까지 붙여넣기로 넣으면 Claude Code가 <pasted_content>로 감싸 Claude가 내 말을 '남이 쓴 글'로 다룬다
    const paste = async t => {
      if (where.tmux) {
        await tmux(['set-buffer', '-b', 'hq', '--', t]);
        await tmux(['paste-buffer', '-p', '-d', '-b', 'hq', '-t', where.tmux]);
      } else await orca(b.pid, ['terminal', 'send', '--text', '\x1b[200~' + t + '\x1b[201~']);
      await sleep(150);
    };
    // 한 번의 tmux 호출로: 줄마다 send-keys -l, 줄 사이에 C-j. 글 안의 줄바꿈 문자는 Claude Code가 버린다
    const type = t => tmux(t.split('\n').flatMap((line, i) => [...(i ? ['send-keys', '-t', where.tmux, 'C-j', ';'] : []),
      ...(line ? ['send-keys', '-t', where.tmux, '-l', '--', line, ';'] : [])]).slice(0, -1));
    if (!where.tmux) { if (text && !text.includes('\n')) return orca(b.pid, ['terminal', 'send', '--text', text, '--enter']); for (const x of list) await paste(x.image || x.paste || x.text); }
    else for (const x of list) { if (x.image || x.paste) await paste(x.image || x.paste); else await type(x.text); }
    await sleep(120);
    if (where.tmux) return tmux(['send-keys', '-t', where.tmux, 'Enter']);
    return orca(b.pid, ['terminal', 'send', '--text', '', '--enter']);
  },
  // 대화 화면의 단축 키: 중단(Esc), 승인 창의 번호 고르기
  'term/key': async b => {
    const keys = { esc: ['Escape', '\x1b'], 1: ['1', '1'], 2: ['2', '2'], 3: ['3', '3'], enter: ['Enter', '\r'] };
    const k = keys[b.key];
    if (!k) throw new Error('모르는 키입니다');
    const where = handles.get(+b.pid) || {};
    if (!where.tmux) return orca(b.pid, ['terminal', 'send', '--text', k[1]]);
    await tmux(['send-keys', '-t', where.tmux, k[0]]);
    if (b.key !== 'esc') return;
    // Claude가 답을 시작하기 전에 중단하면 Claude Code는 보낸 말을 자기 입력칸에 되돌려 놓는다(고쳐서 다시 보내라고).
    // 웹에서는 그 입력칸이 안 보여서, 다음에 보낸 말이 그 뒤에 붙어 둘이 한꺼번에 간다. 그래서 되돌아온 글을 비우고 웹 입력칸으로 돌려준다
    for (let i = 0; i < 4; i++) {
      await sleep(300);
      const text = await inputBox(where.tmux);
      if (text) { await clearInput(where.tmux, text); return { restored: text }; }
    }
  },
  // 되감기: Claude Code의 되감기 창(/rewind)을 tmux 화면에서 읽고 키를 보내 웹 창에서 고르게 한다(웹 세션만).
  // 목록은 맨 아래 (current)에서 위로 한 칸씩 올라가며 고른 줄을 읽어 모은다(창은 몇 줄만 보여서). 고를 때는 그 자리로 옮긴 뒤 글이 맞는지 확인하고 Enter
  'rewind/open': async b => {
    const { name, s } = webPane(b.pid);
    if (['working', 'compact', 'approval'].includes(s.state)) throw new Error('일하는 중에는 되감을 수 없습니다. 먼저 중단하세요');
    if (await inputBox(name)) throw new Error('Claude 입력칸에 글이 남아 있습니다. 터미널 화면에서 비운 뒤 다시 하세요');
    await tmux(['send-keys', '-t', name, '-l', '--', '/rewind']);
    await sleep(300);
    await tmux(['send-keys', '-t', name, 'Enter']);
    let screen = await waitScreen(name, x => x && x.some(l => l.includes('(current)')));
    if (!screen) throw new Error('되감기 창이 열리지 않았습니다');
    const items = [];
    for (let i = 0; i < 50; i++) {
      await tmux(['send-keys', '-t', name, 'Up']);
      const next = await waitScreen(name, x => x && x.join('\n') !== screen.join('\n'), 600);
      if (!next) break; // 맨 위
      screen = next;
      const at = screen.findIndex(l => /^\s*❯ /.test(l));
      if (at < 0) break;
      items.push({ k: i + 1, text: screen[at].replace(/^\s*❯ /, '').trim(), detail: (screen[at + 1] || '').trim() });
    }
    rewinds.set(name, items.length);
    return items.reverse(); // 오래된 것부터
  },
  'rewind/pick': async b => {
    const { name } = webPane(b.pid);
    const pos = rewinds.get(name);
    if (pos === undefined) throw new Error('되감기 창이 열려 있지 않습니다');
    const k = Number(b.k), move = k - pos;
    if (move) await tmux(['send-keys', '-t', name, '-N', String(Math.abs(move)), move > 0 ? 'Up' : 'Down']);
    rewinds.set(name, k);
    await sleep(250);
    const screen = await rewindScreen(name);
    const sel = (screen || []).find(l => /^\s*❯ /.test(l));
    if (!sel || sel.replace(/^\s*❯ /, '').trim() !== String(b.text)) throw new Error('고른 말이 화면과 맞지 않습니다. 다시 열어 주세요');
    await tmux(['send-keys', '-t', name, 'Enter']);
    const confirm = await waitScreen(name, x => x && x.some(l => /^\s*❯ \d+\. /.test(l)));
    if (!confirm) throw new Error('확인 창이 뜨지 않았습니다');
    rewinds.set(name, 'confirm');
    return {
      message: confirm.filter(l => /^\s*│/.test(l)).map(l => l.replace(/^\s*│ ?/, '')).filter(l => !/^\(.+ ago\)$/.test(l)).join('\n').trim(),
      notes: confirm.filter(l => /^\s*(The (code|conversation) |⚠)/.test(l)).map(l => l.trim()),
      // 항목이 많으면 창이 스크롤되어 앞에 ↑·↓가 붙는다
      options: confirm.map(l => l.match(/^\s*(?:[❯↑↓] )?(\d+)\. (.+)$/)).filter(Boolean).map(m => ({ n: +m[1], label: m[2].trim() })),
    };
  },
  'rewind/confirm': async b => {
    const { name } = webPane(b.pid);
    if (rewinds.get(name) !== 'confirm') throw new Error('확인 창이 열려 있지 않습니다');
    const screen = await rewindScreen(name) || [];
    const opts = screen.map(l => l.match(/^\s*([❯↑↓] )?(\d+)\. /)).filter(Boolean);
    const cur = opts.findIndex(m => m[1] === '❯ '), want = opts.findIndex(m => +m[2] === Number(b.n));
    if (cur < 0 || want < 0) throw new Error('고를 수 없는 항목입니다');
    if (want !== cur) await tmux(['send-keys', '-t', name, '-N', String(Math.abs(want - cur)), want > cur ? 'Down' : 'Up']);
    await sleep(200);
    await tmux(['send-keys', '-t', name, 'Enter']);
    rewinds.delete(name);
    await waitScreen(name, x => !x, 3000);
    // 대화를 되돌리면 그때 보낸 말이 Claude 입력칸에 돌아온다. 비우고 웹 입력칸으로 돌려준다
    await sleep(300);
    const text = await inputBox(name);
    if (text) await clearInput(name, text);
    return { restored: text };
  },
  'rewind/cancel': async b => {
    const { name } = webPane(b.pid);
    rewinds.delete(name);
    for (let i = 0; i < 3 && await rewindScreen(name); i++) { await tmux(['send-keys', '-t', name, 'Escape']); await sleep(300); }
  },
};
// 되감기 창: 화면에서 맨 아래 'Rewind' 제목 아래 줄들. 창이 없으면 null
const rewinds = new Map(); // tmux 이름 -> 목록에서 (current) 위로 몇 칸 올라가 있는지, 또는 'confirm'(확인 창)
async function rewindScreen(name) {
  const lines = (await tmux(['capture-pane', '-p', '-t', name])).split('\n');
  const t = lines.map(l => l.trim());
  const top = t.findLastIndex((l, i) => l === 'Rewind' && /^(Restore the code|Confirm you want)/.test(t.slice(i + 1).find(x => x) || ''));
  return top < 0 ? null : lines.slice(top + 1).map(l => l.replace(/\s+$/, '')).filter(l => l.trim());
}
async function waitScreen(name, ok, ms = 2000) {
  for (const t0 = Date.now(); Date.now() - t0 < ms; await sleep(40)) { const x = await rewindScreen(name); if (ok(x)) return x || []; }
  return null;
}
function webPane(pid) {
  const name = (handles.get(+pid) || {}).tmux, s = snapshot.sessions.find(x => x.pid === +pid);
  if (!name || !s) throw new Error('웹에서 띄운 세션만 되감을 수 있습니다');
  return { name, s };
}
// Claude Code 입력칸(화면 맨 아래 두 가로줄 사이)에 들어 있는 글. 흐린 글씨(빈 칸 안내·다음 말 추천)는 빈 것으로 본다
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;
async function inputBox(name) {
  const raw = (await tmux(['capture-pane', '-p', '-e', '-t', name])).split('\n');
  const plain = raw.map(l => l.replace(ANSI, ''));
  const borders = plain.map((l, i) => /^─{20,}$/.test(l.trim()) ? i : -1).filter(i => i >= 0);
  if (borders.length < 2) return '';
  const [a, b] = borders.slice(-2);
  const at = plain[a + 1]?.indexOf('❯\u00a0') ?? -1;
  if (at < 0 || raw[a + 1].slice(raw[a + 1].indexOf('❯\u00a0') + 2).startsWith('\x1b[2m')) return '';
  return plain.slice(a + 1, b).map((l, i) => i ? l.replace(/^  /, '') : l.slice(at + 2)).join('\n').trim();
}
// 입력칸 비우기: 커서가 어디 있든 앞뒤로 지운다. Ctrl-C는 빈 칸에서 두 번이면 Claude가 꺼지고, Ctrl-U는 여러 줄을 다 못 지워서 쓰지 않는다
async function clearInput(name, text) {
  const n = String(text.length + 20);
  await tmux(['send-keys', '-t', name, '-N', n, 'BSpace']);
  await tmux(['send-keys', '-t', name, '-N', n, 'DC']);
}
function orca(pid, args) {
  const h = (handles.get(+pid) || {}).orca;
  if (!h) throw new Error('이 세션은 Orca 터미널이 아닙니다');
  return new Promise((ok, fail) => execFile(ORCA, [...args, '--terminal', h, '--json'], { timeout: 15000 },
    (err, out, errOut) => err ? fail(new Error(clip((errOut || err.message).trim(), 300))) : ok()));
}

/* HTTP */
const createAuth = require('./auth');
const auth = createAuth({ db, save, mailFile: process.env.HQ_MAIL_FILE || path.join(BOARD_DIR, 'mail.env'), ipNamesFile: path.join(BOARD_DIR, 'ip-names.json'), port: PORT });
const LOGIN_PAGE = path.join(__dirname, 'public', 'login.html');
function send(res, code, type, body) {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(body);
}
const json = (res, code, obj) => send(res, code, 'application/json; charset=utf-8', JSON.stringify(obj));
const file = (res, f, type) => fs.readFile(f, (e, b) => e ? json(res, 404, { error: 'not found' }) : send(res, 200, type, b));
const TYPES = { '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.json': 'application/json' };
// 빌드된 화면 파일. dist/ 밖의 파일은 내주지 않는다
function asset(res, url) {
  const f = path.join(DIST, path.normalize(decodeURIComponent(url)).replace(/^(\.\.[/\\])+/, ''));
  if (!f.startsWith(DIST + path.sep)) return json(res, 404, { error: 'not found' });
  file(res, f, TYPES[path.extname(f)] || 'application/octet-stream');
}

/* 웹 터미널: 브라우저 하나가 붙을 때마다 tmux 클라이언트 하나를 pty로 띄워 출력은 SSE로, 입력은 POST로 주고받는다 */
const ptys = new Map(); // id -> { p, login }
const int = (v, lo, hi, d) => Math.min(hi, Math.max(lo, parseInt(v, 10) || d));
function stream(req, res, params, who) {
  const name = params.get('name') || '';
  if (!/^hq-[a-z0-9]+$/.test(name)) return json(res, 400, { error: 'bad name' });
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
  const p = pty.spawn(TMUX, [...TMUX_ARGS, 'attach-session', '-t', name], {
    name: 'xterm-256color', cols: int(params.get('cols'), 20, 500, 120), rows: int(params.get('rows'), 5, 200, 40), cwd: HOME, env: TERM_ENV,
  });
  const id = crypto.randomUUID();
  ptys.set(id, { p, login: who.login ? who.login.id : '' });
  res.write(`event: ready\ndata: ${id}\n\n`);
  const out = s => { if (!res.writableEnded && !res.destroyed) res.write(s); };
  p.onData(d => out(`data: ${JSON.stringify(d)}\n\n`));
  p.onExit(() => { ptys.delete(id); out('event: end\ndata: \n\n'); if (!res.writableEnded) res.end(); });
  req.on('close', () => { ptys.delete(id); try { p.kill(); } catch {} });
}
// 끊은 기기의 터미널 연결은 바로 닫는다
function dropLogins(ids) {
  for (const [id, t] of ptys) if (t.login && ids.includes(t.login)) { ptys.delete(id); try { t.p.kill(); } catch {} }
}
const accessRoutes = {
  'access/lan': (b, who) => {
    if (!who.local) throw new Error('사내망 접속은 이 맥에서만 켜고 끌 수 있습니다');
    db.settings.lan = !!b.on;
    if (!b.on) dropLogins(db.logins.map(l => l.id)); // 끄면 다른 PC의 터미널도 끊는다
  },
  'access/revoke': b => dropLogins(auth.revoke(String(b.id || ''))),
  'access/rename': b => auth.rename(String(b.id || ''), b.label),
  'access/logout': (b, who) => { if (who.login) dropLogins(auth.revoke(who.login.id)); },
};

http.createServer((req, res) => {
  const who = auth.identify(req);
  const [url, qs] = req.url.split('?');
  if (!who || !who.local) {
    if (!db.settings.lan) return send(res, 403, 'text/plain; charset=utf-8', '사내망 접속이 꺼져 있습니다. 이 맥에서 HQ를 열어 접속 설정에서 켜 주세요.');
    if (req.method === 'GET' && url === '/login') return file(res, LOGIN_PAGE, 'text/html; charset=utf-8');
    // 로그인 전에는 로그인 화면과 인증번호 요청·확인만 된다
    if (!who && !(req.method === 'POST' && (url === '/auth/request' || url === '/auth/verify'))) {
      if (req.method === 'GET' && url === '/') { res.writeHead(302, { Location: '/login' }); return res.end(); }
      return json(res, 401, { error: '로그인이 필요합니다' });
    }
  }
  if (req.method === 'GET' && url === '/login') return file(res, LOGIN_PAGE, 'text/html; charset=utf-8');
  if (req.method === 'GET' && url === '/') {
    if (!fs.existsSync(path.join(DIST, 'index.html'))) return send(res, 500, 'text/plain; charset=utf-8', '화면이 아직 빌드되지 않았습니다. 저장소에서 npm run build 를 실행하세요.');
    return file(res, path.join(DIST, 'index.html'), 'text/html; charset=utf-8');
  }
  if (req.method === 'GET' && url.startsWith('/assets/')) return asset(res, url);
  if (req.method === 'GET' && url === '/api/state') return json(res, 200, { ...snapshot, access: auth.status(who) });
  if (req.method === 'GET' && url === '/api/term/stream') return stream(req, res, new URLSearchParams(qs || ''), who);
  if (req.method === 'GET' && url === '/api/transcript') { try { return json(res, 200, transcript(new URLSearchParams(qs || ''))); } catch (e) { return json(res, 400, { error: e.message }); } }
  if (req.method !== 'POST') return json(res, 404, { error: 'not found' });
  // 다른 사이트가 이 주소로 몰래 요청을 보내지 못하게 전용 헤더를 요구한다(브라우저는 다른 사이트에서 이 헤더를 못 붙인다)
  if (req.headers['x-hq'] !== '1') return json(res, 403, { error: 'forbidden' });
  if (url === '/api/upload') return upload(req, res);
  let body = '';
  req.on('data', c => { body += c; if (body.length > 1e6) req.destroy(); });
  req.on('end', async () => {
    let b; try { b = JSON.parse(body || '{}'); } catch { return json(res, 400, { error: 'bad json' }); }
    try {
      if (url === '/auth/request') return json(res, 200, await auth.requestCode(req));
      if (url === '/auth/verify') { await auth.verifyCode(req, res, b); return json(res, 200, { ok: true }); }
    } catch (e) { return json(res, 400, { error: e.message }); }
    // 키 입력과 크기 조정은 자주 오므로 상태를 다시 만들지 않고 바로 답한다
    if (url === '/api/term/input') { ptys.get(b.id)?.p.write(String(b.data || '')); return send(res, 204, 'text/plain', ''); }
    if (url === '/api/term/resize') { try { ptys.get(b.id)?.p.resize(int(b.cols, 20, 500, 120), int(b.rows, 5, 200, 40)); } catch {} return send(res, 204, 'text/plain', ''); }
    const key = url.slice(5);
    const route = url.startsWith('/api/') && (routes[key] || accessRoutes[key]);
    if (!route) return json(res, 404, { error: 'not found' });
    try {
      const result = await route(b, who);
      save(); scan();
      // 방금 자기 자신을 끊었으면 더 보여 줄 것이 없다
      if (!who.local && !db.logins.includes(who.login)) return json(res, 401, { error: '로그아웃했습니다' });
      json(res, 200, { ...snapshot, access: auth.status(who), result });
    } catch (e) { json(res, 400, { error: e.message }); }
  });
// 모든 주소에서 받되, 사내망 접속이 꺼져 있으면 이 맥 밖의 요청은 위에서 막는다
}).listen(PORT, () => console.log(`claude-session-hq: http://127.0.0.1:${PORT}`));

restoreWeb().finally(() => { scan(); setInterval(scan, SCAN_MS); });
