/**
 * What the account-shaped settings share with the rest of the app: the calls
 * (gateways), the install's view of its nest and identity, and the address a
 * phone pairs with. The screens themselves are the Settings page
 * (`settings/`).
 */

export { createHouseholdGateway } from './gateways'
export { routableAddress, useAuthIdentity, useServerStatus } from './useInstall'
