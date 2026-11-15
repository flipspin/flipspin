import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { mediaPathOf, suggestedFileName } from "../libraryPanel";

type Notify = ((message: string) => void) | undefined;
type Song = { path?: string | null; title?: string; url_path?: unknown };

/** Device downloads belong to this desktop. The shell owns their ledger;
 * they do not create personal-library rows on the server. */
export function useDeviceDownloads({ showSuccess, showError }: { showSuccess?: Notify; showError?: Notify }) {
  const { t } = useTranslation();
  const [deviceDownloads, setDeviceDownloads] = useState<Record<string, string>>({});

  useEffect(() => {
    let cancelled = false;
    window.desktopAPI?.listDeviceDownloads?.()
      .then((result) => {
        if (cancelled) return;
        const next = Object.fromEntries(
          (result?.downloads || []).map((item) => [item.mediaPath, item.path]),
        );
        setDeviceDownloads(next);
      })
      .catch(() => {
        // This status is a convenience supplied by the desktop shell. The
        // server library remains usable if an older shell lacks the command.
      });
    return () => { cancelled = true; };
  }, []);

  const isDownloaded = (track: Song | null | undefined) => Boolean(deviceDownloads[mediaPathOf(track)]);

  const downloadToThisDevice = async (track: Song) => {
    const mediaPath = mediaPathOf(track);
    const suggestedName = suggestedFileName(track);
    if (!mediaPath || !window.desktopAPI?.downloadToDevice) {
      showError?.(t("This song has no download available."));
      return;
    }
    try {
      const existingPath = deviceDownloads[mediaPath];
      if (existingPath) {
        await window.desktopAPI.openFile(existingPath);
        return;
      }
      const result = await window.desktopAPI.downloadToDevice(mediaPath, suggestedName);
      if (result?.cancelled) return;
      if (!result?.ok) throw new Error(t("the download didn't complete"));
      if (result.path) {
        setDeviceDownloads((current) => ({ ...current, [mediaPath]: result.path }));
      }
      showSuccess?.(t("“{{title}}” downloaded to this computer.", { title: track.title }));
    } catch (error) {
      showError?.(t("Could not download to this computer: {{reason}}", { reason: error?.message || error }));
    }
  };

  return { isDownloaded, downloadToThisDevice };
}
