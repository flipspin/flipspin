/* krobi-ui; AGPL-3.0; see LICENSE. */
import { createContext, useContext, useMemo, type ReactNode } from "react";

export interface KrobiUiStrings {
  loading: string;
  fileDrop: string;
  filesDrop: string;
  fileRelease: string;
  fileTypeRejected: (count: number) => string;
  fileSizeRejected: (count: number, max: string) => string;
  removeFile: (name: string) => string;
}

export const defaultKrobiUiStrings: KrobiUiStrings = {
  loading: "cargando",
  fileDrop: "arrastra un archivo o haz clic",
  filesDrop: "arrastra archivos o haz clic",
  fileRelease: "suelta para subir",
  fileTypeRejected: (count) => `${count} ${count === 1 ? "archivo no tiene" : "archivos no tienen"} un tipo permitido`,
  fileSizeRejected: (count, max) => `${count} ${count === 1 ? "archivo excede" : "archivos exceden"} ${max}`,
  removeFile: (name) => `quitar ${name}`,
};

interface KrobiUiLocaleContextValue {
  locale: string;
  strings: KrobiUiStrings;
}

const KrobiUiLocaleContext = createContext<KrobiUiLocaleContextValue>({ locale: "es-MX", strings: defaultKrobiUiStrings });

export interface KrobiUiStringsProviderProps {
  locale?: string;
  strings?: Partial<KrobiUiStrings>;
  children: ReactNode;
}

export function KrobiUiStringsProvider({ locale = "es-MX", strings, children }: KrobiUiStringsProviderProps) {
  const value = useMemo(
    () => ({ locale, strings: strings ? { ...defaultKrobiUiStrings, ...strings } : defaultKrobiUiStrings }),
    [locale, strings],
  );
  return <KrobiUiLocaleContext.Provider value={value}>{children}</KrobiUiLocaleContext.Provider>;
}

export function useKrobiUiStrings() {
  return useContext(KrobiUiLocaleContext).strings;
}

export function useKrobiUiLocale() {
  return useContext(KrobiUiLocaleContext).locale;
}
