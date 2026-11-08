/**
 * 通勤缓存 + 地理编码缓存 + 每日配额计数。
 *
 * 三张表都建在这里（而不是 db.ts）的原因：它们只服务通勤这一层，
 * 换掉通勤实现时整块可以一起删；`orders` 的业务列仍然归 db.ts 管。
 *
 * 【为什么缓存键里不含用户】决策 3：为「同学一起用」预留 —— 同一个起点到同一个地址，
 * 谁算都是同一组数，按用户分键只会让配额翻倍。
 * 【为什么坐标只取 4 位小数】约 10 米精度。同一个小区被写成
 * 「星汇金沙」和「金沙洲星汇金沙」时，经纬度往往落在几十米内，取 4 位能命中同一条缓存，
 * 取 6 位则会重复扣配额。
 */
import {
  COMMUTE_ENGINE_VERSION,
  CommuteError,
  QuotaExceededError,
  type CommuteOption,
  type GeoPoint,
  type GeocodeResult,
} from './types.ts';
import { inferCity, isDowngradedMatch } from './city.ts';
import { getDb } from '../db.ts';

const db = getDb();

db.exec(`
CREATE TABLE IF NOT EXISTS commute_cache (
  cache_key      TEXT PRIMARY KEY,
  mode           TEXT NOT NULL,
  origin_lng     REAL NOT NULL,
  origin_lat     REAL NOT NULL,
  dest_lng       REAL NOT NULL,
  dest_lat       REAL NOT NULL,
  depart_bucket  TEXT NOT NULL,
  ok             INTEGER NOT NULL,
  options_json   TEXT NOT NULL DEFAULT '[]',
  error          TEXT,
  fetched_at     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS geo_cache (
  address_key  TEXT PRIMARY KEY,
  address      TEXT NOT NULL,
  ok           INTEGER NOT NULL,
  lng          REAL,
  lat          REAL,
  formatted    TEXT,
  level        TEXT,
  error        TEXT,
  fetched_at   TEXT NOT NULL
);

-- 配额计数必须落库：内存计数一重启就归零，等于每天可以偷偷多刷一轮配额
CREATE TABLE IF NOT EXISTS api_usage (
  day    TEXT NOT NULL,
  kind   TEXT NOT NULL,
  calls  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, kind)
);
`);

/** 成功结果保鲜 30 天（地铁线路一个月内基本不变），失败只记 6 小时（可能是临时抖动） */
const PLAN_TTL_OK_DAYS = 30;
const PLAN_TTL_FAIL_HOURS = 6;
const GEO_TTL_OK_DAYS = 90;
const GEO_TTL_FAIL_HOURS = 6;

/** 本地时间戳，形如 2026-11-09T08:00。刻意不用 toISOString：那会跳成 UTC，缓存键就对不上「早上八点」 */
export function localStamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

function localDay(d: Date): string {
  return localStamp(d).slice(0, 10);
}

/**
 * 出发时刻固定在「下一个工作日 08:00」。
 *
 * 【为什么不是 now】按「当前时刻」算，早上八点算出来的和晚上十点算出来的不是一回事（夜间公交停运），
 * 于是单子之间不可比，缓存也天天失效。定成一个固定锚点后：
 * 同一单今天看和明天看差多少，只反映地址变化，不反映你什么时候心情好点开了它。
 */
export function nextWorkdayDepartAt(now: Date, hour = 8): Date {
  const at = (d: Date) => {
    const x = new Date(d.getTime());
    x.setHours(hour, 0, 0, 0);
    return x;
  };
  const isWorkday = (d: Date) => d.getDay() >= 1 && d.getDay() <= 5;

  const today = at(now);
  if (isWorkday(today) && today.getTime() > now.getTime()) return today;

  const next = at(now);
  do {
    next.setDate(next.getDate() + 1);
  } while (!isWorkday(next));
  return next;
}

/** 4 位小数（约 10 米） */
export function roundCoord(n: number): number {
  return Math.round(n * 1e4) / 1e4;
}

export function coordKey(p: GeoPoint): string {
  return `${roundCoord(p.lng)},${roundCoord(p.lat)}`;
}

