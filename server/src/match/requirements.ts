/**
 * 把「老师要求」那段自由文本拆成结构化条件。
 *
 * 只做一件事：**从文本里读出要求**，不判断我行不行（那是 match.ts 的事）。
 * 所有字段都带 `hard` 与 `evidence`，因为判定结果必须能追溯到原话，
 * 否则一条「不可接」没法让人复核。
 *
 * 分句策略：按 `，。；、#` 切，一句话内部再找维度。
 * 「优先 / 最好 / 更佳 / 可协商」的句子一律降为软条件 ——
 * 这是 T2 的 `# 男老师优先`、T6.4 的 `女老师优先` 与 T1 的 `女老师` 的唯一区别。
 */
import type { Degree, SchoolTier, TeacherType } from '../profile.ts';

export interface RequirementItem<T> {
  value: T;
  /** true = 不满足就「不可接」；false = 不满足只降「存疑」 */
  hard: boolean;
  evidence: string;
}

export interface Requirements {
  gender: RequirementItem<'男' | '女' | '不限'> | null;
  schoolTiers: RequirementItem<SchoolTier[]> | null;
  degree: RequirementItem<Degree> | null;
  teacherTypes: RequirementItem<TeacherType[]> | null;
  majors: RequirementItem<string[]> | null;
  certificates: RequirementItem<string[]> | null;
  languages: RequirementItem<string[]> | null;
  needsExperience: RequirementItem<true> | null;
  /** 带「优先 / 最好 / 可协商」的原句，界面原样展示，不参与硬判定 */
  softPrefs: string[];
  raw: string;
}

