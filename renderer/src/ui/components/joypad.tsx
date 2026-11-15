import React, { useState, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
type GameboyProps = {
  coverUrl?: string | null;
  onPlay?: () => void;
  onNextTrack?: () => void;
  onPreviousTrack?: () => void;
  visualizationType?: string;
  _waveformStyle?: string;
  waveformStyle?: string;
  audioWaveformStyle?: string;
  onVisualizationTypeChange?: (value: string) => void;
  _onWaveformStyleChange?: (value: string) => void;
  onWaveformStyleChange?: (value: string) => void;
  onAudioWaveformStyleChange?: (value: string) => void;
  disableKeyboard?: boolean;
  showKeyHints?: boolean;
  onQueueClick?: () => void;
  onLyricsClick?: () => void;
};

export default function Gameboy({
  coverUrl,
  onPlay,
  onNextTrack,
  onPreviousTrack,
  visualizationType = 'svg',
  _waveformStyle = 'area',
  audioWaveformStyle = 'sine',
  onVisualizationTypeChange,
  _onWaveformStyleChange,
  onAudioWaveformStyleChange,
  disableKeyboard = false,
  showKeyHints = true,
  onQueueClick,
  onLyricsClick,
}: GameboyProps) {
  const { t } = useTranslation();
  const [pressed, setPressed] = useState({ up: false, down: false, left: false, right: false, a: false, b: false, cross: false });


  const visTypeSelectRef = useRef<HTMLSelectElement>(null);
  const styleSelectRef = useRef<HTMLSelectElement>(null);


  const [activeButton, setActiveButton] = useState<string | null>(null);


  const toggleVisualizationType = () => {
    const nextType = visualizationType === 'svg' ? 'realtime' : 'svg';
    if (onVisualizationTypeChange) {
      onVisualizationTypeChange(nextType);
      // Highlight the button briefly to show it was activated
      setActiveButton('start');
      setTimeout(() => setActiveButton(null), 300);
    }
  };


  const toggleAudioWaveformStyle = () => {
    if (visualizationType === 'realtime') {
      const nextStyle = audioWaveformStyle === 'sine' ? 'bars' : 'sine';
      if (onAudioWaveformStyleChange) {
        onAudioWaveformStyleChange(nextStyle);
        setActiveButton('select');
        setTimeout(() => setActiveButton(null), 300);
      }
    }
  };


  const handleNextTrack = () => {
    if (typeof onNextTrack === "function") {
      onNextTrack();
      setActiveButton('b');
      setTimeout(() => setActiveButton(null), 300);
    }
  };


  const handlePreviousTrack = () => {
    if (typeof onPreviousTrack === "function") {
      onPreviousTrack();
      setActiveButton('a');
      setTimeout(() => setActiveButton(null), 300);
    }
  };

  // Play/pause handler (cross + Space) – same visual style as A/B
  const handlePlayPause = () => {
    if (typeof onPlay === "function") {
      onPlay();
      setActiveButton('cross');
      setPressed(p => ({ ...p, cross: true }));
      setTimeout(() => {
        setActiveButton(null);
        setPressed(p => ({ ...p, cross: false }));
      }, 300);
    }
  };


  useEffect(() => {
    if (disableKeyboard) return;
    function handleKeyDown(e: KeyboardEvent) {
      if (e.repeat) return;
      const target = e.target instanceof HTMLElement ? e.target : null;
      const tag = target?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target?.isContentEditable) {
        return;
      }
      if (e.key === "ArrowUp") setPressed(p => ({ ...p, up: true }));
      if (e.key === "ArrowDown") setPressed(p => ({ ...p, down: true }));
      if (e.key === "ArrowLeft") setPressed(p => ({ ...p, left: true }));
      if (e.key === "ArrowRight") setPressed(p => ({ ...p, right: true }));
      // Space: play/pause (cross reacts). A: prev. B: next.
      const isSpace = e.code === "Space" || e.key === " " || e.keyCode === 32;
      if (isSpace) {
        e.preventDefault();
        e.stopPropagation();
        setPressed(p => ({ ...p, cross: true }));
        if (typeof onPlay === "function") onPlay();
      }


      if (e.key.toLowerCase() === "s") {
        toggleVisualizationType();
      }


      if (e.key.toLowerCase() === "w" && visualizationType === 'realtime') {
        toggleAudioWaveformStyle();
      }
    }

    function handleKeyUp(e: KeyboardEvent) {
      if (e.key === "ArrowUp") setPressed(p => ({ ...p, up: false }));
      if (e.key === "ArrowDown") setPressed(p => ({ ...p, down: false }));
      if (e.key === "ArrowLeft") setPressed(p => ({ ...p, left: false }));
      if (e.key === "ArrowRight") setPressed(p => ({ ...p, right: false }));
      if (e.code === "Space" || e.key === " " || e.keyCode === 32) setPressed(p => ({ ...p, cross: false }));
    }

    window.addEventListener("keydown", handleKeyDown, true);
    window.addEventListener("keyup", handleKeyUp, true);
    return () => {
      window.removeEventListener("keydown", handleKeyDown, true);
      window.removeEventListener("keyup", handleKeyUp, true);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- keyboard listeners re-bound on these inputs; track/style callbacks invoked via latest closure
  }, [onPlay, visualizationType, audioWaveformStyle, disableKeyboard]);

  const handleButtonClick = (buttonName: string, selectRef: React.RefObject<HTMLSelectElement | null>) => {

    if (selectRef.current) {
      selectRef.current.focus();
      selectRef.current.click();
      setActiveButton(buttonName);
    }
  };

  const handleSelectChange = (e: React.ChangeEvent<HTMLSelectElement>, callback?: (value: string) => void) => {
    if (callback) {
      callback(e.target.value);
    }

    setTimeout(() => setActiveButton(null), 200);
  };

  return (
    <div className="gameboy-body relative">
      {/* Screen with Cover – click to play/pause; no-drag so it's clickable in player window */}
      <div
        className="gameboy-screen cursor-pointer"
        data-tauri-drag-region="false"
        onClick={() => typeof onPlay === "function" && onPlay()}
        role="button"
        aria-label={t("Play / Pause")}
      >
        <div className="gameboy-screen-inner flex items-center justify-center">
          {coverUrl ? (
            <img
              src={coverUrl}
              alt={t("Album cover")}
              className="w-full h-full object-cover pointer-events-none"
              style={{ maxWidth: "100%", maxHeight: "100%" }}
            />
          ) : (
            <span className="text-[#3d4a3d] text-sm select-none">🧃</span>
          )}
        </div>
      </div>

      {/* Player window: Lyrics (placeholder) + Cola. Main window: Start (type) + Select (style). Bottom row no-drag when onQueueClick set. */}
      <div
        className="gameboy-start-select"
        data-tauri-drag-region={onQueueClick ? "false" : undefined}
      >
        {onQueueClick ? (
          <>
            <div
              className="gameboy-lyrics"
              onClick={() => onLyricsClick?.()}
              onKeyDown={(e) => { if ((e.key === "Enter" || e.key === " ") && onLyricsClick) { e.preventDefault(); onLyricsClick(); } }}
              role="button"
              tabIndex={0}
              aria-label={t("Lyrics_plural")}
            >
              {t("Lyrics_plural")}
            </div>
            <div
              className="gameboy-queue"
              onClick={onQueueClick}
              onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onQueueClick(); } }}
              role="button"
              tabIndex={0}
              aria-label={t("Open queue")}
            >
              {t("Queue")}
            </div>
          </>
        ) : (
          <>
            {/* Start Button - Type */}
            <div 
              className={`gameboy-start relative ${activeButton === 'start' ? 'active' : ''}`}
              onClick={() => handleButtonClick('start', visTypeSelectRef)}
            >
              <select
                ref={visTypeSelectRef}
                value={visualizationType}
                onChange={(e) => handleSelectChange(e, onVisualizationTypeChange)}
                onBlur={() => setActiveButton(null)}
                className="absolute top-0 left-0 w-full h-full opacity-0 cursor-pointer z-10"
                aria-label={t("Choose the visualisation type")}
              >
                <option value="svg">SVG</option>
                <option value="realtime">{t("Real")}</option>
              </select>
<span className="absolute top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2 text-[8px] text-white/95 pointer-events-none font-bold">
            {visualizationType === "svg" ? "SVG" : t("REAL")}
          </span>
            </div>
            {/* Select Button - Wave / Freq */}
            <div 
              className={`gameboy-select relative ${activeButton === 'select' ? 'active' : ''}`}
              onClick={() => handleButtonClick('select', styleSelectRef)}
            >
              <select
                ref={styleSelectRef}
                value={visualizationType === 'realtime' ? audioWaveformStyle : 'none'}
                onChange={(e) => {
                  if (visualizationType === 'realtime') {
                    handleSelectChange(e, onAudioWaveformStyleChange);
                  }
                }}
                onBlur={() => setActiveButton(null)}
                className="absolute top-0 left-0 w-full h-full opacity-0 cursor-pointer z-10"
                disabled={visualizationType !== 'realtime'}
                aria-label={t("Choose the wave style")}
              >
                {visualizationType === 'realtime' ? (
                  <>
                    <option value="sine">{t("Wave")}</option>
                    <option value="bars">{t("Frequencies")}</option>
                  </>
                ) : (
                  <option value="none">{t("None")}</option>
                )}
              </select>
<span className="absolute top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2 text-[8px] text-white/95 pointer-events-none font-bold">
              {visualizationType === "svg" ?
                  t("NONE") :
                  (audioWaveformStyle === "sine" ? t("WAVE") : t("FREQ"))}
              </span>
            </div>
          </>
        )}
      </div>

      {/* CutePlayerBar removed */}

      {/* D-pad – click or Space = play/pause; no-drag so it's clickable in player window */}
      <div
        className="gameboy-cross cursor-pointer select-none"
        data-tauri-drag-region="false"
        onClick={handlePlayPause}
        role="button"
        aria-label={t("Play / Pause")}
      >
        <div className="gameboy-cross-vert" />
        <div className="gameboy-cross-horiz" />
        <div className={`gameboy-dir up ${pressed.up || pressed.cross || activeButton === "cross" ? "pressed" : ""}`} />
        <div className={`gameboy-dir down ${pressed.down || pressed.cross || activeButton === "cross" ? "pressed" : ""}`} />
        <div className={`gameboy-dir left ${pressed.left || pressed.cross || activeButton === "cross" ? "pressed" : ""}`} />
        <div className={`gameboy-dir right ${pressed.right || pressed.cross || activeButton === "cross" ? "pressed" : ""}`} />
      </div>

      {/* Speaker grille */}
      <div className="gameboy-speaker" aria-hidden>
        {Array.from({ length: 15 }, (_, i) => (
          <div key={i} className="gameboy-speaker-dot" />
        ))}
      </div>

      {/* A & B buttons – no-drag so they're clickable in player window */}
      <div className="gameboy-ab" data-tauri-drag-region="false">
        <div
          className={`gameboy-a ${pressed.a || activeButton === "a" ? "pressed" : ""}`}
          onClick={handlePreviousTrack}
        >
          <span className="gameboy-btn-label">{t("Previous")}</span>
        </div>
        <div
          className={`gameboy-b ${pressed.b || activeButton === "b" ? "pressed" : ""}`}
          onClick={handleNextTrack}
        >
          <span className="gameboy-btn-label">{t("Next")}</span>
        </div>
      </div>


      {showKeyHints && (
        <div className="absolute -bottom-8 left-0 w-full text-center text-[8px] text-black/70">
          {t("Space: Play · A: Previous · B: Next · S: View")}
        </div>
      )}
    </div>
  );
}
