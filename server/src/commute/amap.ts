/**
 * 高德 Web 服务实现：地理编码 + 公交路径规划。
 *
 * 用哪一种 key：控制台「绑定服务」应为 **Web服务**。`Web端(JS API)` 的 key 在这里会报鉴权错，
 * 因为它只给浏览器地图组件用（CONTEXT 8.4 已写明）。
 *
 * key 只从环境变量读，绝不落常量：
 *   node --env-file=.env src/index.ts    # AMAP_KEY 写在仓库根 .env，已被 .gitignore 忽略
 *
 * 这一层只管「一次 HTTP 怎么发、返回怎么解析」，**不管缓存、不管配额、不管重试** ——
 * 那些是 cache.ts / queue.ts 的事。混在一起就没法在不联网的情况下测编排逻辑。
 */
import {
  CommuteError,
  GeocodeMissError,
  type CommuteOption,
  type CommuteProvider,
  type GeoPoint,
  type GeocodeResult,
} from './types.ts';
import { firstDistrict, inferCity, isDowngradedMatch, normalizeCity, poiNameCoverage, type CityHint } from './city.ts';

const BASE = 'https://restapi.amap.com/v3';
const TIMEOUT_MS = 8000;

interface AmapBase {
  status: string;
  info: string;
  infocode: string;
}

interface AmapGeocodeItem {
  formatted_address?: string;
  location?: string;
  level?: string;
  city?: string;
  adcode?: string;
}

interface AmapGeoResp extends AmapBase {
  geocodes?: AmapGeocodeItem[];
}

/** /place/text 的一条 POI。address 在高德那里可能是字符串，也可能是空数组，所以按 unknown 收 */
interface AmapPoiItem {
  name?: string;
  adname?: string;
  cityname?: string;
  address?: unknown;
  location?: string;
  adcode?: string;
  typecode?: string;
}

interface AmapPoiResp extends AmapBase {
  pois?: AmapPoiItem[];
}

interface AmapSegment {
  walking?: { distance?: string };
  bus?: { buslines?: { name?: string }[] };
  railway?: { name?: string };
}

interface AmapTransit {
  cost?: string;
  duration?: string;
  distance?: string;
  walking_distance?: string;
  segments?: AmapSegment[];
}

interface AmapTransitResp extends AmapBase {
  route?: { transits?: AmapTransit[] };
}

/** 只读 env，不读文件：加载 .env 是启动方（npm script / --env-file）的责任 */
export function amapKeyFromEnv(env: NodeJS.ProcessEnv = process.env): string | null {
  const key = env.AMAP_KEY?.trim();
  return key ? key : null;
}

function cityFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  const c = env.AMAP_CITY?.trim();
  return c ? c : '广州';
}

/**
 * 全局请求节流：高德个人 key 的 QPS 上限是 3 次/秒，超了**不会**回「限流」，
 * 而是回 30001 `ENGINE_RESPONSE_DATA_ERROR` —— 和「这个地址查不到」长得一模一样，
 * 极易被误判成地址有问题（实测：同一批地址慢速单跑全过，连发就成片 30001）。
 *
 * 【为什么必须在 HTTP 这一层做】队列的 400ms 间隔是「单与单之间」，
 * 而一单内部是 geocode → POI 兜底 → transit 三次背靠背，瞬时能打到 5 次/秒。
 * 限流只能按「每次 HTTP 调用」算，按「每单」算必然漏。
 *
 * 350ms ≈ 2.9 次/秒，留一点余量。代价是 240 单灌库多花两三分钟，值得。
 */
const MIN_CALL_GAP_MS = 350;
let lastCallAt = 0;
let gate: Promise<void> = Promise.resolve();

function throttle(): Promise<void> {
  gate = gate.then(async () => {
    const wait = lastCallAt + MIN_CALL_GAP_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastCallAt = Date.now();
  });
  return gate;
}

