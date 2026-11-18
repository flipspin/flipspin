/** Destination indexes refer to the remaining list, after lifting the block. */
type Song = { path: string };
export type Move = "top" | "up" | "down" | "bottom";

export function moveBlock<T extends Song>(order: T[], moving: readonly Song[], toIndex: number): T[] {
  const paths = new Set(moving.map(song => song.path));
  const block = order.filter(song => paths.has(song.path));
  if (!block.length) return order;
  const rest = order.filter(song => !paths.has(song.path));
  const at = Math.max(0, Math.min(rest.length, Math.trunc(toIndex)));
  const next = [...rest.slice(0, at), ...block, ...rest.slice(at)];
  return next.every((song, index) => song.path === order[index].path) ? order : next;
}

function blockStart(order: Song[], moving: readonly Song[]) {
  const paths = new Set(moving.map(song => song.path));
  return order.findIndex(song => paths.has(song.path));
}
export const moveTop = <T extends Song>(order: T[], moving: readonly Song[]) => moveBlock(order, moving, 0);
export const moveBottom = <T extends Song>(order: T[], moving: readonly Song[]) => moveBlock(order, moving, order.length);
export const moveUp = <T extends Song>(order: T[], moving: readonly Song[]) => moveBlock(order, moving, blockStart(order, moving) - 1);
export const moveDown = <T extends Song>(order: T[], moving: readonly Song[]) => moveBlock(order, moving, blockStart(order, moving) + 1);
export const moves = { top: moveTop, up: moveUp, down: moveDown, bottom: moveBottom };
export const canMove = (order: Song[], moving: readonly Song[], move: Move) => moves[move](order, moving) !== order;

/** Same permission for removal and reordering; older servers have no identity. */
export function canEditPlaylist(owner: unknown, identity: { status: string; me?: { id?: string; role?: string; isOwner?: boolean; source?: string } | null }) {
  if (identity.status === "legacy") return true;
  const me = identity.me;
  return identity.status === "ready" && !!me && (me.isOwner || me.role === "owner" || me.source === "anonymous" || (!!owner && owner === me.id));
}
export function reorderDisabledReason(canEdit: boolean, sortField: string | null, searchQuery: string) {
  if (!canEdit) return "permission";
  if (sortField) return "sort";
  if (searchQuery) return "search";
  return null;
}
