/** Preserve 403 for another account's playlist and 404 for a missing playlist.
 * Names share one household namespace, so collisions remain 409 regardless of ownership. */
import type { ApiData } from "../data/http";

// Only public label fields are needed, including for legacy cached accounts.
type OwnerLabel = Pick<ApiData<"/api/me", "get">, "id" | "label">;
type PublicLabel = Pick<ApiData<"/api/users", "get">["users"][number], "id" | "label">;

import i18n from "../i18n";

export function playlistAccessMessage(status: number) {
  if (status === 403) {
    return i18n.t("That playlist belongs to another account in the nest. Make a copy with a different name.");
  }
  if (status === 404) {
    return i18n.t("That playlist no longer exists.");
  }
  if (status === 409) {
    return i18n.t("There's already a playlist with that name in the nest. Names aren't repeated even across different accounts.");
  }
  return null;
}

/** Resolve public account labels through /api/me for the current account and /api/users for others.
 * Leave unavailable labels absent. */
export function describeOwner<User extends PublicLabel>(ownerId: string | null | undefined, me: OwnerLabel | null | undefined, users: User[] = []) {
  if (!ownerId) return null;
  const mine = ownerId === me?.id;
  const account = mine ? me : users.find((user) => user.id === ownerId);
  return { mine, label: account?.label || null };
}
