/**
 * 三态判定回归：拿六套模板里真实出现过的「老师要求」逐条判一遍。
 *
 * 基准资质就是用户本人填在 data/profile.json 里的那套：
 * 男 / 暨南大学 211 / 本科 / 在读大学生 / 光电信息科学与工程（理科）/ 英语六级 / 默认有经验。
 *
 * 另用一份「什么都没填」的资质做对照，验证保守路径：缺资料必须落「存疑」而不是「可接」。
 *
 * 运行：npm -w server run test
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EMPTY_PROFILE, loadProfile, normalizeProfile, ProfileError, saveProfile, type Profile } from '../profile.ts';
import { matchOrder, type Verdict } from './match.ts';
import { parseRequirements } from './requirements.ts';

let failed = 0;
let passed = 0;

function check(name: string, actual: unknown, expect: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expect);
  if (ok) {
    passed++;
    return;
  }
  failed++;
  console.log(`  ✗ ${name}\n      期望: ${JSON.stringify(expect)}\n      实际: ${JSON.stringify(actual)}`);
}

function checkTrue(name: string, actual: boolean) {
  check(name, actual, true);
}

/** 用户本人的资质（与 data/profile.json 一致） */
const ME: Profile = normalizeProfile({
  gender: '男',
  school: '暨南大学',
  schoolTier: '211',
  degree: '本科',
  teacherType: '大学生',
  majors: ['光电信息科学与工程'],
  majorCategory: '理科',
  certificates: ['英语六级'],
  languages: ['英语', '普通话'],
  hasExperience: true,
});

/** 什么都没填的对照组：只保留性别等最基础的信息 */
const NAKED: Profile = { ...EMPTY_PROFILE, gender: '男' };

/* ---------------------------------------------------------------- *
 * 一、要求解析：先看清「读出了什么」，再看「判成什么」
 * ---------------------------------------------------------------- */
console.log('\n[1] 要求解析');
{
  const r = parseRequirements('女老师');
  check('「女老师」是硬条件', [r.gender?.value, r.gender?.hard], ['女', true]);

  const soft = parseRequirements('男老师优先');
  check('「男老师优先」降为软条件', [soft.gender?.value, soft.gender?.hard], ['男', false]);
  check('软条件句子进 softPrefs', soft.softPrefs, ['男老师优先']);

  const unlimited = parseRequirements('男女不限，女老师优先');
  check('先剥否定：男女不限压过女老师优先', unlimited.gender?.value, '不限');

  const t43 = parseRequirements('一本/982/211大学生，理科专业优先，数学家教经验丰富，有方法有能力');
  check('982 归一为 985', t43.schoolTiers?.value.sort(), ['211', '985', '一本'].sort());
  check('「大学生」识别为身份', t43.teacherTypes?.value, ['大学生']);
  check('没有学位要求（没把「大学生」读成本科）', t43.degree, null);

  const t41 = parseRequirements('一本/985/211女大学生，英语能力强有丰富辅导经验，性格好有耐心的女家教，最好是四六级已经通过的');
  check('多档学历是「或」关系', t41.schoolTiers?.value.sort(), ['211', '985', '一本'].sort());
  check('「女大学生」性别为硬', t41.gender?.hard, true);
  check('四六级是软条件（最好）', t41.certificates?.hard, false);
  check('四六级被读出来', t41.certificates?.value, ['四六级']);

  const t32 = parseRequirements('女老师，初中物理经验丰富，有方法，能长期稳定带课');
  check('「女老师」+「经验丰富」都是硬', [t32.gender?.hard, t32.needsExperience?.hard], [true, true]);
}

/* ---------------------------------------------------------------- *
 * 二、三态判定：六模板真实要求 × 用户资质
 * ---------------------------------------------------------------- */
console.log('\n[2] 六模板要求 × 用户资质（身份=大学生、理科、默认有经验）');

