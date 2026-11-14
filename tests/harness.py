"""Serve ``register_routes(ctx)`` the way the gateway's RouteRegistry does.

The registry mounts one catch-all at ``/api/apps/{app_name}/{path}``, matches the
remainder against each route record, injects path params into ``match_info``,
and calls ``handler(request, ctx)``. aiohttp's own router does the matching here,
under the same prefix, so a test request uses the URL a dashboard request uses.

``FakeCtx`` stands in for the gateway's ``AppContext`` at App Kit level 1, with
only the fields this app reads. Nothing here imports Kiro Crew and nothing opens
a socket beyond aiohttp's loopback test server.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from aiohttp import web

from backend import routes as routes_mod

PREFIX = "/api/apps/mood-music"


class FakeHealth:
    def __init__(self) -> None:
        self.status = "healthy"
        self.issues: list[str] = []

    def mark_degraded(self, issue: str) -> None:
        self.status = "degraded"
        self.issues.append(issue)


@dataclass
class FakeCtx:
    """The ``AppContext`` fields this app reads, at App Kit level 1.

    ``require_owner`` mirrors the host predicate: ``None`` only for a dashboard
    request (``app`` claim present and ``""``) whose subject is the configured
    owner (``app["state"].owner_id``); otherwise the host's 403 ``owner_only``.
    Every call is recorded with its bare operation name.
    """

    name: str
    data_dir: Path
    sdk_level: int = 1
    health: FakeHealth = field(default_factory=FakeHealth)
    owner_checks: list[str] = field(default_factory=list)

    async def require_owner(self, request: web.Request, operation: str) -> Any | None:
        self.owner_checks.append(operation)
        state = request.app.get("state")
        owner_id = str(getattr(state, "owner_id", "") or "")
        caller = str(request.get("user") or "")
        dashboard = "app" in request and request["app"] == ""
        if dashboard and owner_id and caller == owner_id:
            return None
        return web.json_response(
            {"error": "owner authorization required", "code": "owner_only"}, status=403
        )


class LegacyCtx:
    """A context from a gateway that predates App Kit level 1: no seams at all."""

    def __init__(self, data_dir: Path) -> None:
        self.name = "mood-music"
        self.data_dir = Path(data_dir)
        self.health = FakeHealth()


def make_ctx(data_dir: Path) -> FakeCtx:
    return FakeCtx(name="mood-music", data_dir=Path(data_dir))


@dataclass
class _State:
    owner_id: str


def build_app(
    ctx: Any, *, middlewares: list[Any] | None = None, owner_id: str = ""
) -> web.Application:
    app = web.Application(middlewares=middlewares or [])
    app["state"] = _State(owner_id)
    for route in routes_mod.register_routes(ctx):

        async def _dispatch(request: web.Request, _route: Any = route) -> web.StreamResponse:
            return await _route.handler(request, ctx)

        app.router.add_route(route.method, PREFIX + route.path, _dispatch)
    return app


def identity(user: str, app_claim: Any) -> Any:
    """Middleware standing in for the token middleware's authenticated claims.

    ``app_claim`` of ``None`` leaves the ``app`` key absent entirely.
    """

    @web.middleware
    async def _identity(request: web.Request, handler: Any) -> web.StreamResponse:
        request["user"] = user
        if app_claim is not None:
            request["app"] = app_claim
        return await handler(request)

    return _identity
