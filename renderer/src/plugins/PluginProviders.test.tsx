import { createContext, useContext, useState, type PropsWithChildren } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('./index', () => ({ plugins: [] }))
import { plugins } from './index'
import { PluginProviders } from './PluginProviders'

const Count = createContext(0)
function Provider({ children }: PropsWithChildren) {
  const [count, setCount] = useState(0)
  return <Count.Provider value={count}><button onClick={() => setCount(count + 1)}>advance</button>{children}</Count.Provider>
}
function Page({ name }: { name: string }) { return <p>{name}: {useContext(Count)}</p> }

describe('plugin providers', () => {
  it('retains plugin state when the active page changes and works without plugins', () => {
    plugins.push({ id: 'test', Provider })
    try {
      const view = render(<PluginProviders><Page name="first" /></PluginProviders>)
      fireEvent.click(screen.getByText('advance'))
      view.rerender(<PluginProviders><Page name="second" /></PluginProviders>)
      expect(screen.getByText('second: 1')).toBeTruthy()
      view.unmount()
    } finally { plugins.length = 0 }
    render(<PluginProviders><p>public app</p></PluginProviders>)
    expect(screen.getByText('public app')).toBeTruthy()
  })
})
