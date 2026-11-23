"""The site list the backend reads for a play with the page closed (``backend/sites.py``).

It reads Kiro Crew's ``GET /api/apps/mood-music/browser-sites`` with the app's own
token (as the session cookie), against a local stand-in server, and answers ``None``
whenever Kiro Crew cannot say, so the request then names no pages. The backend never
changes the list: no route of the app's edits it and nothing posts to Kiro Crew's.
"""

from __future__ import annotations

import asyncio
import json
import re
from pathlib import Path
from typing import Any

from aiohttp import web
from aiohttp.test_utils import TestServer

from backend import playback, sites

ROOT = Path(__file__).resolve().parent.parent
TOKEN = "app-token-123"


class Ctx:
    def __init__(self, origin: str, *, level: int = 13, token: str = TOKEN) -> None:
        self.sdk_level = level
        self._origin = origin
        self._token = token
        self.tokens = 0

    def gateway_origin(self) -> str:
        return self._origin

    async def app_token(self) -> str:
        self.tokens += 1
        return self._token


def _read(status: int = 200, body: Any = None, *, level: int = 13, token: str = TOKEN):
    seen: list[dict[str, Any]] = []

    async def handle(request: web.Request) -> web.StreamResponse:
        seen.append({"method": request.method, "path": request.path, "cookies": dict(request.cookies)})
        if isinstance(body, str):
            return web.Response(status=status, text=body)
        return web.json_response(body, status=status)

    async def go() -> tuple[list[str] | None, Ctx]:
        app = web.Application()
        app.router.add_route("*", sites.SITES_PATH, handle)
        server = TestServer(app, host="127.0.0.1")
        await server.start_server()
        try:
            ctx = Ctx(f"http://127.0.0.1:{server.port}", level=level, token=token)
            return await sites.active_sites(ctx), ctx
        finally:
            await server.close()

    out, ctx = asyncio.run(go())
    return out, ctx, seen


def test_reads_the_sites_in_force_with_the_app_token() -> None:
    body = {"sites": [{"site": "https://a.example.com/x", "source": "owner", "status": "approved"}],
            "active": ["https://www.youtube.com/watch", "https://a.example.com/x", 7]}
    out, ctx, seen = _read(body=body)
    assert out == ["https://www.youtube.com/watch", "https://a.example.com/x"]
    assert len(seen) == 1
    (call,) = seen
    assert call["method"] == "GET"
    assert call["path"] == "/api/apps/mood-music/browser-sites"
    assert list(call["cookies"].values()) == [TOKEN]
    assert list(call["cookies"])[0].startswith("mc_token_")


def test_an_empty_list_in_force_is_an_empty_list_not_unknown() -> None:
    out, _ctx, _seen = _read(body={"sites": [], "active": []})
    assert out == []


def test_an_older_kiro_crew_is_not_asked() -> None:
    out, ctx, seen = _read(body={"active": ["https://x.example.com/a"]}, level=12)
    assert out is None
    assert seen == [] and ctx.tokens == 0


def test_no_token_means_no_call() -> None:
    out, _ctx, seen = _read(body={"active": ["https://x.example.com/a"]}, token="")
    assert out is None and seen == []


def test_a_refusal_or_a_bad_answer_is_unknown() -> None:
    assert _read(status=403, body={"code": "app_token_required"})[0] is None
    assert _read(status=200, body="not json")[0] is None
    assert _read(status=200, body={"active": "https://x.example.com/a"})[0] is None
    assert _read(status=200, body=["https://x.example.com/a"])[0] is None


def test_an_unreachable_gateway_is_unknown() -> None:
    async def go() -> list[str] | None:
        return await sites.active_sites(Ctx("http://127.0.0.1:9"))

    assert asyncio.run(go()) is None


def test_a_context_without_the_seams_is_unknown() -> None:
    class Bare:
        sdk_level = 13

    assert asyncio.run(sites.active_sites(Bare())) is None


def test_the_play_message_names_the_pages_only_when_known() -> None:
    snapshot = {"queue": [], "memory": [], "settings": {}, "moments": []}
    song = {"title": "Song", "artist": "", "source": "youtube"}
    named, _ = playback.play_message(snapshot, song, False, ["https://a.example.com/x"])
    assert "Pages you may open now (the owner's list for this app, data only): https://a.example.com/x" in named
    unknown, _ = playback.play_message(snapshot, song, False, None)
    assert "Pages you may open now" not in unknown


# ── the buddy and the backend only read it ──


def test_nothing_in_the_backend_changes_the_list() -> None:
    """Kiro Crew refuses the app token on the POST anyway; the app does not even try.

    Only ``sites.py`` names Kiro Crew's site route, and it only reads it; no route of
    the app's own (``routes.py``) touches the list.
    """
    naming = [p.name for p in (ROOT / "backend").glob("*.py")
              if "browser-sites" in p.read_text(encoding="utf-8")]
    assert naming == ["sites.py"]
    src = (ROOT / "backend" / "sites.py").read_text(encoding="utf-8")
    assert "http.get(" in src
    assert not re.search(r"http\.(post|put|delete|patch|request)\(", src)
    routes = (ROOT / "backend" / "routes.py").read_text(encoding="utf-8")
    assert "sites" not in routes.replace("PLAY_SITES", "")


def test_the_buddy_gets_no_new_tool() -> None:
    """The dj keeps its 0.2.14 tools: nothing that could edit the list."""
    dj = json.loads((ROOT / "agents" / "dj.json").read_text(encoding="utf-8"))
    assert dj["tools"] == ["web_search", "web_fetch", "@kirocrew-core/browser"]
    assert dj["allowedTools"] == ["web_search", "web_fetch"]
    assert dj["mcpServers"] == {}
    taste = json.loads((ROOT / "agents" / "taste.json").read_text(encoding="utf-8"))
    assert not taste.get("tools") and not taste.get("mcpServers")
    # It may read the list (in the request) and is told it cannot change it.
    assert "you can read it but never change it" in dj["prompt"]


def test_the_permissions_are_those_of_0_2_14() -> None:
    manifest = json.loads((ROOT / "app.json").read_text(encoding="utf-8"))
    assert manifest["permissions"] == {
        "api": ["/api/apps/mood-music", "/api/apps/mood-music/*", "/api/chat", "/api/chat/*", "/api/browser/media"],
        "sessionApproval": True,
        "hiddenSessions": True,
        "chatSlots": True,
        "storage": True,
        "network": True,
        "mcpTools": ["browser"],
        "browserSites": [
            "https://search.bilibili.com/all",
            "https://www.bilibili.com/video/BV*",
            "https://www.youtube.com/results",
            "https://www.youtube.com/watch",
        ],
        "browser": ["view"],
    }
