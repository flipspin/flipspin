import type { Dispatch, SetStateAction } from "react";

/** Local view of the settings context while its owner is awaiting typing. */
export type ShellSettings = {
  theme: string;
  setTheme: (theme: string) => void;
  mode: string;
  setMode: Dispatch<SetStateAction<string>>;
};
export type ShellLibrary = {
  baseDir: string;
  selectBaseDir: () => Promise<void>;
};
