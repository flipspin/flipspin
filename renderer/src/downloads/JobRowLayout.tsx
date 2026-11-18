import type { ReactNode } from 'react'

export const actionClass = 'min-h-0 px-2 py-0.5 rounded border-2 border-black bg-[var(--panel)] text-black text-[12px] font-semibold cursor-pointer disabled:opacity-50'

/** Shared presentation for ledger jobs, acquisitions and downloads to this computer. */
export default function JobRowLayout({ label, title = label, mark, kind, color, whiteMark = false, word, tone, fact, tooltip, percent, actions, children }: {
  label: string; title?: string; mark: string; kind: string; color: string; whiteMark?: boolean
  word: string; tone: string; fact?: string; tooltip?: string; percent?: number
  actions?: ReactNode; children?: ReactNode
}) {
  return <article aria-label={label} className="px-3 py-2">
    <div className="grid grid-cols-[30px_minmax(0,1fr)_auto] items-center gap-2.5">
      <span title={kind} aria-label={kind} className={`grid place-items-center w-[30px] h-[30px] rounded-[7px] border-2 border-black font-mono text-[10px] font-bold ${whiteMark ? 'text-white' : 'text-black'}`} style={{ background: color }}>{mark}</span>
      <div className="grid min-w-0 gap-1">
        <b title={label} className="truncate text-[13.5px]">{title}</b>
        <div title={tooltip} className="flex items-center gap-1.5 min-w-0 overflow-hidden text-[12px]">
          <span aria-hidden="true" className="shrink-0 w-1.5 h-1.5 rounded-full" style={{ background: tone }} />
          <span className="shrink-0">{word}</span>
          {fact ? <span className="truncate font-mono text-[11px] text-[var(--ink-3)]" title={fact}>· {fact}</span> : null}
        </div>
        {percent !== undefined ? <div role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} className="h-1.5 overflow-hidden rounded bg-[var(--line-med)]"><div className="h-full bg-[var(--teal)] transition-[width]" style={{ width: `${percent}%` }} /></div> : null}
      </div>
      <div className="flex flex-col items-end gap-1">
        {percent !== undefined ? <span className="font-mono text-[12px] text-[var(--ink-3)]">{percent}%</span> : null}
        {actions}
      </div>
    </div>
    {children}
  </article>
}
