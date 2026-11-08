/**
 * 地址 → 城市推断，以及「这次地理编码可不可信」的判定。
 *
 * 【为什么需要这一层】高德 `/geocode/geo` 的 `city` 参数是**硬限定**，不是「优先」。
 * 以前代码把 city 写死成「广州」，于是查「佛山市南海区桂城街道堑坊村」拿到的是
 * 「广州市天河区桂城街道」（113.3456,23.1440）—— 就在暨大石牌旁边 1 公里。
 * 这单算出来的通勤是 24 分钟 / 2 元 / B10 路，而真实佛山桂城是 96 分钟 / 7 元，
 * 差 4 倍，界面上完全看不出来（与「起点不能靠猜」是同一类错误：错在输入，看起来却像结论）。
 *
 * 【为什么不能干脆不传 city】实测同样致命：
 *   - 「珠江帝景（海珠区）」不限定 → 山东省潍坊市高密市珠江帝景（偏 1500 公里）
 *   - 「桂城街道堑坊村」不限定 → 广东省肇庆市鼎湖区桂城街道
 * 所以城市必须**由地址自己说清**，说不清就只能拒收，不能拿一个「看着像」的坐标去算。
 *
 * 这一层是纯函数、零 IO：测试直接传字符串断言，不需要网络也不需要真 key。
 */
import { CITIES, DISTRICTS } from '../parser/dict.ts';

/**
 * 佛山五区。广州十一个区与之没有同名，所以「地址里出现南海/顺德…」就等于「这单在佛山」，
 * 不需要先确认地址里有没有写「佛山市」—— 真实群消息里「南海桂城」「顺德大良」这种写法很常见。
 */
const FOSHAN_DISTRICTS = ['南海', '顺德', '禅城', '三水', '高明'];

/** 广州各区 = 解析层那份区名表减掉佛山五区（区名表是共用的，不另抄一份，免得两边漂移） */
const GUANGZHOU_DISTRICTS = DISTRICTS.filter((d) => !FOSHAN_DISTRICTS.includes(d));

/** 城市是怎么定下来的：越靠前越可信，fallback 意味着地址里连一点地理约束都没有 */
export type CitySource = 'explicit' | 'district' | 'fallback';

export interface CityHint {
  city: string;
  source: CitySource;
}

/**
 * 推断地址所属城市。
 *
 * 判序固定「先显式后隐含」：地址里写了城市就以它为准（多个城市并存取最先出现的，
 * 因为拼接串往往把真正那一单写在前面）；没写城市才看区名；都没有才用兜底。
 *
 * @param fallback 兜底城市（`AMAP_CITY`，默认广州）。fallback 出来的结果会被 `isDowngradedMatch` 判得更严。
 */
export function inferCity(address: string, fallback = '广州'): CityHint {
  const text = address.replace(/\s+/g, '');

  let explicit: { city: string; at: number } | null = null;
  for (const city of CITIES) {
    const at = text.indexOf(city);
    if (at >= 0 && (!explicit || at < explicit.at)) explicit = { city, at };
  }
  if (explicit) return { city: explicit.city, source: 'explicit' };

  if (FOSHAN_DISTRICTS.some((d) => text.includes(d))) return { city: '佛山', source: 'district' };
  if (GUANGZHOU_DISTRICTS.some((d) => text.includes(d))) return { city: '广州', source: 'district' };

  return { city: fallback, source: 'fallback' };
}

/** 高德返回的城市名带「市」字（广州市/佛山市），缓存键和对账都统一去掉 */
export function normalizeCity(city: string | null): string | null {
  return city ? city.replace(/市$/, '') : null;
}

