"""Routing paths and HTTP authorities independent of reconstructed URLs."""
import re

from fastapi import HTTPException, Request



def routing_path(request: Request) -> str:
    """Mirror ASGI routing's root-path removal, on a segment boundary only."""
    path = request.scope['path']
    root = request.scope.get('root_path', '')
    if root and (path == root or path.startswith(root + '/')):
        return path[len(root):]
    return path


def request_host(request: Request) -> str:
    """Validate one Host authority and return its lower-case host without port."""
    values = request.headers.getlist('host')
    if len(values) != 1:
        raise HTTPException(400, 'Invalid Host header')
    # Match the whole authority: no path, query, fragment or userinfo can ride
    # along. Underscores are allowed because container network names use them.
    match = re.fullmatch(r'(\[[0-9a-fA-F:.]+\]|[a-zA-Z0-9_](?:[a-zA-Z0-9_.-]*[a-zA-Z0-9_])?)(?::([0-9]{1,5}))?', values[0])
    if not match or '..' in match[1] or (match[2] and not 1 <= int(match[2]) <= 65535):
        raise HTTPException(400, 'Invalid Host header')
    return match[1].lower()