/** 缓存键：模式|起点|终点|出发时刻桶。不含用户，见文件头 */
export function planCacheKey(mode: string, origin: GeoPoint, dest: GeoPoint, departAt: Date): string {
  return `${mode}|${coordKey(origin)}|${coordKey(dest)}|${localStamp(departAt)}`;
}

/**
 * 地址归一化：去空白、去包裹符号、全角括号转半角。
 * 只做「同一条地址被复制成不同样子」的合并，**绝不改写地址内容** ——
 * 「广州番禺桥南」和「番禺桥南」仍是两条（合并它们就是在猜行政区）。
 */
export function normalizeAddress(address: string): string {
  return address
    .replace(/\s+/g, '')
    .replace(/[（）]/g, (m) => (m === '（' ? '(' : ')'))
    .replace(/[，,、；;。.]/g, '')
    .trim();
}

interface PlanRow {
  ok: number;
  options_json: string;
  error: string | null;
  fetched_at: string;
}

function ageHours(fetchedAt: string, now: Date): number {
  return (now.getTime() - new Date(fetchedAt).getTime()) / 3_600_000;
}

export interface CachedPlan {
  ok: boolean;
  options: CommuteOption[];
  error: string | null;
  fetchedAt: string;
}

/** 读通勤缓存。过期返回 null（过期不删，留着排查「为什么这单算出来变了」） */
export function readPlan(key: string, now: Date = new Date()): CachedPlan | null {
  const row = db.prepare('SELECT ok, options_json, error, fetched_at FROM commute_cache WHERE cache_key = ?').get(key) as
    | PlanRow
    | undefined;
  if (!row) return null;
  const age = ageHours(row.fetched_at, now);
  const ttl = row.ok === 1 ? PLAN_TTL_OK_DAYS * 24 : PLAN_TTL_FAIL_HOURS;
  if (age > ttl) return null;
  return {
    ok: row.ok === 1,
    options: row.ok === 1 ? (JSON.parse(row.options_json) as CommuteOption[]) : [],
    error: row.error,
    fetchedAt: row.fetched_at,
  };
}

export function writePlan(
  key: string,
  mode: string,
  origin: GeoPoint,
  dest: GeoPoint,
  departAt: Date,
  result: { options: CommuteOption[]; error: string | null },
  now: Date = new Date(),
): void {
  db.prepare(
    `INSERT INTO commute_cache (cache_key, mode, origin_lng, origin_lat, dest_lng, dest_lat,
                                depart_bucket, ok, options_json, error, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(cache_key) DO UPDATE SET
       ok = excluded.ok,
       options_json = excluded.options_json,
       error = excluded.error,
       fetched_at = excluded.fetched_at`,
  ).run(
    key,
    mode,
    roundCoord(origin.lng),
    roundCoord(origin.lat),
    roundCoord(dest.lng),
    roundCoord(dest.lat),
    localStamp(departAt),
    result.error === null ? 1 : 0,
    JSON.stringify(result.options),
    result.error,
    now.toISOString(),
  );
}

/** 按缓存键直接取全部方案（详情面板用，不看 TTL —— 过期的方案也比没有强，但仍标记 fetchedAt） */
export function readPlanByKey(key: string): CachedPlan | null {
  const row = db.prepare('SELECT ok, options_json, error, fetched_at FROM commute_cache WHERE cache_key = ?').get(key) as
    | PlanRow
    | undefined;
  if (!row) return null;
  return {
    ok: row.ok === 1,
    options: JSON.parse(row.options_json) as CommuteOption[],
    error: row.error,
    fetchedAt: row.fetched_at,
  };
}

interface GeoRow {
  ok: number;
  lng: number | null;
  lat: number | null;
  formatted: string | null;
  level: string | null;
  error: string | null;
  fetched_at: string;
}

