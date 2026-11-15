/** Device rows have no kind in this API; use the same phone labels as My account. */
export function isPhoneLabel(label: string): boolean {
  return /iphone|ipad|pixel|android|galaxy|móvil|movil|phone|tel[eé]fono/i.test(label)
}
