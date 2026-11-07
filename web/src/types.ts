export type OrderStatus = 'new' | 'seen' | 'contacted' | 'discarded';

/** 可接性三态。后端 `match/match.ts` 的判定结果，列表接口随每条单子一起返回 */
export type Verdict = '可接' | '存疑' | '不可接';

export interface MatchReason {
  dimension: string;
  verdict: '存疑' | '不可接';
  detail: string;
}

export interface MatchResult {
  verdict: Verdict;
  /** 只记不通过的维度；通过的维度不占位置 */
  reasons: MatchReason[];
}

/** 分档薪水，如 `一本100/小时，92/研究生110-120/小时` */
export interface SalaryTier {
  label: string | null;
  min: number;
  max: number;
  unit: 'hour' | 'session' | 'month' | 'day';
}

/** 通勤状态：null = 还没算；ok = 算到了；failed = 试过但失败（error 里有原因） */
export type CommuteState = 'ok' | 'failed' | null;

export interface Order {
  id: number;
  orderNo: string | null;
  statusTag: string | null;
  /** 消息发送时间。列表的「新不新」只能看它，绝不看导入时间 */
  sentAt: string | null;
  district: string | null;
  area: string | null;
  address: string | null;
  stage: string | null;
  gradeNum: number | null;
  gradeText: string | null;
  studentCount: number | null;
  studentGender: string | null;
  mode: string | null;
  subjects: string[];
  subjectTags: string[];
  freqPerWeek: number | null;
  hoursPerSession: number | null;
  schedule: string | null;
  salaryRaw: string | null;
  salaryMin: number | null;
  salaryMax: number | null;
  salaryUnit: 'hour' | 'session' | 'month' | 'day' | null;
  salaryHourly: number | null;
  salaryTiers: SalaryTier[];
  teacherReq: string | null;
  notes: string | null;
  rawText: string;
  confidence: 'high' | 'medium' | 'low';
  warnings: string[];
  status: OrderStatus;
  starred: boolean;
  remark: string | null;
  firstSeen: string;
  lastSeen: string;
  occurrences: number;

  commuteStatus: CommuteState;
  /** 最快那套方案的总耗时（分钟） */
  commuteMinutes: number | null;
  commuteDistance: number | null;
  commuteTransfers: number | null;
  commuteFare: number | null;
  commuteError: string | null;
  commuteCheckedAt: string | null;

  match: MatchResult;
}

export interface Facet {
  value: string;
  count: number;
}

export interface Meta {
  total: number;
  fresh: number;
  districts: Facet[];
  stages: Facet[];
  subjects: Facet[];
  modes: Facet[];
}

export interface CommuteOption {
  mode: 'transit';
  minutes: number;
  distance: number;
  walking: number;
  fare: number | null;
  transfers: number;
  lines: string[];
  departAt: string;
}

/** 通勤现在为什么算不动。三种原因在界面上必须能分开显示 */
export type CommuteBlocker = 'no_key' | 'no_origin' | 'quota' | null;

export interface CommuteStatus {
  provider: { configured: boolean; name: string | null; reason: string | null };
  origin: { id: number; name: string; address: string; lng: number | null; lat: number | null } | null;
  blockedBy: CommuteBlocker;
  queued: number;
  busy: boolean;
  ready: number;
  pending: number;
  quota: { limit: number; used: number; remaining: number; exhausted: boolean };
  lastError: string | null;
}

/**
 * 一条「通勤有问题」的单：算不出（failed）或还没轮到（pending）。
 * 它们不出现在按通勤排序的列表里，只能从设置面板的清单里看。
 */
export interface CommuteIssue {
  id: number;
  orderNo: string | null;
  address: string | null;
  status: 'failed' | 'pending';
  error: string | null;
  checkedAt: string | null;
}

export interface CommuteIssues {
  failed: number;
  pending: number;
  items: CommuteIssue[];
}

export interface OrdersResponse {
  total: number;
  items: Order[];
  profileError: string | null;
  /** 实际用的排序 */
  sort: SortKey;
  /** true = 请求的通勤排序没料，降级成按时薪排（界面要说出来） */
  sortFallback: boolean;
  commute: CommuteStatus;
  commuteEnqueued: number;
  commuteCandidates: number;
}

export interface OrderCommuteDetail {
  orderId: number;
  status: CommuteState;
  minutes: number | null;
  distance: number | null;
  transfers: number | null;
  fare: number | null;
  departAt: string | null;
  checkedAt: string | null;
  error: string | null;
  options: CommuteOption[];
}

export type SortKey = 'hourly' | 'newest' | 'salary' | 'commute';

