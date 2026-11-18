/**
 * Owns normalized HTTP calls over the generated API client.
 * Unwrap successful response bodies and throw ApiError for every failure.
 * Preserve HTTP status and abort semantics through hooks and screens.
 * Derive response shapes from generated paths instead of restating server interfaces.
 * ApiDataOr permits a fallback only until the schema supplies a concrete response type.
 */

import { snapshotResponse, offlineMutation } from '../offline/snapshots'
import { getForcedOffline } from '../offline/mode'
import type { QueryClient, QueryKey } from '@tanstack/react-query'
import type { MaybeOptionalInit } from 'openapi-fetch'

import type { paths } from '../api/generated/schema'
import { getApiClient } from './backend'
import { ApiError } from './errors'

/** The verbs this API actually uses. `options`/`head`/`trace` are not routed here. */
export type Verb = 'get' | 'post' | 'put' | 'patch' | 'delete'

/** Filter absent methods by undefined; never is assignable to every type and cannot identify routed methods. */
export type PathsWith<M extends Verb> = {
  [P in keyof paths]: paths[P][M] extends undefined ? never : P
}[keyof paths]

type SuccessStatus = 200 | 201 | 202 | 203 | 204

type JsonBody<R> = R extends { content: { 'application/json': infer T } } ? T : undefined

type SuccessJson<Responses> = {
  [S in Extract<keyof Responses, SuccessStatus>]: JsonBody<Responses[S]>
}[Extract<keyof Responses, SuccessStatus>]

/** What a successful call to this route resolves with, straight out of the schema. */
export type ApiData<P extends keyof paths, M extends Verb> = paths[P][M] extends { responses: infer R }
  ? SuccessJson<R>
  : never

/** Recognize both unknown and open-record responses as unannotated.
 * Literal model keys make generated response models supersede local fallbacks. */
export type Unannotated<T> = unknown extends T ? true : string extends keyof T ? true : false

/** Use a local fallback only while the server has no model, and validate that fallback at runtime. */
export type ApiDataOr<P extends keyof paths, M extends Verb, Fallback> = OrFallback<ApiData<P, M>, Fallback>

/** Expose fallback selection for fixed-shape tests so adding a server model does not break them. */
export type OrFallback<Data, Fallback> = Unannotated<Data> extends true ? Fallback : Data

// Reproduced rather than imported: the equivalent helper lives in a transitive
// package this project does not declare as a dependency, and reaching into one
// of those is how a lockfile change becomes a build break in a file nobody
// touched.
type RequiredKeysOf<T> = Exclude<{ [K in keyof T]: T extends Record<K, T[K]> ? K : never }[keyof T], undefined>

/** Require init when path parameters are needed so a request cannot retain an unresolved template. */
type InitParam<Init> = RequiredKeysOf<Init> extends never ? [init?: Init] : [init: Init]

export function apiGet<P extends PathsWith<'get'>, Init extends MaybeOptionalInit<paths[P], 'get'>>(
  path: P,
  ...init: InitParam<Init>
): Promise<ApiData<P, 'get'>> {
  return performRequest('GET', path, init[0]) as Promise<ApiData<P, 'get'>>
}

export function apiPost<P extends PathsWith<'post'>, Init extends MaybeOptionalInit<paths[P], 'post'>>(
  path: P,
  ...init: InitParam<Init>
): Promise<ApiData<P, 'post'>> {
  return performRequest('POST', path, init[0]) as Promise<ApiData<P, 'post'>>
}

export function apiPut<P extends PathsWith<'put'>, Init extends MaybeOptionalInit<paths[P], 'put'>>(
  path: P,
  ...init: InitParam<Init>
): Promise<ApiData<P, 'put'>> {
  return performRequest('PUT', path, init[0]) as Promise<ApiData<P, 'put'>>
}

export function apiPatch<P extends PathsWith<'patch'>, Init extends MaybeOptionalInit<paths[P], 'patch'>>(
  path: P,
  ...init: InitParam<Init>
): Promise<ApiData<P, 'patch'>> {
  return performRequest('PATCH', path, init[0]) as Promise<ApiData<P, 'patch'>>
}

export function apiDelete<P extends PathsWith<'delete'>, Init extends MaybeOptionalInit<paths[P], 'delete'>>(
  path: P,
  ...init: InitParam<Init>
): Promise<ApiData<P, 'delete'>> {
  return performRequest('DELETE', path, init[0]) as Promise<ApiData<P, 'delete'>>
}

type Envelope = { data?: unknown; error?: unknown; response: Response }

/** Keep casts and failure handling in one request path while typed wrappers preserve schema types for callers. */
type Validator = { etag?: string; snapshotAt: number | null }
// Validators belong to the query object: clearing auth/nest data drops them too.
const validators = new WeakMap<object, Validator>()
export function queryRevision(client: QueryClient, key: QueryKey): string | undefined {
  const query = client.getQueryCache().find({ queryKey: key, exact: true })
  return query ? validators.get(query)?.etag : undefined
}
export function querySnapshotAt(client: QueryClient, key: QueryKey): number | null {
  const query = client.getQueryCache().find({ queryKey: key, exact: true })
  return query ? validators.get(query)?.snapshotAt ?? null : null
}

