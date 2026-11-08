import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseMessage, type ParsedOrder } from './parser/parse.ts';

const here = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.JIAJIAO_DATA ?? resolve(here, '../../data');
mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(resolve(DATA_DIR, 'jiajiao.db'));

db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS raw_messages (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  group_name    TEXT,
  sender        TEXT,
  sent_at       TEXT,
  raw_text      TEXT NOT NULL,
  content_hash  TEXT NOT NULL UNIQUE,
  source        TEXT NOT NULL DEFAULT 'manual',
  imported_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS orders (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  dedupe_key       TEXT NOT NULL UNIQUE,
  raw_msg_id       INTEGER NOT NULL,
  block_index      INTEGER NOT NULL DEFAULT 0,
  order_no         TEXT,
  status_tag       TEXT,
  sent_at          TEXT,
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
  salary_tiers     TEXT,
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
  occurrences      INTEGER NOT NULL DEFAULT 1,
  -- 通勤结果（阶段 5）。算出来的数落库，列表排序才能用 SQL 做；
  -- commute_cache_key 留着，详情面板据此把 4 套方案原样取回来，不必重算
  commute_status     TEXT,
  commute_minutes    REAL,
  commute_distance   INTEGER,
  commute_transfers  INTEGER,
  commute_fare       REAL,
  commute_origin_id  INTEGER,
  commute_address    TEXT,
  commute_cache_key  TEXT,
  commute_checked_at TEXT,
  commute_error      TEXT
);

CREATE INDEX IF NOT EXISTS idx_orders_hourly   ON orders(salary_hourly DESC);
CREATE INDEX IF NOT EXISTS idx_orders_seen     ON orders(last_seen DESC);
CREATE INDEX IF NOT EXISTS idx_orders_district ON orders(district);
CREATE INDEX IF NOT EXISTS idx_orders_status   ON orders(status);
-- 注意：idx_orders_commute 不在这里建。老库此刻还没有 commute_minutes 列，
-- 在这儿建索引会直接 no such column 把启动打挂 —— 必须等 migrateColumns 补完列再建（见文件下方）

-- 出发点：独立成表（决策 7），支持多个、可设默认。
-- 【为什么不写在 profile.json 里】资质是「我是谁」，出发地是「我从哪走」；
-- 而且通勤缓存键用的是坐标，把出发地放业务表才能顺手存下地理编码结果，省一次调用。
CREATE TABLE IF NOT EXISTS origins (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  address    TEXT NOT NULL,
  lng        REAL,
  lat        REAL,
  is_default INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
`);

/**
 * 老库补列。
 *
 * 【为什么必须有这一步】`CREATE TABLE IF NOT EXISTS` 对已存在的表是**空操作**：
 * 老用户机器上的 `orders` 表不会因为上面多写了 `sent_at` 就多出这一列，
 * 于是下一次 INSERT 才会报 `no such column` —— 而且只在他们机器上炸。
 * 所以每次启动都拿 `PRAGMA table_info` 逐列对一遍，缺什么补什么。
 */
const ADDED_ORDERS_COLUMNS: Record<string, string> = {
  status_tag: 'TEXT',
  sent_at: 'TEXT',
  salary_tiers: 'TEXT',
  // 阶段 5 新增的通勤列：已经有库的用户同样要补上，否则第一次算通勤就 no such column
  commute_status: 'TEXT',
  commute_minutes: 'REAL',
  commute_distance: 'INTEGER',
  commute_transfers: 'INTEGER',
  commute_fare: 'REAL',
  commute_origin_id: 'INTEGER',
  commute_address: 'TEXT',
  commute_cache_key: 'TEXT',
  commute_checked_at: 'TEXT',
  commute_error: 'TEXT',
};

export function migrateColumns(conn: DatabaseSync, table: string, columns: Record<string, string>) {
  const existing = new Set(
    (conn.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((r) => r.name),
  );
  for (const [name, type] of Object.entries(columns)) {
    if (!existing.has(name)) conn.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
  }
}

migrateColumns(db, 'orders', ADDED_ORDERS_COLUMNS);

// 补完列才能建索引：老库走到这一步之前 orders 里根本没有 commute_minutes
db.exec('CREATE INDEX IF NOT EXISTS idx_orders_commute ON orders(commute_minutes)');

/**
 * 老库回填：2026-11-07 之前，sent_at 只认文本里的时间头，绝大多数是 NULL。
 * 既然新语义是「没时间头就记导入时间」，老数据也该按同一规则补齐 ——
 * 否则改完代码，界面上那一百多单还是「发送时间未知」，看起来像没修。
 * 幂等：只碰 NULL，已经有真实发送时间的不动。
 */
db.exec(`
  UPDATE orders SET sent_at = first_seen WHERE sent_at IS NULL;
  UPDATE raw_messages SET sent_at = imported_at WHERE sent_at IS NULL;
`);

/**
 * 把连接交给同进程的其他持久化模块（通勤缓存 / 配额计数）。
 * 【为什么不是各自再 open 一次】SQLite 允许，但两个连接各自持 WAL 锁更容易撞 SQLITE_BUSY；
 * 单进程单连接最简单。
 */
export function getDb(): DatabaseSync {
  return db;
}

const now = () => new Date().toISOString();

export interface ImportInput {
  text: string;
  groupName?: string | null;
  sender?: string | null;
  sentAt?: string | null;
  source?: string;
}

/** 单条单子的体检结果：缺什么、置信度、切块来自哪种锚点 */
export interface OrderDiagnostic {
  orderNo: string | null;
  anchorKind: string | null;
  confidence: string;
  warnings: string[];
  missingFields: string[];
  sentAt: string | null;
}

export interface ImportDiagnostics {
  lines: number;
  anchors: { kind: string; count: number }[];
  orders: OrderDiagnostic[];
  nonOrder: boolean;
}

export interface ImportResult {
  orders: number;
  inserted: number;
  /** 命中已有单子、走了增量补全的条数 */
  duplicated: number;
  nonOrderText: boolean;
  diagnostics: ImportDiagnostics;
}

function diagnoseOrder(o: ParsedOrder, sentAt: string | null): OrderDiagnostic {
  const missingFields: string[] = [];
  if (!o.address) missingFields.push('地址');
  if (!o.salaryRaw) missingFields.push('薪水');
  if (!o.schedule) missingFields.push('时间');
  if (!o.subjects.length) missingFields.push('科目');
  if (!o.teacherReq) missingFields.push('要求');
  if (!sentAt) missingFields.push('发送时间');
  return {
    orderNo: o.orderNo,
    anchorKind: o.anchorKind,
    confidence: o.confidence,
    warnings: o.warnings,
    missingFields,
    sentAt,
  };
}

function buildDiagnostics(parsed: ParsedOrder[], fallbackSentAt: string | null, lines: number): ImportDiagnostics {
  const counts = new Map<string, number>();
  for (const o of parsed) {
    const kind = o.anchorKind ?? 'none';
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  return {
    lines,
    anchors: [...counts.entries()].map(([kind, count]) => ({ kind, count })),
    orders: parsed.map((o) => diagnoseOrder(o, o.sentAt ?? fallbackSentAt)),
    nonOrder: parsed.length === 0,
  };
}

/**
 * 增量补全的字段表。
 *
 * 【为什么要分三类】用户 Ctrl+A 只能选中一小块、会分多次复制同一单：
 * 第一次可能只有地址，第二次补上薪资。合并时必须「新的空值不覆盖旧的实值」，
 * 但「用户手改的 status / starred / remark」一个字都不能动 —— 那属于人的判断，不是解析结果。
 */
const UPSERT_TEXT_COLUMNS = [
  'order_no', 'status_tag', 'district', 'area', 'address', 'stage', 'grade_text',
  'student_gender', 'mode', 'schedule', 'salary_raw', 'salary_unit', 'teacher_req', 'notes',
];

const UPSERT_NUM_COLUMNS = [
  'grade_num', 'student_count', 'freq_per_week', 'hours_per_session',
  'salary_min', 'salary_max', 'salary_hourly',
];

/** JSON 数组列的「空」是 []，不是 ''，COALESCE(NULLIF(x,'')) 会把 [] 当成有值 */
function mergeJson(column: string): string {
  return `${column} = CASE WHEN excluded.${column} IN ('', '[]') THEN orders.${column} ELSE excluded.${column} END`;
}

const INSERT_COLUMNS = [
  'dedupe_key', 'raw_msg_id', 'block_index', 'order_no', 'status_tag', 'sent_at',
  'district', 'area', 'address', 'stage', 'grade_num', 'grade_text',
  'student_count', 'student_gender', 'mode', 'subjects', 'subject_tags',
  'freq_per_week', 'hours_per_session', 'schedule',
  'salary_raw', 'salary_min', 'salary_max', 'salary_unit', 'salary_hourly', 'salary_tiers',
  'teacher_req', 'notes', 'raw_text', 'confidence', 'warnings', 'first_seen', 'last_seen',
];

const UPSERT_SQL = `
  INSERT INTO orders (${INSERT_COLUMNS.join(', ')})
  VALUES (${INSERT_COLUMNS.map(() => '?').join(',')})
  ON CONFLICT(dedupe_key) DO UPDATE SET
    ${UPSERT_TEXT_COLUMNS.map((c) => `${c} = COALESCE(NULLIF(orders.${c}, ''), excluded.${c})`).join(',\n    ')},
    ${mergeJson('subjects')},
    ${mergeJson('subject_tags')},
    ${mergeJson('salary_tiers')},
    ${UPSERT_NUM_COLUMNS.map((c) => `${c} = COALESCE(orders.${c}, excluded.${c})`).join(',\n    ')},
    sent_at = CASE
      WHEN orders.sent_at IS NULL THEN excluded.sent_at
      WHEN excluded.sent_at IS NULL THEN orders.sent_at
      WHEN excluded.sent_at < orders.sent_at THEN excluded.sent_at
      ELSE orders.sent_at END,
    raw_text = CASE
      WHEN length(excluded.raw_text) > length(orders.raw_text) THEN excluded.raw_text
      ELSE orders.raw_text END,
    confidence = CASE
      WHEN excluded.confidence = 'high' THEN 'high'
      WHEN excluded.confidence = 'medium' AND orders.confidence = 'low' THEN 'medium'
      ELSE orders.confidence END,
    warnings = CASE
      WHEN length(excluded.warnings) < length(orders.warnings) THEN excluded.warnings
      ELSE orders.warnings END,
    occurrences = orders.occurrences + 1,
    last_seen   = excluded.last_seen
`;

/* ------------------------------------------------------------------ *
 * 同号不同单
 * ------------------------------------------------------------------ */

/** 用来判断「这两段文字说的是不是同一张单子」的三个字段 */
interface OrderFingerprint {
  address: string | null;
  subjects: string[];
  stage: string | null;
}

function fingerprintOfRow(row: Record<string, unknown>): OrderFingerprint {
  return {
    address: (row.address as string) ?? null,
    subjects: JSON.parse((row.subjects as string) || '[]') as string[],
    stage: (row.stage as string) ?? null,
  };
}

function fingerprintOfOrder(o: ParsedOrder): OrderFingerprint {
  return { address: o.address, subjects: o.subjects, stage: o.stage };
}

/**
 * 判断两段文字是不是**不同的**单子（同号不等于同单）。
 *
 * 【为什么要这一层】不同群的编号体系各自独立，撞号很常见 —— 现场就撞过一次：
 * `ZX2208` 在一个群是「小学 数学 奥数 120/h」，在另一个群是「中五 DSE物理 300-360/2h」。
 * 按 `no:<编号>` 无条件合并，结果是两张单子被缝成一张：科目留着旧的、地址被新的覆盖，
 * 界面上只表现为「标签好像不对」，谁也不会想到是两条记录被并了。
 *
 * 判冲突取**保守**规则，宁可多留一条，也不要把两单的字段搅在一起：
 * 地址两边都有且互不包含 / 科目两边都有且毫无交集 / 学段两边都有且不同。
 * 只要有一边是空的就不算冲突 —— 分次复制本来就常常只复制到一半（决策 9）。
 */
function conflicts(a: OrderFingerprint, b: OrderFingerprint): boolean {
  if (a.address && b.address) {
    const x = a.address.replace(/\s/g, '');
    const y = b.address.replace(/\s/g, '');
    if (!x.includes(y) && !y.includes(x)) return true;
  }
  if (a.subjects.length && b.subjects.length && !a.subjects.some((s) => b.subjects.includes(s))) {
    return true;
  }
  if (a.stage && b.stage && a.stage !== b.stage) return true;
  return false;
}

/**
 * 真去重键：撞号且内容对不上时另起一条。
 * 变体键里带地址指纹 —— 同一张单子下次再被转发，还会落回自己那一条，不会越滚越多。
 */
function dedupeKeyFor(o: ParsedOrder): string {
  if (!o.dedupeKey.startsWith('no:')) return o.dedupeKey;
  const row = db.prepare('SELECT address, subjects, stage FROM orders WHERE dedupe_key = ?').get(o.dedupeKey) as
    | Record<string, unknown>
    | undefined;
  if (!row || !conflicts(fingerprintOfRow(row), fingerprintOfOrder(o))) return o.dedupeKey;
  const fp = createHash('sha1').update(`${o.address ?? ''}|${o.subjects.join(',')}`).digest('hex').slice(0, 8);
  return `${o.dedupeKey}|${fp}`;
}

/**
 * 给一批解析结果算去重键：还要防止**同一段文本里**出现两张同号不同单
 * （库里此时只有前一块，后一块查不到冲突，会一块把另一块覆盖掉）。
 */
function assignDedupeKeys(parsed: ParsedOrder[]): string[] {
  const batch = new Map<string, OrderFingerprint>();
  return parsed.map((o) => {
    let key = dedupeKeyFor(o);
    const prev = batch.get(key);
    if (prev && conflicts(prev, fingerprintOfOrder(o))) key = `${key}|b${batch.size}`;
    batch.set(key, fingerprintOfOrder(o));
    return key;
  });
}

/**
 * 导入一条（或一段）群消息。
 * 同一条消息重复导入会被 content_hash 拦掉；同一单子被不同群转发、或分多次复制，
 * 会按 dedupe_key 走增量补全。
 */
export function importMessage(input: ImportInput): ImportResult {
  const text = input.text.trim();
  const lines = text ? text.split('\n').length : 0;
  if (!text) {
    return { orders: 0, inserted: 0, duplicated: 0, nonOrderText: true, diagnostics: buildDiagnostics([], null, 0) };
  }

  const contentHash = createHash('sha1').update(text.replace(/\s+/g, '')).digest('hex');
  const existed = db.prepare('SELECT id FROM raw_messages WHERE content_hash = ?').get(contentHash) as
    | { id: number }
    | undefined;

  if (existed) {
    const ts = now();
    const sentAt = input.sentAt ?? null;
    // 同一条原文再导入一次：刷新发生次数，顺手补上当初缺失的发送时间
    db.prepare('UPDATE raw_messages SET sent_at = COALESCE(sent_at, ?) WHERE id = ?').run(sentAt, existed.id);

    // 【为什么按 dedupe_key 找行而不是按 raw_msg_id】同一条原文第一次导入时，
    // 单子可能已经由另一段（更早复制的）原文先建好了，那行的 raw_msg_id 指向的是旧消息，
    // 按 raw_msg_id 更新会一行都匹配不到，次数也不会涨。
    const again = parseMessage(text, sentAt);
    const keys = assignDedupeKeys(again);
    if (keys.length) {
      const holders = keys.map(() => '?').join(',');
      db.prepare(
        `UPDATE orders SET occurrences = occurrences + 1, last_seen = ?, sent_at = COALESCE(sent_at, ?)
         WHERE dedupe_key IN (${holders})`,
      ).run(ts, sentAt, ...keys);
    }
    return {
      orders: keys.length,
      inserted: 0,
      duplicated: keys.length,
      nonOrderText: false,
      diagnostics: buildDiagnostics(again, sentAt, lines),
    };
  }

  const parsed = parseMessage(text, input.sentAt ?? null);
  if (!parsed.length) {
    return { orders: 0, inserted: 0, duplicated: 0, nonOrderText: true, diagnostics: buildDiagnostics([], null, lines) };
  }

  const ts = now();
  /**
   * 【为什么空着的时候退到 ts（导入时间）】微信里复制出来的文本**绝大多数不带时间头**，
   * 原来这里 `?? null` 的结果是：绝大多数单子的 sent_at 是空的 —— 卡片上永远显示
   * 「发送时间未知」，时效这一列等于没有，`sort=newest` 也只能把它们全排到最后。
   *
   * 现在的语义：原文写了时间头就用它（那确实是真的发送时间，比导入时间准）；
   * 没写才落到导入时间。两个来源都明确可知，不做任何猜测。
   */
  const msgSentAt = input.sentAt ?? parsed[0]?.sentAt ?? ts;
  const msgRow = db
    .prepare(
      `INSERT INTO raw_messages (group_name, sender, sent_at, raw_text, content_hash, source, imported_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(input.groupName ?? null, input.sender ?? null, msgSentAt, text, contentHash, input.source ?? 'manual', ts);

  const rawMsgId = Number(msgRow.lastInsertRowid);

  const insert = db.prepare(UPSERT_SQL);
  const findDedupe = db.prepare('SELECT id FROM orders WHERE dedupe_key = ?');

  let inserted = 0;
  let duplicated = 0;

  const dedupeKeys = assignDedupeKeys(parsed);

  parsed.forEach((o: ParsedOrder, i: number) => {
    if (findDedupe.get(dedupeKeys[i]!)) duplicated++;
    else inserted++;
    insert.run(
      dedupeKeys[i]!,
      rawMsgId,
      i,
      o.orderNo,
      o.statusTag,
      // 单条自己的时间头 > 调用方显式给的时间 > 导入时间（见上面 msgSentAt 的说明）
      o.sentAt ?? input.sentAt ?? ts,
      o.district,
      o.area,
      o.address,
      o.stage,
      o.gradeNum,
      o.gradeText,
      o.studentCount,
      o.studentGender,
      o.mode,
      JSON.stringify(o.subjects),
      JSON.stringify(o.subjectTags),
      o.freqPerWeek,
      o.hoursPerSession,
      o.schedule,
      o.salaryRaw,
      o.salaryMin,
      o.salaryMax,
      o.salaryUnit,
      o.salaryHourly,
      JSON.stringify(o.salaryTiers),
      o.teacherReq,
      o.notes,
      o.rawText,
      o.confidence,
      JSON.stringify(o.warnings),
      ts,
      ts,
    );
  });

  return {
    orders: parsed.length,
    inserted,
    duplicated,
    nonOrderText: false,
    diagnostics: buildDiagnostics(parsed, input.sentAt ?? null, lines),
  };
}

export interface OrderQuery {
  q?: string;
  districts?: string[];
  stages?: string[];
  subjects?: string[];
  modes?: string[];
  statuses?: string[];
  minHourly?: number;
  maxHourly?: number;
  starred?: boolean;
  sort?: 'hourly' | 'newest' | 'salary' | 'commute';
  /** 只看通勤不超过 N 分钟的单子（未算完通勤的一律不进，见下面 WHERE） */
  maxCommuteMinutes?: number;
  /**
   * 只看「通勤算不出」的单子（commute_status = 'failed'）。
   *
   * 【为什么这一栏可以绕过红线】红线管的是「未算完的别混进通勤排序」，怕的是
   * 「前 10 名」变成「先算完的 10 名」。这里是**独立的一栏**：用户明确要只看这些单子，
   * 进去补地址、看详情，它不参与任何通勤排序，两者不冲突。
   */
  commuteFailed?: boolean;
  limit?: number;
}

function rowToOrder(r: Record<string, unknown>) {
  return {
    id: r.id as number,
    orderNo: (r.order_no as string) ?? null,
    statusTag: (r.status_tag as string) ?? null,
    sentAt: (r.sent_at as string) ?? null,
    district: (r.district as string) ?? null,
    area: (r.area as string) ?? null,
    address: (r.address as string) ?? null,
    stage: (r.stage as string) ?? null,
    gradeNum: (r.grade_num as number) ?? null,
    gradeText: (r.grade_text as string) ?? null,
    studentCount: (r.student_count as number) ?? null,
    studentGender: (r.student_gender as string) ?? null,
    mode: (r.mode as string) ?? null,
    subjects: JSON.parse((r.subjects as string) || '[]'),
    subjectTags: JSON.parse((r.subject_tags as string) || '[]'),
    freqPerWeek: (r.freq_per_week as number) ?? null,
    hoursPerSession: (r.hours_per_session as number) ?? null,
    schedule: (r.schedule as string) ?? null,
    salaryRaw: (r.salary_raw as string) ?? null,
    salaryMin: (r.salary_min as number) ?? null,
    salaryMax: (r.salary_max as number) ?? null,
    salaryUnit: (r.salary_unit as string) ?? null,
    salaryHourly: (r.salary_hourly as number) ?? null,
    salaryTiers: JSON.parse((r.salary_tiers as string) || '[]'),
    teacherReq: (r.teacher_req as string) ?? null,
    notes: (r.notes as string) ?? null,
    rawText: r.raw_text as string,
    confidence: r.confidence as string,
    warnings: JSON.parse((r.warnings as string) || '[]'),
    status: r.status as string,
    starred: Boolean(r.starred),
    remark: (r.remark as string) ?? null,
    firstSeen: r.first_seen as string,
    lastSeen: r.last_seen as string,
    occurrences: r.occurrences as number,
    // 通勤：ok / failed / null（还没算）。没算和「算了但失败」必须能分开，
    // 界面上前者显示「计算中…」、后者显示「算不出来」，否则永远卡在同一个地方等
    commuteStatus: (r.commute_status as string) ?? null,
    commuteMinutes: (r.commute_minutes as number) ?? null,
    commuteDistance: (r.commute_distance as number) ?? null,
    commuteTransfers: (r.commute_transfers as number) ?? null,
    commuteFare: (r.commute_fare as number) ?? null,
    commuteOriginId: (r.commute_origin_id as number) ?? null,
    commuteAddress: (r.commute_address as string) ?? null,
    commuteCacheKey: (r.commute_cache_key as string) ?? null,
    commuteCheckedAt: (r.commute_checked_at as string) ?? null,
    commuteError: (r.commute_error as string) ?? null,
  };
}

export type OrderRow = ReturnType<typeof rowToOrder>;

export function listOrders(q: OrderQuery) {
  const where: string[] = [];
  const params: (string | number)[] = [];

  if (q.q) {
    where.push('(raw_text LIKE ? OR order_no LIKE ? OR address LIKE ? OR teacher_req LIKE ?)');
    const like = `%${q.q}%`;
    params.push(like, like, like, like);
  }
  if (q.districts?.length) {
    where.push(`district IN (${q.districts.map(() => '?').join(',')})`);
    params.push(...q.districts);
  }
  if (q.stages?.length) {
    where.push(`stage IN (${q.stages.map(() => '?').join(',')})`);
    params.push(...q.stages);
  }
  if (q.modes?.length) {
    where.push(`mode IN (${q.modes.map(() => '?').join(',')})`);
    params.push(...q.modes);
  }
  if (q.subjects?.length) {
    where.push(`(${q.subjects.map(() => 'subjects LIKE ?').join(' OR ')})`);
    params.push(...q.subjects.map((s) => `%"${s}"%`));
  }
  if (q.statuses?.length) {
    where.push(`status IN (${q.statuses.map(() => '?').join(',')})`);
    params.push(...q.statuses);
  }
  if (typeof q.minHourly === 'number') {
    where.push('salary_hourly >= ?');
    params.push(q.minHourly);
  }
  if (typeof q.maxHourly === 'number') {
    where.push('salary_hourly <= ?');
    params.push(q.maxHourly);
  }
  if (q.starred) where.push('starred = 1');

  // 【红线】未算完通勤的单子不得混进已排序列表。
  // 否则「通勤最近的 10 单」实际是「先算完的 10 单」——离得近的单子还没算，
  // 用户会以为附近没单，这种漏单是不可察觉的（见 CODEBUDDY.md 硬约束）。
  if (q.commuteFailed) {
    // 独立一栏：只列算不出的。此时不再叠加下面那条「必须是 ok」，
    // 否则两个条件互斥，用户点进去永远看到空列表。
    where.push("commute_status = 'failed'");
  } else if (q.sort === 'commute' || typeof q.maxCommuteMinutes === 'number') {
    where.push("commute_status = 'ok' AND commute_minutes IS NOT NULL");
  }
  // 「算不出」那一栏里 commute_minutes 全是 NULL，再叠一个上限只会得到空列表
  if (typeof q.maxCommuteMinutes === 'number' && !q.commuteFailed) {
    where.push('commute_minutes <= ?');
    params.push(q.maxCommuteMinutes);
  }

  /**
   * 排序。「通勤算不出」这一栏里没有一个有 commute_minutes，按通勤排等于没排，
   * 所以固定按入库时间倒序 —— 用户是按批次去补地址的，最新的先修。
   * 其余情况「最新」按消息时间排，隔天补录的旧单不会顶到最前面。
   */
  const orderBy = q.commuteFailed
    ? 'last_seen DESC'
    : q.sort === 'newest'
      ? 'sent_at IS NULL, sent_at DESC, last_seen DESC'
      : q.sort === 'salary'
        ? 'salary_min IS NULL, salary_min DESC'
        : q.sort === 'commute'
          ? 'commute_minutes ASC, salary_hourly IS NULL, salary_hourly DESC'
          : 'salary_hourly IS NULL, salary_hourly DESC';

  const sql = `SELECT * FROM orders ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
               ORDER BY ${orderBy} LIMIT ?`;
  params.push(q.limit ?? 500);

  const rows = db.prepare(sql).all(...params) as Record<string, unknown>[];
  return rows.map(rowToOrder);
}

export function getMeta() {
  const pick = (col: string) => {
    const rows = db
      .prepare(`SELECT ${col} AS v, COUNT(*) AS n FROM orders WHERE ${col} IS NOT NULL GROUP BY ${col} ORDER BY n DESC`)
      .all() as { v: string; n: number }[];
    return rows.map((r) => ({ value: r.v, count: r.n }));
  };

  const subjectMap = new Map<string, number>();
  const stageMap = new Map<string, number>();
  const rows = db.prepare('SELECT subjects, stage FROM orders').all() as { subjects: string; stage: string | null }[];
  for (const r of rows) {
    for (const s of JSON.parse(r.subjects || '[]') as string[]) {
      subjectMap.set(s, (subjectMap.get(s) ?? 0) + 1);
    }
    if (r.stage) stageMap.set(r.stage, (stageMap.get(r.stage) ?? 0) + 1);
  }

  const total = (db.prepare('SELECT COUNT(*) AS n FROM orders').get() as { n: number }).n;
  const fresh = (
    db.prepare("SELECT COUNT(*) AS n FROM orders WHERE status = 'new'").get() as { n: number }
  ).n;

  return {
    total,
    fresh,
    districts: pick('district'),
    stages: [...stageMap.entries()].map(([value, count]) => ({ value, count })),
    subjects: [...subjectMap.entries()].map(([value, count]) => ({ value, count })).sort((a, b) => b.count - a.count),
    modes: pick('mode'),
  };
}

export function updateOrder(id: number, patch: { status?: string; starred?: boolean; remark?: string }) {
  const sets: string[] = [];
  const params: (string | number)[] = [];
  if (patch.status !== undefined) {
    sets.push('status = ?');
    params.push(patch.status);
  }
  if (patch.starred !== undefined) {
    sets.push('starred = ?');
    params.push(patch.starred ? 1 : 0);
  }
  if (patch.remark !== undefined) {
    sets.push('remark = ?');
    params.push(patch.remark);
  }
  if (!sets.length) return null;
  params.push(id);
  db.prepare(`UPDATE orders SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  const row = db.prepare('SELECT * FROM orders WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  return row ? rowToOrder(row) : null;
}

export function deleteOrder(id: number) {
  db.prepare('DELETE FROM orders WHERE id = ?').run(id);
}

export function getOrder(id: number): OrderRow | null {
  const row = db.prepare('SELECT * FROM orders WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  return row ? rowToOrder(row) : null;
}

export interface CommutePatch {
  /** ok = 算到了；failed = 试过但失败（error 里写原因） */
  status: 'ok' | 'failed';
  minutes?: number | null;
  distance?: number | null;
  transfers?: number | null;
  fare?: number | null;
  originId?: number | null;
  /** 这次计算用的地址：地址被增量补全改了之后，据此判定旧结果作废 */
  address?: string | null;
  cacheKey?: string | null;
  error?: string | null;
}

export function updateOrderCommute(id: number, patch: CommutePatch): void {
  db.prepare(
    `UPDATE orders SET
       commute_status = ?, commute_minutes = ?, commute_distance = ?, commute_transfers = ?,
       commute_fare = ?, commute_origin_id = ?, commute_address = ?, commute_cache_key = ?,
       commute_checked_at = ?, commute_error = ?
     WHERE id = ?`,
  ).run(
    patch.status,
    patch.minutes ?? null,
    patch.distance ?? null,
    patch.transfers ?? null,
    patch.fare ?? null,
    patch.originId ?? null,
    patch.address ?? null,
    patch.cacheKey ?? null,
    now(),
    patch.error ?? null,
    id,
  );
}

/** 已算完（ok）的单子数：用于判断「通勤排序现在有没有意义」 */
export function countCommuteReady(): number {
  return (
    db.prepare("SELECT COUNT(*) AS n FROM orders WHERE commute_status = 'ok' AND commute_minutes IS NOT NULL").get() as {
      n: number;
    }
  ).n;
}

/**
 * 「还要算通勤」的候选单。
 *
 * 【为什么不复用 listOrders({ sort: 'commute' })】那是**红线过滤后的结果**：
 * 按通勤排序时它只返回已算完的单子。曾经拿它去喂入队，于是「算完第一单之后，
 * 入队永远拿到 0 个候选」—— 剩下的单子再也没人捞，界面却一直说「还有 56 单没算出通勤」。
 * 入队必须从「待算集合」取，不能从「已经算好的那一页」取。
 *
 * 条件与 service 里的 needsWork 一一对应，但**失败的冷却直接下沉到 SQL**：
 * 否则一屏 30 条候选全是刚失败、还在 6 小时冷却中的单子，就会挤掉真正还没算的单。
 */
export interface CommuteCandidate {
  id: number;
  address: string | null;
  mode: string | null;
  commuteStatus: string | null;
  commuteCheckedAt: string | null;
  commuteAddress: string | null;
  commuteOriginId: number | null;
}

export function listCommuteCandidates(input: { originId: number; failedBefore: string; limit?: number }): CommuteCandidate[] {
  const limit = input.limit ?? 30;
  return db
    .prepare(
      `SELECT id,
              address,
              mode,
              commute_status    AS commuteStatus,
              commute_checked_at AS commuteCheckedAt,
              commute_address   AS commuteAddress,
              commute_origin_id AS commuteOriginId
         FROM orders
        WHERE address IS NOT NULL AND address <> ''
          AND COALESCE(mode, '') <> '线上'
          AND (
            commute_status IS NULL
            OR commute_status <> 'ok'
            OR commute_address IS NOT address
            OR commute_origin_id IS NOT ?
          )
          AND NOT (commute_status = 'failed' AND commute_checked_at IS NOT NULL AND commute_checked_at >= ?)
        ORDER BY id ASC
        LIMIT ?`,
    )
    .all(input.originId, input.failedBefore, limit) as unknown as CommuteCandidate[];
}

/** 一条「通勤有问题的单」：算不出（failed）或者还没轮到（pending） */
export interface CommuteIssue {
  id: number;
  orderNo: string | null;
  address: string | null;
  status: 'failed' | 'pending';
  error: string | null;
  checkedAt: string | null;
}

/**
 * 「通勤算不出的单子」清单。
 *
 * 【为什么必须有这份清单】这些单子在默认排序（按通勤）里**根本不出现** —— 红线规定
 * 未算完的不许混进通勤排序。于是用户只能在 160 单里靠肉眼找红色徽标，等于看不见；
 * 设置面板又只给「还有 N 单没算」这个数字，说不出是哪几单、为什么。
 * 清单把「编号 + 地址 + 原因」摊开，用户才知道该去修哪条原文。
 *
 * 线上单不算：它们不需要通勤，出现在「有问题」的清单里只是噪音。
 */
export function listCommuteIssues(limit = 200): CommuteIssue[] {
  const rows = db
    .prepare(
      `SELECT id, order_no, address, commute_status, commute_error, commute_checked_at
         FROM orders
        WHERE address IS NOT NULL AND address <> ''
          AND COALESCE(mode, '') <> '线上'
          AND (commute_status = 'failed' OR commute_status IS NULL)
        ORDER BY (commute_status = 'failed') DESC, id ASC
        LIMIT ?`,
    )
    .all(limit) as unknown as Record<string, unknown>[];

  return rows.map((r) => ({
    id: r.id as number,
    orderNo: (r.order_no as string) ?? null,
    address: (r.address as string) ?? null,
    status: r.commute_status === 'failed' ? 'failed' : 'pending',
    error: (r.commute_error as string) ?? null,
    checkedAt: (r.commute_checked_at as string) ?? null,
  }));
}

/**
 * 有地址、但还没算出通勤的单子数：后端据此告诉界面「还有 N 单在算」。
 * 线上单不算 —— 它永远不会被算，计进来只会让状态条一直挂着一句「还有 N 单没算」。
 */
export function countCommutePending(): number {
  return (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM orders
         WHERE address IS NOT NULL AND address <> ''
           AND COALESCE(mode, '') <> '线上'
           AND (commute_status IS NULL OR commute_status = 'failed')`,
      )
      .get() as { n: number }
  ).n;
}

/**
 * 「算不出通勤」的单子数：筛选栏那个分类按钮上的数字。
 *
 * 【为什么口径必须和 listOrders 一字不差】按钮写 21、点进去 23 条，用户会以为筛选坏了。
 * 所以这里不加任何额外条件（不排除线上单、不要求有地址）——
 * 与 `?commute=failed` 的 WHERE 完全一致。没有地址的单也该被看见：正是要去补地址。
 */
export function countCommuteFailed(): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM orders WHERE commute_status = 'failed'`).get() as { n: number }).n;
}

/* ------------------------------------------------------------------ *
 * 出发点
 * ------------------------------------------------------------------ */

export interface Origin {
  id: number;
  name: string;
  address: string;
  lng: number | null;
  lat: number | null;
  isDefault: boolean;
  createdAt: string;
}

function rowToOrigin(r: Record<string, unknown>): Origin {
  return {
    id: r.id as number,
    name: r.name as string,
    address: r.address as string,
    lng: (r.lng as number) ?? null,
    lat: (r.lat as number) ?? null,
    isDefault: Boolean(r.is_default),
    createdAt: r.created_at as string,
  };
}

export function listOrigins(): Origin[] {
  const rows = db.prepare('SELECT * FROM origins ORDER BY is_default DESC, id ASC').all() as Record<string, unknown>[];
  return rows.map(rowToOrigin);
}

/** 默认出发点：is_default 那条；一条都没设就取最早录入的（总得有个起点才能算通勤） */
export function getDefaultOrigin(): Origin | null {
  const rows = listOrigins();
  return rows.find((o) => o.isDefault) ?? rows[0] ?? null;
}

export function addOrigin(input: { name: string; address: string; lng?: number | null; lat?: number | null; isDefault?: boolean }): Origin {
  const ts = now();
  const isDefault = input.isDefault ?? listOrigins().length === 0;
  if (isDefault) db.prepare('UPDATE origins SET is_default = 0').run();
  const res = db
    .prepare('INSERT INTO origins (name, address, lng, lat, is_default, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(input.name, input.address, input.lng ?? null, input.lat ?? null, isDefault ? 1 : 0, ts);
  const row = db.prepare('SELECT * FROM origins WHERE id = ?').get(Number(res.lastInsertRowid)) as Record<
    string,
    unknown
  >;
  return rowToOrigin(row);
}

export function updateOrigin(
  id: number,
  patch: { name?: string; address?: string; lng?: number | null; lat?: number | null; isDefault?: boolean },
): Origin | null {
  const sets: string[] = [];
  const params: (string | number | null)[] = [];
  if (patch.name !== undefined) {
    sets.push('name = ?');
    params.push(patch.name);
  }
  if (patch.address !== undefined) {
    sets.push('address = ?');
    params.push(patch.address);
    // 地址改了，旧的坐标一定作废 —— 留着它比留空更危险（会算出「能通勤到旧地址」的假结论）
    sets.push('lng = NULL', 'lat = NULL');
  }
  if (patch.lng !== undefined) {
    sets.push('lng = ?');
    params.push(patch.lng);
  }
  if (patch.lat !== undefined) {
    sets.push('lat = ?');
    params.push(patch.lat);
  }
  if (patch.isDefault) {
    db.prepare('UPDATE origins SET is_default = 0').run();
    sets.push('is_default = 1');
  }
  if (!sets.length) {
    const same = db.prepare('SELECT * FROM origins WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return same ? rowToOrigin(same) : null;
  }
  params.push(id);
  db.prepare(`UPDATE origins SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  const row = db.prepare('SELECT * FROM origins WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  return row ? rowToOrigin(row) : null;
}

export function deleteOrigin(id: number): void {
  db.prepare('DELETE FROM origins WHERE id = ?').run(id);
  // 删掉的是默认出发点 → 让剩下的第一条顶上，避免「有出发点但都不是默认」的中间态
  const rows = listOrigins();
  if (rows.length && !rows.some((o) => o.isDefault)) {
    db.prepare('UPDATE origins SET is_default = 1 WHERE id = ?').run(rows[0]!.id);
  }
}
