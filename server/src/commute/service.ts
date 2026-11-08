/**
 * 通勤编排：把「起点 → 地址」这件事串起来，并决定「算哪几条、什么时候算」。
 *
 * 一次计算的顺序固定：
 *   1. 读 orders 里这条单子的地址
 *   2. 起始地坐标（没有就先地理编码，结果回写 origins）
 *   3. 终点坐标（地址级缓存，同一个地址被 20 个单子共用，只算一次）
 *   4. 出发时刻固定在「下一个工作日 08:00」→ 算缓存键
 *   5. 命中通勤缓存就直接落库；没命中才真的调高德
 *   6. 取最快一套写进 orders 的标量列供排序，**全部方案**留在缓存里供详情展开
 *
 * 【为什么一次只算 30 条】决策 8.4：按需计算。库里有几百单，全算一遍等于白烧配额；
 * 一次 30 条 × 400ms ≈ 12 秒，和「用户看着这一屏」的节奏对得上，剩下的下一轮继续。
 *
 * 【但「哪 30 条」不能取当前页】曾经拿 `listOrders({sort:'commute'})` 的结果去入队 ——
 * 那个查询按红线只返回**已算完**的单子，于是算完第一单之后入队永远拿到 0 个候选，
 * 剩下的单子再也没人捞（界面却一直显示「还有 N 单没算出通勤」）。
 * 现在改成从 `listCommuteCandidates()` 这个「待算集合」里取，与当前页的排序/筛选完全无关。
 */
import {
  countCommutePending,
  countCommuteReady,
  getDefaultOrigin,
  getOrder,
  listCommuteCandidates,
  updateOrderCommute,
  updateOrigin,
  type CommuteCandidate,
  type OrderRow,
  type Origin,
} from '../db.ts';
import { createDailyQuota, nextWorkdayDepartAt, planCacheKey, readGeo, readPlan, readPlanByKey, writeGeo, writePlan, type DailyQuota } from './cache.ts';
import { CommuteQueue } from './queue.ts';
import {
  CommuteError,
  GeocodeMissError,
  type CommuteMode,
  type CommuteOption,
  type CommuteProvider,
  type GeocodeResult,
  type GeoPoint,
  type ProviderInfo,
} from './types.ts';

/** 每次请求最多入队多少条：30 条 × 400ms ≈ 12 秒，一屏的量，用户感知不到后台在跑 */
export const MAX_ENQUEUE_PER_TICK = 30;

/**
 * 默认日配额上限，单位是**HTTP 调用次数**（≈ 1000 单且完全无缓存）。
 * 高德个人开发者的日配额是数千级（以控制台为准）。默认给 2000 是为了「一次灌完历史单」：
 * 几百单 × 每单最多 2 次调用也够，同时仍是明确的闸门 —— 不会因为某个死循环把一整天额度打光。
 * 需要临时调整走 `.env` 的 `AMAP_DAILY_LIMIT`（见 index.ts）。
 */
export const DEFAULT_DAILY_LIMIT = 2000;

/**
 * 解析 `.env` 里的 `AMAP_DAILY_LIMIT`。
 * 写错（空、负数、`abc`）一律退回默认值并说明原因 —— 配置打错不该让通勤静默停摆，
 * 但也不能因此把配额放开到无限：那会让一次误输入变成一天的额度事故。
 */
export function parseDailyLimit(raw: string | undefined, fallback = DEFAULT_DAILY_LIMIT): number {
  const text = raw?.trim();
  if (!text) return fallback;
  const n = Number(text);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
}

const MODE: CommuteMode = 'transit';

