export const CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'
export const CODE_LENGTH = 6
export const CODE_EXPIRY_SECONDS = 600
export const CODE_POLL_SECONDS = 2

export function normalizeSignInCode(code: string): string {
  return code.trim().toUpperCase().replace(/[- ]/g, '')
}

export function validSignInCode(code: string): boolean {
  const normalized = normalizeSignInCode(code)
  return normalized.length === CODE_LENGTH && [...normalized].every(c => CODE_ALPHABET.includes(c))
}

export function displaySignInCode(code: string): string | null {
  if (!validSignInCode(code)) return null
  const normalized = normalizeSignInCode(code)
  return `${normalized.slice(0, 3)} ${normalized.slice(3)}`
}

export function codeExpiry(seconds: number): string {
  const remaining = Math.max(0, Math.ceil(seconds))
  return `${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, '0')}`
}
