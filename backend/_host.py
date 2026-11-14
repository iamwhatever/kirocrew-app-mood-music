"""Every place this app reaches into the Kiro Crew gateway, in one module.

An external app's Python runs inside the gateway process, but the only gateway
surface it relies on is the public App Kit one: the ``AppContext`` handed to its
hooks, and the structural route records ``RouteRegistry`` accepts. Nothing here
imports ``kiro_crew`` (``tests/test_no_host_imports.py`` pins that), so the app
does not break when a wheel moves a private module.

The seams this app needs arrived at App Kit level 1. Each is read off the
context with ``getattr``, and each has a fallback that is never MORE permissive
than the host:

1. Routes: a local frozen dataclass with ``method`` / ``path`` / ``handler``.
   A level-1 ``RouteRegistry`` accepts any object of that shape.
2. ``ctx.require_owner(request, operation)``: the host's own owner gate, which
   audits a denial as ``<app>.<operation>``. Without it every caller is
   refused, the owner included (fail closed).
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Awaitable, Callable

from aiohttp import web

#: The App Kit seam level this app is written against.
REQUIRED_SDK_LEVEL = 1

Handler = Callable[[web.Request, Any], Awaitable[web.StreamResponse]]


@dataclass(frozen=True)
class Route:
    """One ``hooks.routes`` record, accepted structurally by the gateway."""

    method: str
    path: str
    handler: Handler


def app_route(method: str, path: str, handler: Handler) -> Route:
    return Route(method, path, handler)


def sdk_level(ctx: Any) -> int:
    """The seam level the gateway reports; 0 for a gateway that predates the field."""
    level = getattr(ctx, "sdk_level", 0)
    return level if isinstance(level, int) and not isinstance(level, bool) else 0


def _owner_denied() -> web.Response:
    return web.json_response(
        {"error": "owner authorization required", "code": "owner_only"}, status=403
    )


async def require_owner(
    ctx: Any, request: web.Request, operation: str
) -> web.StreamResponse | None:
    """``None`` when the caller is the dashboard owner, else the refusal to return.

    *operation* is bare (``"add_moment"``): the host prefixes the app's own name
    when it audits a denial. A gateway without the seam refuses everyone.
    """
    gate = getattr(ctx, "require_owner", None)
    if not callable(gate):
        return _owner_denied()
    return await gate(request, operation)
