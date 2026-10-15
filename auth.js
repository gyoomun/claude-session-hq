// 사내망 접속 인증. 이 맥에서 여는 화면(localhost)은 그대로 통과하고, 다른 PC는 메일로 받은 인증번호로 로그인한다.
// 로그인한 기기는 목록으로 보고 언제든 끊을 수 있다. 인증번호와 로그인 토큰은 해시로만 저장한다.
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const tls = require('tls');
const net = require('net');
const { execFile } = require('child_process');

const CODE_TTL = 10 * 60e3; // 인증번호 유효 시간
const LOGIN_IDLE_TTL = 30 * 864e5; // 이만큼 안 쓰면 로그인이 풀린다
const SEND_GAP = 60e3; // 인증번호 메일은 1분에 한 번
const CODE_TRIES = 5; // 인증번호 하나당 틀릴 수 있는 횟수
const HOURLY_FAILS = 20; // 한 시간에 이만큼 틀리면 잠근다

const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const b64 = s => Buffer.from(s, 'utf8').toString('base64');
const isLoopback = a => a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
const ipOf = req => String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
const mask = e => String(e).replace(/^(.{2}).*(@.*)$/, '$1***$2');
function deviceOf(ua = '') {
  const osName = /iPhone|iPad/.test(ua) ? 'iPhone' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows' : /Mac OS X/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : '기기';
  const browser = /Edg\//.test(ua) ? 'Edge' : /Whale\//.test(ua) ? 'Whale' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : '브라우저';
  return `${osName} · ${browser}`;
}

// 같은 망 Windows PC의 컴퓨터 이름(NetBIOS). 사람 이름은 브라우저로 알 수 없어서, 기기를 알아보는 실마리로 쓴다
function pcName(ip) {
  return new Promise(ok => execFile('/usr/bin/smbutil', ['status', ip], { timeout: 3000 },
    (err, out) => ok((String(out || '').match(/^Server:\s*(\S+)/m) || [])[1] || '')));
}

