/**
 * 通勤层的接口契约。
 *
 * 【为什么先定接口再写高德】通勤是唯一依赖外部付费/配额服务的一层：
 * 换地图厂商（百度、腾讯）、换出行方式（驾车、骑行）、或者干脆用假数据跑测试，
 * 都只该换一个实现，不该动上层编排。所以 service / queue 全部只认 `CommuteProvider`。
 *
 * 这一层是**纯类型 + 纯函数**，零 IO：测试直接 new 一个假 provider 就能跑，
 * 绝不消耗真实高德配额（见 CONTEXT 8.4「测试用假 provider」）。
 */

/** 经纬度。高德坐标系（GCJ-02），不做转换 */
export interface GeoPoint {
  lng: number;
  lat: number;
}

export interface GeocodeResult {
  location: GeoPoint;
  /** 高德归一化后的地址，仅用于校对，不覆盖原文地址 */
  formatted: string;
  /** 省/市/区/道路/门牌/兴趣点，命中的级别越细，通勤越可信 */
  level: string | null;
  /** 高德自己说的城市（已去掉「市」字）。留着是为了和地址里写的城市对账，也方便排查 */
  city: string | null;
  adcode: string | null;
}

/** 出行方式。当前只做公交（决策 6），驾车/骑行后续加实现即可 */
export type CommuteMode = 'transit';

/**
 * 通勤结论的「计算口径」版本，落进 `orders.commute_engine`。
 *
 * 【为什么结论要带版本】同一单地址没变、出发点没变，但代码改了（比如地理编码换了城市推断），
 * 旧结论就不可信了。只按「地址/出发点变没变」判断是否重算，会让错值一直挂在界面上 ——
 * 用户看到的还是那个 24 分钟。带上版本号后，口径一变，全库自动重算。
 *
 * v1（无此列）＝城市写死广州；v2＝按地址推断城市 + 城市对账 + 拒收降级匹配；
 * v3＝城市词与区名按出现位置竞争，并挡掉「中山一路」「东莞庄路」这种吃前缀的路名（v2 会把
 * 「越秀区中山一路梅花村」判成中山，然后在中山城里对账，只能报「定位不到」）。
 */
export const COMMUTE_ENGINE_VERSION = 'geocode-city-v3';

/**
 * 一套换乘方案。
 *
 * 【为什么全存而不是只存最快那条】决策 6 明确要「能看多种换乘方案」：
 * 最快的那套可能换乘 3 次、要走 800 米，真正愿意接的是「慢 5 分钟但只换一次」的那套。
 * 所以计划阶段一次调用就把 4 套全存进缓存，卡片显示最快一条，详情展开全部。
 */
export interface CommuteOption {
  mode: CommuteMode;
  /** 总耗时（分钟，四舍五入） */
  minutes: number;
  /** 全程距离（米，含步行） */
  distance: number;
  /** 步行距离（米） */
  walking: number;
  /** 票价（元）。高德不给就是 null，绝不填 0 冒充免费 */
  fare: number | null;
  /** 换乘次数：公交/地铁段数 - 1，纯步行方案为 0 */
  transfers: number;
  /** 线路名，按乘坐顺序，界面直接展示 */
  lines: string[];
  /** 该方案对应的出发时刻（ISO 本地串，进缓存键，保证每天算出来的数可比） */
  departAt: string;
}

export interface CommuteProvider {
  readonly name: string;
  geocode(address: string): Promise<GeocodeResult>;
  /** 一次调用返回多套方案，按耗时升序返回（接口不保证顺序，实现里自己排） */
  planTransit(origin: GeoPoint, dest: GeoPoint, departAt: Date): Promise<CommuteOption[]>;
}

export class CommuteError extends Error {
  /**
   * 高德的 infocode，例如 10001（key 无效）、10003（超配额）、30001（引擎处理不了这个查询）。
   * 【为什么要带出来】30001 不是「坏 key」也不是「网络断」——换个接口（POI 搜索）同一串地址
   * 往往能查到。上层据此决定「降级重试」还是「直接失败」，只看 message 字符串太脆。
   */
  infocode: string | null = null;

  // name 要显式设置：Node 的类型剥离不改类名，默认 name 会是 'Error'，日志里分不清是哪类失败
  constructor(message: string) {
    super(message);
    this.name = 'CommuteError';
  }
}

/** 当日配额用尽：不是「这家算不出来」，而是「今天不算了」，上层要停手并提示 */
export class QuotaExceededError extends CommuteError {
  constructor(message: string) {
    super(message);
    this.name = 'QuotaExceededError';
  }
}

/** 地址根本没法定位（高德返回空结果），跟网络错误区别对待：重试也没用 */
export class GeocodeMissError extends CommuteError {
  constructor(message: string) {
    super(message);
    this.name = 'GeocodeMissError';
  }
}

/** 描述一个 provider 有没有配 key —— 无 key 时全站照常，只是通勤列显示「未配置」 */
export interface ProviderInfo {
  configured: boolean;
  name: string | null;
  reason: string | null;
}