export function recordQueryHeaders(client: QueryClient, key: QueryKey, headers: Headers) {
  const query = client.getQueryCache().find({ queryKey: key, exact: true })
  if (query) validators.set(query, {
    etag: headers.get('etag') || undefined,
    snapshotAt: headers.has('x-krobi-snapshot-at') ? Number(headers.get('x-krobi-snapshot-at')) : null,
  })
}

/** Conditional GET; the query cache is the only copy of the response body. */
export function queryGet<P extends PathsWith<'get'>, Init extends MaybeOptionalInit<paths[P], 'get'>>(
  client: QueryClient, key: QueryKey, path: P, ...init: InitParam<Init>
): Promise<ApiData<P, 'get'>> {
  const query = client.getQueryCache().find({ queryKey: key, exact: true })
  const previous = query?.state.data
  const validator = query && previous !== undefined ? validators.get(query) : undefined
  return performRequest('GET', path, init[0], {
    etag: validator?.etag, previous,
    accept: headers => {
      if (query && !(init[0] as { signal?: AbortSignal })?.signal?.aborted) validators.set(query, {
        etag: headers.get('etag') || undefined,
        snapshotAt: headers.has('x-krobi-snapshot-at') ? Number(headers.get('x-krobi-snapshot-at')) : null,
      })
    },
  }) as Promise<ApiData<P, 'get'>>
}

type Conditional = { etag?: string; previous: unknown; accept: (headers: Headers) => void }
export async function performRequest(method: string, path: string, init: unknown, conditional?: Conditional): Promise<unknown> {
  if (method !== 'GET') {
    const queued = await offlineMutation(path, method, (init as { body?: unknown })?.body)
    if (queued) return queued
  }
  if (method === 'GET') {
    const interpolated = path.replace(/\{([^}]+)\}/g, (_, key: string) => encodeURIComponent(String((init as { params?: { path?: Record<string, unknown> } })?.params?.path?.[key] ?? key)))
    const accountId = (init as { params?: { query?: { accountId?: string } } })?.params?.query?.accountId
    const cached = accountId ? null : await snapshotResponse(interpolated)
    if (cached) {
      if (!cached.ok) throw new ApiError({ kind: 'http', status: cached.status, method, path, body: JSON.parse(cached.body), message: 'snapshot-unavailable' })
      conditional?.accept(new Headers(cached.headers))
      return JSON.parse(cached.body) as unknown
    }
  }
  const client = await getApiClient()
  if (getForcedOffline()) throw new ApiError({ kind: 'network', method, path, message: 'offline-mode' })
  const call = (client as unknown as Record<string, (p: string, i: unknown) => Promise<Envelope>>)[method]
  if (!call) throw new Error(`unsupported HTTP method ${method}`)

  let envelope: Envelope
  try {
    const request = conditional?.etag ? {
      ...(init as object), headers: { ...(init as { headers?: object })?.headers, 'If-None-Match': conditional.etag },
    } : init
    envelope = await call(path, request)
  } catch (cause) {
    throw asThrowable(cause, method, path)
  }

  const { response } = envelope
  if (response.status === 304 && conditional?.previous !== undefined) {
    conditional.accept(response.headers)
    return conditional.previous
  }
  if (!response.ok) {
    throw new ApiError({
      kind: 'http',
      status: response.status,
      method,
      path,
      // The server's own body, parsed when it was JSON and raw text otherwise.
      // Kept whole rather than reduced to a string: `detail` is what FastAPI
      // sends, but the validation errors on a 422 are an array, and a screen
      // that wants to point at the offending field needs the array.
      body: envelope.error,
      // Log the schema template so diagnostics cannot include filenames, search terms or credentials.
      // Append statusText only when the transport supplies it.
      message: `${method} ${path} → ${response.status}${response.statusText ? ` ${response.statusText}` : ''}`,
    })
  }

  // `undefined` here is a 204 or an empty body, which is a legitimate answer for
  // the write routes. Only an unreadable body is an error, and that arrives as a
  // throw above rather than as a value.
  conditional?.accept(response.headers)
  return envelope.data
}

function asThrowable(cause: unknown, method: string, path: string): unknown {
  // Preserve AbortError so navigation cancellation does not become a retryable request failure.
  if (isAbort(cause)) return cause

  // The body arrived and could not be parsed. Distinct from a network failure
  // because the server *did* answer: retrying gets the same broken body, so the
  // retry predicate has to be able to tell them apart.
  if (cause instanceof SyntaxError) {
    return new ApiError({
      kind: 'malformed',
      method,
      path,
      message: `${method} ${path} → response body was not valid JSON`,
      cause,
    })
  }

  return new ApiError({
    kind: 'network',
    method,
    path,
    message: `${method} ${path} → the request never reached the server`,
    cause,
  })
}

function isAbort(cause: unknown): boolean {
  return typeof cause === 'object' && cause !== null && (cause as { name?: unknown }).name === 'AbortError'
}
