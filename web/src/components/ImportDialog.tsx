import { useEffect, useState } from 'react';
import { importText } from '../api';
import type { ImportResult } from '../types';
import { ImportDiagnostics } from './ImportDiagnostics';

interface Props {
  open: boolean;
  onClose: () => void;
  onImported: (r: ImportResult) => void;
}

export function ImportDialog({ open, onClose, onImported }: Props) {
  const [text, setText] = useState('');
  const [groupName, setGroupName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 有结果就切到「体检」视图：导入之后必须先看切块是否合理，再决定关了还是再粘一段 */
  const [result, setResult] = useState<ImportResult | null>(null);

  // 每次重新打开都是一次新的导入，别把上次的体检结果留着
  useEffect(() => {
    if (open) {
      setResult(null);
      setError(null);
    }
  }, [open]);

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
              <div>
                <label className="mb-1.5 block text-[11px] font-medium text-slate-500">群名（可选，用于回溯来源）</label>
                <input
                  value={groupName}
                  onChange={(e) => setGroupName(e.target.value)}
                  placeholder="广州家教群YF11群"
                  className="field !py-2 !text-[13px]"
                />
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
                  复制时一定要带上编号那一行（`#1138` / `110512号家教` / `家教编号: xxx`）—— 它是拆单的唯一依据。
                  一次选不全就分几次粘，同一条单子会合并补全。
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
