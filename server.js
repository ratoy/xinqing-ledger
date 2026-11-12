'use strict';
/**
 * 心情の · 服务端
 * 零第三方依赖：Node.js 内置模块 + 单个 JSON 数据文件（原子写入 + 上一版备份）。
 * 数据目录通过 DATA_DIR 指定，Docker 中挂载到宿主机 ./data。
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'ledger.json');
const BAK_FILE = path.join(DATA_DIR, 'ledger.json.bak');
const PUBLIC_DIR = path.join(__dirname, 'public');
const AUTH_USER = process.env.ACCESS_USER || 'admin';
const AUTH_PASS = process.env.ACCESS_PASSWORD || '';
const SESSION_MAX_AGE = 30 * 24 * 60 * 60;
const SESSION_TTL = SESSION_MAX_AGE * 1000;
const sessions = new Map(); // token -> 过期时间戳（进程内，重启后需重新登录）
const MAX_BODY = 1024 * 1024;
const MAX_RECORDS = 100000;

const DEFAULT_SETTINGS = { casualRate: 100, depositRate: 100 };
const STATIC = {
  '/': 'index.html', '/index.html': 'index.html', '/app.js': 'app.js', '/logo.png': 'logo.png'
};
const MIME = {
  'index.html': 'text/html; charset=utf-8',
  'app.js': 'application/javascript; charset=utf-8',
  'logo.png': 'image/png'
};

class BadRequest extends Error {}

function defaults() {
  return {
    version: 1,
    settings: Object.assign({}, DEFAULT_SETTINGS),
    current: [],
    periods: [],
    updatedAt: new Date().toISOString()
  };
}

function todayCN() {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date());
}

function isNum(v) {
  return typeof v === 'number' && Number.isFinite(v) && Math.abs(v) < 1e9;
}
function isDate(v) {
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
}
function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

function optNum(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return isNum(n) && n >= 0 ? round2(n) : null;
}

function sanitizeRecord(r) {
  if (!r || typeof r !== 'object') return null;
  const amount = Number(r.amount);
  if (!isNum(amount) || Math.abs(amount) >= 1e9) return null;
  // 到手由①区规则自动折算，记录不保存单笔手动覆盖值
  return {
    id: (typeof r.id === 'string' && r.id.length > 0 && r.id.length < 64) ? r.id : crypto.randomUUID(),
    date: isDate(r.date) ? r.date : todayCN(),
    amount: round2(amount),
    type: r.type === 'deposit' ? 'deposit' : 'casual',
    note: typeof r.note === 'string' ? r.note.slice(0, 200) : '',
    override: null,
    rate: optNum(r.rate),
    hours: optNum(r.hours)
  };
}

function sanitizeSettings(s) {
  const src = (s && typeof s === 'object') ? s : {};
  const out = {};
  Object.keys(DEFAULT_SETTINGS).forEach(function (k) {
    const v = Number(src[k]);
    if (!isNum(v) || v < 0 || v > 10000) throw new BadRequest('规则数值无效：' + k);
    out[k] = round2(v);
  });
  return out;
}

function sanitizeState(o) {
  if (!o || !Array.isArray(o.current) || !Array.isArray(o.periods)) {
    throw new BadRequest('备份格式无效');
  }
  if (o.current.length + o.periods.length > MAX_RECORDS) throw new BadRequest('数据量过大');
  const next = defaults();
  next.settings = sanitizeSettings(o.settings);
  next.current = o.current.map(sanitizeRecord).filter(Boolean);
  next.periods = o.periods.map(function (p, i) {
    const recs = Array.isArray(p && p.records) ? p.records.map(sanitizeRecord).filter(Boolean) : [];
    const dates = recs.map(function (r) { return r.date; }).sort();
    return {
      id: (p && typeof p.id === 'string') ? p.id : crypto.randomUUID(),
      no: i + 1,
      dateFrom: dates[0] || '',
      dateTo: dates[dates.length - 1] || '',
      closedAt: isDate(p && p.closedAt) ? p.closedAt : todayCN(),
      records: recs
    };
  });
  return next;
}

function load() {
  try {
    return sanitizeState(JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')));
  } catch (e) {
    return defaults();
  }
}

let state = load();
let writing = Promise.resolve();

function persist() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  state.updatedAt = new Date().toISOString();
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
  if (fs.existsSync(DATA_FILE)) fs.copyFileSync(DATA_FILE, BAK_FILE);
  fs.renameSync(tmp, DATA_FILE);
}

function apply(op, p) {
  p = (p && typeof p === 'object') ? p : {};
  switch (op) {
    case 'add': {
      const rec = sanitizeRecord(p.record);
      if (!rec) throw new BadRequest('记录格式无效');
      if (state.current.length >= MAX_RECORDS) throw new BadRequest('本期记录过多');
      state.current.push(rec);
      break;
    }
    case 'update': {
      const id = String(p.id || '');
      const rec = state.current.find(function (x) { return x.id === id; });
      if (!rec) throw new BadRequest('记录不存在，请刷新页面');
      if (p.override !== undefined && p.override !== null) {
        throw new BadRequest('到手金额按规则自动折算，不可手动修改');
      }
      if (typeof p.note === 'string') rec.note = p.note.slice(0, 200);
      break;
    }
    case 'delete': {
      const id = String(p.id || '');
      const before = state.current.length;
      state.current = state.current.filter(function (x) { return x.id !== id; });
      if (state.current.length === before) throw new BadRequest('记录不存在，请刷新页面');
      break;
    }
    case 'close': {
      if (!state.current.length) throw new BadRequest('本期还没有记录');
      const dates = state.current.map(function (r) { return r.date; }).sort();
      state.periods.push({
        id: crypto.randomUUID(),
        no: state.periods.length + 1,
        dateFrom: dates[0] || '',
        dateTo: dates[dates.length - 1] || '',
        closedAt: todayCN(),
        records: state.current.slice()
      });
      state.current = [];
      break;
    }
    case 'undo': {
      if (!state.periods.length) throw new BadRequest('没有可撤销的结算');
      const period = state.periods.pop();
      state.current = state.current.concat(period.records || []);
      break;
    }
    case 'settings': {
      state.settings = sanitizeSettings(p.settings);
      break;
    }
    case 'import': {
      state = sanitizeState(p.state);
      break;
    }
    case 'clear': {
      state = defaults();
      break;
    }
    default:
      throw new BadRequest('未知操作：' + op);
  }
  persist();
  return state;
}

function send(res, code, obj, extra) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(code, Object.assign({
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer'
  }, extra || {}));
  res.end(body);
}

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function parseCookies(header) {
  const out = {};
  String(header || '').split(';').forEach(function (part) {
    const i = part.indexOf('=');
    if (i < 0) return;
    const k = part.slice(0, i).trim();
    if (!k) return;
    const raw = part.slice(i + 1).trim();
    try { out[k] = decodeURIComponent(raw); } catch (e) { out[k] = raw; }
  });
  return out;
}

function sessionToken(req) {
  return parseCookies(req.headers.cookie).ledger_session || '';
}

function validSession(req) {
  if (!AUTH_PASS) return true; // 未设置访问密码时不启用鉴权
  const t = sessionToken(req);
  if (!t) return false;
  const exp = sessions.get(t);
  if (!exp) return false;
  if (Date.now() > exp) { sessions.delete(t); return false; }
  return true;
}

function createSession() {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, Date.now() + SESSION_TTL);
  const now = Date.now();
  for (const [k, v] of sessions) { if (now > v) sessions.delete(k); }
  return token;
}

function sessionCookie(token, maxAge) {
  return 'ledger_session=' + token + '; Path=/; HttpOnly; SameSite=Strict; Max-Age=' + maxAge;
}

function authOk(req, res) {
  if (validSession(req)) return true;
  // 不返回 WWW-Authenticate，避免浏览器弹出原生认证框；由前端展示页面内登录卡片
  send(res, 401, { error: '未登录或登录已过期' });
  return false;
}

function serveStatic(pathname, res) {
  const name = STATIC[pathname];
  if (!name) { send(res, 404, { error: 'Not Found' }); return; }
  let buf;
  try { buf = fs.readFileSync(path.join(PUBLIC_DIR, name)); }
  catch (e) { send(res, 404, { error: 'Not Found' }); return; }
  res.writeHead(200, {
    'Content-Type': MIME[name],
    'Content-Length': buf.length,
    'Cache-Control': 'no-cache',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer'
  });
  res.end(buf);
}

function readBody(req) {
  return new Promise(function (resolve, reject) {
    let size = 0;
    const chunks = [];
    req.on('data', function (c) {
      size += c.length;
      if (size > MAX_BODY) { reject(new BadRequest('请求体过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', function () {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch (e) { reject(new BadRequest('JSON 格式无效')); }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async function (req, res) {
  try {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (pathname === '/api/health') {
      send(res, 200, { ok: true, version: 1, authEnabled: !!AUTH_PASS });
      return;
    }
    if (pathname === '/api/login' && req.method === 'POST') {
      const body = await readBody(req);
      if (!AUTH_PASS) { send(res, 200, { ok: true }); return; }
      const u = String(body.user || ''), p = String(body.password || '');
      if (safeEqual(u, AUTH_USER) && safeEqual(p, AUTH_PASS)) {
        const token = createSession();
        send(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(token, SESSION_MAX_AGE) });
      } else {
        send(res, 401, { error: '用户名或密码不正确' });
      }
      return;
    }
    if (pathname === '/api/logout' && req.method === 'POST') {
      const t = sessionToken(req);
      if (t) sessions.delete(t);
      send(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie('', 0) });
      return;
    }
    // 静态页面与前端脚本公开，登录卡片才能加载；所有 /api/ 数据接口需会话
    if (pathname.startsWith('/api/') && !authOk(req, res)) return;

    if (pathname === '/api/state' && req.method === 'GET') {
      send(res, 200, Object.assign({}, state, { authEnabled: !!AUTH_PASS }));
      return;
    }
    if (pathname === '/api/mutate' && req.method === 'POST') {
      const body = await readBody(req);
      // 串行化写操作，避免并发请求交错写入
      writing = writing.catch(function () {}).then(function () {
        return apply(String(body.op || ''), body.payload);
      });
      const next = await writing;
      send(res, 200, { ok: true, state: next });
      return;
    }
    if (req.method === 'GET' || req.method === 'HEAD') { serveStatic(pathname, res); return; }
    send(res, 405, { error: 'Method Not Allowed' });
  } catch (e) {
    const code = e instanceof BadRequest ? 400 : 500;
    if (code === 500) console.error('[error]', e);
    let msg = '服务器内部错误';
    if (e && e.code === 'EACCES') msg = '数据目录不可写，请检查数据卷挂载权限';
    else if (e && e.code === 'ENOSPC') msg = '磁盘空间不足，数据未保存';
    send(res, code, { error: code === 500 ? msg : e.message });
  }
});

server.listen(PORT, '0.0.0.0', function () {
  console.log('心情の已启动: http://0.0.0.0:' + PORT);
  console.log('数据文件: ' + DATA_FILE);
  console.log('页面登录: ' + (AUTH_PASS ? '已启用（用户 ' + AUTH_USER + '）' : '未启用（仅限内网使用）'));
});

process.on('SIGTERM', function () { server.close(function () { process.exit(0); }); });
process.on('SIGINT', function () { server.close(function () { process.exit(0); }); });
