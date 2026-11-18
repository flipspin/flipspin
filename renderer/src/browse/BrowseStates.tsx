/** Offer retry for transient failures and Settings for disabled providers. */
import type { ReactNode } from "react";
import { AlertTriangle, PlugZap, RotateCcw, SearchX } from "lucide-react";
import { Trans, useTranslation } from "react-i18next";

export function BrowseSkeleton({ rows = 8 }: { rows?: number }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-3 animate-pulse" aria-busy="true" aria-label={t("Loading")}>
      <div className="flex gap-5">
        <div className="w-[188px] h-[188px] rounded-[10px] border-2 border-black bg-[var(--panel-2)]" />
        <div className="flex flex-col gap-3 pt-2 flex-1 min-w-0">
          <div className="h-7 w-2/5 rounded bg-[var(--panel-2)]" />
          <div className="h-4 w-1/4 rounded bg-[var(--panel-2)]" />
          <div className="h-4 w-1/6 rounded bg-[var(--panel-2)]" />
        </div>
      </div>
      <div className="flex flex-col gap-2 mt-4">
        {Array.from({ length: rows }).map((_, i) => (
          <div key={i} className="h-11 rounded-[10px] border-2 border-black bg-[var(--panel-2)]" />
        ))}
      </div>
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: { message: string; kind?: string }; onRetry?: (refresh?: boolean) => unknown }) {
  const { t } = useTranslation();
  const kind = error?.kind || "failed";

  if (kind === "unavailable") {
    return (
      <Panel
        icon={<PlugZap size={22} strokeWidth={2.5} />}
        accent="var(--yellow)"
        title={t("No source can show this")}
      >
        <p className="text-[13.5px] text-[var(--ink-2)] m-0">{error.message}</p>
        {/* Deliberately no Retry: this will answer identically until a setting
            changes, and offering a retry would be a lie. */}
        <p className="text-[12.5px] text-[var(--ink-3)] m-0">
          <Trans i18nKey={"Check <strong>Settings → Sources</strong>."}>
            Revisa <strong>Ajustes → Fuentes</strong>.
          </Trans>
        </p>
      </Panel>
    );
  }

  if (kind === "notFound") {
    return (
      <Panel icon={<SearchX size={22} strokeWidth={2.5} />} accent="var(--blue)" title={t("Not found")}>
        <p className="text-[13.5px] text-[var(--ink-2)] m-0">{error.message}</p>
      </Panel>
    );
  }

  return (
    <Panel icon={<AlertTriangle size={22} strokeWidth={2.5} />} accent="var(--coral)" title={t("Couldn't load")}>
      <p className="text-[13.5px] text-[var(--ink-2)] m-0">{error?.message || t("Unknown error")}</p>
      {onRetry ? (
        <button type="button" className="explore-button self-start" onClick={() => onRetry(true)}>
          <RotateCcw size={14} strokeWidth={2.5} /> {t("Retry")}
        </button>
      ) : null}
    </Panel>
  );
}

export function EmptyState({ children }: { children?: ReactNode }) {
  return <p className="text-[13.5px] text-[var(--ink-3)] italic m-0 py-6">{children}</p>;
}

function Panel({ icon, accent, title, children }: { icon: ReactNode; accent: string; title: string; children: ReactNode }) {
  return (
    <div
      className="flex flex-col gap-2.5 p-4 rounded-[10px] border-2 border-black max-w-[560px]"
      style={{ background: "var(--panel)", boxShadow: "var(--shadow-pop-sm)" }}
    >
      <div className="flex items-center gap-2.5">
        <span
          className="grid place-items-center w-8 h-8 rounded-panel border-2 border-black shrink-0"
          style={{ background: accent }}
          aria-hidden
        >
          {icon}
        </span>
        <strong className="text-[15px]">{title}</strong>
      </div>
      {children}
    </div>
  );
}
