import { Maximize2, Minus, X } from "lucide-react";
import { useTranslation } from "react-i18next";

/**
 * The macOS close / minimise / full-screen buttons, drawn in the app's own ink.
 *
 * The main window keeps its native frame (`titleBarStyle: "Overlay"`: rounded
 * corners, shadow, edge resizing) and `lib.rs::hide_native_window_buttons`
 * hides only AppKit's three buttons, so these take their place. Rendered only
 * where that happened; inside Tauri on a Mac. Everywhere else (Windows,
 * Linux, a browser tab) the window still has its own buttons and this is null.
 */
export function hasCustomWindowControls(): boolean {
  return "__TAURI_INTERNALS__" in globalThis && /Mac/.test(navigator.userAgent);
}

type Action = "close" | "minimize" | "fullscreen";

async function run(action: Action) {
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  const window = getCurrentWindow();
  if (action === "close") await window.close();
  else if (action === "minimize") await window.minimize();
  else await window.setFullscreen(!(await window.isFullscreen()));
}

export default function WindowControls({ className = "" }: { className?: string }) {
  const { t } = useTranslation();
  if (!hasCustomWindowControls()) return null;

  const buttons: { action: Action; label: string; Icon: typeof X }[] = [
    { action: "close", label: t("Close"), Icon: X },
    { action: "minimize", label: t("Minimize"), Icon: Minus },
    { action: "fullscreen", label: t("Full screen"), Icon: Maximize2 },
  ];

  return (
    <div className={`window-dots ${className}`} data-tauri-drag-region="false">
      {buttons.map(({ action, label, Icon }) => (
        <button
          key={action}
          type="button"
          className={`window-dot window-dot--${action}`}
          onClick={() => void run(action)}
          aria-label={label}
          title={label}
        >
          <Icon size={8} strokeWidth={3.5} aria-hidden />
        </button>
      ))}
    </div>
  );
}
