const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// 极简 .env 解析（零依赖）：只认 KEY=VALUE 行，# 开头视为注释，支持首尾引号
function loadDotEnv() {
  const file = path.join(__dirname, '.env');
  const out = {};
  try {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
      if (!m) continue;
      let v = m[2].trim();
      if (v.length > 1 && ((v[0] === '"' && v.slice(-1) === '"') || (v[0] === "'" && v.slice(-1) === "'"))) {
        v = v.slice(1, -1);
      }
      out[m[1]] = v;
    }
  } catch (e) { /* 没有 .env 就用默认值 */ }
  return out;
}

// 真实环境变量优先于 .env 文件
const ENV = { ...loadDotEnv(), ...process.env };

const PORT = Number(ENV.PORT) || 3000;
const DATA_FILE = path.join(__dirname, 'data.json');
const BAN_FILE = path.join(__dirname, 'bans.json');

// 后台管理账号：只从环境变量 / .env 读取，源码中不保存任何真实密码
let ADMIN_USER = ENV.ADMIN_USER || '';
let ADMIN_PASS = ENV.ADMIN_PASS || '';

// 未配置凭据时随机生成一套，打印到控制台，避免"空密码可登录"
if (!ADMIN_USER || !ADMIN_PASS) {
  ADMIN_USER = ADMIN_USER || 'admin';
  ADMIN_PASS = crypto.randomBytes(9).toString('hex');
  console.log('── 未检测到 ADMIN_USER / ADMIN_PASS 配置 ──');
  console.log(`本次启动使用临时账号: ${ADMIN_USER} / ${ADMIN_PASS}`);
  console.log('提示: cp .env.example .env 后填入自己的账号密码即可固定下来');
  console.log('──────────────────────────────────────');
}

// 四个研发部分（四条线），顺序固定
const PARTS = ['硬件研发', '软件开发', '平台运营', '其他部分'];

// 同一部分内最多允许并行进行的事件数（必须 < 3，即最多 2 个并行）
const MAX_CONCURRENT_PER_PART = 2;

// 登录会话：token -> 过期时间戳。12 小时过期。
const SESSION_TTL = 12 * 60 * 60 * 1000;
const SESSIONS = new Map();

// 登录失败封禁策略：
//   累计输错 3 次 → 封禁 IP 12 小时
//   累计输错 4 次 → 永久封禁 IP
const TEMP_BAN_COUNT = 3;
const PERM_BAN_COUNT = 4;
const TEMP_BAN_MS = 12 * 60 * 60 * 1000;

const DAY = 86400000;

// bans: IP -> { fail: number, banUntil: number, permanent: boolean }
let bans = {};

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function ensureData() {
  if (!fs.existsSync(DATA_FILE)) {
    const seed = {
      events: [
        { id: 1, title: '样机方案设计', part: '硬件研发', start: '2026-01-05', end: '2026-02-20', desc: '智能餐盘硬件样机的整体方案设计、元器件选型与原理图评审。', owners: [] },
        { id: 2, title: '硬件打样与测试', part: '硬件研发', start: '2026-03-01', end: '2026-04-30', desc: 'PCB 打样、贴片与实验室可靠性测试，完成硬件首轮迭代。', owners: [] },
        { id: 3, title: '硬件量产准备', part: '硬件研发', start: '2026-05-15', end: '2026-07-10', desc: '准备量产模具、认证（3C/CE）与供应链采购。', owners: [] },
        { id: 4, title: '小程序开发', part: '软件开发', start: '2026-02-01', end: '2026-04-15', desc: '悦享 e 食点餐小程序：用户端点餐、支付、营养数据查看。', owners: [] },
        { id: 5, title: '管理后台开发', part: '软件开发', start: '2026-03-01', end: '2026-05-20', desc: '商户管理后台：菜品管理、订单管理、数据分析看板。', owners: [] },
        { id: 6, title: '系统联调与测试', part: '软件开发', start: '2026-06-01', end: '2026-07-25', desc: '软硬件联合调试、性能压测与安全测试，修复关键缺陷。', owners: [] },
        { id: 7, title: '试运营上线', part: '平台运营', start: '2026-08-01', end: '2026-09-15', desc: '首批合作食堂试运营，收集用户反馈并优化流程。', owners: [] },
        { id: 8, title: '全面推广运营', part: '平台运营', start: '2026-10-01', end: '2026-12-31', desc: '扩大覆盖校园与企业食堂，开展营销活动与日常运营。', owners: [] },
      ],
      roster: [],
    };
    fs.writeFileSync(DATA_FILE, JSON.stringify(seed, null, 2));
  }
}

