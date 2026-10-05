import express from 'express';
import helmet from 'helmet';
import cookieSession from 'cookie-session';
import rateLimit from 'express-rate-limit';
import bcrypt from 'bcryptjs';
import ipaddr from 'ipaddr.js';
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, tx, getSetting, setSetting, encrypt, decrypt, cookieKey, DATA_DIR } from './db.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const app = express();

// 端口、监听地址、反向代理可以用环境变量指定，也可以在网页的 设置 → 服务器 里改（存在数据库里）。
// 两边都有时以环境变量为准。
const envConfig = { port: process.env.PORT, host: process.env.HOST, trustProxy: process.env.TRUST_PROXY };
const serverConfig = () => ({
  port: Number(envConfig.port) || getSetting('port', 3080),
  host: envConfig.host || getSetting('host', '0.0.0.0'),
  trustProxy: envConfig.trustProxy ?? getSetting('trust_proxy', ''),
});

// 部署在反向代理后面时必须设置，否则白名单看到的是代理的 IP。
// 直连时保持关闭，避免客户端伪造 X-Forwarded-For 绕过白名单。
function applyTrustProxy(value) {
  app.set('trust proxy', !value ? false : value === 'true' ? true : /^\d+$/.test(value) ? Number(value) : value);
}
applyTrustProxy(serverConfig().trustProxy);

app.use(
  helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        // Vue 在浏览器内编译模板需要 unsafe-eval
        scriptSrc: ["'self'", "'unsafe-eval'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        // blob: 用于裁切站点图标时预览本地选中的图片
        imgSrc: ['*', 'data:', 'blob:'],
        fontSrc: ["'self'"],
        // blob: 是裁切库读取本地图片的拍摄方向信息时用的
        connectSrc: ["'self'", 'blob:'],
        // HEIC 图片在浏览器里解码时会用到由 blob 创建的 Worker
        workerSrc: ["'self'", 'blob:'],
        objectSrc: ["'none'"],
        baseUri: ["'none'"],
        frameAncestors: ["'none'"],
      },
    },
    strictTransportSecurity: false,
  })
);
app.use(
  cookieSession({
    name: 'nav',
    keys: [cookieKey],
    maxAge: 30 * 24 * 3600 * 1000,
    sameSite: 'lax',
    httpOnly: true,
  })
);
// 登录有效期可以在设置里调，所以每次请求按当前设置覆盖
app.use((req, res, next) => {
  req.sessionOptions.maxAge = getSetting('session_days', 30) * 24 * 3600 * 1000;
  next();
});

// ---------- 静态资源 ----------
const nm = (...p) => path.join(ROOT, 'node_modules', ...p);
const vendor = {
  'vue.js': nm('vue', 'dist', 'vue.esm-browser.prod.js'),
  'fuse.js': nm('fuse.js', 'dist', 'fuse.min.mjs'),
  'sortable.js': nm('sortablejs', 'modular', 'sortable.esm.js'),
  // 下面两个只在设置站点图标时才按需加载
  'cropper.js': nm('cropperjs', 'dist', 'cropper.esm.js'),
  'cropper.css': nm('cropperjs', 'dist', 'cropper.min.css'),
  'heic.js': nm('heic-to', 'dist', 'csp', 'heic-to.min.js'),
};
app.use('/vendor/pinyin', express.static(nm('pinyin-pro', 'dist', 'esm'), { maxAge: '7d' }));
app.get('/vendor/:file', (req, res, next) => {
  const file = vendor[req.params.file];
  if (!file) return next();
  res.type(req.params.file.endsWith('.css') ? 'text/css' : 'text/javascript').sendFile(file, { maxAge: '7d' });
});
// 字体包按 unicode-range 分片；补上 font-display: swap，分片加载期间先用系统字体，不留空白
for (const [route, pkg] of [['body', 'cn-fontsource-xiaolai-sc-regular'], ['title', 'cn-fontsource-975-maru-sc-bold']]) {
  const css = fs.readFileSync(nm(pkg, 'font.css'), 'utf8').replaceAll('@font-face {', '@font-face {font-display:swap;');
  app.get(`/fonts/${route}/font.css`, (req, res) => res.type('text/css').set('Cache-Control', 'public, max-age=604800').send(css));
}
app.use('/fonts/body', express.static(nm('cn-fontsource-xiaolai-sc-regular'), { maxAge: '365d', immutable: true }));
app.use('/fonts/title', express.static(nm('cn-fontsource-975-maru-sc-bold'), { maxAge: '365d', immutable: true }));
app.use('/icons', express.static(nm('lucide-static', 'icons'), { maxAge: '365d', immutable: true }));
app.use(express.static(path.join(ROOT, 'public')));

// ---------- 鉴权 ----------
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function clientIp(req) {
  try {
    return ipaddr.process(req.ip).toString();
  } catch {
    return req.ip || '';
  }
}

