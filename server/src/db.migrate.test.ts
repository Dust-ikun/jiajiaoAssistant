/**
 * 老库迁移回归。
 *
 * 这是最容易被忽略的一类 bug：新装用户一切正常，老用户一导入就 `no such column`。
 * 所以这里先造一个**旧版**的 orders 表（没有 status_tag / sent_at / salary_tiers），
 * 再让 db.ts 启动，验证它能自己把列补上、并且旧数据一行不丢。
 *
 * 运行：npm -w server run test
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

let failed = 0;
let passed = 0;

function check(name: string, actual: unknown, expect: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expect);
  if (ok) {
    passed++;
    return;
  }
  failed++;
  console.log(`  ✗ ${name}\n      期望: ${JSON.stringify(expect)}\n      实际: ${JSON.stringify(actual)}`);
}

/** 旧版 schema：字段与阶段 3 之前的 db.ts 一致 */
const OLD_SCHEMA = `
CREATE TABLE raw_messages (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  group_name    TEXT,
  sender        TEXT,
  sent_at       TEXT,
  raw_text      TEXT NOT NULL,
  content_hash  TEXT NOT NULL UNIQUE,
  source        TEXT NOT NULL DEFAULT 'manual',
  imported_at   TEXT NOT NULL
);

CREATE TABLE orders (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  dedupe_key       TEXT NOT NULL UNIQUE,
  raw_msg_id       INTEGER NOT NULL,
  block_index      INTEGER NOT NULL DEFAULT 0,
  order_no         TEXT,
  district         TEXT,
  area             TEXT,
  address          TEXT,
  stage            TEXT,
  grade_num        INTEGER,
  grade_text       TEXT,
  student_count    INTEGER,
  student_gender   TEXT,
  mode             TEXT,
  subjects         TEXT,
  subject_tags     TEXT,
  freq_per_week    REAL,
  hours_per_session REAL,
  schedule         TEXT,
  salary_raw       TEXT,
  salary_min       REAL,
  salary_max       REAL,
  salary_unit      TEXT,
  salary_hourly    REAL,
  teacher_req      TEXT,
  notes            TEXT,
  raw_text         TEXT NOT NULL,
  confidence       TEXT NOT NULL DEFAULT 'high',
  warnings         TEXT,
  status           TEXT NOT NULL DEFAULT 'new',
  starred          INTEGER NOT NULL DEFAULT 0,
  remark           TEXT,
  first_seen       TEXT NOT NULL,
  last_seen        TEXT NOT NULL,
  occurrences      INTEGER NOT NULL DEFAULT 1
);
`;

const dir = mkdtempSync(join(tmpdir(), 'jiajiao-migrate-'));
const file = join(dir, 'jiajiao.db');

try {
  // 造一个「老用户」的库：旧表结构 + 一条已经在用的单子
  const legacy = new DatabaseSync(file);
  legacy.exec(OLD_SCHEMA);
  legacy
    .prepare(
      `INSERT INTO raw_messages (id, raw_text, content_hash, imported_at) VALUES (1, '老消息', 'hash-old', '2026-10-01T10:00:00Z')`,
    )
    .run();
  legacy
    .prepare(
      `INSERT INTO orders (dedupe_key, raw_msg_id, order_no, address, raw_text, status, starred, remark,
                            first_seen, last_seen, occurrences)
       VALUES ('no:LEGACY', 1, 'LEGACY', '广州番禺桥南', '老库里的单子', 'contacted', 1, '老备注',
               '2026-10-01T10:00:00Z', '2026-10-01T10:00:00Z', 3)`,
    )
    .run();
  legacy.close();

  console.log('\n[1] 旧库启动后自动补列');
  process.env.JIAJIAO_DATA = dir;
  const db = await import('./db.ts');

  const probe = new DatabaseSync(file);
  const columns = new Set(
    (probe.prepare('PRAGMA table_info(orders)').all() as { name: string }[]).map((r) => r.name),
  );
  probe.close();
  check('补出 status_tag', columns.has('status_tag'), true);
  check('补出 sent_at', columns.has('sent_at'), true);
  check('补出 salary_tiers', columns.has('salary_tiers'), true);
  check('补出阶段 5 的 commute_status', columns.has('commute_status'), true);
  check('补出阶段 5 的 commute_minutes', columns.has('commute_minutes'), true);
  check('补出阶段 5 的 commute_cache_key', columns.has('commute_cache_key'), true);

  const originCols = new DatabaseSync(file);
  const originNames = (originCols.prepare('PRAGMA table_info(origins)').all() as { name: string }[]).map((r) => r.name);
  originCols.close();
  check('老库也会建出 origins 表', originNames.includes('is_default'), true);

  console.log('\n[2] 旧数据一行不丢、一个字段不改');
  {
    const row = db.listOrders({ q: 'LEGACY' })[0]!;
    check('旧单还在', row.orderNo, 'LEGACY');
    check('手改的 status 还在', row.status, 'contacted');
    check('手改的 starred 还在', row.starred, true);
    check('手改的 remark 还在', row.remark, '老备注');
    check('旧单没有发送时间就是 null（不编造）', row.sentAt, null);
    check('旧单没有分档薪水就是空数组', row.salaryTiers, []);
    check('出现次数没被重置', row.occurrences, 3);
    check('旧单没算过通勤就是 null（不是 failed，更不是 0）', [row.commuteStatus, row.commuteMinutes], [null, null]);
  }

  console.log('\n[3] 迁移后新导入能写进新列');
  {
    const text = `家教编号: 2026110599
学员地址: 广州番禺桥南
辅导科目: 英语
时间安排: 每周1次，每次2小时
教员要求: 男女不限
老师薪水: 100元/h`;
    const res = db.importMessage({ text, sentAt: '2026-11-05T09:00:00' });
    check('新增 1 单', [res.inserted, res.orders], [1, 1]);
    const row = db.listOrders({ q: '2026110599' })[0]!;
    check('发送时间落库', row.sentAt, '2026-11-05T09:00:00');
    check('分档薪水落库', row.salaryTiers, [{ label: null, min: 100, max: 100, unit: 'hour' }]);
    check('旧单仍在', db.listOrders({ q: 'LEGACY' }).length, 1);
  }

  console.log('\n[4] migrateColumns 可重复执行（每次启动都会跑）');
  {
    const mem = new DatabaseSync(':memory:');
    mem.exec(OLD_SCHEMA);
    const cols = { status_tag: 'TEXT', sent_at: 'TEXT', salary_tiers: 'TEXT' };
    db.migrateColumns(mem, 'orders', cols);
    let threw = false;
    try {
      db.migrateColumns(mem, 'orders', cols);
    } catch {
      threw = true;
    }
    const names = (mem.prepare('PRAGMA table_info(orders)').all() as { name: string }[]).map((r) => r.name);
    check('第二次执行不报错（重复 ALTER 会炸）', threw, false);
    check('列只加一次', names.filter((n) => n === 'sent_at').length, 1);
    mem.close();
  }
} finally {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* Windows 上连接没关时删不掉，忽略 */
  }
}

console.log(failed === 0 ? `\n全部通过 ✓（${passed} 项）\n` : `\n${failed} 项未通过 ✗（通过 ${passed} 项）\n`);
process.exit(failed === 0 ? 0 : 1);