/* ------------------------------------------------------------------ *
 * 阶段 7：资质 / 出发点 / 导入体检
 * 枚举值必须与 server/src/profile.ts 逐字一致 —— 后端校验很硬，
 * 这里多写一个空格都会换来一个 400。
 * ------------------------------------------------------------------ */

export type Gender = '男' | '女';
export type SchoolTier = '985' | '211' | '一本';
export type Degree = '本科' | '硕士' | '博士';
export type TeacherType = '大学生' | '专职' | '在职';
export type MajorCategory = '理科' | '工科' | '文科' | '商科' | '艺术';

/** 「我的资质」，落 server 的 data/profile.json，改完下一次请求即生效 */
export interface Profile {
  name: string | null;
  gender: Gender | null;
  /** 学校名只用于展示，判定看 schoolTier */
  school: string | null;
  schoolTier: SchoolTier | null;
  degree: Degree | null;
  teacherType: TeacherType | null;
  majors: string[];
  majorCategory: MajorCategory | null;
  certificates: string[];
  languages: string[];
  /** 策略而非事实：默认 true = 凡「要求有经验」一律放行（用户 2026-11-05 定） */
  hasExperience: boolean;
}

export interface ProfileResponse {
  profile: Profile;
  /** 读资质失败的原因（文件写坏了），非 null 时判定全部失效 */
  error: string | null;
  path: string;
}

/** 出发点。地址一改坐标就作废（后端置 NULL），通勤会重算 */
export interface Origin {
  id: number;
  name: string;
  address: string;
  lng: number | null;
  lat: number | null;
  isDefault: boolean;
  createdAt: string;
}

/** 单条单子的体检结果 */
export interface OrderDiagnostic {
  orderNo: string | null;
  /** 切块用的锚点类型；null = 没命中任何锚点（多半是噪声块） */
  anchorKind: string | null;
  confidence: 'high' | 'medium' | 'low' | string;
  warnings: string[];
  missingFields: string[];
  sentAt: string | null;
}

export interface ImportDiagnostics {
  lines: number;
  anchors: { kind: string; count: number }[];
  orders: OrderDiagnostic[];
  /** true = 整段文本一个单子都没切出来 */
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

/** 剪贴板自动导入的一次摘要（后端只给编号与计数，不含正文） */
export interface CaptureRecord {
  at: string;
  orders: number;
  inserted: number;
  duplicated: number;
  orderNos: string[];
}

export interface CaptureStatus {
  supported: boolean;
  running: boolean;
  /** 没开或开不了的原因 */
  reason: string | null;
  recent: CaptureRecord[];
}

/** 锚点类型 → 中文说明。左边是 parse.ts 的 AnchorKind，右边是「这长什么样」 */
export const ANCHOR_LABEL: Record<string, string> = {
  hashId: '#1138',
  cityLabel: '广州线下: ZX2201#新单',
  emojiId: '🏄 susu2610501',
  numJiajiao: '110512号家教',
  alnumDot: 'ZXGZ20261103.2',
  labelId: '家教编号: 2026101803',
  none: '无锚点',
};

export const GENDER_OPTIONS: Gender[] = ['男', '女'];
export const SCHOOL_TIER_OPTIONS: SchoolTier[] = ['985', '211', '一本'];
export const DEGREE_OPTIONS: Degree[] = ['本科', '硕士', '博士'];
export const TEACHER_TYPE_OPTIONS: TeacherType[] = ['大学生', '专职', '在职'];
export const MAJOR_CATEGORY_OPTIONS: MajorCategory[] = ['理科', '工科', '文科', '商科', '艺术'];

export interface Filters {
  q: string;
  districts: string[];
  stages: string[];
  subjects: string[];
  modes: string[];
  statuses: string[];
  verdict: '' | Verdict;
  minHourly: string;
  /** 只看通勤不超过 N 分钟的单子（未算完的一律不进） */
  maxCommuteMinutes: string;
  starredOnly: boolean;
  sort: SortKey;
}

export const STATUS_LABEL: Record<OrderStatus, string> = {
  new: '新单',
  seen: '已看',
  contacted: '已联系',
  discarded: '放弃',
};

export const UNIT_LABEL: Record<string, string> = {
  hour: '/小时',
  session: '/次',
  month: '/月',
  day: '/天',
};

export const VERDICTS: Verdict[] = ['可接', '存疑', '不可接'];

export const SORT_LABEL: Record<SortKey, string> = {
  commute: '按通勤最短',
  hourly: '按时薪排序',
  newest: '按最新排序',
  salary: '按原始薪水排序',
};
