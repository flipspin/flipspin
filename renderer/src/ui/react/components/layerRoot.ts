/* krobi-ui; AGPL-3.0; see LICENSE. */

/** Keep a persistent portal container so opening a layer does not make WebKit restyle the whole document. */
let layerRoot: HTMLElement | null = null;
export function getLayerRoot(): HTMLElement | null {
  if (typeof document === "undefined") return null;
  if (layerRoot?.isConnected) return layerRoot;
  layerRoot = document.getElementById("krobi-layers");
  if (!layerRoot) {
    layerRoot = document.createElement("div");
    layerRoot.id = "krobi-layers";
    layerRoot.style.display = "contents";
    document.body.appendChild(layerRoot);
  }
  return layerRoot;
}
// Created at import, i.e. at startup, so the first opening is cheap too.
getLayerRoot();