/**
 * 地理编码缓存键：**城市 + 归一化地址**。
 *
 * 【为什么城市必须在键里】同一条地址在不同城市限定下会解析到完全不同的点：
 * 「桂城街道堑坊村」按广州查 → 广州市天河区桂城街道（离暨大 1 公里）；
 * 不限定 → 肇庆市鼎湖区桂城街道。只按地址缓存，等于把「当初用哪个城市查的」
 * 偷偷固化在旧值里 —— 改完城市推断后，旧错值还会命中，界面上那个 24 分钟永远刷不掉。
 *
 * 副作用是旧格式（纯地址）的行全部失效，这正好是想要的效果：它们都是按广州查出来的。
 */
export function geoKey(city: string, address: string): string {
  return `${city}|${normalizeAddress(address)}`;
}

export function readGeo(
  city: string,
  address: string,
  now: Date = new Date(),
): { ok: boolean; result: GeocodeResult | null; error: string | null } | null {
  const row = db
    .prepare('SELECT ok, lng, lat, formatted, level, error, fetched_at FROM geo_cache WHERE address_key = ?')
    .get(geoKey(city, address)) as GeoRow | undefined;
  if (!row) return null;
  const ttl = row.ok === 1 ? GEO_TTL_OK_DAYS * 24 : GEO_TTL_FAIL_HOURS;
  if (ageHours(row.fetched_at, now) > ttl) return null;
  if (row.ok !== 1 || row.lng === null || row.lat === null) {
    return { ok: false, result: null, error: row.error };
  }
  return {
    ok: true,
    // 缓存表没存 city/adcode：老库不用加列，这两个字段只用于当次校验与排查
    result: { location: { lng: row.lng, lat: row.lat }, formatted: row.formatted ?? '', level: row.level, city: null, adcode: null },
    error: null,
  };
}

export function writeGeo(
  city: string,
  address: string,
  result: { result: GeocodeResult | null; error: string | null },
  now: Date = new Date(),
): void {
  const loc = result.result?.location ?? null;
  db.prepare(
    `INSERT INTO geo_cache (address_key, address, ok, lng, lat, formatted, level, error, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(address_key) DO UPDATE SET
       ok = excluded.ok, lng = excluded.lng, lat = excluded.lat,
       formatted = excluded.formatted, level = excluded.level,
       error = excluded.error, fetched_at = excluded.fetched_at`,
  ).run(
    geoKey(city, address),
    address,
    result.result ? 1 : 0,
    loc ? roundCoord(loc.lng) : null,
    loc ? roundCoord(loc.lat) : null,
    result.result?.formatted ?? null,
    result.result?.level ?? null,
    result.error,
    now.toISOString(),
  );
}

/**
 * 一次性数据修正（2026-11-08）：建在「区县/乡镇/村庄」级坐标上的旧通勤结论全部作废。
 *
 * 【为什么连广州单也要查】第一次修复只清了佛山那批，假设「广州地址本来就用广州查的，结论可信」。
 * 这个假设是错的：地理编码当时还盲取 `geocodes[0]`、也不校验降级，高德对
 * 「广州市天河区黄埔大道易通大厦（暨大旁边）」只返回「广东省广州市黄埔区」—— 区县中心，
 * 离暨大 15 公里，于是这单算出 71 分钟；真实位置就在旁边。真实库里 239 条已算单中有 31 条
 * 都建在这种粗坐标上（「天河壹品」→ 整个天河区、「白云中海金沙湾」→ 整个白云区……）。
 *
 * 判据只看当时那条 geo_cache 的 level：
 *   - 细（住宅区/门牌号/兴趣点/道路/公交地铁站点…）→ 坐标可信，打版本号继续用，不白烧配额
 *   - 粗（区县/乡镇/村庄…）或查不到              → 作废，等新口径重算
 *
 * 幂等：只处理 `commute_engine` 为空的老数据；处理后要么带上版本号，要么被清成 NULL 再算一遍。
 */
