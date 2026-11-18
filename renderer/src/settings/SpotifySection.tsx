import { waitForPoll } from '../data/poll'
import type { ApiData } from "../data/http";
import type { SchemaSpotifyConfigRequest } from "../api/generated/schema";
import { useQueryClient } from "@tanstack/react-query";
import { queryKeys, useSpotifyStatus } from "../data";
import { Word } from "./parts";
import React, { useCallback, useEffect, useState } from "react";
import { Check, Copy, Music2, Settings } from "lucide-react";
import { apiUrl } from "@lib/api";
import SettingsSection from "./SettingsSection";
import { IS_REMOTE_BACKEND } from "@lib/api";
import { openExternal } from "../ui/components/cardArt";
import { apiGet } from "../data/http";
import { openSettings } from "../shell/ServerBadge";
import { requestLanding, takeLanding } from "./landing";
import { useTranslation } from "react-i18next";

// The embedded view retains OAuth; Settings owns source credentials in its secret list.
export default function SpotifySection({ id, embedded = false }: { id?: string; embedded?: boolean }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [spotifyClientId, setSpotifyClientId] = useState("");
  const [spotifyClientSecret, setSpotifyClientSecret] = useState("");
  const [spotifyConfigured, setSpotifyConfigured] = useState(false);
  const [spotifyConnected, setSpotifyConnected] = useState(false);
  const [savingSpotify, setSavingSpotify] = useState(false);
  const [spotifyClientIdEditing, setSpotifyClientIdEditing] = useState(false);
  const [spotifyClientSecretEditing, setSpotifyClientSecretEditing] = useState(false);
  const [spotifyUriCopied, setSpotifyUriCopied] = useState(false);

  const { data: spotifyStatus, refetch } = useSpotifyStatus();
  const refreshSpotifyStatus = useCallback(() => {
    void refetch();
  }, [refetch]);

  useEffect(() => {
    if (!spotifyStatus || typeof spotifyStatus !== "object") return;
    setSpotifyConfigured(Boolean("configured" in spotifyStatus && spotifyStatus.configured));
    setSpotifyConnected(Boolean("connected" in spotifyStatus && spotifyStatus.connected));
  }, [spotifyStatus]);

  const displaySpotifyClientId = spotifyConfigured && spotifyClientId === "" && !spotifyClientIdEditing ? "••••••••" : spotifyClientId;
  const displaySpotifyClientSecret = spotifyConfigured && spotifyClientSecret === "" && !spotifyClientSecretEditing ? "••••••••" : spotifyClientSecret;

  function handleSaveSpotify() {
    setSavingSpotify(true);
    const idToSend = displaySpotifyClientId === "••••••••" ? "" : spotifyClientId;
    const secretToSend = displaySpotifyClientSecret === "••••••••" ? "" : spotifyClientSecret;
    fetch(apiUrl("/api/config/spotify"), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: idToSend, client_secret: secretToSend } satisfies SchemaSpotifyConfigRequest),
    })
      .then((r): Promise<ApiData<"/api/config/spotify", "put">> => r.json())
      .then((data) => {
        if (!isSpotifySave(data)) return;
        if (data.success) {
          setSpotifyConfigured(true);
          void queryClient.invalidateQueries({ queryKey: queryKeys.server.providers() });
          setSpotifyClientId("");
          setSpotifyClientSecret("");
          setSpotifyClientIdEditing(false);
          setSpotifyClientSecretEditing(false);
          alert(data.message || t("Saved. Restart the app for the changes to take effect."));
        } else {
          alert(data.detail || t("Couldn't save."));
        }
      })
      .catch((err: unknown) => alert(t("Error: {{reason}}", { reason: err instanceof Error ? err.message : String(err) })))
      .finally(() => setSavingSpotify(false));
  }

  function handleConnectSpotify() {
    // The server builds the consent URL for this signed-in owner; a browser that
    // opened /api/spotify/login directly would carry no token and get 401.
    apiGet("/api/spotify/authorize-url")
      .then(({ url }) => openExternal(url))
      .catch((err: unknown) => alert(t("Error: {{reason}}", { reason: err instanceof Error ? err.message : String(err) })));
    // Re-check status shortly after the user authorizes in the browser.
    void waitForPoll(4000).then(refreshSpotifyStatus);
  }

  function handleDisconnectSpotify() {
    fetch(apiUrl("/api/spotify/disconnect"), { method: "POST" })
      .then(() => setSpotifyConnected(false))
      .catch((err: unknown) => alert(t("Error: {{reason}}", { reason: err instanceof Error ? err.message : String(err) })));
  }

  // The exact Redirect URI to register in the Spotify dashboard. Derived from
  // the live backend URL (which may not be :8000 in packaged builds) and forced
  // to the 127.0.0.1 loopback literal that Spotify requires.
  const spotifyRedirectUri = (apiUrl("/api/spotify/callback") || "http://127.0.0.1:8000/api/spotify/callback")
    .replace("localhost", "127.0.0.1");

  function copySpotifyRedirectUri() {
    const done = () => { setSpotifyUriCopied(true); setTimeout(() => setSpotifyUriCopied(false), 1500); };
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(spotifyRedirectUri).then(done).catch(() => {});
    }
  }

  // Keep account connection controls beside the provider, without another key form.
  if (embedded) return <div className="settings-spotify">
    <div className="ks-row"><div className="ks-l"><b title={t("Dashboard → your app → Settings → Redirect URIs.")}>{t("Redirect URI")}</b><span className="z-mono" title={spotifyRedirectUri}>{spotifyRedirectUri}</span></div><button
      type="button" className="ks-link" onClick={copySpotifyRedirectUri} aria-label={t("Copy Redirect URI")}>{spotifyUriCopied ? t("Copied!") : t("Copy")}</button></div>
    <div className="ks-row"><div className="ks-l"><b>{t("Spotify account")}</b><Word tone={spotifyConnected ? "ok" : "warn"}>{spotifyConnected ? t("connected") : t("To do")}</Word></div>
      {spotifyConnected ? <button type="button" className="ks-link" onClick={handleDisconnectSpotify}>{t("Disconnect account")}</button> : <button
        type="button" className="ks-link" onClick={handleConnectSpotify} disabled={!spotifyConfigured}
        title={!spotifyConfigured ? t("Save your Client ID and Secret first") : undefined}>{t("Connect")}</button>}
    </div>
  </div>;

  return (
    <Frame id={id} embedded={embedded}>
      <div className="flex flex-col gap-3">
        <div>
          <label className="settings-panel-neu-label block mb-0.5">{t("Client ID")}</label>
          <input
            type="text"
            value={displaySpotifyClientId}
            onChange={(e) => setSpotifyClientId(e.target.value)}
            onFocus={() => setSpotifyClientIdEditing(true)}
            onBlur={() => { if (spotifyClientId === "") setSpotifyClientIdEditing(false); }}
            placeholder={!spotifyConfigured ? t("Paste your Client ID") : undefined}
            className="settings-panel-neu-input w-full"
          />
        </div>
        <div>
          <label className="settings-panel-neu-label block mb-0.5">{t("Client Secret")}</label>
          <input
            type="password"
            value={displaySpotifyClientSecret}
            onChange={(e) => setSpotifyClientSecret(e.target.value)}
            onFocus={() => setSpotifyClientSecretEditing(true)}
            onBlur={() => { if (spotifyClientSecret === "") setSpotifyClientSecretEditing(false); }}
            placeholder={!spotifyConfigured ? t("Paste your Client Secret") : undefined}
            className="settings-panel-neu-input w-full"
          />
        </div>
        <button
          type="button"
          onClick={handleSaveSpotify}
          disabled={savingSpotify}
          className="settings-panel-neu-btn settings-panel-neu-btn-primary self-start"
        >
          <Settings size={12} />
          {savingSpotify ? t("Saving…") : t("Save credentials")}
        </button>

        {/* The Redirect URI must be registered in the Spotify dashboard,
            character-for-character, or OAuth fails. Surface it so the
            user can copy the exact value (correct port + 127.0.0.1). */}
        <div
          className="rounded-[10px] border-2 px-3 py-2 text-[12px] leading-snug"
          style={{ borderColor: "var(--line)", backgroundColor: "var(--paper)" }}
        >
          <div className="font-bold mb-1" style={{ color: "var(--ink-2)" }}>
            {t("Redirect URI — register it in Spotify")}
          </div>
          <div className="flex items-center gap-1">
            <code
              className="flex-1 truncate font-mono text-[12px]"
              style={{ color: "var(--ink-1, var(--dm-ink, #151515))" }}
              title={spotifyRedirectUri}
            >
              {spotifyRedirectUri}
            </code>
            <button
              type="button"
              onClick={copySpotifyRedirectUri}
              className="settings-icon-btn shrink-0"
              style={spotifyUriCopied ? { color: "var(--green)", borderColor: "var(--green)" } : undefined}
              title={spotifyUriCopied ? t("Copied!") : t("Copy")}
              aria-label={t("Copy Redirect URI")}
            >
              {spotifyUriCopied ? <Check size={13} /> : <Copy size={13} />}
            </button>
          </div>
          <div className="mt-1" style={{ color: "var(--ink-3)" }}>
            {t("Dashboard → your app → Settings → Redirect URIs.")}
          </div>
        </div>

        {/* Spotify now requires user login to read playlists (Feb 2026 API change) */}
        <div className="flex items-center gap-2 text-[12px]">
          <span
            className="inline-block w-2 h-2 rounded-full shrink-0"
            style={{ backgroundColor: spotifyConnected ? "var(--green)" : "var(--ink-4)" }}
          />
          <span style={{ color: "var(--ink-3)" }}>
            {spotifyConnected ? t("Account connected") : t("Account not connected")}
          </span>
        </div>
        {spotifyConnected ? (
          <button type="button" onClick={handleDisconnectSpotify} className="settings-panel-neu-btn self-start">
            {t("Disconnect account")}
          </button>
        ) : (
          <button
            type="button"
            onClick={handleConnectSpotify}
            disabled={!spotifyConfigured}
            title={!spotifyConfigured ? t("Save your Client ID and Secret first") : undefined}
            className="settings-panel-neu-btn settings-panel-neu-btn-primary self-start"
          >
            {t("Connect Spotify account")}
          </button>
        )}
      </div>
    </Frame>
  );
}

