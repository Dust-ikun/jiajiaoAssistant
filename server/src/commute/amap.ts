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

const BASE = 'https://restapi.amap.com/v3';
const TIMEOUT_MS = 8000;

interface AmapBase {
  status: string;
  info: string;
  infocode: string;
}

interface AmapGeoResp extends AmapBase {
  geocodes?: {
    formatted_address?: string;
    location?: string;
    level?: string;
  }[];
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

async function amapGet<T extends AmapBase>(path: string, params: Record<string, string>): Promise<T> {
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
    // infocode 要留着：10001 是 key 无效，10003 是超配额，10009 是路径规划返回空 —— 处理方式完全不同
    throw new CommuteError(`高德返回 ${body.info || '未知错误'}（infocode=${body.infocode}）`);
  }
  return body;
}

/** 「113.123456,23.654321」→ GeoPoint */
function parseLocation(location: string | undefined): GeoPoint | null {
  if (!location) return null;
  const [lng, lat] = location.split(',').map(Number);
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null;
  return { lng, lat };
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

  async geocode(address: string): Promise<GeocodeResult> {
    const body = await amapGet<AmapGeoResp>('/geocode/geo', {
      key: this.key,
      address,
      city: this.city,
    });
    const first = body.geocodes?.[0];
    const location = parseLocation(first?.location);
    if (!first || !location) {
      // 地址是真的定位不到（「（截图中被裁切，待补）」这类），不是网络问题，重试无意义
      throw new GeocodeMissError(`高德定位不到「${address}」`);
    }
    return {
      location,
      formatted: first.formatted_address ?? '',
      level: first.level ?? null,
    };
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