export function migrateCommuteEngineOnce(): void {
  const stale = db
    .prepare('SELECT id, address FROM orders WHERE commute_status IS NOT NULL AND commute_engine IS NULL')
    .all() as { id: number; address: string | null }[];
  if (!stale.length) return;

  const geoOf = db.prepare('SELECT level, formatted FROM geo_cache WHERE address_key = ?');
  const reset = db.prepare(
    `UPDATE orders SET
       commute_status = NULL, commute_minutes = NULL, commute_distance = NULL, commute_transfers = NULL,
       commute_fare = NULL, commute_cache_key = NULL, commute_checked_at = NULL, commute_error = NULL
     WHERE id = ?`,
  );
  const mark = db.prepare('UPDATE orders SET commute_engine = ? WHERE id = ?');
  const fallbackCity = process.env.AMAP_CITY?.trim() || '广州';

  let dropped = 0;
  db.exec('BEGIN');
  try {
    for (const row of stale) {
      const address = row.address ?? '';
      const geo = geoOf.get(normalizeAddress(address)) as { level: string | null; formatted: string | null } | undefined;
      // 用**和现在完全同一套判定**去回看当初那条坐标：区县中心、落到别的区、无城市还只到街道 —— 一律作废。
      // 拿不到 geo 行（说明这条结论来路不明）也作废：宁可重算一次，也不留一个解释不了的数。
      const usable =
        geo &&
        !isDowngradedMatch({
          address,
          level: geo.level,
          formatted: geo.formatted ?? '',
          fromFallback: inferCity(address, fallbackCity).source === 'fallback',
        });
      if (usable) {
        mark.run(COMMUTE_ENGINE_VERSION, row.id);
      } else {
        reset.run(row.id);
        dropped++;
      }
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }

  if (dropped) {
    // 【关键】失败也要清：旧口径留下的 ok=0 缓存（比如被 30001/错坐标害的）会在 6 小时内
    // 直接把错误原样抛回去，根本不会再去问一次高德 —— 表现就是「代码明明修好了，重算还是同样的错」。
    const geo = db.prepare('DELETE FROM geo_cache WHERE ok = 0').run();
    const plan = db.prepare('DELETE FROM commute_cache WHERE ok = 0').run();
    console.log(
      `[迁移] ${dropped} 单的旧通勤结论用了不可信的坐标，已作废重算；` +
        `顺带清掉 ${geo.changes} 条定位失败缓存、${plan.changes} 条规划失败缓存（旧口径的失败不作数）`,
    );
  }
}

// 必须等 geo_cache 建好表再跑（就是上面那段 DDL），所以放在文件末尾而不是 db.ts 里
migrateCommuteEngineOnce();

export interface DailyQuota {
  readonly limit: number;
  used(): number;
  remaining(): number;
  /** 扣一次额度；用尽时抛 QuotaExceededError（上层据此停队列，而不是继续撞墙） */
  take(): void;
  /** 测试用：把今天的计数清零 */
  reset(): void;
}

/**
 * 每日调用配额。
 *
 * 【为什么落库而不是放内存】内存计数重启即归零 —— 调试时反复重启，一天能把配额刷到几倍，
 * 高德那边直接限流，表现为「昨天还好好的今天全失败」，排查成本极高。
 * 计数单位是**单次 HTTP 调用**，不是单子：一个 job 最多两次（geocode + transit），
 * 所以上限 300 大约等于「150 单 × 无缓存」。两种服务（地理编码 / 公交规划）在控制台是**分开计费**的，
 * 这里合成一个池子按总量卡，取保守值最安全：宁可少算几十单，也不要把 key 刷爆。
 */
export function createDailyQuota(
  limit: number,
  kind = 'amap',
  now: () => Date = () => new Date(),
): DailyQuota {
  const day = () => localDay(now());
  const read = (): number => {
    const row = db.prepare('SELECT calls FROM api_usage WHERE day = ? AND kind = ?').get(day(), kind) as
      | { calls: number }
      | undefined;
    return row?.calls ?? 0;
  };
  return {
    limit,
    used: read,
    remaining: () => Math.max(0, limit - read()),
    take: () => {
      const used = read();
      if (used >= limit) throw new QuotaExceededError(`今日高德调用已达上限 ${limit} 次，明天再算`);
      db.prepare(
        `INSERT INTO api_usage (day, kind, calls) VALUES (?, ?, 1)
         ON CONFLICT(day, kind) DO UPDATE SET calls = calls + 1`,
      ).run(day(), kind);
    },
    reset: () => {
      db.prepare('DELETE FROM api_usage WHERE day = ? AND kind = ?').run(day(), kind);
    },
  };
}
