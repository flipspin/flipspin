import type { ComponentProps } from "react";
import type { useAcquisition } from "./useAcquisition";
import type { AcquisitionIdentity } from "../acquisition/api";
import type { BrowseTrack, OwnershipVerdict } from "./browse.types";
import type CollectionActions from "../acquisition/CollectionActions";
import type { RowEnd } from "../acquisition/RowState";

// Legacy acquisition consumers already handle null metadata with || and ??.
// Widen their UI signatures to the nullable generated AcquireTrack fields.
export type BrowseAcquisition = Omit<ReturnType<typeof useAcquisition>, "acquire"> & {
  acquire: (tracks: BrowseTrack[], options?: AcquisitionIdentity) => ReturnType<ReturnType<typeof useAcquisition>["acquire"]>;
};
export type BrowseCollectionActions = (props: Omit<ComponentProps<typeof CollectionActions>, "tracks" | "verdicts" | "acquisition"> & {
  tracks: BrowseTrack[];
  verdicts?: OwnershipVerdict[];
  acquisition?: BrowseAcquisition;
}) => ReturnType<typeof CollectionActions>;
export type BrowseRowEnd = (props: Omit<ComponentProps<typeof RowEnd>, "track" | "nearDuration"> & {
  track?: BrowseTrack;
  nearDuration?: number | null;
}) => ReturnType<typeof RowEnd>;