function Frame({ id, embedded, children }: { id?: string; embedded: boolean; children: React.ReactNode }) {
  if (embedded) return <div id={id}>{children}</div>;
  return (
    <SettingsSection id={id} icon={Music2} color="var(--green)" title="Spotify">
      {children}
    </SettingsSection>
  );
}

/** Use Spotify dashboard button names in the help text so users can find them.
 * See https://developer.spotify.com/documentation/web-api/tutorials/getting-started
 * and https://developer.spotify.com/documentation/web-api/concepts/redirect_uri. */
const DASHBOARD = "https://developer.spotify.com/dashboard";

export function SpotifyKeysHelp({ remote = IS_REMOTE_BACKEND }: { remote?: boolean }) {
  const { t } = useTranslation();
  const [landed] = useState(() => takeLanding("spotify-keys"));
  const ref = React.useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    if (landed) ref.current?.scrollIntoView?.({ block: "nearest" });
  }, [landed]);
  return (
    <details ref={ref} className="z-collapse settings-spotify__help" open={landed || undefined}>
      <summary className="z-collapse__head">{t("How do I get Spotify keys?")}</summary>
      <ol className="settings-spotify__steps">
        <li>
          {t("Go to")}{" "}
          <button type="button" className="ks-link" onClick={() => openExternal(DASHBOARD)}>developer.spotify.com/dashboard</button>{" "}
          {t("with your Spotify account (Premium required).")}
        </li>
        <li>{t("«Create app»: any name and description. In «Redirect URIs», paste the redirect address from this screen. Accept the terms and save.")}</li>
        <li>{t("In your app, «Settings»: the Client ID is there; the Client Secret appears with «View client secret».")}</li>
        <li>{t("Paste them here, «Guardar las claves», then «Conectar».")}</li>
      </ol>
      <h4 className="settings-spotify__limits">{t("Spotify's limits")}</h4>
      <ul className="settings-spotify__steps">
        <li>
          {t("You can only import playlists you created or collaborate on; for the rest,")}{" "}
          <button type="button" className="ks-link" onClick={() => { requestLanding("spotify-export"); openSettings("biblioteca"); }}>{t("use the Spotify data file")}</button>.
        </li>
        <li>{t("Up to 5 accounts can use your app; add them in «Settings → User Management».")}</li>
        {remote ? <li>{t("«Conectar» only works on the computer the nest runs on: Spotify accepts only https or 127.0.0.1 as a redirect address.")}</li> : null}
      </ul>
    </details>
  );
}

// The save route has no response model; narrow only the fields this form reads.
function isSpotifySave(value: unknown): value is { success?: boolean; message?: string; detail?: string } {
  if (!value || typeof value !== "object") return false;
  const fields = value as Record<string, unknown>;
  return (fields.success === undefined || typeof fields.success === "boolean")
    && (fields.message === undefined || typeof fields.message === "string")
    && (fields.detail === undefined || typeof fields.detail === "string");
}
