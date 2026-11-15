import React from "react";
import i18n from "../i18n";

type State = { hasError: boolean; error: unknown };

/** Keeps a crash in the Playlists page from taking the whole shell down; "Retry" remounts it. */
export default class PlaylistErrorBoundary extends React.Component<{ children?: React.ReactNode }, State> {
  state: State = { hasError: false, error: null };

  static getDerivedStateFromError(error: unknown): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: unknown, info: React.ErrorInfo) {
    console.error("PlaylistView crashed:", error, info);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="p-4 bg-[#C13A5C] text-white rounded">
          {/* A class component: `i18n.t` at render time, which is still call time. */}
          <div className="font-bold mb-2">{i18n.t("Playlists failed")}</div>
          <div className="text-sm whitespace-pre-wrap">{String(this.state.error || "")}</div>
          <button
            className="mt-2 px-2 py-1 bg-white text-[#8B1A4A] rounded"
            onClick={() => this.setState({ hasError: false, error: null })}
          >
            {i18n.t("Retry")}
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
