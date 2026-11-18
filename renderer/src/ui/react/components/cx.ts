/* krobi-ui; AGPL-3.0; see LICENSE. */
/** join class names, dropping falsy parts. */
export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}