const CASES: { name: string; req: string | null; verdict: Verdict; reason?: string }[] = [
  { name: 'T1.1 有相关辅导经验的女老师', req: '有相关辅导经验的女老师', verdict: '不可接', reason: '性别' },
  { name: 'T1.2 有相关辅导经验（默认有经验→放行）', req: '有相关辅导经验', verdict: '可接' },
  {
    name: 'T2.1 经验 + 男老师优先（优先项正好满足）',
    req: '有经验，有耐心，有方式方法，能够帮助孩子打实基础，查缺补漏，提高学习成绩 # 男老师优先',
    verdict: '可接',
  },
  { name: 'T2.2 没有要求', req: null, verdict: '可接' },
  {
    name: 'T3.1 985 + 粤语',
    req: '男/女老师均可，经验丰富/性格开朗，成绩优异，有方法 粤语上课 擅长数学 985',
    verdict: '不可接',
    reason: '学校层次',
  },
  { name: 'T3.2 女老师', req: '女老师，初中物理经验丰富，有方法，能长期稳定带课', verdict: '不可接', reason: '性别' },
  {
    name: 'T4.1 女大学生（一本/985/211 或关系）',
    req: '一本/985/211女大学生，英语能力强有丰富辅导经验，性格好有耐心的女家教，最好是四六级已经通过的',
    verdict: '不可接',
    reason: '性别',
  },
  {
    name: 'T4.2 专职/在职老师（大学生接不了）',
    req: '男女皆可，专职/在职老师，经验丰富，教学严厉的，气场强大，震慑力更强的老师，英语师范毕业的最好，有初中英语教学经验',
    verdict: '不可接',
    reason: '身份',
  },
  {
    name: 'T4.3 982 + 理科专业（理科正好对上）',
    req: '一本/982/211大学生，理科专业优先，数学家教经验丰富，有方法有能力',
    verdict: '可接',
  },
  { name: 'T5.1 有经验女大学生', req: '有经验女大学生 DSE课程 一对二', verdict: '不可接', reason: '性别' },
  { name: 'T5.2 专职老师', req: '专职老师', verdict: '不可接', reason: '身份' },
  {
    name: 'T5.3 有经验的大学生',
    req: '1-3年级的英语作业辅导，一年级的语文20分钟的英语拼读，带一下课文，周末上英语课复习预习，有经验的大学生来就行',
    verdict: '可接',
  },
  {
    name: 'T6.1 男女不限 + 英语专业（六级顶不了专业）',
    req: '男女不限，英语专业，有剑桥辅导经验，有耐心，有责任心。',
    verdict: '存疑',
    reason: '专业',
  },
  {
    name: 'T6.2 女老师',
    req: '女老师，应届毕业生老师优先，有幼儿辅导经验，有耐心，有责任心。',
    verdict: '不可接',
    reason: '性别',
  },
  {
    name: 'T6.3 英语专业 + 口语好男女不限',
    req: '英语专业，口语好男女不限，有辅导经验，有耐心，有责任心。',
    verdict: '存疑',
    reason: '专业',
  },
  {
    name: 'T6.4 女老师优先 + 全英上课（只有软条件不满足）',
    req: '女老师优先，全英上课，上课资料家长会提前发PPT，有耐心，有责任心。',
    verdict: '存疑',
    reason: '性别',
  },
];

for (const c of CASES) {
  const result = matchOrder(c.req, ME);
  check(c.name, result.verdict, c.verdict);
  if (c.reason) {
    checkTrue(`${c.name} → 卡在「${c.reason}」`, result.reasons.some((r) => r.dimension === c.reason));
  } else {
    check(`${c.name} → 没有卡点`, result.reasons, []);
  }
}

/* ---------------------------------------------------------------- *
 * 三、保守路径：资料没填全时必须落「存疑」
 * ---------------------------------------------------------------- */
console.log('\n[3] 资料没填全 → 存疑，不虚报可接');
{
  const t53 = '1-3年级的英语作业辅导，一年级的语文20分钟的英语拼读，带一下课文，周末上英语课复习预习，有经验的大学生来就行';
  check('T5.3 未填身份/无经验 → 存疑', matchOrder(t53, NAKED).verdict, '存疑');
  check('T5.3 填全后 → 可接', matchOrder(t53, ME).verdict, '可接');
  check('T5.2 未填身份 → 存疑', matchOrder('专职老师', NAKED).verdict, '存疑');
  check('T6.1 未填专业 → 存疑', matchOrder('英语专业', NAKED).verdict, '存疑');
  check('T1.2 显式无经验 → 存疑', matchOrder('有相关辅导经验', { ...ME, hasExperience: false }).verdict, '存疑');
  check('T3.1 985 是硬门槛：211 不可接', matchOrder('985', ME).verdict, '不可接');
  check('T4.3 理科专业改成「英语专业」后 → 存疑', matchOrder('理科专业优先，英语专业', ME).verdict, '存疑');
}

/* ---------------------------------------------------------------- *
 * 四、资质文件的读写与校验
 * ---------------------------------------------------------------- */
console.log('\n[4] profile.json 读写');
{
  const dir = mkdtempSync(join(tmpdir(), 'jiajiao-profile-'));
  try {
    check('没文件时读出全空资质', [loadProfile(dir).gender, loadProfile(dir).hasExperience], [null, true]);

    const saved = saveProfile({ ...ME, name: 'Dust' }, dir);
    check('写入后能读回', loadProfile(dir), saved);
    check('读回的身份', loadProfile(dir).teacherType, '大学生');
    check('读回的专业门类', loadProfile(dir).majorCategory, '理科');

    mkdirSync(dir, { recursive: true });
    let threw = '';
    try {
      saveProfile({ gender: '男生' }, dir);
    } catch (e) {
      threw = e instanceof ProfileError ? e.message : 'wrong-error';
    }
    checkTrue('非法枚举必须报错而不是静默通过', threw.includes('gender'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/* ---------------------------------------------------------------- *
 * 五、「数学家教经验丰富」不是「数学专业」
 * ---------------------------------------------------------------- */
{
  console.log('\n[5] 专业要求只认「X专业」，经验要求不进这一维');
  const req = parseRequirements('一本/982/211大学生，理科专业优先，数学家教经验丰富，有方法有能力');
  check('专业要求只取到「理科」', req.majors?.value, ['理科']);
  check('带「优先」→ 软条件', req.majors?.hard, false);
  checkTrue('「数学家教经验」不该变成专业要求', !(req.majors?.value ?? []).includes('数学'));

  const hard = parseRequirements('数学专业 逻辑较好');
  check('明写「数学专业」才算硬要求', [hard.majors?.value, hard.majors?.hard], [['数学'], true]);
}

console.log(failed === 0 ? `\n全部通过 ✓（${passed} 项）\n` : `\n${failed} 项未通过 ✗（通过 ${passed} 项）\n`);
process.exit(failed === 0 ? 0 : 1);
