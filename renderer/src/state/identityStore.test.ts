import { afterEach, expect, it, vi } from 'vitest';

vi.mock('../lib/api', () => ({ apiUrl: (path: string) => path }));
afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

it('starts a new identity read on token change and ignores the old missing-token 401', async () => {
  vi.resetModules();
  let finishOld!: (response: Response) => void;
  let finishNew!: (response: Response) => void;
  const fetch = vi.fn()
    .mockReturnValueOnce(new Promise(resolve => { finishOld = resolve; }))
    .mockReturnValueOnce(new Promise(resolve => { finishNew = resolve; }));
  vi.stubGlobal('fetch', fetch);
  const { setApiToken } = await import('../lib/authToken');
  setApiToken('');
  const store = await import('./identityStore');
  const old = store.load();
  setApiToken('current-token');
  expect(fetch).toHaveBeenCalledTimes(2);
  finishOld(new Response(null, { status: 401 }));
  await old;
  // The obsolete request's finally must not clear the newer in-flight read.
  const current = store.load();
  expect(fetch).toHaveBeenCalledTimes(2);
  finishNew(Response.json({ source: 'token', userId: 'current-account' }));
  await current;
  expect(store.getState()).toMatchObject({ status: 'ready', me: { userId: 'current-account' } });
});


it.each(['401', 'body', 'network'])('discards obsolete %s after the new identity is ready', async outcome => {
  vi.resetModules();
  let finish!: (response: Response) => void;
  let reject!: (error: Error) => void;
  let finishBody!: (value: unknown) => void;
  const body = new Promise(resolve => { finishBody = resolve; });
  const oldResponse = new Promise<Response>((resolve, fail) => { finish = resolve; reject = fail; });
  const fetch = vi.fn().mockReturnValueOnce(oldResponse).mockResolvedValueOnce(Response.json({ source: 'token', userId: 'new-account' }));
  vi.stubGlobal('fetch', fetch);
  const { setApiToken } = await import('../lib/authToken');
  setApiToken('old-token');
  const store = await import('./identityStore');
  const old = store.load();
  if (outcome === 'body') {
    const response = Response.json({});
    response.json = () => body;
    finish(response);
    await Promise.resolve();
  }
  setApiToken('new-token');
  await store.load();
  expect(store.getState()).toMatchObject({ status: 'ready', me: { userId: 'new-account' } });
  if (outcome === '401') finish(new Response(null, { status: 401 }));
  if (outcome === 'body') finishBody({ source: 'token', userId: 'old-account' });
  if (outcome === 'network') reject(new Error('old request failed'));
  await old;
  expect(store.getState()).toMatchObject({ status: 'ready', me: { userId: 'new-account' } });
});
