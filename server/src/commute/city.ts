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

/** 城市是怎么定下来的：越靠前越可信，fallback 意味着地址里连一点地理约束都没有 */
export type CitySource = 'explicit' | 'district' | 'fallback';

export interface CityHint {
  city: string;
  source: CitySource;
}

/**
 * 城市词后面紧跟这些东西，说明它是**路名**不是城市名：
 * 「中山一路」「中山八路」「中山大道」「东莞庄路」「广州大道中」。
 *
 * 【为什么必须挡】实测「越秀区中山一路梅花村」里的「中山」让城市推断落到广东省中山市，
 * 而中山真有一条中山一路、level 还是「道路」—— 城市对账反而通过了，区名对账才把它拦下，
 * 最终只能报「只匹配到广东省中山市中山一路」。错在第一层输入，后面所有闸门都在错的城里对账。
 */
const ROAD_SUFFIX = /^[\u4e00-\u9fa5]{0,2}(路|道|街|桥|巷|涌|站)/;

/**
 * 这个位置上的城市词，是真的在说「这个城市」吗。
 *
 * 三层判据，从硬到软：
 *   1. 后面紧跟「市」（广州市、中山市）—— 最硬，一定是城市
 *   2. 后面紧跟区名（广州番禺、佛山南海）—— 同样是城市
 *   3. 后面接路名特征（中山一路、东莞庄路）—— 是路名，不是城市
 *   4. 剩下的裸城市词只认**串首**（「广州桥南」「深圳南山」这类省略写法都在开头），
 *      出现在地址中段的裸城市词（「天河区广州大道中」）一律不当城市
 *
 * @param at 城市词在去空白文本里的起始下标
 */
function isCityWordAt(text: string, city: string, at: number): boolean {
  const rest = text.slice(at + city.length);
  if (rest.startsWith('市')) return true;
  if (DISTRICTS.some((d) => rest.startsWith(d))) return true;
  if (ROAD_SUFFIX.test(rest)) return false;
  return at === 0;
}

/**
 * 推断地址所属城市。
 *
 * 【判序为什么改成「谁先出现谁说话」】城市词优先的老判序有个致命漏洞：
 * 城市名会被路名吃掉一个前缀。「越秀区中山一路梅花村」里「越秀」明明写在最前面、
 * 是更强的地理约束，却因为「中山」属于城市词表而被判成广东省中山市。
 * 现在城市词与区名一起按**出现位置**竞争，靠前的那一个说了算 —— 与
 * `firstDistrict()`（「番禺区大石街道…和樾府」取番禺不取越秀）是同一套口径。
 *
 * 同时城市词本身要先过 `isCityWordAt`：带「市」、后面跟区名、或在串首才算数，
 * 否则「中山一路」「东莞庄路」这类路名会把整单搬到另一个城市去。
 *
 * @param fallback 兜底城市（`AMAP_CITY`，默认广州）。fallback 出来的结果会被 `isDowngradedMatch` 判得更严。
 */
export function inferCity(address: string, fallback = '广州'): CityHint {
  const text = address.replace(/\s+/g, '');

  // 候选只有一个：所有「城市词 / 区名」按其出现位置竞争，位置最小者胜出
  let best: { city: string; at: number; source: CitySource } | null = null;

  for (const city of CITIES) {
    const at = text.indexOf(city);
    if (at < 0) continue;
    if (!isCityWordAt(text, city, at)) continue;
    // 多个城市并存取最先出现的：拼接串往往把真正那一单写在前面
    if (!best || at < best.at) best = { city, at, source: 'explicit' };
  }

  for (const district of DISTRICTS) {
    const at = text.indexOf(district);
    if (at < 0) continue;
    // 城市词已经更靠前 → 区名不参与（「广州市番禺区」以广州为准）
    if (best && at >= best.at) continue;
    best = { city: FOSHAN_DISTRICTS.includes(district) ? '佛山' : '广州', at, source: 'district' };
  }

  return best ? { city: best.city, source: best.source } : { city: fallback, source: 'fallback' };
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