export interface CommuteServiceOptions {
  provider?: CommuteProvider | null;
  quota?: DailyQuota;
  dailyLimit?: number;
  intervalMs?: number;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * 通勤现在为什么算不动。
 * 【为什么要显式给出来】「通勤列一片空白」有三种完全不同的原因：没 key、没设出发点、配额用完。
 * 不区分的话用户只会以为程序坏了，然后在设置里瞎改。
 */
export type CommuteBlocker = 'no_key' | 'no_origin' | 'quota' | null;

export interface CommuteStatus {
  provider: ProviderInfo;
  origin: Origin | null;
  blockedBy: CommuteBlocker;
  /** 队列里还没跑的条数 */
  queued: number;
  busy: boolean;
  /** 已算出通勤的单子数（全库） */
  ready: number;
  /** 有地址但还没算出（或算失败过）的单子数 */
  pending: number;
  quota: { limit: number; used: number; remaining: number; exhausted: boolean };
  lastError: string | null;
}

export interface OrderCommuteView {
  orderId: number;
  status: string | null;
  minutes: number | null;
  distance: number | null;
  transfers: number | null;
  fare: number | null;
  departAt: string | null;
  checkedAt: string | null;
  error: string | null;
  /** 多套方案，按耗时升序；没算过就是空数组 */
  options: CommuteOption[];
}

export interface CommuteService {
  readonly queue: CommuteQueue;
  status(): CommuteStatus;
  /** 对「本屏返回的单子里缺通勤数据的前 n 条」入队；返回候选数与实际入队数 */
  enqueueMissing(orders: CommuteCandidate[], limit?: number): { candidates: number; queued: number };
  /**
   * 从**全库待算集合**里取前 n 条入队（接口层该用这个）。
   * 与当前页的排序、筛选无关 —— 按通勤排序时列表里根本没有待算单，用列表去入队等于永远不入队。
   */
  enqueuePending(limit?: number): { candidates: number; queued: number };
  optionsFor(orderId: number): OrderCommuteView | null;
}

export function createCommuteService(options: CommuteServiceOptions = {}): CommuteService {
  const provider = options.provider ?? null;
  const quota = options.quota ?? createDailyQuota(options.dailyLimit ?? DEFAULT_DAILY_LIMIT, 'amap', options.now);
  const now = options.now ?? (() => new Date());

  const providerInfo = (): ProviderInfo =>
    provider
      ? { configured: true, name: provider.name, reason: null }
      : { configured: false, name: null, reason: '未配置高德 key（在 .env 里设 AMAP_KEY）' };

  /**
   * 地理编码（带缓存）。
   * 【为什么按地址而不是按单子缓存】同一个「海珠昌岗」会被几十条单子共用，
   * 按单子缓存等于把一个地址重复解析几十次。
   */
  async function geocodeCached(address: string): Promise<GeocodeResult> {
    const hit = readGeo(address, now());
    if (hit) {
      if (hit.ok && hit.result) return hit.result;
      // 上次就定位不到：直接抛，重试没有意义（TTL 6 小时后才会再试）
      throw new GeocodeMissError(hit.error ?? `高德定位不到「${address}」`);
    }
    if (!provider) throw new CommuteError('未配置高德 key');
    quota.take();
    try {
      const result = await provider.geocode(address);
      writeGeo(address, { result, error: null }, now());
      return result;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      writeGeo(address, { result: null, error: msg }, now());
      throw e;
    }
  }

  /** 起始地坐标：第一次用时顺手把坐标补进 origins，之后不必再解析 */
  async function ensureOriginCoords(origin: Origin): Promise<GeoPoint> {
    if (origin.lng !== null && origin.lat !== null) return { lng: origin.lng, lat: origin.lat };
    const geo = await geocodeCached(origin.address);
    updateOrigin(origin.id, { lng: geo.location.lng, lat: geo.location.lat });
    return geo.location;
  }

  function applyResult(order: OrderRow, origin: Origin, address: string, key: string, opt: CommuteOption): void {
    updateOrderCommute(order.id, {
      status: 'ok',
      minutes: opt.minutes,
      distance: opt.distance,
      transfers: opt.transfers,
      fare: opt.fare,
      originId: origin.id,
      address,
      cacheKey: key,
      error: null,
    });
  }

  /**
   * 单条单子的完整计算流程。抛错即视为失败（由队列重试一次，仍失败则由 onFailure 落 failed）。
   * 注意：**失败也落库**，否则同一单会在每次刷新时被重新排队，白烧配额。
   */
  async function handleOrder(orderId: number): Promise<void> {
    const order = getOrder(orderId);
    if (!order) throw new CommuteError(`单子 ${orderId} 不存在`);

    if (!order.address) {
      updateOrderCommute(orderId, { status: 'failed', error: '没有地址，无法计算通勤' });
      return;
    }

    const origin = getDefaultOrigin();
    if (!origin) throw new CommuteError('还没有设置出发点');
    if (!provider) throw new CommuteError('未配置高德 key');

    const from = await ensureOriginCoords(origin);
    const dest = await geocodeCached(order.address);

    const departAt = nextWorkdayDepartAt(now());
    const key = planCacheKey(MODE, from, dest.location, departAt);

    const cached = readPlan(key, now());
    if (cached) {
      if (cached.ok && cached.options.length) {
        // 命中最快的第 0 套（planTransit 保证按耗时升序，缓存里存的也是排好序的）
        applyResult(order, origin, order.address, key, cached.options[0]!);
        return;
      }
      throw new CommuteError(cached.error ?? '上次计算就没有拿到可用方案');
    }

    quota.take();
    try {
      const opts = await provider.planTransit(from, dest.location, departAt);
      writePlan(key, MODE, from, dest.location, departAt, { options: opts, error: null }, now());
      applyResult(order, origin, order.address, key, opts[0]!);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // 失败也写缓存：6 小时内不再重试，避免用户每刷一次就撞一次同样的错
      writePlan(key, MODE, from, dest.location, departAt, { options: [], error: msg }, now());
      throw e;
    }
  }

  const queue = new CommuteQueue({
    handler: handleOrder,
    intervalMs: options.intervalMs ?? 400,
    canRun: () => quota.remaining() > 0,
    onFailure: (orderId, error) => {
      // 失败要留痕、也要留时间戳：界面显示「算不出来 + 原因」，而不是永远转圈
      updateOrderCommute(orderId, { status: 'failed', error: error.message });
    },
    sleep: options.sleep,
  });

  /** 失败结果与缓存 TTL 对齐：这段时间内不再排队，否则每次刷新都会把它捞回来空转 */
  const FAILED_COOLDOWN_MS = 6 * 3600_000;

  /** 这条单子现在需要（重新）算吗？*/
  function needsWork(order: CommuteCandidate, originId: number): boolean {
    if (!order.address) return false;
    // 线上授课没有通勤可言：不占配额、不算「还没算」，也不该出现在通勤排序里
    if (order.mode === '线上') return false;
    if (order.commuteStatus === 'failed') {
      const checked = order.commuteCheckedAt ? new Date(order.commuteCheckedAt).getTime() : 0;
      if (checked && now().getTime() - checked < FAILED_COOLDOWN_MS) return false;
      return true;
    }
    if (order.commuteStatus !== 'ok') return true;
    // 地址被增量补全改了、或换了默认出发点 → 旧结论作废，重算（多数情况会命中缓存，几乎不耗配额）
    if (order.commuteAddress !== order.address) return true;
    if (order.commuteOriginId !== originId) return true;
    return false;
  }

  /** 入队的最后一步：过滤掉不该算的、截到一屏的量、交给队列 */
  function enqueueOrders(orders: CommuteCandidate[], limit = MAX_ENQUEUE_PER_TICK) {
    const origin = getDefaultOrigin();
    if (!provider || !origin) return { candidates: 0, queued: 0 };
    const ids = orders
      .filter((o) => needsWork(o, origin.id))
      .slice(0, limit)
      .map((o) => o.id);
    return { candidates: ids.length, queued: queue.enqueue(ids) };
  }

  return {
    queue,

    status(): CommuteStatus {
      const origin = getDefaultOrigin();
      const blockedBy: CommuteBlocker = !provider
        ? 'no_key'
        : !origin
          ? 'no_origin'
          : queue.quotaExhausted() || quota.remaining() === 0
            ? 'quota'
            : null;
      return {
        provider: providerInfo(),
        origin,
        blockedBy,
        queued: queue.size(),
        busy: queue.isBusy(),
        ready: countCommuteReady(),
        pending: countCommutePending(),
        quota: {
          limit: quota.limit,
          used: quota.used(),
          remaining: quota.remaining(),
          exhausted: queue.quotaExhausted() || quota.remaining() === 0,
        },
        lastError: queue.lastFailure(),
      };
    },

    enqueueMissing: enqueueOrders,

    enqueuePending(limit = MAX_ENQUEUE_PER_TICK) {
      const origin = getDefaultOrigin();
      if (!provider || !origin) return { candidates: 0, queued: 0 };
      // 冷却期内的失败单由 SQL 排除，这里拿到的每一条都真的该算
      const rows = listCommuteCandidates({
        originId: origin.id,
        failedBefore: new Date(now().getTime() - FAILED_COOLDOWN_MS).toISOString(),
        limit,
      });
      return { candidates: rows.length, queued: enqueueOrders(rows, limit).queued };
    },

    optionsFor(orderId: number): OrderCommuteView | null {
      const order = getOrder(orderId);
      if (!order) return null;
      const cached = order.commuteCacheKey ? readPlanByKey(order.commuteCacheKey) : null;
      return {
        orderId,
        status: order.commuteStatus,
        minutes: order.commuteMinutes,
        distance: order.commuteDistance,
        transfers: order.commuteTransfers,
        fare: order.commuteFare,
        departAt: cached?.options[0]?.departAt ?? null,
        checkedAt: order.commuteCheckedAt,
        error: order.commuteError,
        options: cached?.options ?? [],
      };
    },
  };
}