// 메일 설정 파일(KEY=VALUE): SMTP_USER, SMTP_PASS(Gmail이면 앱 비밀번호), MAIL_TO, 선택 SMTP_HOST·SMTP_PORT·SMTP_SECURE
function readMailConfig(file) {
  try {
    const c = {};
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
      if (m) c[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
    return c.SMTP_USER && c.SMTP_PASS && c.MAIL_TO ? c : null;
  } catch { return null; }
}

// 외부 라이브러리 없이 SMTP로 보낸다(기본: Gmail 465 TLS)
function sendMail(cfg, subject, text) {
  const host = cfg.SMTP_HOST || 'smtp.gmail.com', port = +(cfg.SMTP_PORT || 465);
  const sock = cfg.SMTP_SECURE === '0' ? net.connect({ host, port }) : tls.connect({ host, port, servername: host });
  sock.setEncoding('utf8');
  sock.setTimeout(20000, () => sock.destroy(new Error('메일 서버가 응답하지 않습니다')));
  let buf = '', waiter = null, failed = null;
  sock.on('data', d => { buf += d; if (waiter) waiter(); });
  sock.on('error', e => { failed = e; if (waiter) waiter(); });
  const reply = () => new Promise((ok, fail) => {
    waiter = () => {
      if (failed) return fail(failed);
      const m = buf.match(/(?:^|\n)(\d{3}) [^\n]*\n/);
      if (!m) return;
      const end = buf.indexOf(m[0]) + m[0].length, out = buf.slice(0, end).trim();
      buf = buf.slice(end); waiter = null; ok(out.split('\n').pop().trim());
    };
    waiter();
  });
  const step = async (line, code) => {
    if (line !== null) sock.write(line + '\r\n');
    const r = await reply();
    if (!r.startsWith(String(code))) throw new Error(r.startsWith('535') ? '메일 계정 인증에 실패했습니다. SMTP_PASS(앱 비밀번호)를 확인하세요' : '메일 서버 오류: ' + r.slice(0, 120));
  };
  const body = [
    `From: Claude Session HQ <${cfg.SMTP_USER}>`, `To: <${cfg.MAIL_TO}>`, `Subject: =?UTF-8?B?${b64(subject)}?=`,
    `Date: ${new Date().toUTCString()}`, 'MIME-Version: 1.0', 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64',
    '', b64(text).replace(/.{76}/g, '$&\r\n'),
  ].join('\r\n');
  return (async () => {
    try {
      await step(null, 220);
      await step('EHLO claude-session-hq', 250);
      await step('AUTH LOGIN', 334);
      await step(b64(cfg.SMTP_USER), 334);
      await step(b64(cfg.SMTP_PASS), 235);
      await step(`MAIL FROM:<${cfg.SMTP_USER}>`, 250);
      await step(`RCPT TO:<${cfg.MAIL_TO}>`, 250);
      await step('DATA', 354);
      await step(body + '\r\n.', 250);
      sock.end('QUIT\r\n');
    } catch (e) { sock.destroy(); throw e; }
  })();
}

module.exports = function createAuth({ db, save, mailFile, port }) {
  db.logins = db.logins || [];
  db.settings = db.settings || {};
  db.deviceNames = db.deviceNames || {}; // IP -> 주인이 붙인 이름. 같은 PC가 다시 로그인하면 그 이름을 쓴다
  let code = null; // { hash, exp, tries }
  let lastSent = 0;
  const fails = [];

  function cookie(req) {
    const m = (req.headers.cookie || '').match(/(?:^|;\s*)hq_login=([^;]+)/);
    return m ? m[1] : '';
  }
  // 누가 보냈나: 이 맥에서 연 화면이면 local, 로그인한 기기면 login, 아니면 null
  function identify(req) {
    if (isLoopback(req.socket.remoteAddress) && /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(req.headers.host || '')) return { local: true };
    const token = cookie(req);
    const login = token && db.logins.find(l => l.hash === sha(token));
    if (!login) return null;
    const now = Date.now();
    if (now - login.lastSeenAt > LOGIN_IDLE_TTL) { db.logins = db.logins.filter(l => l !== login); save(); return null; }
    if (now - login.lastSeenAt > 60e3 || login.ip !== ipOf(req)) { login.lastSeenAt = now; login.ip = ipOf(req); save(); }
    return { login };
  }

  async function requestCode(req) {
    if (!db.settings.lan) throw new Error('사내망 접속이 꺼져 있습니다');
    const cfg = readMailConfig(mailFile);
    if (!cfg) throw new Error('인증 메일 설정이 없습니다. 맥에서 HQ를 열어 접속 설정을 확인하세요');
    if (Date.now() - lastSent < SEND_GAP) throw new Error('인증번호는 1분에 한 번만 보낼 수 있습니다. 잠시 뒤 다시 요청하세요');
    const value = String(crypto.randomInt(0, 1e6)).padStart(6, '0');
    const pc = await pcName(ipOf(req));
    lastSent = Date.now();
    await sendMail(cfg, `[Claude Session HQ] 로그인 인증번호 ${value}`, [
      `인증번호: ${value}`, '', '10분 동안 쓸 수 있습니다.',
      `요청한 곳: ${db.deviceNames[ipOf(req)] ? db.deviceNames[ipOf(req)] + ' · ' : ''}${pc ? pc + ' · ' : ''}${ipOf(req)} (${deviceOf(req.headers['user-agent'])})`, `요청 시각: ${new Date().toLocaleString('ko-KR')}`, '',
      '직접 요청한 것이 아니라면 이 메일을 무시하세요. 인증번호 없이는 들어올 수 없습니다.',
    ].join('\n'));
    code = { hash: sha(value), exp: Date.now() + CODE_TTL, tries: 0 };
    return { to: mask(cfg.MAIL_TO) };
  }

  async function verifyCode(req, res, b) {
    const now = Date.now();
    while (fails.length && now - fails[0] > 36e5) fails.shift();
    if (fails.length >= HOURLY_FAILS) throw new Error('틀린 시도가 너무 많아 한 시간 동안 잠겼습니다');
    if (!code || now > code.exp) { code = null; throw new Error('인증번호가 없거나 만료됐습니다. 다시 받아 주세요'); }
    if (sha(String(b.code || '').trim()) !== code.hash) {
      fails.push(now);
      if (++code.tries >= CODE_TRIES) { code = null; throw new Error('여러 번 틀려서 이 인증번호는 막혔습니다. 다시 받아 주세요'); }
      throw new Error(`인증번호가 맞지 않습니다 (남은 횟수 ${CODE_TRIES - code.tries})`);
    }
    code = null;
    const token = crypto.randomBytes(32).toString('base64url');
    // 로그인하는 사람에게 이름을 묻지 않는다. 주인이 전에 붙인 이름 → PC 이름 → 기기 종류 순으로 정하고, 주인이 나중에 고친다
    const ip = ipOf(req), pc = await pcName(ip);
    const label = db.deviceNames[ip] || pc || deviceOf(req.headers['user-agent']);
    db.logins.push({ id: crypto.randomBytes(4).toString('hex'), hash: sha(token), label, ip, pc,
      device: deviceOf(req.headers['user-agent']), createdAt: now, lastSeenAt: now });
    save();
    res.setHeader('Set-Cookie', `hq_login=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${LOGIN_IDLE_TTL / 1000}`);
  }

  function addresses() {
    return Object.values(os.networkInterfaces()).flat()
      .filter(a => a && a.family === 'IPv4' && !a.internal).map(a => `http://${a.address}:${port}`);
  }
  // 화면에 보여 줄 접속 상태
  function status(who) {
    const cfg = readMailConfig(mailFile);
    return {
      lan: !!db.settings.lan, mail: cfg ? mask(cfg.MAIL_TO) : '', mailFile, addresses: addresses(),
      me: who.local ? 'local' : who.login.id,
      logins: db.logins.map(({ id, label, ip, pc, device, createdAt, lastSeenAt }) => ({ id, label, ip, pc, device, createdAt, lastSeenAt })),
    };
  }
  function revoke(id) {
    const gone = id === 'all' ? db.logins.map(l => l.id) : db.logins.filter(l => l.id === id).map(l => l.id);
    db.logins = db.logins.filter(l => !gone.includes(l.id));
    save();
    return gone;
  }
  function rename(id, label) {
    const l = db.logins.find(x => x.id === id);
    label = String(label || '').trim().slice(0, 60);
    if (!l || !label) throw new Error('이름을 적어 주세요');
    l.label = label;
    db.deviceNames[l.ip] = label;
    save();
  }
  return { identify, requestCode, verifyCode, status, revoke, rename };
};
module.exports.sendMail = sendMail;
module.exports.readMailConfig = readMailConfig;
