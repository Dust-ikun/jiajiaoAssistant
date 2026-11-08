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
import { COMMUTE_ENGINE_VERSION } from './commute/types.ts';

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
      `INSERT INTO raw_messages (id, group_name, raw_text, content_hash, imported_at)
       VALUES (1, '广州家教群YF11群', '老消息', 'hash-old', '2026-10-01T10:00:00Z')`,
    )
    .run();
  // 剪贴板自动入库时代留下的痕迹：group_name 是字面量「剪贴板」，不是真群名
  legacy
    .prepare(
      `INSERT INTO raw_messages (id, group_name, raw_text, content_hash, source, imported_at)
       VALUES (2, '剪贴板', '剪贴板来的消息', 'hash-clip', 'clipboard', '2026-10-20T10:00:00Z')`,
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
  check('补出通勤口径版本列', columns.has('commute_engine'), true);

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
    // 2026-11-07 决策：没解析到时间头就用入库时间补，不留空（否则界面永远显示「时间未知」）
    check('旧单没有发送时间就用入库时间补上', row.sentAt, '2026-10-01T10:00:00Z');
    check('旧单没有分档薪水就是空数组', row.salaryTiers, []);
    check('出现次数没被重置', row.occurrences, 3);
    check('旧单没算过通勤就是 null（不是 failed，更不是 0）', [row.commuteStatus, row.commuteMinutes], [null, null]);
  }

  console.log('\n[2.5] 「剪贴板」这个假群名被清掉（2026-11-08 移除自动入库）');
  {
    const msg = (hash: string) =>
      db.getDb().prepare('SELECT group_name, source FROM raw_messages WHERE content_hash = ?').get(hash) as {
        group_name: string | null;
        source: string;
      };
    check('假群名置空（卡片会显示「群未填」，语义诚实）', msg('hash-clip').group_name, null);
    check('来源通道没丢（source 仍是 clipboard）', msg('hash-clip').source, 'clipboard');
    check('真实群名一个都不动', msg('hash-old').group_name, '广州家教群YF11群');
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

  console.log('\n[5] 旧通勤结论：建在「区县/乡镇」级坐标上的全部作废重算（2026-11-08）');
  {
    // geo_cache 是 cache.ts 建的表，必须等它加载过才能插旧数据
    const cache = await import('./commute/cache.ts');

    db.importMessage({
      text: `家教编号: GZa2164A
学员地址: 佛山市南海区桂城街道堑坊村
辅导科目: 英语
时间安排: 每周1次，每次2小时
教员要求: 男女不限
老师薪水: 65元/h`,
      sentAt: '2026-11-07T10:00:00',
    });
    db.importMessage({
      text: `家教编号: 2026110701
学员地址: 海珠昌岗
辅导科目: 数学
时间安排: 每周1次
教员要求: 男女不限
老师薪水: 100元/h`,
      sentAt: '2026-11-07T10:00:00',
    });

    const f = db.listOrders({ q: 'GZa2164A' })[0]!;
    const g = db.listOrders({ q: '2026110701' })[0]!;
    // 造出「旧口径算出来的数」：有结论、没有版本号（等同于升级前的库）
    db.updateOrderCommute(f.id, { status: 'ok', minutes: 24, fare: 2, originId: 1, address: f.address });
    db.updateOrderCommute(g.id, { status: 'ok', minutes: 26, fare: 2, originId: 1, address: g.address });

    // 旧库的 geo_cache 行：键是纯地址（没有「城市|」前缀）
    const insertGeo = db.getDb().prepare(
      `INSERT OR REPLACE INTO geo_cache (address_key, address, ok, lng, lat, formatted, level, error, fetched_at)
       VALUES (?, ?, 1, ?, ?, ?, ?, NULL, ?)`,
    );
    // 佛山那条：被旧的「写死广州」坑过，只匹配到区县
    insertGeo.run(cache.normalizeAddress(f.address!), f.address, 113.4806, 23.1814, '广东省广州市黄埔区', '区县', '2026-11-07T15:00:00.000Z');
    // 广州那条：当初就匹配到住宅区，坐标可信
    insertGeo.run(cache.normalizeAddress(g.address!), g.address, 113.2759, 23.0898, '广东省广州市海珠区昌岗', '住宅区', '2026-11-07T15:00:00.000Z');
    check('前提：两条旧结论都在', [db.getOrder(f.id)!.commuteMinutes, db.getOrder(g.id)!.commuteMinutes], [24, 26]);

    cache.migrateCommuteEngineOnce();

    check(
      '坐标只到区县的旧结论被清空（那个 24 分钟不许再出现）',
      [db.getOrder(f.id)!.commuteStatus, db.getOrder(f.id)!.commuteMinutes],
      [null, null],
    );
    check('坐标够细的旧结论保留（不必白烧配额）', db.getOrder(g.id)!.commuteMinutes, 26);
    check('保留的那条打上新口径版本', db.getOrder(g.id)!.commuteEngine, COMMUTE_ENGINE_VERSION);
    cache.migrateCommuteEngineOnce();
    check('重复执行是幂等的', [db.getOrder(f.id)!.commuteStatus, db.getOrder(g.id)!.commuteMinutes], [null, 26]);
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