function readData() {
  ensureData();
  const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));

  // 兼容旧版：data.json 曾是纯事件数组，自动迁移为对象结构
  let data;
  if (Array.isArray(raw)) {
    data = { events: raw, roster: [] };
    normalizeData(data);
    writeData(data);
  } else {
    data = raw || {};
    data.events = data.events || [];
    data.roster = data.roster || [];
    normalizeData(data);
  }
  return data;
}

function normalizeData(data) {
  data.events.forEach((e) => {
    if (!Array.isArray(e.owners)) e.owners = [];
    else e.owners = [...new Set(e.owners.map(String).map((s) => s.trim()).filter(Boolean))];
  });
  // 名单 = 预设名字 ∪ 所有事件用过的负责人名字
  const set = new Set((data.roster || []).map(String).map((s) => s.trim()).filter(Boolean));
  data.events.forEach((e) => e.owners.forEach((o) => set.add(o)));
  data.roster = [...set];
}

function writeData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

function addToRoster(data, names) {
  const set = new Set(data.roster);
  (names || []).forEach((n) => { if (n && String(n).trim()) set.add(String(n).trim()); });
  data.roster = [...set];
}

// 计算一组 [startMs, endMs] 区间的最大并行数（含起止当天）
function calcMaxConcurrent(intervals) {
  const points = [];
  for (const [s, e] of intervals) {
    points.push([s, 1]);
    points.push([e + DAY, -1]); // 到结束当天 24:00 都算"进行中"
  }
  points.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let cur = 0, max = 0;
  for (const [, d] of points) {
    cur += d;
    if (cur > max) max = cur;
  }
  return max;
}

// 同一部分内并发校验：候选事件加入后，该部分同一时间并行事件数不得超过 MAX_CONCURRENT_PER_PART
function checkConcurrency(events, part, start, end, excludeId) {
  const intervals = events
    .filter((e) => e.part === part && e.id !== excludeId)
    .map((e) => [new Date(e.start).getTime(), new Date(e.end).getTime()]);
  intervals.push([new Date(start).getTime(), new Date(end).getTime()]);
  const max = calcMaxConcurrent(intervals);
  if (max > MAX_CONCURRENT_PER_PART) {
    return { ok: false, max };
  }
  return { ok: true, max };
}

function loadBans() {
  try {
    bans = JSON.parse(fs.readFileSync(BAN_FILE, 'utf8'));
  } catch (e) {
    bans = {};
  }
}

function saveBans() {
  try {
    fs.writeFileSync(BAN_FILE, JSON.stringify(bans, null, 2));
  } catch (e) {
    console.error('保存封禁记录失败:', e.message);
  }
}

function sendJSON(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1e6) {
        req.destroy();
        reject(new Error('body too large'));
      }
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

// 获取客户端真实 IP（兼容 ::ffff: 前缀与 IPv6 回环地址）
function getIP(req) {
  let ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
    || req.socket.remoteAddress
    || req.connection.remoteAddress
    || '';
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);
  if (ip === '::1' || ip === '::') ip = '127.0.0.1';
  return ip;
}

// 恒定时长字符串比较，避免时序侧信道泄露密码比对差异
function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

// 校验登录是否有效
function isAuthed(req) {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  const exp = SESSIONS.get(token);
  if (!exp || exp <= Date.now()) {
    SESSIONS.delete(token);
    return false;
  }
  return true;
}

// 解析请求体中的负责人名单（字符串数组，去重、去空）
function parseOwners(body) {
  if (!Array.isArray(body.owners)) return [];
  return [...new Set(body.owners.map(String).map((s) => s.trim()).filter(Boolean))];
}

