"""The ``subsonic-response`` envelope, as JSON (``f=json``) or XML (anything else).

Handlers build one plain dict and never think about the format. In XML a
scalar becomes an attribute, a dict a child element, a list of dicts repeated
child elements under the list's key, and the key ``value`` the element's text
(a lyric line, a genre). That is the shape every Subsonic client parses.
"""
from __future__ import annotations

import json
from typing import Any
from xml.sax.saxutils import escape, quoteattr

from fastapi.responses import Response

from app.config import APP_VERSION

API_VERSION = "1.16.1"
XMLNS = "http://subsonic.org/restapi"

# Error codes from the Subsonic spec. HTTP status stays 200 for every one of them:
# clients read the code from the body.
GENERIC = 0
MISSING_PARAMETER = 10
WRONG_CREDENTIALS = 40
TOKEN_AUTH_UNSUPPORTED = 41
AUTH_MECHANISM_UNSUPPORTED = 42
CONFLICTING_AUTH = 43
INVALID_API_KEY = 44
NOT_AUTHORIZED = 50
NOT_FOUND = 70


class SubsonicError(Exception):
    def __init__(self, code: int, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


def _envelope(status: str, body: dict[str, Any]) -> dict[str, Any]:
    return {
        "status": status,
        "version": API_VERSION,
        "type": "krobi",
        "serverVersion": APP_VERSION,
        "openSubsonic": True,
        **body,
    }


def _scalar(value: Any) -> str:
    if isinstance(value, bool):
        return "true" if value else "false"
    return str(value)


def _element(name: str, value: dict[str, Any]) -> str:
    attrs: list[str] = []
    children: list[str] = []
    text = ""
    for key, item in value.items():
        if item is None:
            continue
        if key == "value":
            text = escape(_scalar(item))
        elif isinstance(item, dict):
            children.append(_element(key, item))
        elif isinstance(item, list):
            for entry in item:
                if isinstance(entry, dict):
                    children.append(_element(key, entry))
                else:
                    children.append(f"<{key}>{escape(_scalar(entry))}</{key}>")
        else:
            attrs.append(f"{key}={quoteattr(_scalar(item))}")
    head = f"<{name}{''.join(' ' + a for a in attrs)}"
    if not children and not text:
        return head + "/>"
    return f"{head}>{text}{''.join(children)}</{name}>"


def _strip_none(value: Any) -> Any:
    if isinstance(value, dict):
        return {k: _strip_none(v) for k, v in value.items() if v is not None}
    if isinstance(value, list):
        return [_strip_none(v) for v in value]
    return value


def respond(body: dict[str, Any], fmt: str | None, status: str = "ok") -> Response:
    envelope = _envelope(status, body)
    if (fmt or "").lower() == "json":
        payload = json.dumps({"subsonic-response": _strip_none(envelope)}, ensure_ascii=False)
        return Response(payload, media_type="application/json")
    root = dict(envelope)
    root["xmlns"] = XMLNS
    xml = '<?xml version="1.0" encoding="UTF-8"?>' + _element("subsonic-response", root)
    return Response(xml, media_type="application/xml")


def error(err: SubsonicError, fmt: str | None) -> Response:
    return respond({"error": {"code": err.code, "message": err.message}}, fmt, status="failed")
