import { RotateCw, Search } from "lucide-react";
import { useTranslation } from "react-i18next";
import { openRetry, type Failure } from "./downloadsStore";

/**
 * The songs of a finished job that did not work, each with "Search another way". Expanded in place inside the Jobs panel.
 */
export default function FailedSongs({ jobId, failures }: { jobId: string; failures: Failure[] | undefined }) {
  const { t } = useTranslation();
  if (!failures?.length) return null;
  return (
    <ul className="mt-2 flex flex-col gap-1.5" aria-label={t("Songs that failed")}>
      {failures.map((f) => (
        <li key={f.index} className="flex items-center gap-2 text-[12px]">
          <span className="flex-1 min-w-0 truncate" title={f.item}>
            {f.item}
          </span>
          {f.retriedAs ? (
            <span className="shrink-0 flex items-center gap-1 text-[11px] text-[var(--ink-3)]">
              <RotateCw size={11} strokeWidth={2.5} />
              {t("retried")}
            </span>
          ) : (
            <button
              type="button"
              onClick={() => openRetry(jobId, f)}
              title={f.kind === "no-results" ? t("YouTube found nothing with that search") : undefined}
              className="shrink-0 min-h-0 h-6 px-2 flex items-center gap-1 rounded border-2 border-black bg-[var(--yellow)] text-black text-[11px] font-bold cursor-pointer"
            >
              <Search size={11} strokeWidth={2.75} />
              {t("Search another way")}
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}
