/** Remember alternate addresses only after authenticated identity succeeds so an unauthenticated
 * server cannot replace the stored instanceId. Ignore unsupported or pinned configurations. */
import { bridge } from '../bridge'
import { apiGet } from '../data'
import { logger } from '../ui'

export async function rememberNestNetwork(): Promise<void> {
  try {
    const network = await apiGet('/api/server/network')
    await bridge().invoke('server:set-network', network)
  } catch (error) {
    logger.debug('Nest addresses not refreshed', { error: String(error) })
  }
}
