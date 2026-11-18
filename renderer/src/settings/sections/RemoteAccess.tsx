import { CustomHeaders } from './CustomHeaders'
import { APP_NAME } from '../../brand'
import { useNest } from '../nest'
import { RemoteSetup } from '../../remote/RemoteSetup'
import { useSettings } from '../context'
import { Page } from './Head'
import { IS_REMOTE_BACKEND } from '../../lib/api'

export function RemoteAccess(): React.JSX.Element {
  const { admin, server } = useSettings()
  const nest = useNest(server)
  return <Page id="remoto">
    <RemoteSetup nestName={nest.name ?? APP_NAME} settings readOnly={admin !== true} elsewhere={IS_REMOTE_BACKEND}>{({ picture, content }) => (
      <div className="settings-block ks-group settings-remote">
        <div className="settings-block__body">
          {content}
          {admin === true ? picture : null}
        </div>
      </div>
    )}</RemoteSetup>
    <CustomHeaders />
  </Page>
}
