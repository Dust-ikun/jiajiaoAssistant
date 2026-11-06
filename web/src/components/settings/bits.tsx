import { useState } from 'react';
import { cn } from '../../cn';

/**
 * 枚举选择器。
 *
 * 【为什么不用 <select>】资质只有「男/女」「985/211/一本」这种三五个取值，
 * 下拉要点两下才能看到全部选项，分段按钮一眼就能比出「我现在是哪一档、还能改成哪一档」。
 */
interface SegProps<T extends string> {
  value: T | null;
  options: readonly T[];
  onChange: (v: T | null) => void;
  /** 「不填」这一档的文案；传 null 表示这一项必须选（资质里没有必填项，一般都给） */
  emptyLabel?: string | null;
}

export function Seg<T extends string>({ value, options, onChange, emptyLabel = '不填' }: SegProps<T>) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {emptyLabel !== null && (
        <button
          type="button"
          onClick={() => onChange(null)}
          className={cn('seg', value === null ? 'seg-on' : 'seg-off')}
        >
          {emptyLabel}
        </button>
      )}
      {options.map((o) => (
        <button
          key={o}
          type="button"
          onClick={() => onChange(o)}
          className={cn('seg', value === o ? 'seg-on' : 'seg-off')}
        >
          {o}
        </button>
      ))}
    </div>
  );
}

interface TagFieldProps {
  values: string[];
  onChange: (v: string[]) => void;
  placeholder: string;
}

/**
 * 一串自由文本（专业 / 证书 / 语言）。
 *
 * 【为什么是回车追加而不是逗号分隔输入框】这些值会直接参与判定比对，
 * 用户在输入框里手打「英语, 普通话」并留下一个中英文逗号混合的字符串，
 * 后端拿到的就是一条「英语, 普通话」，永远匹配不上。切成数组存，才不会把分隔符的锅甩给用户。
 */
export function TagField({ values, onChange, placeholder }: TagFieldProps) {
  const [draft, setDraft] = useState('');

  const add = () => {
    const v = draft.trim();
    if (!v || values.includes(v)) {
      setDraft('');
      return;
    }
    onChange([...values, v]);
    setDraft('');
  };

  return (
    <div>
      <div className="flex flex-wrap gap-1.5">
        {values.map((v) => (
          <span key={v} className="chip gap-1 border border-slate-200 bg-white text-slate-700">
            {v}
            <button
              type="button"
              onClick={() => onChange(values.filter((x) => x !== v))}
              className="text-slate-400 hover:text-rose-500"
              title="移除"
            >
              ×
            </button>
          </span>
        ))}
        {!values.length && <span className="text-[11.5px] text-slate-400">未填</span>}
      </div>
      <input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            add();
          }
        }}
        onBlur={add}
        placeholder={placeholder}
        className="mt-1.5 w-full rounded-lg border border-slate-200 px-2.5 py-1.5 text-[12.5px] outline-none transition-colors placeholder:text-slate-300 focus:border-indigo-400"
      />
    </div>
  );
}

/** 表单一行：左边标题（含说明），右边控件。窄抽屉里上下排比左右排好读 */
export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="mb-1 flex items-baseline gap-1.5">
        <span className="text-[12px] font-medium text-slate-700">{label}</span>
        {hint && <span className="text-[10.5px] text-slate-400">{hint}</span>}
      </div>
      {children}
    </div>
  );
}

export function SectionTitle({ children }: { children: React.ReactNode }) {
  return <h3 className="mb-2 text-[11px] font-semibold tracking-wider text-slate-400">{children}</h3>;
}
