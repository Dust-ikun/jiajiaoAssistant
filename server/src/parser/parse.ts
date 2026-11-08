import { createHash } from 'node:crypto';
import {
  AREA_SUFFIXES,
  CN_NUM,
  DISTRICTS,
  FIELD_ALIASES,
  SUBJECT_ABBR,
  SUBJECT_MAIN,
  SUBJECT_TAGS,
  type FieldKey,
} from './dict.ts';

export type Stage = '幼儿' | '小学' | '初中' | '高中';
export type Mode = '上门' | '线上' | '机构';
export type SalaryUnit = 'hour' | 'session' | 'month' | 'day';
export type Confidence = 'high' | 'medium' | 'low';

/** 分档薪水的一条，如「一本100/小时」「92/研究生110-120/小时」 */
export interface SalaryTier {
  label: string | null;
  min: number;
  max: number;
  unit: SalaryUnit | null;
}

export interface ParsedOrder {
  orderNo: string | null;
  /** 命中的锚点类型（hashId / cityLabel / …），导入体检要用它统计切块来源 */
  anchorKind: AnchorKind | null;
  /** 锚点行自带的标记（如 T1 的「#新单」），必须和编号分开，否则去重失效 */
  statusTag: string | null;
  /** 消息发送时间（来自消息里的时间头，不是导入时间） */
  sentAt: string | null;
  district: string | null;
  area: string | null;
  address: string | null;
  stage: Stage | null;
  gradeNum: number | null;
  gradeText: string | null;
  studentCount: number | null;
  studentGender: '男' | '女' | null;
  mode: Mode | null;
  subjects: string[];
  subjectTags: string[];
  freqPerWeek: number | null;
  hoursPerSession: number | null;
  schedule: string | null;
  salaryRaw: string | null;
  salaryMin: number | null;
  salaryMax: number | null;
  salaryUnit: SalaryUnit | null;
  /** 折算时薪（元/小时）。月薪会按 频次×单次时长 折算，无法折算时为 null */
  salaryHourly: number | null;
  salaryTiers: SalaryTier[];
  teacherReq: string | null;
  notes: string | null;
  rawText: string;
  confidence: Confidence;
  warnings: string[];
  dedupeKey: string;
}

/* ------------------------------------------------------------------ *
 * 一、字段语法：一条正则覆盖「无包裹 / 【】/ 『』/ 「」/ [] / （）」四种包装
 * ------------------------------------------------------------------ */

const OPEN_TO_CLOSE: Record<string, string> = {
  '【': '】',
  '『': '』',
  '「': '」',
  '[': ']',
  '（': '）',
  '(': ')',
};

const OPENERS = Object.keys(OPEN_TO_CLOSE).join('');
const CLOSERS = new Set(Object.values(OPEN_TO_CLOSE));
const NAME_CHAR = /[\u4e00-\u9fa5A-Za-z]/;

/**
 * 解析一行「字段名 + 值」。
 *
 * 【为什么不写成一条大正则】字段名可长可短（`地址` / `对老师要求`），无冒号时
 * 还要能切出值（`【地址】广州市…`）。所以先抠出开头的连续「中文字/字母」段，
 * 再从中**从长到短**找字典命中最长的那个别名 —— 这样 `学员地址` 不会被 `学员` 抢走。
 *
 * 三条校验（对应 docs/CONTEXT.md 8.1）：
 * 1. 左右包裹符必须配对（`【信息费收取标准】…：` 这种通告行就是靠这条被挡掉的）
 * 2. 字段名必须命中词典
 * 3. 冒号可有可无；但「无包裹且无冒号」只认值以数字/字母/符号开头的紧凑写法，
 *    否则任何一句话都能被当成字段（宁可漏，不可乱认）
 */