/**
 * POI 名字有多少字出现在地址里（0~1），用来判断搜到的这个 POI 是不是地址说的那个地方。
 *
 * 【为什么需要它】POI 搜索是关键字模糊匹配，几乎总能返回点什么：
 *   搜「白云中海金沙湾」返回的是「达美乐比萨(锦佳店)」「阿杏饭团」——
 *   说明这个小区根本不在库里，高德只是拿几个字凑了凑。不校验名字，就会把这些无关 POI 当成地址。
 *
 * 算法看的是**POI 名里有多少字能在地址中找到**（而不是反过来）：
 *   「城投珠江·天河壹品」8 个字里 4 个能在「天河壹品」里找到 → 0.5
 *   「壹品服饰(时尚天河商业广场店)」13 个字里 4 个 → 0.31
 *   以地址为分母会两者都等于 1.0，分不出哪个才是真的。
 *
 * 阈值取 0.4：实测「城投珠江·天河壹品」0.5、「东荣翰林苑」（原文错写成「瀚」）0.8、
 * 「易通大厦」1.0 都能过；无关 POI 基本在 0.3 以下。
 */
export function poiNameCoverage(poiName: string, address: string): number {
  const strip = (s: string) => s.replace(/[\s()（）·・,，。.\-—_/\\]/g, '');
  const name = strip(poiName);
  if (!name) return 0;
  const chars = new Set(name);
  const pool = new Set(strip(address));
  let hit = 0;
  for (const ch of chars) if (pool.has(ch)) hit++;
  return hit / chars.size;
}

/**
 * 大到不能用来算通勤的级别：一个市、一个区、一个开发区。
 *
 * 【为什么和下面的乡镇/村庄分开】这两类差着一个量级：
 *   - 「天河壹品」被退到「广东省广州市天河区」= 整个区的几何中心，离真实小区可能 5~8 公里，
 *     通勤差二十分钟以上，而且**区名还是对的**，肉眼根本看不出问题；
 *   - 「桂城街道」这种街道级，范围就两三公里，通勤差几分钟，拿来排序够用了。
 * 所以区县及以上一律拒收，街道/村庄级留一条活路（靠区名对账把关）。
 */
export const TOO_COARSE_LEVELS = new Set(['国家', '省', '市', '区县', '开发区']);

/** 粗到需要额外把关的级别（含街道/村庄）：地址连城市都没写时，落到这个级别就纯属猜了 */
export const COARSE_LEVELS = new Set([...TOO_COARSE_LEVELS, '乡镇', '村庄']);

/** 地址里最先出现的区名（「天河区…在海珠区旁边」这种取天河） */
export function firstDistrict(text: string): string | null {
  let hit: { district: string; at: number } | null = null;
  for (const d of DISTRICTS) {
    const at = text.indexOf(d);
    if (at >= 0 && (!hit || at < hit.at)) hit = { district: d, at };
  }
  return hit?.district ?? null;
}

export interface DowngradeInput {
  /** 原始地址（单子里写的） */
  address: string;
  /** 高德返回的 level，可能是 null */
  level: string | null;
  /** 高德返回的格式化地址 */
  formatted: string;
  /** 地址里既没有城市也没有区名，只能靠 fallback 猜 */
  fromFallback: boolean;
}

/**
 * 这次匹配能不能用。
 *
 * 三条，任何一条命中就拒收：
 *   1. 只匹配到「区县/市/省」—— 那是整个区的几何中心。实测「天河壹品」被退到「广东省广州市天河区」，
 *      离真实小区好几公里；「黄埔大道易通大厦」更离谱，退到整个黄埔区（15 公里外）。
 *      注意这类错**区名还是对的**，所以不能只靠区名对账。
 *   2. 地址写了区名，结果却落在别的区 —— 「珠江帝景（海珠区）」被解析到「黄埔区珠江」。
 *   3. 地址里连城市都没有，还只匹配到街道/村庄 —— 没有任何地理约束，纯属猜。
 *
 * 【为什么这三条必须拦住】它们算出来的通勤看着完全正常（十几二十分钟、两三块钱），
 * 但对应的是城市另一头的某个中点。用户不会去核对，只会照着这个数决定接不接。
 */
export function isDowngradedMatch(input: DowngradeInput): boolean {
  const level = (input.level ?? '').trim();

  // 1. 整个区/市：不论区名对不对，都不能用
  if (TOO_COARSE_LEVELS.has(level)) return true;

  // 2. 落到了别的区
  const district = firstDistrict(input.address);
  if (district && !input.formatted.includes(district)) return true;

  // 3. 无城市无区名 + 街道/村庄级
  return input.fromFallback && COARSE_LEVELS.has(level);
}
