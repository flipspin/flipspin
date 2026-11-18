import { createContext, useContext } from 'react'
import type { ApiData } from '../data'

export type SignInRequest = ApiData<'/api/me/sign-in-requests', 'get'>['requests'][number]
export const SignInRequestsContext = createContext<{ openCode: (code: string) => void; openRequest: (request: SignInRequest) => void } | null>(null)
export function useSignInRequests() {
  const context = useContext(SignInRequestsContext)
  if (!context) throw new Error('SignInRequestsProvider is required')
  return context
}
