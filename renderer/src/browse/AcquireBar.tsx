/** Rows and the downloads menu already show progress. Keep failures here
 * so they remain actionable without adding another progress surface. */
import { AlertTriangle } from "lucide-react";
import { useTranslation } from "react-i18next";

export function AcquireBar({ acquisition }: { acquisition: { error?: Error | null } }) {
  const { t } = useTranslation();
  const { error } = acquisition;
  if (!error) return null;
  return (
    <div
      className="flex items-start gap-2.5 px-3.5 py-2.5 rounded-[10px] border-2 border-black"
      style={{ background: "var(--coral-tint, var(--panel-2))", boxShadow: "var(--shadow-pop-sm)" }}
      role="alert"
    >
      <AlertTriangle size={16} className="mt-[2px] shrink-0" strokeWidth={2.5} />
      <p className="text-[13px] leading-snug m-0">
        <span className="font-bold">{t("Could not add.")}</span> {error.message}
      </p>
    </div>
  );
}