export function readFieldLine(raw: string): { key: FieldKey; value: string } | null {
  const line = raw.trim();
  if (!line) return null;

  let i = 0;
  let opener = '';
  if (OPENERS.includes(line[0])) {
    opener = line[0];
    i = 1;
  }

  let j = i;
  while (j < line.length && NAME_CHAR.test(line[j])) j++;
  const run = line.slice(i, j);
  if (!run) return null;

  let key: FieldKey | undefined;
  let nameLen = 0;
  for (let len = Math.min(run.length, 10); len >= 1; len--) {
    const hit = FIELD_ALIASES[run.slice(0, len)];
    if (hit) {
      key = hit;
      nameLen = len;
      break;
    }
  }
  if (!key) return null;

  let k = i + nameLen;
  if (opener) {
    while (line[k] === ' ') k++;
    if (line[k] !== OPEN_TO_CLOSE[opener]) return null; // 包裹符没配对 → 不是字段行
    k++;
  } else if (line[k] !== undefined && CLOSERS.has(line[k])) {
    return null; // 有右包裹符却没有左包裹符
  }

  while (line[k] === ' ' || line[k] === '\u3000') k++;
  let hadColon = false;
  if (line[k] === ':' || line[k] === '：') {
    hadColon = true;
    k++;
  }
  while (line[k] === ' ' || line[k] === '\u3000') k++;

  const value = line.slice(k).trim();
  if (!opener && !hadColon) {
    if (nameLen < 2) return null;
    if (!/^[\dA-Za-z+\-~（(]/.test(value)) return null;
  }

  return { key, value };
}

export function looksLikeFieldLine(line: string): boolean {
  return readFieldLine(line) !== null;
}

/* ------------------------------------------------------------------ *
 * 二、锚点池：六个群六种编号写法，一条正则一种，任取其一即视为「新单开头」
 * ------------------------------------------------------------------ */

export type AnchorKind = 'hashId' | 'cityLabel' | 'emojiId' | 'numJiajiao' | 'alnumDot' | 'labelId';

export interface AnchorHit {
  kind: AnchorKind;
  orderNo: string;
  statusTag: string | null;
}

/**
 * 去掉编号里的 # 与空白：`202601002#` → `202601002`，`ZXGZ#20261103.3` → `ZXGZ20261103.3`。
 * 【为什么内部 # 也要剥】T4 的三条单子同时出现 `ZXGZ20261103.2` 和 `ZXGZ#20261103.3`，
 * 说明 # 只是分隔装饰；保留会让同一套编号被当成两套，去重失效。
 */
function normalizeOrderNo(raw: string): string {
  return raw.replace(/[#＃\s]/g, '').trim();
}

/** 把编号行行尾那段备注洗成标签：去掉 ＃、方括号、多余空白 */
function cleanTag(raw: string | undefined): string | null {
  if (!raw) return null;
  const t = raw
    .replace(/[#＃[\]]/g, ' ')
    .replace(/[（(]\s*[)）]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return t || null;
}

const CITY_WORDS = '广州|广东|佛山|深圳|东莞|中山|珠海|惠州';

const ANCHOR_RULES: { kind: AnchorKind; test: (line: string) => AnchorHit | null }[] = [
  {
    // T5：独立一行的 #1138（也容忍行尾一小段备注，如 `#1138 急单`）
    kind: 'hashId',
    test: (line) => {
      const m = line.match(/^[#＃]\s*(\d{3,})(?:[\s　]+(.{1,16}))?$/);
      return m ? { kind: 'hashId', orderNo: m[1], statusTag: cleanTag(m[2]) } : null;
    },
  },
  {
    /**
     * 城市词 + 编号，八种写法一族收掉。
     *
     * 真实粘进来的写法（同一次粘贴里就全有）：
     *   广州线下: ZX2201#新单
     *   广州线下：ZX2208#新单            ← 全角冒号
     *   深圳线下🍔WHR26110402            ← 没冒号，城市词后面直接跟 emoji + 编号
     *   广东线下TFY🌧️26110602＃新单     ← 编号中间还夹着 emoji
     *   广州线下🌧️TFY2510106＃老家长回购寒暑假预约单🔥
     *   广州110208       回收单♻️        ← 纯数字编号 + 尾注
     *   广州HS110454         回收单♻️
     *   广州1105126
     *
     * 【为什么先「洗」再匹配】这些写法的差别全在装饰符上（冒号、emoji、全角空格、连续空格）。
     * 逐个写正则就是六个正则、改一个漏五个 —— 现场已经吃过一次亏（`ZXGZ20261104.2  机构单618`
     * 匹配不上，第二单被并进第一单）。所以统一先剥掉「汉字/字母/数字/＃」以外的一切，再匹配，
     * 剩下的部分就是干净的三段：城市词、编号里的字母前缀、数字、尾巴。
     *
     * 洗掉装饰符会不会误伤？字段行以汉字开头（`学员地址：`、`上课次数：`），洗完了也不以城市词开头，
     * 而且这里还要求「城市词之后必须紧跟 ≥3 位数字」，所以 `广州家教`「广州南站ICC…」这类行仍然不是锚点。
     */
    kind: 'cityLabel',
    test: (line) => {
      const s = line.replace(/[^\p{L}\p{N}＃#]/gu, '');
      const m = s.match(new RegExp(`^(${CITY_WORDS})(?:线下|上门|线上)?([A-Za-z]{0,6})(\\d{3,})(.{0,24})$`, 'u'));
      if (!m) return null;
      const code = `${m[2]}${m[3]}`;
      // 纯数字编号至少 4 位，否则「广州地铁3号线」这种也会被当成编号
      if (!m[2] && m[3].length < 4) return null;
      return { kind: 'cityLabel', orderNo: normalizeOrderNo(code), statusTag: cleanTag(m[4]) };
    },
  },
  {
    // T2：🏄 susu2610501（emoji + 字母数字编号）
    kind: 'emojiId',
    test: (line) => {
      const m = line.match(/^[^\p{L}\p{N}\s]{1,4}\s*([A-Za-z]{1,12}\d{4,})$/u);
      return m ? { kind: 'emojiId', orderNo: m[1], statusTag: null } : null;
    },
  },
  {
    // T3：110512号家教
    kind: 'numJiajiao',
    test: (line) => {
      const m = line.match(/^(\d{4,})\s*号家教/);
      return m ? { kind: 'numJiajiao', orderNo: m[1], statusTag: null } : null;
    },
  },
  {
    /**
     * 字母编号 + 可选点号：ZXGZ20261103.2 / ZXGZ#20261103.3 / AEJ102301 / LL11.5回收（梧桐）
     *
     * 现场出现过三种变形，全都是「编号后面还跟着一段人话」：
     *   ZXGZ20261104.2  机构单618        ← 两个空格 + 备注
     *   ZXGZ#202617.3   继续派  #八折     ← 备注里还有第二个 #
     *   AEJ110505短期单子                 ← 紧贴着，没有空格
     * 原来的正则要求「整行只有编号」，这些行全都匹配不上，于是后一单的字段被并进前一单
     * （地址被后者覆盖、要求被两张单子的句子缝在一起）—— 界面上就是「两单没切好」。
     *
     * 现在：编号后面的部分一律当 statusTag（`机构单618`、`继续派 八折` 本身就是标签）。
     * 唯一保留的限制是**尾巴里不许有冒号** —— 有冒号说明这是一行「编号 字段：值」，
     * 不是编号行，得留给字段解析。
     */
    kind: 'alnumDot',
    test: (line) => {
      const m = line.match(/^([A-Za-z]{2,}[#＃]?\d{2,}(?:\.\d+)?)\s*(.{0,24})$/);
      if (!m) return null;
      if (/[:：]/.test(m[2])) return null;
      return { kind: 'alnumDot', orderNo: normalizeOrderNo(m[1]), statusTag: cleanTag(m[2]) };
    },
  },
  {
    // T6：家教编号: 2026101803 / 【家教编号】gz31511106 / 编号：GZ505718143F110610
    kind: 'labelId',
    test: (line) => {
      const m = line.match(
        /^[【\[]?\s*(?:家教编号|编号|单号|订单编号|信息编号)\s*[】\]]?\s*[:：]?\s*([A-Za-z0-9][A-Za-z0-9#-]{2,})$/u,
      );
      return m ? { kind: 'labelId', orderNo: normalizeOrderNo(m[1]), statusTag: null } : null;
    },
  },
];

/** 判序固定：先锚点，后字段。`广州线下: ZX2201#新单` 在语法上也像「名称: 值」 */
export function matchAnchor(line: string): AnchorHit | null {
  const t = line.trim();
  if (!t) return null;
  for (const rule of ANCHOR_RULES) {
    const hit = rule.test(t);
    if (hit) return hit;
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * 三、噪声与时间游标
 * ------------------------------------------------------------------ */

const SENT_AT_RE = /(20\d{2})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日\s*(\d{1,2})\s*[:：]\s*(\d{2})/;

/** 从「上门家教073（朝九晚六周日休息）    2026年11月5日 14:58」这种时间头里取发送时间 */
export function matchSentAt(line: string): string | null {
  const m = line.match(SENT_AT_RE);
  if (!m) return null;
  const pad = (s: string) => s.padStart(2, '0');
  return `${m[1]}-${pad(m[2])}-${pad(m[3])}T${pad(m[4])}:${m[5]}:00`;
}

/**
 * 噪声行：不是单子内容的公告、话题、收费规则。
 * 字段行优先判定 —— `【信息费】: 报价算` 是字段，`【信息费收取标准】` 才是噪声。
 */
const NOISE_PATTERNS: RegExp[] = [
  /^[#＃]\s*[^\d]/, // 独立成行的话题标记：# 带相关证书投递 / #加急
  /信息费|试课收费|退费标准|跑行|同行|放心接/,
  /^(?:这些单|大家可以)/,
  // 群头：`广州家教`、`广州家教#家长只要华师男生`。它写在编号上面，不剥掉会被并进上一单的字段
  new RegExp(`^(?:${CITY_WORDS})?家教(?:[#＃]|$)`),
  // 夹在单子里的小广告（`招小助理啦❣线上操作，时间自由…`），不是单子内容
  /招小助理|时间自由福利/,
];

export function isNoiseLine(line: string): boolean {
  const t = line.trim();
  if (!t) return true;
  if (looksLikeFieldLine(t)) return false;
  if (matchSentAt(t)) return true; // 时间头只提供时间游标，不进正文
  return NOISE_PATTERNS.some((re) => re.test(t));
}

/** 单独一行的区名，如「南沙区」。它写在编号上面，语义属于下一块 */
function isPureDistrictLine(line: string): boolean {
  const t = line.trim().replace(/[市\s]/g, '');
  if (!t || t.length > 5) return false;
  return DISTRICTS.some((d) => t === `${d}区` || t === d);
}

/* ------------------------------------------------------------------ *
 * 四、切块
 * ------------------------------------------------------------------ */

function normalizeLines(input: string): string[] {
  return input
    .replace(/\u200b|\ufeff/g, '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    // 去掉行首的列表序号：1、 2. ① 等
    .map((l) => l.replace(/^\s*\d{1,3}\s*[、.．)）]\s*/, '').trim())
    .map((l) => l.replace(/\u3000/g, ' '));
}

export interface RawBlock {
  lines: string[];
  regionHint: string | null;
  sentAt: string | null;
  anchor: AnchorHit | null;
}

/**
 * 把一段聊天记录切成多个单子。
 *
 * 【为什么先找锚点】六套模板里唯一可靠的边界信号就是编号行；
 * 空行分段在微信里根本不成立（用户复制时分多次、也不带空行）。
 */
export function splitBlocks(input: string, fallbackSentAt: string | null = null): RawBlock[] {
  const lines = normalizeLines(input);

  const anchors: { index: number; hit: AnchorHit; sentAt: string | null }[] = [];
  let cursor = fallbackSentAt;
  for (let i = 0; i < lines.length; i++) {
    const t = matchSentAt(lines[i]);
    if (t) cursor = t;
    const hit = matchAnchor(lines[i]);
    if (hit) anchors.push({ index: i, hit, sentAt: cursor });
  }

  if (!anchors.length) return splitByBlank(lines, fallbackSentAt);

  // 起点要往前吃「单独成行的区名」（如 T6 的「南沙区」），它属于下一块而不是上一块
  const starts: number[] = [];
  for (let k = 0; k < anchors.length; k++) {
    const lowerBound = k === 0 ? 0 : anchors[k - 1].index + 1;
    let start = anchors[k].index;
    while (start - 1 >= lowerBound && isPureDistrictLine(lines[start - 1])) start--;
    starts.push(start);
  }

  const blocks: RawBlock[] = [];
  for (let k = 0; k < anchors.length; k++) {
    const end = k + 1 < anchors.length ? starts[k + 1] : lines.length;
    const body = lines.slice(starts[k], end).filter((l) => l !== '' && !isNoiseLine(l));
    if (!body.some(looksLikeFieldLine)) continue; // 只有编号没有字段 → 不是单子
    const regionHint = body.find(isPureDistrictLine) ?? null;
    blocks.push({ lines: body, regionHint, sentAt: anchors[k].sentAt, anchor: anchors[k].hit });
  }
  return blocks;
}

/** 没有锚点时的兜底：靠空行分段，且必须至少有两个字段行 */
function splitByBlank(lines: string[], fallback: string | null): RawBlock[] {
  const out: RawBlock[] = [];
  let cur: string[] = [];
  let cursor = fallback;
  const flush = () => {
    const body = cur.filter((l) => l !== '' && !isNoiseLine(l));
    cur = [];
    if (!body.length || body.filter(looksLikeFieldLine).length < 2) return;
    out.push({ lines: body, regionHint: body.find(isPureDistrictLine) ?? null, sentAt: cursor, anchor: null });
  };
  for (const l of lines) {
    const t = matchSentAt(l);
    if (t) cursor = t;
    if (l === '') {
      flush();
      continue;
    }
    cur.push(l);
  }
  flush();
  return out;
}

/* ------------------------------------------------------------------ *
 * 五、字段抽取
 * ------------------------------------------------------------------ */

function parseFields(lines: string[]): { fields: Partial<Record<FieldKey, string>>; extra: string[] } {
  const fields: Partial<Record<FieldKey, string>> = {};
  const extra: string[] = [];
  let cur: FieldKey | null = null;

  for (const line of lines) {
    const hit = readFieldLine(line);
    if (hit) {
      cur = hit.key;
      const v = hit.value;
      fields[hit.key] = fields[hit.key] ? `${fields[hit.key]} ${v}`.trim() : v;
      continue;
    }
    // 【为什么这里要过噪声闸门】「上门家教073 2026年11月5日 14:58」这类行
    // 一旦被当成续行吞进薪资字段，界面上就会看到「150-180/h 上门家教073 …」，
    // 而且不会报错 —— 静默污染比解析失败危险得多。
    if (isNoiseLine(line)) continue;
    if (cur) {
      fields[cur] = `${fields[cur]} ${line}`.trim();
    } else if (line) {
      extra.push(line);
    }
  }
  return { fields, extra };
}

/* ------------------------------------------------------------------ *
 * 六、各字段归一化
 * ------------------------------------------------------------------ */

/** 中文数字或阿拉伯数字统一转 number */
function toNum(s: string): number | null {
  const t = s.trim();
  if (/^\d+(\.\d+)?$/.test(t)) return Number(t);
  if (CN_NUM[t] !== undefined) return CN_NUM[t];
  return null;
}

/**
 * 从地址里反推行政区。
 *
 * 【为什么不能按词典顺序取第一个命中】T6 的真实地址是
 * `番禺区大石街道高尔夫路华发越秀·和樾府`，词典里 `越秀` 排在 `番禺` 前面，
 * 按顺序判断会把行政区判成越秀区。规则改成「取地址里出现位置最靠前的区名」。
 */
function detectDistrict(addr: string, hint: string | null): string | null {
  const earliest = (text: string): string | null => {
    let found: { name: string; at: number } | null = null;
    for (const d of DISTRICTS) {
      const at = text.indexOf(d);
      if (at >= 0 && (found === null || at < found.at)) found = { name: d, at };
    }
    return found ? `${found.name}区` : null;
  };
  return earliest(addr) ?? (hint ? earliest(hint) : null);
}

function detectArea(addr: string, district: string | null): string | null {
  if (!addr || !district) return null;
  const d = district.replace(/区$/, '');
  const idx = addr.indexOf(d);
  if (idx < 0) return null;
  const rest = addr.slice(idx + d.length).replace(/^[区\s,，、]+/, '');
  if (!rest) return null;
  const suffixGroup = AREA_SUFFIXES.join('|');
  const m = rest.match(new RegExp(`^(.{1,8}?(?:${suffixGroup}))`));
  return (m ? m[1] : rest).slice(0, 14);
}

function detectStage(gradeText: string): Stage | null {
  if (!gradeText) return null;
  if (/高[一二三]|高中|高考/.test(gradeText)) return '高中';
  if (/初[一二三]|初中|中考/.test(gradeText)) return '初中';
  if (/[一二三四五六1-6]\s*[-~至]?\s*[一二三四五六1-6]?\s*年级|小学/.test(gradeText)) return '小学';
  if (/\d+\s*岁|岁半|幼儿园|幼儿|学前|早教/.test(gradeText)) return '幼儿';
  return null;
}

function detectGradeNum(gradeText: string): number | null {
  if (!gradeText) return null;
  // 初一/高一：年级数字在学段内部，学段由 stage 表达
  const ms = gradeText.match(/[高初]\s*([一二三])/);
  if (ms) return CN_NUM[ms[1]] ?? null;
  // `1-3年级` 是区间，取下限（误取上限会把一年级单子当成三年级）
  const range = gradeText.match(/([一二三四五六1-6])\s*[-~–—至]\s*[一二三四五六1-6]\s*年级/);
  if (range) return toNum(range[1]);
  const single = gradeText.match(/([一二三四五六七八九1-9])\s*年级/);
  if (single) return toNum(single[1]);
  return null;
}

/**
 * 科目：先按关键字全扫，再补上连写简称（`物化生` / `语数英`）。
 * 最后按 SUBJECT_MAIN 的顺序输出，保证界面上科的排列稳定（不随原文词序跳来跳去）。
 */
function detectSubjects(text: string): string[] {
  if (!text) return [];
  const lower = text.toLowerCase();
  const hit = SUBJECT_MAIN.filter((r) => r.keywords.some((k) => lower.includes(k.toLowerCase()))).map((r) => r.name);
  for (const abbr of SUBJECT_ABBR) {
    if (abbr.pattern.test(text)) hit.push(...abbr.names);
  }
  const order = new Map(SUBJECT_MAIN.map((r, i) => [r.name, i]));
  return [...new Set(hit)].sort((a, b) => (order.get(a) ?? 99) - (order.get(b) ?? 99));
}

function detectTags(text: string): string[] {
  if (!text) return [];
  const lower = text.toLowerCase();
  return SUBJECT_TAGS.filter((r) => r.keywords.some((k) => lower.includes(k.toLowerCase()))).map((r) => r.tag);
}

function detectCount(text: string): number | null {
  if (!text) return null;
  if (/双胞胎/.test(text)) return 2;
  const m = text.match(/一\s*对\s*([一二三四两1-4])/);
  return m ? toNum(m[1]) : null;
}

function detectGender(text: string): '男' | '女' | null {
  if (/女生|女孩|女宝|女同学/.test(text)) return '女';
  if (/男生|男孩|男宝|男同学/.test(text)) return '男';
  return null;
}

/**
 * 授课形式。
 *
 * 【线上为什么要求「独立词」】原来只要出现「线上」两个字就算线上单。这很危险：
 * 线上单不再算通勤，一个地名里带「线上」的线下单（比如「××线上城小区」）会被判成线上，
 * 于是**永远不算通勤且悄无声息** —— 漏算比算错更难发现。
 * 所以要求它出现在分隔符之后/行首，并且后面紧跟分隔符或「授课/上课/辅导」这类词。
 */
function detectMode(text: string): Mode | null {
  if (/(?:^|[\s【】\[\]()（）：:、,，。;；#＃])(?:线上|网课|网络课|视频课|在线|腾讯会议|钉钉)(?=$|[\s【】\[\]()（）：:、,，。;；#＃]|授课|上课|教学|辅导)/.test(text)) {
    return '线上';
  }
  if (/上门|线下/.test(text)) return '上门';
  if (/机构|校区/.test(text)) return '机构';
  return null;
}

/* ------------------------------------------------------------------ *
 * 七、薪水：区间 / 分档 / 单位 / 时薪折算
 * ------------------------------------------------------------------ */

function mapSalaryUnit(u: string): SalaryUnit {
  if (/小时|时|^h$|^H$/.test(u)) return 'hour';
  if (/次|节/.test(u)) return 'session';
  if (/月/.test(u)) return 'month';
  return 'day';
}

/** 取「单位标记之前的尾部数字」作价格，前面的文字作档位标签 */
function tailPrice(head: string): { min: number; max: number; label: string } | null {
  const t = head.trim();
  const range = t.match(/(\d+(?:\.\d+)?)\s*[-~–—至]\s*(\d+(?:\.\d+)?)\s*$/);
  if (range && range.index !== undefined) {
    const label = t.slice(0, range.index).replace(/[/、,，\s]+$/, '').trim();
    return { min: Number(range[1]), max: Number(range[2]), label };
  }
  const single = t.match(/(\d+(?:\.\d+)?)\s*$/);
  if (single && single.index !== undefined) {
    const label = t.slice(0, single.index).replace(/[/、,，\s]+$/, '').trim();
    return { min: Number(single[1]), max: Number(single[1]), label };
  }
  return null;
}

function parseSalarySegment(seg: string): SalaryTier | null {
  const s = seg.trim();
  if (!s) return null;

  /**
   * 0) 按次报价：`一节课150（1.5小时）`、`每节课130`
   *
   * 【为什么必须排在其他规则前面】「一节课150（1.5小时)」里离单位词 小时 最近的数字是 **1.5**，
   * 规则 2) 会把 1.5 当成价格、单位当成「每小时」，于是这张单子变成 **1.5 元/小时** ——
   * 既不是它写的 150，也不是折算后的 100，还会被排到列表最末。价格其实写在括号前面。
   * 括号里的数字是「这一节课多长」，属于时长而不是价钱。
   */
  const perSession = s.match(/(?:一节课|一课时|一次课|每节课|每次课|每节|每次)\s*[:：]?\s*(\d+(?:\.\d+)?)\s*(?:元|块)?/);
  if (perSession) {
    const min = Number(perSession[1]);
    // 区间写法：一节课150-180
    const range = s.slice(perSession.index ?? 0).match(/^[^\d]*(\d+(?:\.\d+)?)\s*[-~–—至]\s*(\d+(?:\.\d+)?)/);
    const max = range ? Number(range[2]) : min;
    return { label: null, min, max: Math.max(min, max), unit: 'session' };
  }

  /**
   * 0.5) 总价 / 单次时长：`120/2小时`、`200-240/2h`、`120-135/1.5h`
   *
   * 【为什么必须排到 1)、2) 前面】这两种写法喂给下面的规则会得到两种都错的答案：
   * - `120/2小时` 里离单位词「小时」最近的是 2，规则 2) 把它当价格 → **2 元/小时**。
   *   这不是「算不出来」，是算出一个看着很正常的数，于是被排到列表最末，谁也看不出是错的；
   * - `200-240/2h` 里的 h 不在规则 2) 的中文单位表里 → 单位留空 → 时薪 null。
   * 症状不同，病因只有一个：斜杠后面那段是**时长**，不是价钱。
   */
  const perSlot = s.match(/\/\s*(\d+(?:\.\d+)?)\s*(?:个)?\s*(?:小时|h|H)/);
  if (perSlot && perSlot.index !== undefined) {
    // 剥掉不属于价格的东西：「120元/2小时」的「元」、「160-200一次课/2小时」的「一次课」
    const head = s
      .slice(0, perSlot.index)
      .replace(/\s*[元块]\s*$/, '')
      .replace(/\s*(?:一次课|一节课|每节课|每次课|一次|每节|每次|一对一)\s*$/, '');
    const priced = tailPrice(head);
    if (!priced) return null;
    return { label: priced.label || null, min: priced.min, max: priced.max, unit: 'session' };
  }

  // 1) 斜杠单位：100-120/h、3000元/月、92/研究生110-120/小时
  const slash = s.match(/(?:元|块)?\s*\/\s*(小时|h|H|时|次|节|月|天)/);
  if (slash && slash.index !== undefined) {
    const priced = tailPrice(s.slice(0, slash.index));
    if (!priced) return null;
    return { label: priced.label || null, min: priced.min, max: priced.max, unit: mapSalaryUnit(slash[1]) };
  }

  // 2) 中文单位写在数字后面：100每小时 / 120一小时
  const after = s.match(/(\d+(?:\.\d+)?)\s*(?:元|块)?\s*(?:每|一)?\s*(?:个)?\s*(小时|时|节|次|月|天)/);
  if (after) {
    const min = Number(after[1]);
    return { label: null, min, max: min, unit: mapSalaryUnit(after[2]) };
  }

  // 3) 单位写在数字前面：每节课130 / 时薪130
  const before = s.match(/(?:每\s*个?\s*)?(小时|时|节|次|月|天)\s*(?:课)?\s*[:：]?\s*(\d+(?:\.\d+)?)/);
  if (before) {
    const min = Number(before[2]);
    return { label: null, min, max: min, unit: mapSalaryUnit(before[1]) };
  }

  return null;
}

export interface SalaryResult {
  min: number | null;
  max: number | null;
  unit: SalaryUnit | null;
  /** 分档原文，如 一本100/小时、92/研究生110-120/小时 */
  tiers: SalaryTier[];
}

/**
 * 报价里自带的单次时长（原文写了，不是猜的）：
 * - 按次报价的括号：`一节课150（1.5小时)` → 1.5
 * - 总价/时长写法：`120/2小时`、`200-240/2h` → 2
 *
 * 【为什么斜杠写法也要认】这类单子的「时间」字段常写「具体时间协商」，
 * parseHours 拿不到时长；若不从这里补，unit=session 却缺时长，时薪只能留空。
 */
function hoursInSalary(raw: string): number | null {
  const paren = raw.match(/[（(]\s*(\d+(?:\.\d+)?)\s*(?:个)?\s*(?:小时|h|H)\s*[)）]/);
  if (paren) return Number(paren[1]);
  const perSlot = raw.match(/\/\s*(\d+(?:\.\d+)?)\s*(?:个)?\s*(?:小时|h|H)/);
  return perSlot ? Number(perSlot[1]) : null;
}

/**
 * 解析薪水原文。
 *
 * 【为什么不用「抓所有数字」】「130元/小时，一周3次」里有两个数字，
 * 无脑抓会把一周3次当成薪水上限。所以先定位单位标记，只取它前面的数字。
 *
 * 【为什么标量只留最低档】筛选排序要用一个数，多档时取下限才不会虚高，
 * 明细放 salaryTiers 里给界面展示。
 */
export function parseSalary(raw: string): SalaryResult {
  // `200--300/h`：连着写两个减号的区间也是区间，不归一化会被当成「300 一档」，下限直接丢掉
  const text = raw.trim().replace(/[-~–—－]{2,}/g, '-');
  if (!text) return { min: null, max: null, unit: null, tiers: [] };

  const segments = text
    .split(/[，,；;]/)
    .map((s) => s.trim())
    .filter(Boolean)
    /**
     * 纯频次段不是薪水：`200-240/2h，一周2次` 的第二段会被规则 2) 读成「2 元/次」，
     * 再被当成最低档，时薪就凭空变成 1 元/小时。
     * 判据：带「周」且不含任何价格度量（元/块/小时/h/节/月/天）→ 它只在说次数。
     */
    .filter((s) => !(/周/.test(s) && !/(?:元|块|小时|[hH](?![a-zA-Z])|节|月|天)/.test(s)));
  const tiers = segments.map(parseSalarySegment).filter((t): t is SalaryTier => t !== null);

  if (tiers.length) {
    const lowest = tiers.reduce((a, b) => (b.min < a.min ? b : a));
    return { min: lowest.min, max: lowest.max, unit: lowest.unit, tiers };
  }

  // 兜底：只认数字，不认单位（如「80三次」），单位留空由调用方报警告
  const nums = text.match(/\d+(?:\.\d+)?/g);
  if (!nums?.length) return { min: null, max: null, unit: null, tiers: [] };
  const min = Number(nums[0]);
  const range = text.match(/(\d+(?:\.\d+)?)\s*[-~–—至]\s*(\d+(?:\.\d+)?)/);
  return { min, max: range ? Number(range[2]) : min, unit: null, tiers: [] };
}

/** 用月薪/次薪折算时薪，缺频次或时长就不折算（宁可留空不猜） */
export function toHourly(
  min: number | null,
  unit: SalaryUnit | null,
  freqPerWeek: number | null,
  hoursPerSession: number | null,
): number | null {
  if (min === null || !unit) return null;
  if (unit === 'hour') return round1(min);
  if (unit === 'session') return hoursPerSession ? round1(min / hoursPerSession) : null;
  if (unit === 'day') return hoursPerSession ? round1(min / hoursPerSession) : null;
  if (unit === 'month') {
    if (!freqPerWeek || !hoursPerSession) return null;
    return round1(min / (freqPerWeek * hoursPerSession * 4.33));
  }
  return null;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/* ------------------------------------------------------------------ *
 * 八、频次与单次时长
 * ------------------------------------------------------------------ */

const CN_COUNT = '一二三四五六七两';

function parseFreq(schedule: string): number | null {
  if (!schedule) return null;
  let m = schedule.match(new RegExp(`每\\s*(?:周|星期|礼拜)\\s*(\\d+|[${CN_COUNT}])\\s*次`));
  if (m) return toNum(m[1]);
  m = schedule.match(new RegExp(`[一1]\\s*周\\s*(\\d+|[${CN_COUNT}])\\s*次`));
  if (m) return toNum(m[1]);
  if (/每天|每日/.test(schedule)) return 7;
  m = schedule.match(new RegExp(`安排\\s*(\\d+|[${CN_COUNT}])\\s*次`));
  if (m) return toNum(m[1]);
  // 「每周六上午一节课」：提到周几但没给次数，按一周一次理解
  if (/每\s*(?:周|星期|礼拜)/.test(schedule)) return 1;
  return null;
}

function parseHours(schedule: string): number | null {
  if (!schedule) return null;

  const units = '小时|h|H';
  // 一次1-1.5h：区间取下限
  let m = schedule.match(
    new RegExp(`(?:每次|一次|每节|上课)\\s*(?:课)?\\s*(\\d+(?:\\.\\d+)?)\\s*[-~–—至]\\s*(\\d+(?:\\.\\d+)?)\\s*(?:个)?\\s*(?:${units})`),
  );
  if (m) return Number(m[1]);

  // 每次2小时 / 一次2h / 每节课两小时 / 上课2小时
  m = schedule.match(
    new RegExp(
      `(?:每次|一次|每节课|每节|一节课|上课|每堂)\\s*(?:课)?\\s*[:：]?\\s*(\\d+(?:\\.\\d+)?|[${CN_COUNT}])\\s*(?:个)?\\s*(?:${units})`,
    ),
  );
  if (m) return toNum(m[1]);

  // 19:00-21:30 / 7.30-8.30
  m = schedule.match(/(\d{1,2})[:：.](\d{2})\s*[-~–—至]\s*(\d{1,2})[:：.](\d{2})/);
  if (m) {
    const start = Number(m[1]) * 60 + Number(m[2]);
    const end = Number(m[3]) * 60 + Number(m[4]);
    const diff = (end - start + 24 * 60) % (24 * 60);
    if (diff > 0 && diff <= 12 * 60) return round1(diff / 60);
  }

  // 9-11点 / 10~12点 / 晚7-9
  m = schedule.match(/(\d{1,2})\s*[-~–—至]\s*(\d{1,2})\s*点/);
  if (m) {
    const diff = Number(m[2]) - Number(m[1]);
    if (diff > 0 && diff <= 12) return diff;
  }

  return null;
}

/* ------------------------------------------------------------------ *
 * 九、组装一条单子
 * ------------------------------------------------------------------ */

export function buildOrder(block: RawBlock): ParsedOrder | null {
  const { fields, extra } = parseFields(block.lines);
  if (Object.keys(fields).length === 0) return null;

  const rawText = block.lines.join('\n');
  const all = rawText;

  const orderNo = normalizeOrderNo(block.anchor?.orderNo ?? fields.orderNo ?? '') || null;
  // `【辅导地址】#海珠区…` / `【辅导地址】】#白云区…`：值前面常带 # 或多余的右括号，都不属于地址
  const addressRaw = fields.address?.replace(/^[】\]#＃\s]+/, '').trim() || null;

  /**
   * 地址栏里只写了「线上」的情况（真实数据里不止一条）：那**不是地址**，是授课形式。
   *
   * 【为什么必须在这里剥掉】把它当地址留着，通勤就会去地理编码一个叫「线上」的地方：
   * 高德要么给一个莫名其妙（通常在市区某栋楼）的坐标，要么直接 30001。这样算出来的通勤
   * 是错的，而界面上完全看不出来 —— 比「无地址」危险得多。空着比错着好。
   * 顺带把 mode 定成「线上」，通勤侧据此直接跳过（不占配额，也不算「还没算出通勤」）。
   */
  const ONLINE_ONLY = /^(线上|网课|网络课|视频课|在线|线上授课|网课授课|腾讯会议|钉钉)(授课|上课|辅导|教学)?$/;
  const onlineAddress = addressRaw ? ONLINE_ONLY.test(addressRaw) : false;
  const address = onlineAddress ? null : addressRaw;

  const district = detectDistrict(address ?? '', block.regionHint);
  const gradeText = [fields.grade, fields.studentInfo].filter(Boolean).join(' ').trim() || null;
  const subjectText = fields.subjects ?? '';

  const subjects = subjectText ? detectSubjects(subjectText) : detectSubjects(all);
  const subjectTags = detectTags(`${subjectText} ${all}`);

  const schedule = fields.schedule?.trim() || null;
  const freqPerWeek = parseFreq(schedule ?? '');

  const salaryRaw = fields.salary?.trim() || null;
  const sal = parseSalary(salaryRaw ?? '');

  /**
   * 单次时长优先看「时间」字段；没有时，按次报价的括号里常直接写着
   * （`一节课150（1.5小时)`），那是原文给的时长，不是猜的。
   * 只在 unit=session 时启用 —— 时薪报价里的括号多半是别的意思，拿它去除会把时薪算错。
   */
  const hoursPerSession = parseHours(schedule ?? '') ?? (sal.unit === 'session' ? hoursInSalary(salaryRaw ?? '') : null);
  const salaryHourly = toHourly(sal.min, sal.unit, freqPerWeek, hoursPerSession);

  const genderText = fields.studentGender ?? '';
  const studentGender =
    (/女/.test(genderText) ? '女' : /男/.test(genderText) ? '男' : null) ??
    detectGender(`${gradeText ?? ''} ${fields.studentInfo ?? ''}`);

  /** 地址写着「线上」→ 形式是线上；否则照常从全文里认（`#线上`、`网课` 都算） */
  const mode: Mode | null = onlineAddress ? '线上' : detectMode(all);

  const warnings: string[] = [];
  if (!orderNo) warnings.push('未识别到家教编号');
  if (!salaryRaw) warnings.push('未识别到薪水');
  else if (sal.min === null) warnings.push('薪水数字未识别');
  else if (!sal.unit) warnings.push('薪水单位不明确，无法折算时薪');
  else if (salaryHourly === null) warnings.push('缺少频次或时长，无法折算时薪');
  if (!subjects.length) warnings.push('未识别到科目');
  // 线上单本来就没有区域，别让它因为「缺区域」掉置信度
  if (!district && mode !== '线上') warnings.push('未识别到区域');
  // T5 的 #1045 被截断就是这个信号：有编号有薪资，但没有要求
  if (!fields.teacherReq) warnings.push('缺少老师要求');

  const confidence: Confidence = !orderNo ? 'low' : warnings.length ? 'medium' : 'high';

  // 去重键：有编号用编号（跨群转发同一个单子编号相同），没有就用正文指纹
  const dedupeKey = orderNo
    ? `no:${orderNo}`
    : `h:${createHash('sha1')
        .update(rawText.replace(/[\s:：,，。、；;!！?？]/g, ''))
        .digest('hex')
        .slice(0, 16)}`;

  return {
    orderNo,
    anchorKind: block.anchor?.kind ?? null,
    statusTag: block.anchor?.statusTag ?? null,
    sentAt: block.sentAt,
    district,
    area: detectArea(address ?? '', district),
    address,
    stage: detectStage(gradeText ?? ''),
    gradeNum: detectGradeNum(gradeText ?? ''),
    gradeText,
    studentCount: detectCount(`${gradeText ?? ''} ${fields.studentInfo ?? ''}`),
    studentGender,
    mode,
    subjects,
    subjectTags,
    freqPerWeek,
    hoursPerSession,
    schedule,
    salaryRaw,
    salaryMin: sal.min,
    salaryMax: sal.max,
    salaryUnit: sal.unit,
    salaryHourly,
    salaryTiers: sal.tiers,
    teacherReq: fields.teacherReq ?? null,
    notes: (fields.notes ?? extra.join(' ')) || null,
    rawText,
    confidence,
    warnings,
    dedupeKey,
  };
}

export function parseMessage(text: string, fallbackSentAt: string | null = null): ParsedOrder[] {
  const blocks = splitBlocks(text, fallbackSentAt);
  const out: ParsedOrder[] = [];
  for (const b of blocks) {
    const o = buildOrder(b);
    if (o) out.push(o);
  }
  return out;
}
