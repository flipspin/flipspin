import type { ReactElement } from "react";

export type CatalogCard = (props: {
  title: string; subtitle?: string | null; imageUrl?: string | null;
  kind?: string; size?: number | string; onOpen?: () => void; titleHint?: string;
}) => ReactElement;

// StatusContext is still untyped and infers null under strictNullChecks.
export type StatusActions = {
  status: unknown;
  clear: () => void;
  showSuccess: (message: string) => void;
  showError: (message: string) => void;
  showInfo: (message: string) => void;
};