function serveStatic(res, pathname) {
  let root;
  let rel;
  if (pathname === '/admin-manage' || pathname.startsWith('/admin-manage/')) {
    root = path.join(__dirname, 'admin');
    rel = decodeURIComponent(pathname).replace(/^\/admin-manage\/?/, '') || 'index.html';
  } else {
    root = path.join(__dirname, 'public');
    rel = decodeURIComponent(pathname).replace(/^\/+/, '') || 'index.html';
  }

  const rootResolved = path.resolve(root);
  const filePath = path.resolve(root, rel);
  if (filePath !== rootResolved && !filePath.startsWith(rootResolved + path.sep)) {
    return sendJSON(res, 403, { error: 'forbidden' });
  }

  fs.readFile(filePath, (err, content) => {
    if (err) return sendJSON(res, 404, { error: 'not found' });
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(content);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = url.pathname;
  const method = req.method;

  try {
    // 公共只读
    if (method === 'GET' && pathname === '/api/data') {
      const d = readData();
      return sendJSON(res, 200, { events: d.events, roster: d.roster });
    }

    if (method === 'GET' && pathname === '/api/events') {
      return sendJSON(res, 200, readData().events);
    }

    if (method === 'GET' && pathname === '/api/auth') {
      const token = url.searchParams.get('t') || '';
      const exp = SESSIONS.get(token);
      const ok = !!exp && exp > Date.now();
      if (exp && !ok) SESSIONS.delete(token);
      return sendJSON(res, 200, { ok });
    }

    if (method === 'POST' && pathname === '/api/login') {
      const ip = getIP(req);
      const rec = bans[ip] || { fail: 0, banUntil: 0, permanent: false };

      if (rec.permanent) {
        return sendJSON(res, 403, { ok: false, error: '用户名或密码错误，该 IP 已被永久封禁，无法登录' });
      }

      let body = {};
      try {
        body = JSON.parse(await readBody(req) || '{}');
      } catch (e) {
        return sendJSON(res, 400, { ok: false, error: '请求格式错误' });
      }

      const userOk = safeEqual(body.user, ADMIN_USER);
      const passOk = safeEqual(body.pass, ADMIN_PASS);

      if (userOk && passOk) {
        delete bans[ip];
        saveBans();
        const token = crypto.randomBytes(24).toString('hex');
        SESSIONS.set(token, Date.now() + SESSION_TTL);
        return sendJSON(res, 200, { ok: true, token });
      }

      rec.fail += 1;
      let error;
      if (rec.fail >= PERM_BAN_COUNT) {
        rec.permanent = true;
        rec.banUntil = 0;
        error = '用户名或密码错误，该 IP 已被永久封禁';
      } else if (rec.fail >= TEMP_BAN_COUNT) {
        rec.banUntil = Date.now() + TEMP_BAN_MS;
        error = `用户名或密码错误，已累计 ${rec.fail} 次，IP 已封禁 12 小时`;
      } else {
        error = `用户名或密码错误（剩余 ${TEMP_BAN_COUNT - rec.fail} 次机会）`;
      }

      bans[ip] = rec;
      saveBans();
      return sendJSON(res, 401, { ok: false, error });
    }

    if (method === 'POST' && pathname === '/api/logout') {
      const token = (req.headers.authorization || '').replace('Bearer ', '');
      SESSIONS.delete(token);
      return sendJSON(res, 200, { ok: true });
    }

    // ===== 以下为写操作，需要登录鉴权 =====
    if (method === 'POST' && pathname === '/api/events') {
      if (!isAuthed(req)) return sendJSON(res, 401, { ok: false, error: '未登录或登录已过期' });
      const body = JSON.parse(await readBody(req) || '{}');
      if (!body.title || !body.part || !body.start || !body.end) {
        return sendJSON(res, 400, { ok: false, error: '标题、所属部分、开始时间和结束时间必填' });
      }
      if (!PARTS.includes(body.part)) {
        return sendJSON(res, 400, { ok: false, error: '所属部分不合法' });
      }
      const data = readData();
      const owners = parseOwners(body);

      const conc = checkConcurrency(data.events, body.part, body.start, body.end, null);
      if (!conc.ok) {
        return sendJSON(res, 409, {
          ok: false,
          error: `「${body.part}」同一时间进行的事件不能超过 ${MAX_CONCURRENT_PER_PART} 个（当前会导致 ${conc.max} 个并行），请调整时间`,
        });
      }

      const event = {
        id: data.events.length ? Math.max(...data.events.map((e) => e.id)) + 1 : 1,
        title: String(body.title).trim(),
        part: body.part,
        start: body.start,
        end: body.end,
        desc: body.desc || '',
        owners,
      };
      data.events.push(event);
      addToRoster(data, owners);
      writeData(data);
      return sendJSON(res, 200, { ok: true, event });
    }

    if (method === 'PUT' && pathname === '/api/events') {
      if (!isAuthed(req)) return sendJSON(res, 401, { ok: false, error: '未登录或登录已过期' });
      const body = JSON.parse(await readBody(req) || '{}');
      const id = Number(body.id);
      if (!body.title || !body.part || !body.start || !body.end) {
        return sendJSON(res, 400, { ok: false, error: '标题、所属部分、开始时间和结束时间必填' });
      }
      if (!PARTS.includes(body.part)) {
        return sendJSON(res, 400, { ok: false, error: '所属部分不合法' });
      }
      const data = readData();
      const idx = data.events.findIndex((e) => e.id === id);
      if (idx === -1) return sendJSON(res, 404, { ok: false, error: '事件不存在' });
      const owners = parseOwners(body);

      const conc = checkConcurrency(data.events, body.part, body.start, body.end, id);
      if (!conc.ok) {
        return sendJSON(res, 409, {
          ok: false,
          error: `「${body.part}」同一时间进行的事件不能超过 ${MAX_CONCURRENT_PER_PART} 个（当前会导致 ${conc.max} 个并行），请调整时间`,
        });
      }

      const event = {
        id,
        title: String(body.title).trim(),
        part: body.part,
        start: body.start,
        end: body.end,
        desc: body.desc || '',
        owners,
      };
      data.events[idx] = event;
      addToRoster(data, owners);
      writeData(data);
      return sendJSON(res, 200, { ok: true, event });
    }

    if (method === 'DELETE' && pathname === '/api/events') {
      if (!isAuthed(req)) return sendJSON(res, 401, { ok: false, error: '未登录或登录已过期' });
      const id = Number(url.searchParams.get('id'));
      const data = readData();
      const idx = data.events.findIndex((e) => e.id === id);
      if (idx === -1) return sendJSON(res, 404, { ok: false, error: '事件不存在' });
      data.events.splice(idx, 1);
      writeData(data);
      return sendJSON(res, 200, { ok: true });
    }

    // 预置名单：批量添加人员
    if (method === 'POST' && pathname === '/api/roster') {
      if (!isAuthed(req)) return sendJSON(res, 401, { ok: false, error: '未登录或登录已过期' });
      const body = JSON.parse(await readBody(req) || '{}');
      const names = Array.isArray(body.names) ? body.names : (body.name ? [body.name] : []);
      const data = readData();
      addToRoster(data, names);
      writeData(data);
      return sendJSON(res, 200, { ok: true, roster: data.roster });
    }

    // 从名单中移除某人（若仍被事件使用，会自动回到名单）
    if (method === 'POST' && pathname === '/api/roster-remove') {
      if (!isAuthed(req)) return sendJSON(res, 401, { ok: false, error: '未登录或登录已过期' });
      const body = JSON.parse(await readBody(req) || '{}');
      const name = String(body.name || '').trim();
      const data = readData();
      if (name) {
        data.roster = data.roster.filter((n) => n !== name);
        writeData(data);
      }
      normalizeData(data);
      writeData(data);
      return sendJSON(res, 200, { ok: true, roster: data.roster });
    }

    if (method === 'GET') return serveStatic(res, pathname);
    return sendJSON(res, 404, { error: 'not found' });
  } catch (e) {
    return sendJSON(res, 500, { ok: false, error: e.message });
  }
});

server.listen(PORT, () => {
  ensureData();
  loadBans();
  console.log(`悦享e食平台时间线已启动: http://localhost:${PORT}`);
  console.log(`后台管理: http://localhost:${PORT}/admin-manage`);
});