const CLAUSE_SPLIT = /[，,。；;！!、#]/;
const SOFT_RE = /优先|最好|更佳|更优|择优|可协商|都可以|优先考虑/;
const GENDER_UNLIMITED_RE = /(?:男女|男\s*\/\s*女|女\s*\/\s*男|性别)[^，,。;；!！]{0,6}(?:不限|均可|皆可)/;

function empty(): Requirements {
  return {
    gender: null,
    schoolTiers: null,
    degree: null,
    teacherTypes: null,
    majors: null,
    certificates: null,
    languages: null,
    needsExperience: null,
    softPrefs: [],
    raw: '',
  };
}

/** 硬条件优先：同一维度既有「女老师」又有「女老师优先」时，按硬的算 */
function setItem<T>(cur: RequirementItem<T> | null, next: RequirementItem<T>): RequirementItem<T> {
  if (!cur) return next;
  if (cur.hard && !next.hard) return cur;
  return next;
}

function unionItem<T>(cur: RequirementItem<T[]> | null, next: RequirementItem<T[]>): RequirementItem<T[]> {
  if (!cur) return next;
  const value = [...new Set([...cur.value, ...next.value])];
  return { value, hard: cur.hard || next.hard, evidence: cur.hard ? cur.evidence : next.evidence };
}

function detectGenderReq(clause: string): '男' | '女' | null {
  if (/女老师|女家教|女大学生|女生|女性|女的/.test(clause)) return '女';
  if (/男老师|男家教|男大学生|男生|男性|男的/.test(clause)) return '男';
  return null;
}

/**
 * 学校层次：`982` 是 T4 里真实出现的 985 错别字，必须归一。
 * `92` 单写在要求里是 985+211 的简称；但薪酬字段里的 92 是档位标签，
 * 所以这个函数**只允许**喂老师要求文本，绝不能把 salary 拼进来。
 */
function detectTiers(clause: string): SchoolTier[] | null {
  const out: SchoolTier[] = [];
  if (/982|985/.test(clause)) out.push('985');
  if (/211/.test(clause)) out.push('211');
  if (/一本|重本/.test(clause)) out.push('一本');
  if (/(?:^|[^\d])92(?:[^\d]|$)/.test(clause)) out.push('985', '211');
  return out.length ? [...new Set(out)] : null;
}

function detectDegreeReq(clause: string): Degree | null {
  if (/博士/.test(clause)) return '博士';
  if (/研究生|硕士/.test(clause)) return '硕士';
  if (/本科(?!在读)/.test(clause)) return '本科';
  return null;
}

function detectTeacherTypes(clause: string): TeacherType[] | null {
  const out: TeacherType[] = [];
  if (/专职|全职/.test(clause)) out.push('专职');
  if (/在职/.test(clause)) out.push('在职');
  if (/大学生|在校生|本科在读/.test(clause)) out.push('大学生');
  return out.length ? [...new Set(out)] : null;
}

/** 专业要求：只认「X专业 / 师范」，能力形容词（英语能力强）不进这里 */
function detectMajors(clause: string): string[] | null {
  const out: string[] = [];
  const m = clause.match(/(英语|数学|物理|化学|语文|生物|地理|历史|政治|理科|工科|文科)专业/g);
  if (m) for (const s of m) out.push(s.replace(/专业$/, ''));
  if (/师范/.test(clause)) out.push('师范');
  return out.length ? [...new Set(out)] : null;
}

function detectCertificates(clause: string): string[] | null {
  const out: string[] = [];
  if (/四六级/.test(clause)) out.push('四六级');
  else {
    if (/六级/.test(clause)) out.push('英语六级');
    if (/四级/.test(clause)) out.push('英语四级');
  }
  if (/专八/.test(clause)) out.push('专八');
  if (/专四/.test(clause)) out.push('专四');
  if (/教资|教师资格证/.test(clause)) out.push('教师资格证');
  if (/普通话/.test(clause)) out.push('普通话');
  return out.length ? [...new Set(out)] : null;
}

function detectLanguages(clause: string): string[] | null {
  const out: string[] = [];
  if (/粤语|白话|广东话/.test(clause)) out.push('粤语');
  if (/全英|纯英文|全英文|英文授课|全英语/.test(clause)) out.push('英语');
  if (/普通话/.test(clause)) out.push('普通话');
  return out.length ? [...new Set(out)] : null;
}

export function parseRequirements(raw: string | null | undefined): Requirements {
  const text = (raw ?? '').trim();
  const req = empty();
  req.raw = text;
  if (!text) return req;

  const genderUnlimited = GENDER_UNLIMITED_RE.test(text);
  if (genderUnlimited) {
    req.gender = { value: '不限', hard: true, evidence: '男女不限 / 均可' };
  }

  for (const clauseRaw of text.split(CLAUSE_SPLIT)) {
    const clause = clauseRaw.trim();
    if (!clause) continue;
    const soft = SOFT_RE.test(clause);
    if (soft) req.softPrefs.push(clause);

    const gender = genderUnlimited ? null : detectGenderReq(clause);
    if (gender) req.gender = setItem(req.gender, { value: gender, hard: !soft, evidence: clause });

    const tiers = detectTiers(clause);
    if (tiers) req.schoolTiers = unionItem(req.schoolTiers, { value: tiers, hard: !soft, evidence: clause });

    const degree = detectDegreeReq(clause);
    if (degree) req.degree = setItem(req.degree, { value: degree, hard: !soft, evidence: clause });

    const types = detectTeacherTypes(clause);
    if (types) req.teacherTypes = unionItem(req.teacherTypes, { value: types, hard: !soft, evidence: clause });

    const majors = detectMajors(clause);
    if (majors) req.majors = unionItem(req.majors, { value: majors, hard: !soft, evidence: clause });

    const certs = detectCertificates(clause);
    if (certs) req.certificates = unionItem(req.certificates, { value: certs, hard: !soft, evidence: clause });

    const langs = detectLanguages(clause);
    if (langs) req.languages = unionItem(req.languages, { value: langs, hard: !soft, evidence: clause });

    if (/有.{0,8}经验|经验丰富/.test(clause)) {
      req.needsExperience = setItem(req.needsExperience, { value: true, hard: !soft, evidence: clause });
    }
  }

  return req;
}

/** 是否有任何一条硬条件（用于界面提示「这条注定接不了」） */
export function hasHardRequirement(req: Requirements): boolean {
  return [
    req.gender,
    req.schoolTiers,
    req.degree,
    req.teacherTypes,
    req.majors,
    req.certificates,
    req.languages,
    req.needsExperience,
  ].some((item) => item?.hard);
}
