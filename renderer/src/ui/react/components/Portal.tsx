/* krobi-ui; AGPL-3.0; see LICENSE. */
import { createContext, useContext, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { getLayerRoot } from "./layerRoot";

const ModalPortalContext = createContext(false);



export interface PortalProps {
  children: ReactNode;
  container?: Element | null;
  /** marks this portal and descendant portals as part of a modal branch. */
  modal?: boolean;
}

/** render children outside transformed ancestors; the root also scopes modal isolation. */
export function Portal({ children, container, modal = false }: PortalProps) {
  const parentModal = useContext(ModalPortalContext);
  if (typeof document === "undefined") return null;
  const modalBranch = modal || parentModal;
  return createPortal(
    <ModalPortalContext.Provider value={modalBranch}>
      <div data-krobi-portal="" data-krobi-modal-branch={modalBranch ? "" : undefined} style={{ display: "contents" }}>
        {children}
      </div>
    </ModalPortalContext.Provider>,
    container ?? getLayerRoot() ?? document.body,
  );
}
Portal.displayName = "Portal";
