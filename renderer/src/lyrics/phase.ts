import type { TFunction } from 'i18next'

/** Engine phases → words. Keys are the protocol's; keep them in step with helper. */
export function enginePhase(phase: string, t: TFunction): string {
  switch (phase) {
    case "queued":
    case "en cola": return t("queued");
    case "claimed": return t("preparing…");
    case "decoding":
    case "decodificando": return t("decoding");
    case "separating": return t("separating stems");
    case "beats":
    case "ritmo": return t("detecting beats");
    case "chops":
    case "cortando": return t("cutting");
    case "encoding":
    case "codificando": return t("encoding");
    case "uploading":
    case "subiendo": return t("uploading");
    case "separando": return t("separating vocals");
    case "transcribiendo": return t("transcribing");
    case "alineando": return t("aligning");
    case "guardando": return t("saving");
    case "entorno": return t("creating the environment");
    case "paquetes": return t("installing packages");
    case "modelos": return t("downloading models");
    default: return phase || "";
  }
}

