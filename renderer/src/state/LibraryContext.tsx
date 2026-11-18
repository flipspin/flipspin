import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from "react";
import { backendRequest, IS_REMOTE_BACKEND } from "@lib/api";
import i18n from "../i18n";
import { setLibraryRoot } from "../lib/libraryKeys";

import type { ApiData } from "../data/http";
import type { SchemaBaseDirRequest } from "../api/generated/schema";

export interface LibraryContextValue {
  baseDir: string;
  defaultDir: string;
  setBaseDir: React.Dispatch<React.SetStateAction<string>>;
  setDefaultDir: React.Dispatch<React.SetStateAction<string>>;
  selectBaseDir: () => Promise<void>;
}

const LibraryContext = createContext<LibraryContextValue | null>(null);

// Both directory routes have unmodelled bodies in OpenAPI; narrow only the fields read here.
function directoryField(data: unknown, key: "basedir" | "default_basedir"): string | undefined {
  if (!data || typeof data !== "object" || !(key in data)) return undefined;
  const value = (data as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}

export function LibraryProvider({ children }: { children: React.ReactNode }) {
  const [baseDir, setBaseDir] = useState("");
  const [defaultDir, setDefaultDir] = useState("");
  const skipNextServerSync = useRef(false);

  useEffect(() => {
    const readJson = async (path: "/api/get-basedir" | "/api/get-default-basedir"): Promise<ApiData<typeof path, "get">> => {
      const response = await backendRequest(path);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.body ? JSON.parse(response.body) : {};
    };

    // Each nest persists its own music folder. Always adopt the selected
    // server's choice; a renderer cache may belong to a different nest.
    readJson("/api/get-basedir")
      .then((data) => {
        const basedir = directoryField(data, "basedir");
        if (basedir) {
          skipNextServerSync.current = true;
          setBaseDir(basedir);
        } else {
          readJson("/api/get-default-basedir")
            .then((def) => {
              const d = directoryField(def, "default_basedir") ?? "";
              if (d) skipNextServerSync.current = true;
              setDefaultDir(d);
              setBaseDir(d);
            })
            .catch(() => setDefaultDir(""));
        }
      })
      .catch(() => {
        readJson("/api/get-default-basedir")
          .then((def) => {
            const d = directoryField(def, "default_basedir") ?? "";
            if (d) skipNextServerSync.current = true;
            setDefaultDir(d);
            setBaseDir(d);
          })
          .catch(() => setDefaultDir(""));
      });
  }, []);

  // Every key builder outside the tree (utils/libraryKeys.ts) reads the root
  // from there, so a nested library's songs resolve the way the server's do.
  useEffect(() => {
    setLibraryRoot(baseDir);
  }, [baseDir]);

  useEffect(() => {
    if (!baseDir) return;
    if (!IS_REMOTE_BACKEND) localStorage.setItem("baseDir", baseDir);
    // A value just read from this server is already authoritative. Posting it
    // straight back was a redundant request and can be rejected for remote or
    // temporary server paths that do not exist on this machine.
    if (skipNextServerSync.current) {
      skipNextServerSync.current = false;
      return;
    }
    // Remote backend: neither persist nor push. Pushing fails (server-side $HOME
    // check), and its path must not overwrite the local session cache.
    if (IS_REMOTE_BACKEND) return;
    backendRequest("/api/set-basedir", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ basedir: baseDir } satisfies SchemaBaseDirRequest),
    }).catch(() => {});
  }, [baseDir]);

  const selectBaseDir = useCallback(async () => {
    if (!window.desktopAPI?.selectBaseDir) {
      alert(i18n.t("Not available in this environment."));
      return;
    }
    // The native picker returns a folder on *this* machine; a remote server can
    // neither read it nor accept it as its basedir.
    if (IS_REMOTE_BACKEND) {
      alert(i18n.t("The music folder is chosen by your nest, which is on another computer."));
      return;
    }
    const dir = await window.desktopAPI.selectBaseDir();
    if (dir) {
      const response = await backendRequest("/api/set-basedir", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ basedir: dir } satisfies SchemaBaseDirRequest),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      skipNextServerSync.current = true;
      setBaseDir(dir);
      setDefaultDir("");
    }
  }, []);

  const value = { baseDir, defaultDir, setBaseDir, setDefaultDir, selectBaseDir };
  return <LibraryContext.Provider value={value}>{children}</LibraryContext.Provider>;
}

// eslint-disable-next-line react-refresh/only-export-components
export function useLibrary() {
  const ctx = useContext(LibraryContext);
  if (!ctx) throw new Error("useLibrary must be used within LibraryProvider");
  return ctx;
}
