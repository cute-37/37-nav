import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const DATA_DIR = path.resolve(process.env.DATA_DIR || 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

export const db = new DatabaseSync(path.join(DATA_DIR, 'nav.db'));
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS categories (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    private INTEGER NOT NULL DEFAULT 0,
    sort INTEGER NOT NULL DEFAULT 0,
    parent_id INTEGER REFERENCES categories(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS links (
    id INTEGER PRIMARY KEY,
    title TEXT NOT NULL,
    url TEXT NOT NULL,
    desc TEXT NOT NULL DEFAULT '',
    tags TEXT NOT NULL DEFAULT '',
    private INTEGER NOT NULL DEFAULT 0,
    pinned INTEGER NOT NULL DEFAULT 0,
    sort INTEGER NOT NULL DEFAULT 0,
    clicks INTEGER NOT NULL DEFAULT 0,
    last_visit INTEGER,
    secret TEXT,
    created_at INTEGER NOT NULL
  );
  -- 一个网址可以属于多个分类；sort 是它在该分类里的位置（未分类的网址用 links.sort）
  CREATE TABLE IF NOT EXISTS link_cats (
    link_id INTEGER NOT NULL REFERENCES links(id) ON DELETE CASCADE,
    category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
    sort INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (link_id, category_id)
  );
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`);

// 分类可以嵌套（最多三层）。旧库的分类表没有 parent_id，而且名称是全局唯一的；
// 现在只要求「同一个上级下面不重名」。SQLite 去不掉列上的 UNIQUE，只能重建这张表。
if (!db.prepare('PRAGMA table_info(categories)').all().some((col) => col.name === 'parent_id')) {
  db.exec(`
    PRAGMA foreign_keys = OFF;
    BEGIN;
    CREATE TABLE categories_new (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      private INTEGER NOT NULL DEFAULT 0,
      sort INTEGER NOT NULL DEFAULT 0,
      parent_id INTEGER REFERENCES categories(id) ON DELETE CASCADE
    );
    INSERT INTO categories_new (id, name, private, sort) SELECT id, REPLACE(name, '/', '／'), private, sort FROM categories;
    DROP TABLE categories;
    ALTER TABLE categories_new RENAME TO categories;
    COMMIT;
    PRAGMA foreign_keys = ON;
  `);
}
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS categories_sibling_name ON categories (COALESCE(parent_id, 0), name)');

// 旧版每个网址只有一个 category_id，迁移到 link_cats 后清空旧列，保证只迁一次
if (db.prepare('PRAGMA table_info(links)').all().some((col) => col.name === 'category_id')) {
  db.exec(`
    INSERT OR IGNORE INTO link_cats (link_id, category_id, sort)
      SELECT id, category_id, sort FROM links WHERE category_id IS NOT NULL;
    UPDATE links SET category_id = NULL WHERE category_id IS NOT NULL;
  `);
}

// 网址详情（简介、功能、笔记、相关链接）是后加的列
if (!db.prepare('PRAGMA table_info(links)').all().some((col) => col.name === 'detail')) {
  db.exec('ALTER TABLE links ADD COLUMN detail TEXT');
}

// 网站图标：links.icon 是用户手动上传的；icons 表缓存服务器自动抓到的（按网站来源存一份）
if (!db.prepare('PRAGMA table_info(links)').all().some((col) => col.name === 'icon')) {
  db.exec('ALTER TABLE links ADD COLUMN icon TEXT');
}
// 分类也可以标 NSFW，下面各级子分类和其中的网址都算 NSFW
if (!db.prepare('PRAGMA table_info(categories)').all().some((col) => col.name === 'nsfw')) {
  db.exec('ALTER TABLE categories ADD COLUMN nsfw INTEGER NOT NULL DEFAULT 0');
}
// NSFW 标记：工作模式下这些网址一律不显示（不管是不是管理员）
if (!db.prepare('PRAGMA table_info(links)').all().some((col) => col.name === 'nsfw')) {
  db.exec('ALTER TABLE links ADD COLUMN nsfw INTEGER NOT NULL DEFAULT 0');
}
db.exec(`
  CREATE TABLE IF NOT EXISTS icon_choices (origin TEXT PRIMARY KEY, data TEXT NOT NULL, fetched_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS icons (
    origin TEXT PRIMARY KEY,
    type TEXT,
    data BLOB,
    ok INTEGER NOT NULL,
    fetched_at INTEGER NOT NULL
  );
`);

export function tx(fn) {
  db.exec('BEGIN');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

const getStmt = db.prepare('SELECT value FROM settings WHERE key = ?');
const setStmt = db.prepare(
  'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
);
export const getSetting = (key, fallback = null) => {
  const row = getStmt.get(key);
  return row ? JSON.parse(row.value) : fallback;
};
export const setSetting = (key, value) => setStmt.run(key, JSON.stringify(value));

// 主密钥：用于加密账号信息和签名会话 Cookie。和数据库分开存放，单独泄露数据库文件时账号信息仍不可读。
const keyFile = path.join(DATA_DIR, 'secret.key');
if (!fs.existsSync(keyFile)) fs.writeFileSync(keyFile, crypto.randomBytes(32), { mode: 0o600 });
const masterKey = fs.readFileSync(keyFile);
export const cookieKey = crypto.createHmac('sha256', masterKey).update('cookie').digest('hex');

export function encrypt(obj) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', masterKey, iv);
  const ct = Buffer.concat([cipher.update(JSON.stringify(obj), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]).toString('base64');
}

export function decrypt(text) {
  const buf = Buffer.from(text, 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', masterKey, buf.subarray(0, 12));
  decipher.setAuthTag(buf.subarray(12, 28));
  return JSON.parse(Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString('utf8'));
}
