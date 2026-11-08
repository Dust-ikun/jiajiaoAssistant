import { useEffect } from 'react';
import { cn } from '../cn';
import { CommutePanel } from './settings/CommutePanel';
import { OriginList } from './settings/OriginList';
import { ProfileForm } from './settings/ProfileForm';

/** 「自动导入」页签随剪贴板自动入库一起移除（2026-11-08），入库只剩「粘贴导入」一条路 */
export type SettingsTab = 'profile' | 'origins' | 'commute';

const TABS: { key: SettingsTab; label: string }[] = [
  { key: 'profile', label: '我的资质' },
  { key: 'origins', label: '出发点' },
  { key: 'commute', label: '通勤状态' },
];

interface Props {
  open: boolean;
  tab: SettingsTab;
  onTab: (t: SettingsTab) => void;
  onClose: () => void;
  /** 资质改了 → 可接性要按新资质重算，列表必须重拉 */
  onProfileSaved: () => void;
  /** 出发点变了 → 通勤数据作废，列表必须重拉 */
  onOriginsChanged: () => void;
}

/**
 * 设置抽屉。
 *
 * 【为什么是右侧抽屉而不是独立页面】设置是「顺手看一眼、改完继续看单」的附属动作：
 * 独立页面要离开列表、回来还要重新定位。抽屉盖住三分之一屏，改完关掉列表就在原地。
 */
export function SettingsDrawer({ open, tab, onTab, onClose, onProfileSaved, onOriginsChanged }: Props) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-slate-900/30" onClick={onClose}>
      <aside
        className="flex h-full w-[440px] max-w-full flex-col bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex shrink-0 items-center justify-between border-b border-slate-100 px-4 py-3">
          <div>
            <h2 className="text-[14px] font-semibold text-slate-900">设置</h2>
            <p className="mt-0.5 text-[10.5px] text-slate-400">全部只存在本机，不上传任何地方</p>
          </div>
          <button onClick={onClose} className="btn-ghost !px-2 !py-1" title="关闭（Esc）">
            ✕
          </button>
        </header>

        <nav className="flex shrink-0 gap-0.5 border-b border-slate-100 px-2 py-1.5">
          {TABS.map((t) => (
            <button
              key={t.key}
              onClick={() => onTab(t.key)}
              className={cn(
                'rounded-md px-2.5 py-1 text-[12px] transition-colors',
                tab === t.key ? 'bg-slate-900 font-medium text-white' : 'text-slate-500 hover:bg-slate-100 hover:text-slate-800',
              )}
            >
              {t.label}
            </button>
          ))}
        </nav>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {tab === 'profile' && <ProfileForm onSaved={onProfileSaved} />}
          {tab === 'origins' && <OriginList onChanged={onOriginsChanged} />}
          {tab === 'commute' && <CommutePanel onOpenOrigins={() => onTab('origins')} />}
        </div>
      </aside>
    </div>
  );
}
