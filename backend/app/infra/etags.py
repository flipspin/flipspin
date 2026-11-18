"""Validate area revisions before running a read's builder."""
import hashlib
import inspect
import json
from dataclasses import dataclass
from functools import wraps

from app.infra.request_paths import routing_path
from fastapi import Depends, Request, Response
from fastapi.encoders import jsonable_encoder

from app.infra.changes import Changes
from app.infra.identity import Principal
from app.infra.idempotency import canonical


def strong_etag(body):
    return '"' + hashlib.sha256(canonical(body).encode()).hexdigest() + '"'


def matches(request, etag):
    return any(value.strip().removeprefix('W/') in (etag, '*')
               for value in request.headers.get('if-none-match', '').split(','))


@dataclass
class ConditionalContext:
    request: Request
    response: Response
    changes: Changes
    principal: Principal


def validator(ctx, areas, restriction=None, *, path=None, query=None):
    # Query credentials authenticate but never enter validators.
    if query is None:
        query = [(key, value) for key, value in ctx.request.query_params.multi_items()
                 if key != 'access_token']
    key = [ctx.changes.boot_id, path or routing_path(ctx.request), query,
           [ctx.principal.user_id, ctx.principal.role,
            sorted(restriction) if restriction is not None else None]]
    fast = all(ctx.changes.wired(area) for area in areas)
    etag = strong_etag([key, [(area, ctx.changes.revision(area)) for area in areas]]) if fast else None
    return key, etag


def conditional(areas, *, context, account_scope=False):
    """Compose with an injected context; infra never resolves domain services.

    FastAPI still solves authentication and validates parameters before this
    wrapper. Response-model validation/serialization remains FastAPI's job.
    Unwired reads hash the built body until all their writers are connected.
    """
    areas = tuple(areas)

    def decorate(handler):
        def before(kwargs):
            ctx = kwargs.pop('_conditional_context')
            scope = kwargs.get('scope')
            restriction = getattr(scope, 'allowed_rel_paths', None)
            declared = tuple(f'me:{kwargs.get("accountId") or ctx.principal.user_id}'
                             if area == 'me:<account>' else area for area in areas)
            if account_scope and restriction is not None:
                declared += (f'me:{ctx.principal.user_id}',)
            key, etag = validator(ctx, declared, restriction)
            return ctx, key, etag

        def finish(result, ctx, key, etag):
            target = result if isinstance(result, Response) else ctx.response
            if target.status_code not in (None, 200):
                return result
            if etag is None:
                body = json.loads(result.body) if isinstance(result, Response) else jsonable_encoder(result)
                etag = strong_etag([key, body])
            headers = {'ETag': etag, 'Cache-Control': 'private, no-cache'}
            vary = [part.strip() for part in target.headers.get('vary', '').split(',') if part.strip()]
            if 'authorization' not in {part.lower() for part in vary}:
                vary.append('Authorization')
            headers['Vary'] = ', '.join(vary)
            target.headers.update(headers)
            if matches(ctx.request, etag):
                return Response(status_code=304, headers=headers)
            return result

        if inspect.iscoroutinefunction(handler):
            @wraps(handler)
            async def wrapped(*args, **kwargs):
                ctx, key, etag = before(kwargs)
                if etag is not None and matches(ctx.request, etag):
                    return finish(Response(), ctx, key, etag)
                return finish(await handler(*args, **kwargs), ctx, key, etag)
        else:
            @wraps(handler)
            def wrapped(*args, **kwargs):
                ctx, key, etag = before(kwargs)
                if etag is not None and matches(ctx.request, etag):
                    return finish(Response(), ctx, key, etag)
                return finish(handler(*args, **kwargs), ctx, key, etag)

        signature = inspect.signature(handler, eval_str=True)
        wrapped.__signature__ = signature.replace(parameters=[*signature.parameters.values(), inspect.Parameter(
            '_conditional_context', inspect.Parameter.KEYWORD_ONLY, default=Depends(context),
        )])
        wrapped.conditional_areas = areas
        wrapped.conditional_account_scope = account_scope
        return wrapped
    return decorate
