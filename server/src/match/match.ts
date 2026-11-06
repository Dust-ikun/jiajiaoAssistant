/**
 * 三态判定：这条单子我接不接得了。
 *
 * 【为什么是三态而不是布尔】漏单是不可察觉的 —— 你以为「今天没单」，
 * 其实是被自己的筛选规则误杀了。所以只有**能确证不符**才判「不可接」，
 * 剩下的（要求含糊、资质没填、软条件不满足）一律「存疑」，让人自己看一眼。
 *
 * 硬条件（不满足即不可接）：性别明确不符、学校层次无交集、学位要求更高、身份明确限定。
 * 软条件（不满足只降存疑）：专业、证书、语言、经验，以及带「优先 / 最好」的句子。
 */
import type { Degree, Profile, SchoolTier } from '../profile.ts';
import { parseRequirements, type Requirements } from './requirements.ts';

export type Verdict = '可接' | '存疑' | '不可接';

export interface MatchReason {
  dimension: '性别' | '学校层次' | '学位' | '身份' | '专业' | '证书' | '语言' | '经验';
  verdict: '存疑' | '不可接';
  detail: string;
}

export interface MatchResult {
  verdict: Verdict;
  /** 只记不通过的维度，通过的维度不占位置 */
  reasons: MatchReason[];
  requirements: Requirements;
}

const TIER_RANK: Record<SchoolTier, number> = { 一本: 1, '211': 2, '985': 3 };
const DEGREE_RANK: Record<Degree, number> = { 本科: 1, 硕士: 2, 博士: 3 };

/** 证书的等价组：「四六级」不等于必须有六级，专四专八也算 */
const CERT_ALIASES: Record<string, string[]> = {
  四六级: ['四六级', '英语四级', '英语六级', '四级', '六级', '专四', '专八', 'cet4', 'cet6'],
  英语六级: ['英语六级', '六级', 'cet6'],
  英语四级: ['英语四级', '四级', 'cet4'],
  专四: ['专四'],
  专八: ['专八'],
  教师资格证: ['教师资格证', '教资'],
  普通话: ['普通话', '普通话证书'],
};

function norm(s: string): string {
  return s.toLowerCase().replace(/\s+/g, '');
}

function hasCert(profile: Profile, required: string): boolean {
  const aliases = (CERT_ALIASES[required] ?? [required]).map(norm);
  return profile.certificates.some((c) => aliases.includes(norm(c)));
}

function hasLanguage(profile: Profile, required: string): boolean {
  const want = norm(required);
  return profile.languages.some((l) => {
    const have = norm(l);
    return have.includes(want) || want.includes(have);
  });
}

function majorHit(profile: Profile, required: string): boolean {
  const mine = [...profile.majors, profile.majorCategory ?? ''].map(norm).filter(Boolean);
  const want = norm(required);
  return mine.some((m) => m.includes(want) || want.includes(m));
}

export function matchOrder(teacherReq: string | null | undefined, profile: Profile): MatchResult {
  const req = parseRequirements(teacherReq);
  const reasons: MatchReason[] = [];

  // 1) 性别：明确写「女老师」才硬判，「女老师优先」只降存疑
  if (req.gender && req.gender.value !== '不限') {
    const want = req.gender.value;
    if (!profile.gender) {
      reasons.push({ dimension: '性别', verdict: '存疑', detail: `要求${want}老师，你的性别还没填` });
    } else if (profile.gender !== want) {
      reasons.push({
        dimension: '性别',
        verdict: req.gender.hard ? '不可接' : '存疑',
        detail: req.gender.hard ? `要求${want}老师（${req.gender.evidence}）` : `偏好${want}老师：${req.gender.evidence}`,
      });
    }
  }

  // 2) 学校层次：`一本/985/211` 是「或」关系，满足其中最低的一档即可
  if (req.schoolTiers) {
    const mine = profile.schoolTier;
    if (!mine) {
      reasons.push({ dimension: '学校层次', verdict: '存疑', detail: `要求 ${req.schoolTiers.value.join('/')}，你的学校层次还没填` });
    } else {
      const need = Math.min(...req.schoolTiers.value.map((t) => TIER_RANK[t]));
      if (TIER_RANK[mine] < need) {
        reasons.push({
          dimension: '学校层次',
          verdict: req.schoolTiers.hard ? '不可接' : '存疑',
          detail: `要求 ${req.schoolTiers.value.join('/')}，你是 ${mine}（${profile.school ?? '未填学校'}）`,
        });
      }
    }
  }

  // 3) 学位：要求比现状高才是硬门槛
  if (req.degree) {
    const mine = profile.degree;
    if (!mine) {
      reasons.push({ dimension: '学位', verdict: '存疑', detail: `要求${req.degree.value}，你的学位还没填` });
    } else if (DEGREE_RANK[mine] < DEGREE_RANK[req.degree.value]) {
      reasons.push({
        dimension: '学位',
        verdict: req.degree.hard ? '不可接' : '存疑',
        detail: `要求${req.degree.value}，你是${mine}`,
      });
    }
  }

  // 4) 老师身份：机构专职 / 学校在职 与 大学生 互斥
  if (req.teacherTypes) {
    const mine = profile.teacherType;
    if (!mine) {
      reasons.push({ dimension: '身份', verdict: '存疑', detail: `要求${req.teacherTypes.value.join('/')}，你的身份还没填` });
    } else if (!req.teacherTypes.value.includes(mine)) {
      reasons.push({
        dimension: '身份',
        verdict: req.teacherTypes.hard ? '不可接' : '存疑',
        detail: `要求${req.teacherTypes.value.join('/')}，你是${mine}`,
      });
    }
  }

  // 5) 专业：默认宽松，不符只降存疑
  if (req.majors) {
    const missing = req.majors.value.filter((m) => !majorHit(profile, m));
    if (missing.length) {
      reasons.push({
        dimension: '专业',
        verdict: '存疑', // 专业默认宽松，即使原句没写「优先」也不硬杀
        detail: `要求${missing.join('/')}，你的专业是${profile.majors.join('、') || '未填'}`,
      });
    }
  }

  // 6) 证书
  if (req.certificates) {
    const missing = req.certificates.value.filter((c) => !hasCert(profile, c));
    if (missing.length) {
      reasons.push({ dimension: '证书', verdict: '存疑', detail: `要求${missing.join('/')}，你的证书里没有` });
    }
  }

  // 7) 语言 / 授课语言
  if (req.languages) {
    const missing = req.languages.value.filter((l) => !hasLanguage(profile, l));
    if (missing.length) {
      reasons.push({ dimension: '语言', verdict: '存疑', detail: `要求${missing.join('/')}，没在你的语言里` });
    }
  }

  // 8) 经验：默认按「有经验」处理（用户 2026-11-05 的决定），只在显式设为 false 时才降存疑
  if (req.needsExperience && !profile.hasExperience) {
    reasons.push({ dimension: '经验', verdict: '存疑', detail: '要求有辅导经验，而你的资质里标了没经验' });
  }

  const verdict: Verdict = reasons.some((r) => r.verdict === '不可接')
    ? '不可接'
    : reasons.length
      ? '存疑'
      : '可接';

  return { verdict, reasons, requirements: req };
}
