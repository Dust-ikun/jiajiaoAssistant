import { useCallback, useEffect, useState } from 'react';
import { fetchProfile, saveProfile } from '../../api';
import {
  DEGREE_OPTIONS,
  GENDER_OPTIONS,
  MAJOR_CATEGORY_OPTIONS,
  SCHOOL_TIER_OPTIONS,
  TEACHER_TYPE_OPTIONS,
  type Profile,
} from '../../types';
import { Field, Seg, SectionTitle, TagField } from './bits';

interface Props {
  /** 保存成功 → 通知外层重拉列表，让「可接性」立刻按新资质重算 */
  onSaved: () => void;
}

/**
 * 「我的资质」编辑表单。
 *
 * 【为什么每次打开都重新 GET，而不是由外层传进来】
 * 资质是唯一会变的判定输入，而落盘位置是 `data/profile.json` —— 用户完全可能在编辑器里手改。
 * 抽屉一开就现读，才不会出现「界面显示的是十分钟前的资质、判定用的是现在的」这种错位。
 */
export function ProfileForm({ onSaved }: Props) {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [savedAs, setSavedAs] = useState<string>(''); // JSON 快照，用来判断有没有改动
  const [path, setPath] = useState('');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    setLoadError(null);
    setStatus(null);
    fetchProfile()
      .then((r) => {
        setProfile(r.profile);
        setSavedAs(JSON.stringify(r.profile));
        setPath(r.path);
        // 文件写坏了：后端给的是全空兜底资质，必须把错误说出来，
        // 否则用户会以为自己填的东西被清空了
        setLoadError(r.error);
      })
      .catch((e: unknown) => setLoadError(e instanceof Error ? e.message : '读取失败'));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  if (!profile) {
    return (
      <div className="px-4 py-6 text-[12px] text-slate-400">
        {loadError ? <span className="text-rose-600">{loadError}</span> : '读取资质…'}
      </div>
    );
  }

  const patch = (p: Partial<Profile>) => {
    setProfile((cur) => (cur ? { ...cur, ...p } : cur));
    setStatus(null);
    setError(null);
  };

  const dirty = JSON.stringify(profile) !== savedAs;

  const save = async () => {
    if (busy || !dirty) return;
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      const r = await saveProfile(profile);
      setProfile(r.profile);
      setSavedAs(JSON.stringify(r.profile));
      setPath(r.path);
      setStatus('已保存，列表的「可接性」已按新资质重算');
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : '保存失败');
    } finally {
      setBusy(false);
    }
  };

  const summary = [
    profile.gender,
    profile.school ? `${profile.school}${profile.schoolTier ? `（${profile.schoolTier}）` : ''}` : profile.schoolTier,
    profile.degree,
    profile.teacherType,
    profile.majorCategory,
    profile.hasExperience ? '有经验' : '无经验',
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <div className="space-y-5 px-4 py-4">
      <p className="rounded-lg bg-slate-50 px-3 py-2 text-[11.5px] leading-relaxed text-slate-500">
        这些值直接决定每张单子右侧的「可接 / 存疑 / 不可接」。没填的项一律判「存疑」——
        宁可疑也不漏，因为漏掉的单子你根本不会知道。
      </p>

      {loadError && (
        <p className="rounded-lg bg-rose-50 px-3 py-2 text-[11.5px] leading-relaxed text-rose-700">
          读取资质文件出错，下面显示的是空资质：{loadError}
        </p>
      )}

      <div>
        <SectionTitle>我是谁</SectionTitle>
        <div className="space-y-3">
          <Field label="姓名" hint="只用于显示">
            <input
              value={profile.name ?? ''}
              onChange={(e) => patch({ name: e.target.value || null })}
              placeholder="可留空"
              className="field"
            />
          </Field>

          <Field label="性别" hint="「只要女老师」这类单子靠它判定">
            <Seg value={profile.gender} options={GENDER_OPTIONS} onChange={(v) => patch({ gender: v })} />
          </Field>

          <Field label="学校">
            <input
              value={profile.school ?? ''}
              onChange={(e) => patch({ school: e.target.value || null })}
              placeholder="暨南大学"
              className="field"
            />
          </Field>

          <Field label="学校层次" hint="与「学历」是两件事">
            <Seg
              value={profile.schoolTier}
              options={SCHOOL_TIER_OPTIONS}
              onChange={(v) => patch({ schoolTier: v })}
            />
            <p className="mt-1 text-[10.5px] leading-snug text-slate-400">
              单子上写「一本/985/211」是<b>或</b>的关系，满足最低一档即可；只写「985」的才真拦人
            </p>
          </Field>

          <Field label="学历">
            <Seg value={profile.degree} options={DEGREE_OPTIONS} onChange={(v) => patch({ degree: v })} />
          </Field>

          <Field label="身份" hint="大学生 / 机构专职 / 学校在职">
            <Seg
              value={profile.teacherType}
              options={TEACHER_TYPE_OPTIONS}
              onChange={(v) => patch({ teacherType: v })}
            />
          </Field>
        </div>
      </div>

      <div>
        <SectionTitle>专业与证书</SectionTitle>
        <div className="space-y-3">
          <Field label="专业" hint="回车添加">
            <TagField
              values={profile.majors}
              onChange={(v) => patch({ majors: v })}
              placeholder="光电信息科学与工程"
            />
          </Field>

          <Field label="专业大类" hint="「理科专业优先」靠它判">
            <Seg
              value={profile.majorCategory}
              options={MAJOR_CATEGORY_OPTIONS}
              onChange={(v) => patch({ majorCategory: v })}
            />
          </Field>

          <Field label="证书 / 等级" hint="回车添加">
            <TagField
              values={profile.certificates}
              onChange={(v) => patch({ certificates: v })}
              placeholder="英语六级、教师资格证…"
            />
          </Field>

          <Field label="可授课语言" hint="回车添加">
            <TagField
              values={profile.languages}
              onChange={(v) => patch({ languages: v })}
              placeholder="英语、普通话、粤语…"
            />
          </Field>
        </div>
      </div>

      <div>
        <SectionTitle>经验</SectionTitle>
        <label className="flex cursor-pointer items-start gap-2 rounded-lg border border-slate-200 px-3 py-2">
          <input
            type="checkbox"
            checked={profile.hasExperience}
            onChange={(e) => patch({ hasExperience: e.target.checked })}
            className="mt-0.5 h-3.5 w-3.5 accent-indigo-600"
          />
          <span className="text-[12px] leading-relaxed text-slate-600">
            我算「有经验」
            <span className="block text-[10.5px] text-slate-400">
              打开 = 凡写「要求有经验」的单子一律放行（默认，多数单子都这么写，卡它等于砍掉大半）；
              关掉 = 这类单子降为「存疑」
            </span>
          </span>
        </label>
      </div>

      <div className="rounded-lg bg-slate-50 px-3 py-2 text-[11px] leading-relaxed text-slate-500">
        当前身份：<span className="text-slate-700">{summary || '未填'}</span>
        <span className="mt-1 block break-all text-slate-400">落盘位置 {path}</span>
      </div>

      {error && <p className="text-[12px] leading-relaxed text-rose-600">{error}</p>}
      {status && <p className="text-[12px] text-emerald-600">{status}</p>}

      <div className="flex items-center gap-2 border-t border-slate-100 pt-3">
        <button onClick={save} disabled={!dirty || busy} className="btn-primary disabled:opacity-40">
          {busy ? '保存中…' : dirty ? '保存资质' : '已保存'}
        </button>
        <button onClick={load} disabled={busy} className="btn-ghost">
          重新读取
        </button>
      </div>
    </div>
  );
}
