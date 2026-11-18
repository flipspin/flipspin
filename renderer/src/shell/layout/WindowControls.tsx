import { Copy, Maximize2, Minus, Square, X } from "lucide-react";
import { useEffect, useState } from "react";
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

/**
 * Windows draws no title bar for the main window (`build_main_window` turns its
 * decorations off there), so the header is the title bar and these are its
 * minimize, maximize/restore and close buttons, at its right edge.
 */
export function hasWindowsCaption(): boolean {
  return "__TAURI_INTERNALS__" in globalThis && /Windows/.test(navigator.userAgent);
}

export function WindowsCaption() {
  const { t } = useTranslation();
  const [maximized, setMaximized] = useState(false);
  useEffect(() => {
    if (!hasWindowsCaption()) return;
    let live = true;
    let stop: (() => void) | undefined;
    void (async () => {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      const window = getCurrentWindow();
      const sync = async () => { const value = await window.isMaximized(); if (live) setMaximized(value); };
      await sync();
      // Maximizing by double-click, Aero snap or Win+Up resizes the window too.
      const unlisten = await window.onResized(() => void sync());
      if (live) stop = unlisten; else unlisten();
    })();
    return () => { live = false; stop?.(); };
  }, []);
  if (!hasWindowsCaption()) return null;
  const act = (action: "minimize" | "toggleMaximize" | "close") => async () => {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    await getCurrentWindow()[action]();
  };
  const restoreLabel = maximized ? t("Restore_window") : t("Maximize");
  return (
    <div className="window-caption" data-tauri-drag-region="false">
      <button type="button" className="window-caption__button" aria-label={t("Minimize")} title={t("Minimize")} onClick={() => void act("minimize")()}>
        <Minus size={16} strokeWidth={1.5} aria-hidden />
      </button>
      <button type="button" className="window-caption__button" data-maximize="" aria-label={restoreLabel} title={restoreLabel} onClick={() => void act("toggleMaximize")()}>
        {maximized ? <Copy size={13} strokeWidth={1.5} aria-hidden className="window-caption__restore" /> : <Square size={13} strokeWidth={1.5} aria-hidden />}
      </button>
      <button type="button" className="window-caption__button window-caption__button--close" aria-label={t("Close")} title={t("Close")} onClick={() => void act("close")()}>
        <X size={17} strokeWidth={1.5} aria-hidden />
      </button>
    </div>
  );
}
