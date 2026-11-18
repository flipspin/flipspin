import { Capacity, ConfigSection } from './ConfigSection'

export function Performance(): React.JSX.Element {
  return <ConfigSection id="performance">{config => config.groups.filter(g => g.id === 'capacity').map(g => <Capacity key={g.id} config={config} rows={g.settings} />)}</ConfigSection>
}