function parseRule(rule) {
  if (rule.includes('/')) {
    const [range, bits] = ipaddr.parseCIDR(rule);
    return (addr) => addr.kind() === range.kind() && addr.match(range, bits);
  }
  const target = ipaddr.process(rule);
  return (addr) => addr.kind() === target.kind() && addr.toNormalizedString() === target.toNormalizedString();
}

function ipWhitelisted(req) {
  const rules = getSetting('whitelist', []);
  if (!rules.length) return false;
  let addr;
  try {
    addr = ipaddr.process(req.ip);
  } catch {
    return false;
  }
  return rules.some((rule) => {
    try {
      return parseRule(rule)(addr);
    } catch {
      return false;
    }
  });
}

const isSetup = () => !!getSetting('password');
const sessionValid = (req) => isSetup() && req.session?.pv === getSetting('pwd_ver', 0);
const authState = (req) => {
  const viaIp = isSetup() && ipWhitelisted(req);
  return { viaIp, authorized: viaIp || sessionValid(req) };
};

function requireAuth(req, res, next) {
  if (!authState(req).authorized) throw new HttpError(401, '需要进入私密模式');
  next();
}

function checkPassword(password) {
  const hash = getSetting('password');
  return !!hash && typeof password === 'string' && bcrypt.compareSync(password, hash);
}

function setPassword(password) {
  if (typeof password !== 'string' || password.length < 6) throw new HttpError(400, '密码至少 6 位');
  setSetting('password', bcrypt.hashSync(password, 10));
  setSetting('pwd_ver', getSetting('pwd_ver', 0) + 1);
}

// ---------- 智能体接口 ----------
// 给外部智能体用的独立入口：凭令牌访问，只能读网址的基本信息、写「详情」。
// 这里的代码从不读取 secret 列，账号密码对智能体不可见也不可写。
const agent = express.Router();
app.use('/api/agent', agent);
agent.use(rateLimit({ windowMs: 60 * 1000, limit: 120, standardHeaders: true, legacyHeaders: false, message: { error: '请求过于频繁' } }));
agent.use((req, res, next) => {
  const expected = getSetting('agent_hash');
  const token = /^Bearer (.+)$/.exec(req.get('authorization') || '')?.[1] || '';
  const given = crypto.createHash('sha256').update(token).digest();
  if (!expected || !crypto.timingSafeEqual(given, Buffer.from(expected, 'hex'))) {
    throw new HttpError(401, '令牌无效或未启用智能体接入');
  }
  res.set('Cache-Control', 'no-store');
  next();
});
agent.use(express.json({ limit: '1mb' }));

const DETAIL_SCHEMA = {
  summary: '简介：这个网站是什么、适合用来做什么。纯文本，建议 1~3 句，最多 2000 字',
  features: '功能亮点：字符串数组，每条一句话，最多 20 条',
  notes: '使用笔记：注意事项、技巧、收费情况等。纯文本，最多 5000 字',
  links: '相关链接：[{ "label": "文档", "url": "https://…" }]，如文档、登录页、状态页，最多 20 条',
  desc: '（可选）卡片上显示的一句话描述，最多 500 字',
  tags: '（可选）标签数组，最多 20 个',
};

// 智能体默认只能看到公开网址；在设置里打开「允许访问私密网址」后才是全部
function agentLinks() {
  const { cats, links, members } = visibleData(getSetting('agent_private', false));
  const name = new Map(cats.map((c) => [c.id, c.name]));
  return links.map((l) => ({
    id: l.id,
    title: l.title,
    url: l.url,
    desc: l.desc,
    tags: l.tags ? l.tags.split(',') : [],
    categories: (members.get(l.id) || []).map((m) => name.get(m.category_id)),
    private: !!l.private,
    detail: l.detail ? JSON.parse(l.detail) : null,
  }));
}

agent.get('/schema', (req, res) => {
  res.json({
    about: '网址导航的智能体接口。用于为每个网址补全「详情」。接口不返回、也不接受任何账号密码信息。',
    endpoints: {
      'GET /api/agent/links': '列出可访问的网址；加 ?missing=1 只列出还没有详情的',
      'GET /api/agent/links/:id': '读取单个网址',
      'PUT /api/agent/links/:id/detail': '写入详情，请求体字段见 detail',
    },
    detail: DETAIL_SCHEMA,
  });
});

agent.get('/links', (req, res) => {
  const links = agentLinks();
  res.json({ links: req.query.missing ? links.filter((l) => !l.detail) : links });
});

agent.get('/links/:id', (req, res) => {
  const link = agentLinks().find((l) => l.id === Number(req.params.id));
  if (!link) throw new HttpError(404, '网址不存在或无权访问');
  res.json(link);
});

