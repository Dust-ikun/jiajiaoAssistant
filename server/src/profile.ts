/**
 * 「我的资质」——可接性判定的输入。
 *
 * 【为什么放在外部 JSON 而不是写死在代码里】
 * 1. 每个人资质不同：同学一起用时各改各的，改数据不该改代码、更不该重新构建；
 * 2. 这些是个人隐私，只落本机 `data/profile.json`，不进版本控制（见 .gitignore）；
 * 3. 资质会变（考上研、拿到教资），改一个文件比发一版程序合理。
 *
 * 找不到文件时用「全空」资质：所有依赖资质的维度都会判成「存疑」，
 * 而不是默认「可接」——漏单不可察觉，虚报可接只是多看一眼。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/** 与 db.ts 保持一致：数据目录可用 JIAJIAO_DATA 覆盖（测试用临时目录） */
export const DATA_DIR = process.env.JIAJIAO_DATA ?? resolve(here, '../../data');

export type Gender = '男' | '女';
export type SchoolTier = '985' | '211' | '一本';
export type Degree = '本科' | '硕士' | '博士';
export type TeacherType = '大学生' | '专职' | '在职';
export type MajorCategory = '理科' | '工科' | '文科' | '商科' | '艺术';

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
  /**
   * 是否带过家教。**默认 true** —— 用户 2026-11-05 明确要求：「要求有经验的不用管他，
   * 默认就当成有经验」。所以这里不是「猜」，是用户自己定的策略；
   * 真想严格过滤时把它改成 false 即可。
   */
  hasExperience: boolean;
}

export const EMPTY_PROFILE: Profile = {
  name: null,
  gender: null,
  school: null,
  schoolTier: null,
  degree: null,
  teacherType: null,
  majors: [],
  majorCategory: null,
  certificates: [],
  languages: [],
  hasExperience: true,
};

const GENDERS: Gender[] = ['男', '女'];
const TIERS: SchoolTier[] = ['985', '211', '一本'];
const DEGREES: Degree[] = ['本科', '硕士', '博士'];
const TEACHER_TYPES: TeacherType[] = ['大学生', '专职', '在职'];
const CATEGORIES: MajorCategory[] = ['理科', '工科', '文科', '商科', '艺术'];

export class ProfileError extends Error {}

function pickEnum<T extends string>(value: unknown, allowed: T[], field: string): T | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new ProfileError(`${field} 只能是 ${allowed.join(' / ')} 或 null，收到 ${JSON.stringify(value)}`);
  }
  return value as T;
}

function pickString(value: unknown, field: string): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string') throw new ProfileError(`${field} 必须是字符串或 null`);
  return value.trim() || null;
}

function pickList(value: unknown, field: string): string[] {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
    throw new ProfileError(`${field} 必须是字符串数组`);
  }
  return (value as string[]).map((v) => v.trim()).filter(Boolean);
}

function pickBool(value: unknown, fallback: boolean, field: string): boolean {
  if (value === null || value === undefined) return fallback;
  if (typeof value !== 'boolean') throw new ProfileError(`${field} 必须是 true / false`);
  return value;
}

/**
 * 校验并补全一份资质。未知字段直接丢弃，避免手改 JSON 打错字却静默生效。
 * 手改出错时**必须报错**，否则一个拼错的 gender 会让全部单子判成可接。
 */
export function normalizeProfile(input: unknown): Profile {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new ProfileError('profile 必须是一个 JSON 对象');
  }
  const raw = input as Record<string, unknown>;
  return {
    name: pickString(raw.name, 'name'),
    gender: pickEnum(raw.gender, GENDERS, 'gender'),
    school: pickString(raw.school, 'school'),
    schoolTier: pickEnum(raw.schoolTier, TIERS, 'schoolTier'),
    degree: pickEnum(raw.degree, DEGREES, 'degree'),
    teacherType: pickEnum(raw.teacherType, TEACHER_TYPES, 'teacherType'),
    majors: pickList(raw.majors, 'majors'),
    majorCategory: pickEnum(raw.majorCategory, CATEGORIES, 'majorCategory'),
    certificates: pickList(raw.certificates, 'certificates'),
    languages: pickList(raw.languages, 'languages'),
    hasExperience: pickBool(raw.hasExperience, true, 'hasExperience'),
  };
}

export function profilePath(dataDir: string = DATA_DIR): string {
  return resolve(dataDir, 'profile.json');
}

/** 读资质。文件不存在 → 全空资质；JSON 坏了 → 抛错（不静默降级） */
export function loadProfile(dataDir: string = DATA_DIR): Profile {
  const file = profilePath(dataDir);
  if (!existsSync(file)) return { ...EMPTY_PROFILE };
  const text = readFileSync(file, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ProfileError(`${file} 不是合法 JSON，请检查逗号与引号`);
  }
  return normalizeProfile(parsed);
}

/** 写资质：先校验再落盘，保证磁盘上永远是合法数据 */
export function saveProfile(input: unknown, dataDir: string = DATA_DIR): Profile {
  const profile = normalizeProfile(input);
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(profilePath(dataDir), `${JSON.stringify(profile, null, 2)}\n`, 'utf8');
  return profile;
}
