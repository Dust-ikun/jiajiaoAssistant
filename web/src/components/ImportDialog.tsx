import { useEffect, useState } from 'react';
import { importText } from '../api';
import type { Facet, ImportResult } from '../types';
import { ImportDiagnostics } from './ImportDiagnostics';

interface Props {
  open: boolean;
  onClose: () => void;
  onImported: (r: ImportResult) => void;
  /** 已经用过的群名（来自 /api/meta）：给个历史列表，避免同一个群被手打成好几种写法 */
  groups: Facet[];
}

/** select 里「新建群…」这一项的哨兵值：不可能是真实群名 */
const NEW_GROUP = '\u0000new';

export function ImportDialog({ open, onClose, onImported, groups }: Props) {
  const [text, setText] = useState('');
  const [groupName, setGroupName] = useState('');
  /** 是否处于「新建群」状态（这时下拉显示哨兵项、下面多一个输入框） */
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 有结果就切到「体检」视图：导入之后必须先看切块是否合理，再决定关了还是再粘一段 */
  const [result, setResult] = useState<ImportResult | null>(null);

  // 每次重新打开都是一次新的导入，别把上次的体检结果留着
  useEffect(() => {
    if (open) {
      setResult(null);
      setError(null);
      setCreating(false);
    }
  }, [open]);

  /**
   * 下拉里要有当前值这一项。
   * 【为什么】群名是「记住上次」的，如果那个群是刚新建、还没成功导入过，
   * /api/meta 里就还没有它 —— 少这一项，select 会静默显示成第一项，用户以为群选丢了。
   */
  const known = groups.map((g) => g.value);
  const options = groupName && !known.includes(groupName) ? [groupName, ...known] : known;

  if (!open) return null;

  const submit = async () => {
    if (!text.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await importText({ text, groupName: groupName.trim() || undefined, source: 'manual' });
      setResult(r);
      setText('');
      onImported(r);
    } catch (e) {
      setError(e instanceof Error ? e.message : '导入失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/30 p-6" onClick={onClose}>
      <div
        className="w-full max-w-2xl overflow-hidden rounded-2xl bg-white shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        {result ? (
          <>
            <div className="border-b border-slate-100 px-5 py-3">
              <h2 className="text-[15px] font-semibold text-slate-900">导入体检</h2>
              <p className="mt-0.5 text-[11.5px] text-slate-500">
                看看有没有该切开的没切开、该有的字段没解析出来
              </p>
            </div>
            <ImportDiagnostics
              result={result}
              groupName={groupName.trim() || null}
              onAgain={() => setResult(null)}
              onDone={() => {
                setResult(null);
                onClose();
              }}
            />
          </>
        ) : (
          <>
            <div className="border-b border-slate-100 px-5 py-3.5">
              <h2 className="text-[15px] font-semibold text-slate-900">导入群消息</h2>
              <p className="mt-1 text-[12px] leading-relaxed text-slate-500">
                在微信里选中一条或多条消息复制，整段粘贴进来即可。含多个单子的消息会自动拆开，
                重复转发的单子会按编号合并。
              </p>
            </div>

            <div className="space-y-3 px-5 py-4">
              {/*
                群名不是「可选装饰」：一单接不接得下来，除了资质还得能联系到发单的老师。
                【为什么是下拉而不是自由输入】自由输入会让同一个群长出两种写法
                （「广州家教群YF11」/「广州家教群YF11群」），按群筛选就散了、统计也不准。
                新建群走下拉最后那一项，名字只在第一次手动敲。
              */}
              <div>
                <label className="mb-1.5 block text-[11px] font-medium text-slate-500">
                  这批单来自哪个群（接单要回去找那个群的老师）
                </label>
                <select
                  value={creating ? NEW_GROUP : groupName}
                  onChange={(e) => {
                    const v = e.target.value;
                    if (v === NEW_GROUP) {
                      setCreating(true);
                      setGroupName('');
                      return;
                    }
                    setCreating(false);
                    setGroupName(v);
                  }}
                  className="field bg-white !py-2 !text-[13px]"
                >
                  <option value="">不填（之后想回去找发单老师就找不到了）</option>
                  {options.map((g) => (
                    <option key={g} value={g}>
                      {g}
                    </option>
                  ))}
                  <option value={NEW_GROUP}>+ 新建群…</option>
                </select>

                {creating && (
                  <input
                    value={groupName}
                    onChange={(e) => setGroupName(e.target.value)}
                    autoFocus
                    placeholder="照微信里显示的群名抄，比如 广州家教群YF11群"
                    className="field mt-1.5 !py-2 !text-[13px]"
                  />
                )}

                <p className="mt-1 text-[10.5px] leading-snug text-slate-400">
                  首次为空，之后会记住上次选的群。<b>换群时记得改</b> —— 不然这一批单会被记到上一个群。
                </p>
              </div>

              <div>
                <label className="mb-1.5 block text-[11px] font-medium text-slate-500">消息内容</label>
                <textarea
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  autoFocus
                  spellCheck={false}
                  placeholder={'家教编号: 2026101803\n学员地址: 广州番禺桥南\n辅导科目: 剑桥think1教材\n...'}
                  className="h-64 w-full resize-none rounded-lg border border-slate-200 p-3 font-mono text-[12.5px] leading-relaxed outline-none transition-colors placeholder:text-slate-300 focus:border-indigo-400"
                />
                <p className="mt-1 text-[10.5px] leading-snug text-slate-400">
                  带上编号那一行（`#1138` / `110512号家教` / `家教编号: xxx`）最准。
                  没编号的单子会按「字段重来一遍」自动切开（学员/科目/地址再次出现就当成下一单），
                  切完一定要看体检结果。一次选不全就分几次粘，同一条单子会合并补全。
                </p>
              </div>

              {error && <p className="text-[12px] text-rose-600">{error}</p>}
            </div>

            <div className="flex items-center justify-between border-t border-slate-100 px-5 py-3">
              <span className="text-[11.5px] text-slate-400">{text.length ? `${text.length} 字` : '尚未粘贴内容'}</span>
              <div className="flex gap-2">
                <button onClick={onClose} className="btn-ghost">
                  取消
                </button>
                <button onClick={submit} disabled={!text.trim() || busy} className="btn-primary disabled:opacity-40">
                  {busy ? '解析中…' : '解析并导入'}
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