agent.put('/links/:id/detail', (req, res) => {
  const link = agentLinks().find((l) => l.id === Number(req.params.id));
  if (!link) throw new HttpError(404, '网址不存在或无权访问');
  const b = req.body || {};
  const detail = cleanDetail(b, 'agent');
  tx(() => {
    db.prepare('UPDATE links SET detail = ? WHERE id = ?').run(detail && JSON.stringify(detail), link.id);
    if (typeof b.desc === 'string') db.prepare('UPDATE links SET desc = ? WHERE id = ?').run(str(b.desc), link.id);
    if (Array.isArray(b.tags)) db.prepare('UPDATE links SET tags = ? WHERE id = ?').run(cleanTags(b.tags).join(','), link.id);
  });
  res.json({ ok: true, detail });
});

// 有新网址时通知智能体（可选）。只发 id、标题、网址，不含任何账号信息；发不出去也不影响主流程。
function notifyAgent(ids) {
  const url = getSetting('agent_webhook', '');
  if (!url || !ids.length) return;
  const links = agentLinks().filter((l) => ids.includes(l.id)).map(({ id, title, url }) => ({ id, title, url }));
  if (!links.length) return;
  fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ event: 'links.created', links }),
    signal: AbortSignal.timeout(5000),
  }).catch(() => {});
}

// ---------- API ----------
const api = express.Router();
app.use('/api', api);

// 白名单 IP 不带 Cookie 也算已授权，SameSite 防不住跨站请求，所以要求自定义请求头（跨域时会被预检拦下）。
api.use((req, res, next) => {
  const site = req.get('sec-fetch-site');
  if (req.get('x-nav') !== '1' || (site && site !== 'same-origin' && site !== 'none')) {
    throw new HttpError(403, '非法请求');
  }
  res.set('Cache-Control', 'no-store');
  next();
});
api.use(express.json({ limit: '10mb' }));

const passwordLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  skipSuccessfulRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: '尝试次数过多，请 15 分钟后再试' },
});

api.get('/state', (req, res) => {
  res.json({
    setup: isSetup(),
    ...authState(req),
    ip: clientIp(req),
    title: getSetting('title', '我的导航'),
    logo: getSetting('logo', ''),
  });
});

api.post('/setup', (req, res) => {
  if (isSetup()) throw new HttpError(400, '已经初始化过了');
  setPassword(req.body.password);
  req.session.pv = getSetting('pwd_ver');
  res.json({ ok: true });
});

api.post('/login', passwordLimiter, (req, res) => {
  if (!checkPassword(req.body.password)) throw new HttpError(401, '密码不正确');
  req.session.pv = getSetting('pwd_ver');
  res.json({ ok: true });
});

api.post('/logout', (req, res) => {
  req.session = null;
  res.json({ ok: true });
});

// ---------- 数据读写 ----------
const str = (v, max = 500) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

function cleanUrl(v) {
  let url;
  try {
    url = new URL(str(v, 2000));
  } catch {
    throw new HttpError(400, '网址格式不正确');
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new HttpError(400, '只支持 http / https 网址');
  return url.href;
}

function cleanTags(v) {
  const list = Array.isArray(v) ? v : String(v || '').split(/[,，\s]+/);
  return [...new Set(list.map((t) => str(t, 30)).filter(Boolean))].slice(0, 20);
}

const entities = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const decodeEntities = (s) =>
  s.replace(/&(#x?[0-9a-f]+|\w+);/gi, (m, e) =>
    e[0] === '#' ? String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : (entities[e] ?? m)
  );

// 从浏览器拖进来的网址常常不带标题，这时去取网页的 <title>。只读前 256KB，失败就返回空串由域名兜底。
async function fetchTitle(url) {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(4000),
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; nav-title-fetcher)', accept: 'text/html' },
    });
    const type = res.headers.get('content-type') || '';
    if (!res.ok || !type.includes('html')) return '';
    const chunks = [];
    let size = 0;
    for await (const chunk of res.body) {
      chunks.push(chunk);
      if ((size += chunk.length) > 262144) break;
    }
    const buf = Buffer.concat(chunks);
    const charset = (type.match(/charset=([\w-]+)/i) || buf.toString('latin1').match(/<meta[^>]+charset=["']?([\w-]+)/i) || [])[1];
    let text;
    try {
      text = new TextDecoder(charset || 'utf-8').decode(buf);
    } catch {
      text = buf.toString('utf8');
    }
    const title = text.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1] || '';
    return decodeEntities(title).replace(/\s+/g, ' ').trim().slice(0, 200);
  } catch {
    return '';
  }
}

// 账号信息：账号、密码、备注三个固定字段 + 任意自定义字段
function cleanSecret(v) {
  if (!v || typeof v !== 'object') return null;
  const secret = {
    account: str(v.account),
    password: typeof v.password === 'string' ? v.password.slice(0, 500) : '',
    note: str(v.note, 5000),
    extra: (Array.isArray(v.extra) ? v.extra : [])
      .map((f) => ({ k: str(f?.k, 50), v: str(f?.v, 2000) }))
      .filter((f) => f.k || f.v)
      .slice(0, 30),
  };
  return secret.account || secret.password || secret.note || secret.extra.length ? secret : null;
}

