import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { setFakeBridgeForTest } from '../bridge'
import type { KrobiBridge } from '../lib/ipc'
import { CustomHeaders } from './sections/CustomHeaders'

let undo: (() => void) | undefined
afterEach(() => undo?.())
it('adds, saves without retaining values, edits and removes custom headers', async () => {
  const invoke = vi.fn(async (channel, request) => channel === 'headers:get' ? []
    : request.headers.map((row: { name: string }) => ({ name: row.name, set: true })))
  undo = setFakeBridgeForTest({ invoke, on: () => () => {} } as KrobiBridge)
  render(<CustomHeaders />)
  const add = screen.getByRole('button', { name: 'Añadir cabecera' })
  await waitFor(() => expect(add).toBeEnabled())
  fireEvent.click(add)
  fireEvent.change(screen.getByLabelText('Nombre de cabecera'), { target: { value: 'Authorization' } })
  fireEvent.change(screen.getByLabelText('Valor de cabecera'), { target: { value: 'proxy-secret' } })
  expect(screen.getByRole('button', { name: 'Guardar cabeceras' })).toBeDisabled()
  fireEvent.change(screen.getByLabelText('Nombre de cabecera'), { target: { value: 'X-Proxy-Secret' } })
  fireEvent.click(screen.getByRole('button', { name: 'Guardar cabeceras' }))
  const saved = await screen.findByLabelText('Valor de cabecera guardado')
  expect(saved).toHaveValue('')
  expect(saved).toHaveAttribute('type', 'password')
  expect(saved).toHaveAttribute('placeholder', '••••••••')
  expect(screen.queryByDisplayValue('proxy-secret')).not.toBeInTheDocument()
  fireEvent.change(saved, { target: { value: 'replacement-secret' } })
  fireEvent.click(screen.getByRole('button', { name: 'Guardar cabeceras' }))
  await waitFor(() => expect(saved).toHaveValue(''))
  expect(invoke).toHaveBeenLastCalledWith('headers:set', { headers: [{ name: 'X-Proxy-Secret', value: 'replacement-secret' }] })
  fireEvent.click(screen.getByRole('button', { name: 'Eliminar' }))
  fireEvent.click(screen.getByRole('button', { name: 'Guardar cabeceras' }))
  await waitFor(() => expect(invoke).toHaveBeenLastCalledWith('headers:set', { headers: [] }))
})