async function amapGet<T extends AmapBase>(path: string, params: Record<string, string>): Promise<T> {
  await throttle();
  const url = new URL(`${BASE}${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (e) {
    // 网络层失败：超时、断网、DNS。这类错误值得重试一次（队列负责）
    throw new CommuteError(`请求高德失败：${e instanceof Error ? e.message : String(e)}`);
  }
  if (!res.ok) throw new CommuteError(`高德返回 HTTP ${res.status}`);

  const body = (await res.json()) as T;
  if (body.status !== '1') {
    // infocode 要留着：10001 是 key 无效，10003 是超配额，10009 是路径规划返回空，
    // 30001 是「引擎处理不了这个查询」（换个接口通常还有救）—— 处理方式完全不同
    const err = new CommuteError(`高德返回 ${body.info || '未知错误'}（infocode=${body.infocode}）`);
    err.infocode = body.infocode ?? null;
    throw err;
  }
  return body;
}

/** 「113.123456,23.654321」→ GeoPoint */
function parseLocation(location: string | null | undefined): GeoPoint | null {
  if (!location) return null;
  const [lng, lat] = location.split(',').map(Number);
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null;
  return { lng, lat };
}

/**
 * 高德的空值不一定是空串：查不到省/城市时它返回的是空数组 `[]`。
 * 直接当字符串用会变成 "[object Object]" 或 "undefined"，所以统一收口成 string | null。
 */
function pickStr(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

export class AmapProvider implements CommuteProvider {
  readonly name = 'amap';
  private readonly key: string;
  private readonly city: string;

  constructor(key: string, city?: string) {
    if (!key) throw new CommuteError('缺少高德 key');
    this.key = key;
    this.city = city || '广州';
  }

  /**
   * 一次 /geocode/geo 调用，只返回「高德说的城市 == 推断城市」的那条。
   *
   * `engineError` 对应 infocode 30001：**它不是网络错误**，是带 city 参数时高德引擎处理不了
   * 这串地址（同样是「同和同宝路星汇云城13栋 小北地铁A口200米」，去掉 city 就正常返回）。
   * 这种情况下不能直接判死，得让上层换 POI 搜索再救一次 —— 所以在这里收住、只打标记。
   */
  private async lookup(
    address: string,
    hint: CityHint,
  ): Promise<{ hit: AmapGeocodeItem | null; total: number; engineError: boolean }> {
    try {
      const body = await amapGet<AmapGeoResp>('/geocode/geo', {
        key: this.key,
        address,
        city: hint.city,
      });
      const list = body.geocodes ?? [];
      return {
        hit: list.find((g) => normalizeCity(pickStr(g.city)) === hint.city) ?? null,
        total: list.length,
        engineError: false,
      };
    } catch (e) {
      if (e instanceof CommuteError && e.infocode === '30001') return { hit: null, total: 0, engineError: true };
      throw e; // 10001（key 无效）、10003（超配额）这类是真故障，降级也没用
    }
  }

  /**
   * POI 关键字搜索 —— App 搜索框走的就是这个接口，用来补 geocode 的短板。
   *
   * 【为什么 geocode 不够，必须换接口而不是换写法】`/geocode/geo` 面向**标准地址**
   * （省 + 市 + 路 + 门牌号）。「天河壹品」这种只有小区名的地址，它当成不完整地址，
   * 直接退到「广东省广州市天河区」（区县中心）；而 `/place/text` 认的是 POI 名字，
   * 第一条就是「城投珠江·天河壹品」（健明三路）；「天河东荣瀚林苑」原文写错成「瀚」，
   * 也能靠容忍错字命中「东荣翰林苑」。实测这几个在 App 里能搜出来、我们却算不出来，
   * 就是因为之前一直用的是地理编码。
   *
   * 代价是它会返回一堆**无关** POI（「白云中海金沙湾」搜出来是达美乐、饭团），
   * 所以必须同时过城市、区名、名字覆盖率三道对账，宁可不认。
   */
  private async searchPoi(address: string, hint: CityHint): Promise<GeocodeResult | null> {
    const body = await amapGet<AmapPoiResp>('/place/text', {
      key: this.key,
      keywords: address,
      city: hint.city,
      citylimit: 'true', // 只在推断城市里搜，免得「珠江帝景」跑到山东
      offset: '5',
      page: '1',
      extensions: 'base',
    });

    const district = firstDistrict(address);
    for (const poi of body.pois ?? []) {
      if (normalizeCity(pickStr(poi.cityname)) !== hint.city) continue;
      // 公交线路 / 地铁线路（typecode 1507xx、1508xx）的坐标是整条线的代表点，不是能走到的地方。
      // 实测「普君北站地铁站附近」搜出来是「665路;743路;804路;981路」，名字还高度重合，必须挡掉。
      const type = pickStr(poi.typecode) ?? '';
      if (type.startsWith('1507') || type.startsWith('1508')) continue;
      const name = pickStr(poi.name);
      if (!name || poiNameCoverage(name, address) < 0.4) continue;
      // 地址里写了区名，POI 却在别的区 → 不是同一个地方（「白云区凯德广场」在黄埔也有一个）
      const adname = pickStr(poi.adname) ?? '';
      if (district && !adname.includes(district)) continue;
      const location = parseLocation(pickStr(poi.location));
      if (!location) continue;
      return {
        location,
        formatted: `${adname}${pickStr(poi.address) ?? ''}` || name,
        level: '兴趣点',
        city: normalizeCity(pickStr(poi.cityname)),
        adcode: pickStr(poi.adcode),
      };
    }
    return null;
  }

  /**
   * 地址 → 坐标。任何一道闸门过不去都**宁可失败也不给坐标**：
   *   1. 城市按地址推断（`inferCity`），不再一律按「广州」查
   *   2. geocode 返回里只认「高德说的城市 == 推断的城市」的那条，不盲取第 0 条
   *   3. 只匹配到区县/市/省、或落到别的区 → 判为不可信，拒收（`isDowngradedMatch`）
   *   4. 被拒时改走 POI 搜索（`searchPoi`），仍不行就失败
   *
   * 【第 2 条为什么必要】限定城市后高德仍会返回多条近似结果：
   * 查「桂城街道」在广州就同时给天河、番禺、荔湾三条，取第一条等于赌哪条排前面。
   *
   * 【第 4 条为什么要多花一次调用】见 `searchPoi` —— 小区名/楼宇名根本不在 geocode 的
   * 地址库里，换接口才能认出来。这类地址在真实数据里占一成多，错起来都是十几公里。
   */
  async geocode(address: string): Promise<GeocodeResult> {
    // GET 的 URL 长度有限：几单地址粘在一起的那种（实测有 400 多字的）会直接回 HTTP 413。
    // 截断了硬算等于拿半串地址去猜，不如说清楚让用户去修原文。
    if (address.length > 120) {
      throw new GeocodeMissError(`地址过长（${address.length} 字），像是几单的地址粘在一起了，先修原文再算`);
    }

    const hint = inferCity(address, this.city);

    const first = await this.lookup(address, hint);
    const hit = first.hit;
    const formatted = hit ? (pickStr(hit.formatted_address) ?? '') : '';
    const level = hit ? pickStr(hit.level) : null;

    if (hit && !isDowngradedMatch({ address, level, formatted, fromFallback: hint.source === 'fallback' })) {
      const location = parseLocation(pickStr(hit.location));
      if (location) {
        return { location, formatted, level, city: normalizeCity(pickStr(hit.city)), adcode: pickStr(hit.adcode) };
      }
    }

    // geocode 只给到区县 / 落到别的区 / 引擎直接 30001 → 换 POI 搜索再试一次
    let poi: GeocodeResult | null = null;
    try {
      poi = await this.searchPoi(address, hint);
    } catch (e) {
      // POI 也处理不了这串地址：不用把 30001 抛给用户，下面统一给「解析不了」
      if (!(e instanceof CommuteError && e.infocode === '30001')) throw e;
    }
    if (poi) return poi;

    if (hit) {
      throw new GeocodeMissError(
        `「${address}」只匹配到「${formatted}」（${level ?? '未知级别'}），位置对不上，算出来的通勤会整体偏移`,
      );
    }
    if (first.engineError) {
      throw new GeocodeMissError(`高德解析不了「${address}」（引擎返回异常），地址换个写法再试`);
    }
    throw new GeocodeMissError(
      first.total
        ? `高德在${hint.city}找不到「${address}」（返回的 ${first.total} 条都在别的城市）`
        : `高德在${hint.city}找不到「${address}」`,
    );
  }

  async planTransit(origin: GeoPoint, dest: GeoPoint, departAt: Date): Promise<CommuteOption[]> {
    const ymd = `${departAt.getFullYear()}${String(departAt.getMonth() + 1).padStart(2, '0')}${String(
      departAt.getDate(),
    ).padStart(2, '0')}`;
    const hm = `${String(departAt.getHours()).padStart(2, '0')}${String(departAt.getMinutes()).padStart(2, '0')}`;

    const body = await amapGet<AmapTransitResp>('/direction/transit/integrated', {
      key: this.key,
      origin: `${origin.lng},${origin.lat}`,
      destination: `${dest.lng},${dest.lat}`,
      // 这里的 city/cityd 是「起终点所在城市」，但高德实测按坐标走：同一对坐标传「广州/广州」
      // 与「佛山/佛山」返回的方案完全一致（2026-11-08 跨城冒烟：96/94 分钟、7/9 元）。
      // 所以跨城单算错**不在这里**，而在上面的地理编码 —— 不要为「支持佛山」去改这两个参数。
      city: this.city,
      cityd: this.city,
      strategy: '0', // 最快捷模式：与「通勤最短优先」的默认排序一致
      nightflag: '0',
      date: ymd,
      time: hm,
    });

    const transits = body.route?.transits ?? [];
    if (!transits.length) throw new CommuteError('高德没有返回可用的公交换乘方案');

    const departAtStamp = `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}T${hm.slice(0, 2)}:${hm.slice(2, 4)}`;

    const options = transits.map((t): CommuteOption => {
      const durationSec = Number(t.duration ?? 0);
      const segments = t.segments ?? [];
      // 换乘次数 = 需要「坐上去」的段数 - 1：步行段不算，城际铁路也算一段
      const rideSegments = segments.filter(
        (s) => (s.bus?.buslines?.length ?? 0) > 0 || Boolean(s.railway?.name),
      ).length;
      const lines = segments
        .map((s) => s.bus?.buslines?.[0]?.name ?? s.railway?.name ?? null)
        .filter((x): x is string => Boolean(x));
      const cost = Number(t.cost ?? '');
      return {
        mode: 'transit',
        minutes: Math.round(durationSec / 60),
        distance: Math.round(Number(t.distance ?? 0)),
        walking: Math.round(Number(t.walking_distance ?? 0)),
        // 高德可能返回空串：宁可 null，也不要把「不知道票价」写成 0 元
        fare: Number.isFinite(cost) ? cost : null,
        transfers: Math.max(0, rideSegments - 1),
        lines,
        departAt: departAtStamp,
      };
    });

    return options.sort((a, b) => a.minutes - b.minutes);
  }
}

/**
 * 有 key 就造一个，没有就返回 null。
 * 【为什么返回 null 而不是抛错】无 key 时整站必须照常可用（决策：通勤列显示「未配置」），
 * 让「没配 key」变成一种正常状态，而不是启动失败。
 */
export function createAmapProvider(env: NodeJS.ProcessEnv = process.env): AmapProvider | null {
  const key = amapKeyFromEnv(env);
  if (!key) return null;
  return new AmapProvider(key, cityFromEnv(env));
}