// 网址详情：四个预设字段。by 记录是谁写的（user / agent），显示在详情页上
function cleanDetail(v, by) {
  if (!v || typeof v !== 'object') return null;
  const features = Array.isArray(v.features) ? v.features : String(v.features || '').split('\n');
  const detail = {
    summary: str(v.summary, 2000),
    features: features.map((f) => str(f, 200)).filter(Boolean).slice(0, 20),
    notes: str(v.notes, 5000),
    links: (Array.isArray(v.links) ? v.links : [])
      .map((l) => {
        try {
          return { label: str(l?.label, 60), url: cleanUrl(l?.url) };
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .slice(0, 20),
  };
  if (!detail.summary && !detail.features.length && !detail.notes && !detail.links.length) return null;
  return { ...detail, updated_at: Date.now(), updated_by: by };
}

const linkOut = (row, cats, priv) => ({
  id: row.id,
  title: row.title,
  url: row.url,
  desc: row.desc,
  tags: row.tags ? row.tags.split(',') : [],
  private: !!row.private,
  pinned: !!row.pinned,
  sort: row.sort,
  categories: cats.map((c) => c.category_id),
  // 在各个分类里的排序位置
  pos: Object.fromEntries(cats.map((c) => [c.category_id, c.sort])),
  detail: row.detail ? JSON.parse(row.detail) : null,
  ...(priv && { clicks: row.clicks, last_visit: row.last_visit, created_at: row.created_at, has_secret: !!row.secret }),
});
const catOut = (row) => ({ id: row.id, name: row.name, private: !!row.private, sort: row.sort });

const q = {
  cats: db.prepare('SELECT * FROM categories ORDER BY sort, id'),
  links: db.prepare('SELECT * FROM links ORDER BY sort, id'),
  link: db.prepare('SELECT * FROM links WHERE id = ?'),
  cat: db.prepare('SELECT * FROM categories WHERE id = ?'),
  catByName: db.prepare('SELECT * FROM categories WHERE name = ?'),
  addCat: db.prepare(
    'INSERT INTO categories (name, private, sort) VALUES (?, ?, (SELECT COALESCE(MAX(sort), 0) + 1 FROM categories))'
  ),
  addLink: db.prepare(
    `INSERT INTO links (title, url, desc, tags, private, pinned, secret, created_at, sort)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, (SELECT COALESCE(MAX(sort), 0) + 1 FROM links))`
  ),
  members: db.prepare(
    'SELECT m.* FROM link_cats m JOIN categories c ON c.id = m.category_id ORDER BY c.sort, c.id'
  ),
  membersOf: db.prepare('SELECT category_id FROM link_cats WHERE link_id = ?'),
  linksIn: db.prepare('SELECT link_id FROM link_cats WHERE category_id = ?'),
  // 新加入一个分类时排到该分类末尾
  join: db.prepare(
    `INSERT OR IGNORE INTO link_cats (link_id, category_id, sort)
     VALUES (?, ?, (SELECT COALESCE(MAX(sort), 0) + 1 FROM link_cats WHERE category_id = ?))`
  ),
  leave: db.prepare('DELETE FROM link_cats WHERE link_id = ? AND category_id = ?'),
};

function membersByLink() {
  const map = new Map();
  for (const m of q.members.all()) {
    if (!map.has(m.link_id)) map.set(m.link_id, []);
    map.get(m.link_id).push(m);
  }
  return map;
}

function ensureCategory(name, isPrivate) {
  name = str(name, 40);
  if (!name) return null;
  const found = q.catByName.get(name);
  if (found) return found.id;
  return Number(q.addCat.run(name, isPrivate ? 1 : 0).lastInsertRowid);
}

// categories 里可以混用分类 id 和分类名称（名称不存在则新建）；也兼容单个 category 名称
function resolveCategories(body, isPrivate) {
  const list = Array.isArray(body.categories) ? body.categories : [body.category];
  const ids = list.map((v) => (typeof v === 'number' ? q.cat.get(v)?.id : ensureCategory(v, isPrivate)));
  return [...new Set(ids.filter((id) => id != null))];
}

function setCategories(linkId, ids) {
  for (const { category_id } of q.membersOf.all(linkId)) {
    if (!ids.includes(category_id)) q.leave.run(linkId, category_id);
  }
  for (const id of ids) q.join.run(linkId, id, id);
}

// priv 为 false 时按公开模式过滤：网址只出现在它的公开分类里；所属分类全是私密的就整个隐藏
function visibleData(priv) {
  let cats = q.cats.all();
  let links = q.links.all();
  const members = membersByLink();
  if (!priv) {
    const hidden = new Set(cats.filter((c) => c.private).map((c) => c.id));
    links = links.filter((l) => {
      if (l.private) return false;
      const own = members.get(l.id);
      if (!own) return true;
      const visible = own.filter((m) => !hidden.has(m.category_id));
      members.set(l.id, visible);
      return visible.length > 0;
    });
    // 不暴露没有公开网址的分类名
    const used = new Set(links.flatMap((l) => (members.get(l.id) || []).map((m) => m.category_id)));
    cats = cats.filter((c) => used.has(c.id));
  }
  return { cats, links, members };
}

api.get('/data', (req, res) => {
  const priv = req.query.mode === 'private';
  if (priv && !authState(req).authorized) throw new HttpError(401, '需要进入私密模式');
  const { cats, links, members } = visibleData(priv);
  res.json({
    categories: cats.map(catOut),
    links: links.map((l) => linkOut(l, members.get(l.id) || [], priv)),
    settings: {
      search: getSetting('search', 'https://www.bing.com/search?q=%s'),
      ...(priv && {
        whitelist: getSetting('whitelist', []),
        agent: {
          enabled: !!getSetting('agent_hash'),
          private: getSetting('agent_private', false),
          webhook: getSetting('agent_webhook', ''),
        },
        server: {
          ...serverConfig(),
          publicUrl: getSetting('public_url', ''),
          sessionDays: getSetting('session_days', 30),
          // 哪些项被环境变量锁定了
          locked: { port: !!envConfig.port, host: !!envConfig.host, trustProxy: envConfig.trustProxy !== undefined },
          dataDir: DATA_DIR,
          node: process.version,
        },
      }),
    },
  });
});

api.post('/links', requireAuth, async (req, res) => {
  const b = req.body;
  const url = cleanUrl(b.url);
  const title = str(b.title, 200) || (await fetchTitle(url)) || new URL(url).hostname;
  const secret = cleanSecret(b.secret);
  const id = tx(() => {
    const linkId = Number(
      q.addLink.run(
        title,
        url,
        str(b.desc),
        cleanTags(b.tags).join(','),
        b.private ? 1 : 0,
        b.pinned ? 1 : 0,
        secret && encrypt(secret),
        Date.now()
      ).lastInsertRowid
    );
    setCategories(linkId, resolveCategories(b, b.private));
    return linkId;
  });
  notifyAgent([id]);
  res.json({ id });
});

api.put('/links/:id/detail', requireAuth, (req, res) => {
  if (!q.link.get(req.params.id)) throw new HttpError(404, '网址不存在');
  const detail = cleanDetail(req.body.detail, 'user');
  db.prepare('UPDATE links SET detail = ? WHERE id = ?').run(detail && JSON.stringify(detail), req.params.id);
  res.json({ ok: true, detail });
});

api.put('/links/:id', requireAuth, (req, res) => {
  const b = req.body;
  const old = q.link.get(req.params.id);
  if (!old) throw new HttpError(404, '网址不存在');
  const url = cleanUrl(b.url);
  // 没带 secret 字段表示不修改账号信息
  const secret = 'secret' in b ? cleanSecret(b.secret) && encrypt(cleanSecret(b.secret)) : old.secret;
  tx(() => {
    db.prepare(
      'UPDATE links SET title = ?, url = ?, desc = ?, tags = ?, private = ?, pinned = ?, secret = ? WHERE id = ?'
    ).run(
      str(b.title, 200) || new URL(url).hostname,
      url,
      str(b.desc),
      cleanTags(b.tags).join(','),
      b.private ? 1 : 0,
      b.pinned ? 1 : 0,
      secret,
      old.id
    );
    if ('categories' in b || 'category' in b) setCategories(old.id, resolveCategories(b, b.private));
  });
  res.json({ ok: true });
});

api.delete('/links/:id', requireAuth, (req, res) => {
  tx(() => {
    db.prepare('DELETE FROM link_cats WHERE link_id = ?').run(req.params.id);
    db.prepare('DELETE FROM links WHERE id = ?').run(req.params.id);
  });
  res.json({ ok: true });
});

api.get('/links/:id/secret', requireAuth, (req, res) => {
  const row = q.link.get(req.params.id);
  if (!row) throw new HttpError(404, '网址不存在');
  res.json({ secret: row.secret ? decrypt(row.secret) : null });
});

// 访问统计只在私密模式下记录，公开访客不能改数据
api.post('/links/:id/visit', (req, res) => {
  if (authState(req).authorized) {
    db.prepare('UPDATE links SET clicks = clicks + 1, last_visit = ? WHERE id = ?').run(Date.now(), req.params.id);
  }
  res.json({ ok: true });
});

api.post('/categories', requireAuth, (req, res) => {
  const name = str(req.body.name, 40);
  if (!name) throw new HttpError(400, '请填写分类名称');
  if (q.catByName.get(name)) throw new HttpError(400, '已有同名分类');
  res.json({ id: Number(q.addCat.run(name, req.body.private ? 1 : 0).lastInsertRowid) });
});

api.put('/categories/:id', requireAuth, (req, res) => {
  const name = str(req.body.name, 40);
  if (!name) throw new HttpError(400, '请填写分类名称');
  const same = q.catByName.get(name);
  if (same && same.id !== Number(req.params.id)) throw new HttpError(400, '已有同名分类');
  db.prepare('UPDATE categories SET name = ?, private = ? WHERE id = ?').run(
    name,
    req.body.private ? 1 : 0,
    req.params.id
  );
  res.json({ ok: true });
});

api.delete('/categories/:id', requireAuth, (req, res) => {
  const cat = q.cat.get(req.params.id);
  if (!cat) throw new HttpError(404, '分类不存在');
  tx(() => {
    const linkIds = q.linksIn.all(cat.id).map((m) => m.link_id);
    db.prepare('DELETE FROM link_cats WHERE category_id = ?').run(cat.id);
    // 还在别的分类里的网址不受影响，只处理因此变成「未分类」的那些
    const orphans = linkIds.filter((id) => !q.membersOf.all(id).length);
    for (const id of orphans) {
      if (req.body?.with_links) db.prepare('DELETE FROM links WHERE id = ?').run(id);
      // 私密分类解散后，里面的网址要各自保持私密，不能因为落到「未分类」而变成公开
      else if (cat.private) db.prepare('UPDATE links SET private = 1 WHERE id = ?').run(id);
    }
    db.prepare('DELETE FROM categories WHERE id = ?').run(cat.id);
  });
  res.json({ ok: true });
});

// 排序；带 moved 时先把那个网址从 moved.from 分类移出、移入目标分类（移动而不是复制）
api.post('/reorder', requireAuth, (req, res) => {
  const ids = (Array.isArray(req.body.ids) ? req.body.ids : []).map(Number).filter(Number.isInteger);
  tx(() => {
    if (req.body.type === 'categories') {
      const stmt = db.prepare('UPDATE categories SET sort = ? WHERE id = ?');
      ids.forEach((id, i) => stmt.run(i, id));
      return;
    }
    const catId = req.body.category_id ?? null;
    if (catId != null && !q.cat.get(catId)) throw new HttpError(400, '分类不存在');
    const moved = req.body.moved;
    if (Number.isInteger(moved?.id)) {
      if (moved.from != null) q.leave.run(moved.id, moved.from);
      if (catId != null) q.join.run(moved.id, catId, catId);
    }
    const stmt =
      catId == null
        ? db.prepare('UPDATE links SET sort = ? WHERE id = ?')
        : db.prepare('UPDATE link_cats SET sort = ? WHERE link_id = ? AND category_id = ?');
    ids.forEach((id, i) => (catId == null ? stmt.run(i, id) : stmt.run(i, id, catId)));
  });
  res.json({ ok: true });
});

// 书签文件和备份文件都由前端解析成同一种 items 结构再提交
api.post('/import', requireAuth, async (req, res) => {
  const items = (Array.isArray(req.body.items) ? req.body.items : []).filter((item) => item && typeof item === 'object');
  const untitled = items.filter((item) => !str(item.title));
  if (untitled.length <= 10) {
    await Promise.all(untitled.map(async (item) => (item.title = await fetchTitle(str(item.url, 2000)))));
  }
  const forcePrivate = !!req.body.private;
  const catPrivacy = new Map(
    (Array.isArray(req.body.categories) ? req.body.categories : []).map((c) => [str(c?.name, 40), !!c?.private])
  );
  const existing = new Set(q.links.all().map((l) => l.url));
  let added = 0;
  let skipped = 0;
  const newIds = [];
  tx(() => {
    for (const item of items) {
      let url;
      try {
        url = cleanUrl(item.url);
      } catch {
        skipped++;
        continue;
      }
      if (existing.has(url)) {
        skipped++;
        continue;
      }
      existing.add(url);
      const secret = cleanSecret(item.secret);
      const linkId = Number(
        q.addLink.run(
          str(item.title, 200) || new URL(url).hostname,
          url,
          str(item.desc),
          cleanTags(item.tags).join(','),
          forcePrivate || item.private ? 1 : 0,
          item.pinned ? 1 : 0,
          secret && encrypt(secret),
          Date.now()
        ).lastInsertRowid
      );
      const names = Array.isArray(item.categories) ? item.categories : [item.category];
      for (const name of names) {
        const catId = ensureCategory(name, forcePrivate || catPrivacy.get(str(name, 40)));
        if (catId != null) q.join.run(linkId, catId, catId);
      }
      // 备份里的详情原样恢复（包括是谁写的）
      const detail = cleanDetail(item.detail, item.detail?.updated_by === 'agent' ? 'agent' : 'user');
      if (detail) db.prepare('UPDATE links SET detail = ? WHERE id = ?').run(JSON.stringify(detail), linkId);
      newIds.push(linkId);
      added++;
    }
  });
  notifyAgent(newIds);
  res.json({ added, skipped });
});

const escapeHtml = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

api.get('/export', requireAuth, (req, res) => {
  const cats = q.cats.all();
  const links = q.links.all();
  const members = membersByLink();
  const catName = new Map(cats.map((c) => [c.id, c.name]));
  const date = new Date().toISOString().slice(0, 10);

  if (req.query.format === 'html') {
    // Netscape 书签格式，可直接导回浏览器；属于多个分类的网址在每个文件夹里各出现一次
    const inCat = (id) =>
      links
        .filter((l) => members.get(l.id)?.some((m) => m.category_id === id))
        .sort((a, b) => members.get(a.id).find((m) => m.category_id === id).sort - members.get(b.id).find((m) => m.category_id === id).sort);
    const groups = cats.map((c) => [c.name, inCat(c.id)]);
    groups.push(['未分类', links.filter((l) => !members.has(l.id))]);
    const body = groups
      .filter(([, list]) => list.length)
      .map(
        ([name, list]) =>
          `  <DT><H3>${escapeHtml(name)}</H3>\n  <DL><p>\n` +
          list.map((l) => `    <DT><A HREF="${escapeHtml(l.url)}">${escapeHtml(l.title)}</A>\n`).join('') +
          '  </DL><p>\n'
      )
      .join('');
    res
      .attachment(`nav-bookmarks-${date}.html`)
      .send(
        '<!DOCTYPE NETSCAPE-Bookmark-file-1>\n<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">\n' +
          `<TITLE>Bookmarks</TITLE>\n<H1>Bookmarks</H1>\n<DL><p>\n${body}</DL><p>\n`
      );
    return;
  }

  const withSecrets = req.query.secrets === '1';
  res.attachment(`nav-backup-${date}.json`).json({
    version: 2,
    exported_at: new Date().toISOString(),
    categories: cats.map((c) => ({ name: c.name, private: !!c.private })),
    links: links.map((l) => ({
      title: l.title,
      url: l.url,
      desc: l.desc,
      tags: l.tags ? l.tags.split(',') : [],
      categories: (members.get(l.id) || []).map((m) => catName.get(m.category_id)),
      private: !!l.private,
      pinned: !!l.pinned,
      ...(l.detail && { detail: JSON.parse(l.detail) }),
      ...(withSecrets && l.secret && { secret: decrypt(l.secret) }),
    })),
  });
});

api.put('/settings', requireAuth, passwordLimiter, (req, res) => {
  const b = req.body;
  // 改密码和白名单必须验证当前密码，白名单内的设备也不例外
  const agentKeys = ['agent_action', 'agent_private', 'agent_webhook'];
  if ('whitelist' in b || 'new_password' in b || agentKeys.some((k) => k in b)) {
    if (!checkPassword(b.current_password)) throw new HttpError(401, '管理密码不正确');
  }
  if ('whitelist' in b) {
    const rules = [...new Set((Array.isArray(b.whitelist) ? b.whitelist : []).map((r) => str(r, 60)).filter(Boolean))];
    for (const rule of rules) {
      try {
        parseRule(rule);
      } catch {
        throw new HttpError(400, `无法识别的 IP 或网段：${rule}`);
      }
    }
    setSetting('whitelist', rules);
  }
  if ('new_password' in b) {
    setPassword(b.new_password);
    req.session.pv = getSetting('pwd_ver');
  }
  if ('title' in b) setSetting('title', str(b.title, 40) || '我的导航');
  // 站点图标：前端已缩成小图，以 data URL 存在设置里；空串表示恢复默认（站点名称的首字）
  if ('logo' in b) {
    // 三种取值：空串 = 默认（站点名称首字）；data URL = 图片；其他 = 自定义文字（最多 4 个字符）
    let logo = typeof b.logo === 'string' ? b.logo.trim() : '';
    if (logo.startsWith('data:')) {
      if (!/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(logo)) throw new HttpError(400, '图标格式不支持');
      if (logo.length > 300000) throw new HttpError(400, '图标太大了');
    } else {
      logo = [...logo].slice(0, 4).join('');
    }
    setSetting('logo', logo);
  }
  if ('search' in b) {
    const search = str(b.search, 300);
    if (!/^https?:\/\/.+%s/.test(search)) throw new HttpError(400, '搜索引擎地址需以 http(s):// 开头并包含 %s');
    setSetting('search', search);
  }
  // 智能体接入：令牌只在生成时返回一次，库里只存它的哈希
  let token;
  if (b.agent_action === 'generate') {
    token = 'nav_' + crypto.randomBytes(24).toString('base64url');
    setSetting('agent_hash', crypto.createHash('sha256').update(token).digest('hex'));
  } else if (b.agent_action === 'revoke') {
    setSetting('agent_hash', '');
  }
  if ('agent_private' in b) setSetting('agent_private', !!b.agent_private);
  if ('agent_webhook' in b) {
    const hook = str(b.agent_webhook, 500);
    if (hook) cleanUrl(hook);
    setSetting('agent_webhook', hook);
  }
  res.json({ ok: true, ...(token && { token }) });
});

// ---------- 服务器设置（端口、监听地址、反向代理等） ----------
let server;
const listen = (port, host) =>
  new Promise((resolve, reject) => {
    const s = app.listen(port, host);
    s.once('listening', () => resolve(s));
    s.once('error', reject);
  });

api.put('/server', requireAuth, passwordLimiter, async (req, res) => {
  const b = req.body;
  if (!checkPassword(b.current_password)) throw new HttpError(401, '管理密码不正确');
  const old = serverConfig();
  const next = { ...old };
  // 由环境变量指定的项以环境变量为准，网页里改不了
  if ('port' in b && !envConfig.port) {
    next.port = Number(b.port);
    if (!Number.isInteger(next.port) || next.port < 1 || next.port > 65535) throw new HttpError(400, '端口号需要在 1 ~ 65535 之间');
  }
  if ('host' in b && !envConfig.host) {
    next.host = str(b.host, 60);
    if (!ipaddr.isValid(next.host)) throw new HttpError(400, '监听地址需要是一个 IP，例如 0.0.0.0 或 127.0.0.1');
  }
  if ('session_days' in b) {
    const days = Math.round(Number(b.session_days));
    if (!(days >= 1 && days <= 365)) throw new HttpError(400, '登录有效期需要在 1 ~ 365 天之间');
    setSetting('session_days', days);
  }
  if ('public_url' in b) {
    const url = str(b.public_url, 300);
    setSetting('public_url', url ? cleanUrl(url).replace(/\/+$/, '') : '');
  }
  if ('trust_proxy' in b && envConfig.trustProxy === undefined) {
    const value = str(b.trust_proxy, 100);
    try {
      applyTrustProxy(value);
    } catch {
      applyTrustProxy(old.trustProxy);
      throw new HttpError(400, '反向代理设置无法识别，可以填层数（如 1）、loopback，或代理服务器的 IP / 网段');
    }
    setSetting('trust_proxy', value);
  }

  if (next.port !== old.port) {
    // 换端口：先在新端口上监听成功，再保存并关掉旧的。失败的话什么都不变，把原因告诉用户
    let fresh;
    try {
      fresh = await listen(next.port, next.host);
    } catch (e) {
      const reason = { EADDRINUSE: '已被其他程序占用', EACCES: '没有权限使用（1024 以下的端口通常需要管理员权限）' }[e.code] || `无法监听（${e.code}）`;
      throw new HttpError(400, `端口 ${next.port} ${reason}`);
    }
    const previous = server;
    server = fresh;
    setSetting('port', next.port);
    setSetting('host', next.host);
    console.log(`监听地址已改为 ${next.host}:${next.port}`);
    res.json({ ok: true, moved: true, port: next.port });
    setTimeout(() => {
      previous.close();
      previous.closeAllConnections();
    }, 500);
    return;
  }
  if (next.host !== old.host) {
    // 只换监听地址：同一个端口没法先试，只能先关再开，开不起来就退回原来的
    setSetting('host', next.host);
    res.json({ ok: true, moved: true, port: next.port });
    setTimeout(async () => {
      const previous = server;
      previous.closeAllConnections();
      await new Promise((done) => previous.close(done));
      try {
        server = await listen(next.port, next.host);
        console.log(`监听地址已改为 ${next.host}:${next.port}`);
      } catch (e) {
        console.error(`无法监听 ${next.host}:${next.port}（${e.code}），已退回 ${old.host}`);
        setSetting('host', old.host);
        server = await listen(old.port, old.host);
      }
    }, 500);
    return;
  }
  res.json({ ok: true });
});

api.use((req, res) => res.status(404).json({ error: '接口不存在' }));

app.use((err, req, res, next) => {
  const status = err.status || err.statusCode || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: status >= 500 ? '服务器出错了' : err.message });
});

const { port, host } = serverConfig();
try {
  server = await listen(port, host);
  console.log(`网址导航已启动：http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`);
  if (!isSetup()) console.log('首次使用：请打开页面设置管理密码');
} catch (e) {
  console.error(`启动失败：无法监听 ${host}:${port}（${e.code}）。可以用环境变量临时换一个端口，例如 PORT=3081 npm start`);
  process.exit(1);
}
