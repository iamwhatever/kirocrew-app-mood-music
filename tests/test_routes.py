"""Mood Music routes: input checked at the boundary, owner-only on every route.

The link refusals are the load-bearing ones: a pick's link reaches an iframe
(YouTube) or a new tab (bilibili), so a request carrying one bad pick is refused
whole and nothing is stored. Disabling is the registry's job (it unmounts the
routes), so the app carries no enable check of its own.
"""

from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any

import pytest
from aiohttp.test_utils import TestClient, TestServer

from tests.harness import PREFIX, LegacyCtx, build_app, identity, make_ctx

OWNER = "owner-1"
ID = "dQw4w9WgXcQ"
NO_APP_CLAIM = None


def _yt(**over: Any) -> dict:
    return {
        "title": "Song",
        "artist": "A",
        "why": "fits",
        "source": "youtube",
        "url": f"https://www.youtube.com/watch?v={ID}",
        **over,
    }


def _bili(url: str) -> dict:
    return {"title": "Song", "source": "bilibili", "url": url}


def _call(
    ctx: Any, method: str, path: str, body: Any = None, *, user: str = OWNER, app: Any = ""
) -> tuple[int, Any]:
    async def go() -> tuple[int, Any]:
        server_app = build_app(ctx, middlewares=[identity(user, app)], owner_id=OWNER)
        async with TestClient(TestServer(server_app)) as client:
            resp = await client.request(method, PREFIX + path, json=body)
            return resp.status, await resp.json()

    return asyncio.run(go())


@pytest.fixture
def ctx(tmp_path: Path):
    return make_ctx(tmp_path)


def _state_file(ctx: Any) -> Path:
    return Path(ctx.data_dir) / "state.json"


def test_a_mood_then_a_queue_then_feedback(ctx) -> None:
    status, moment = _call(ctx, "POST", "/moments", {"mood": "  想念  ", "note": "rain"})
    assert status == 201 and moment["mood"] == "想念" and moment["note"] == "rain"
    status, body = _call(
        ctx,
        "POST",
        "/queue",
        {
            "source": "r1",
            "moment_id": moment["id"],
            "mood_tags": ["温柔"],
            "picks": [
                _yt(),
                _yt(url=f"https://youtu.be/{ID}"),
                _bili("https://www.bilibili.com/video/BV1xx411c7mD"),
            ],
        },
    )
    assert status == 200
    queue = body["queue"]
    assert [p["source"] for p in queue] == ["youtube", "youtube", "bilibili"]
    # A YouTube pick keeps only its id; the URL the agent gave is not stored.
    assert queue[0]["video_id"] == ID and "url" not in queue[0]
    assert queue[2]["url"] == "https://www.bilibili.com/video/BV1xx411c7mD"
    status, pick = _call(ctx, "PUT", f"/queue/{queue[0]['id']}/feedback", {"verdict": "liked"})
    assert (status, pick["feedback"]) == (200, "liked")
    status, state = _call(ctx, "GET", "/state")
    assert status == 200
    assert state["feedback"][0]["verdict"] == "liked"
    assert state["moments"][0]["songs"][0]["title"] == "Song"


def test_a_pick_keeps_its_tier_arc_listen_for_and_evidence(ctx) -> None:
    extra = {
        "tier": "explore",
        "arc": "turn",
        "listen_for": "  the second verse drops to piano  ",
        "evidence": {"url": "https://Example.com/review?x=1#top", "label": "A review"},
    }
    status, body = _call(ctx, "POST", "/queue", {"source": "r1", "picks": [_yt(**extra), _yt()]})
    assert status == 200
    first, plain = body["queue"]
    assert first["tier"] == "explore" and first["arc"] == "turn"
    assert first["listen_for"] == "the second verse drops to piano"
    assert first["evidence"] == {"url": "https://example.com/review?x=1", "label": "A review"}
    assert not {"tier", "arc", "listen_for", "evidence"} & plain.keys()


@pytest.mark.parametrize(
    ("pick", "code"),
    [
        (_yt(url=f"https://www.youtube.com/watch?v={ID}Q"), "invalid_video_id"),
        (_yt(url=None, video_id=ID + "Q"), "invalid_video_id"),
        (_yt(url=None, video_id="dQw4w9WgXc!"), "invalid_video_id"),
        (_yt(url=f"https://www.youtube-nocookie.com/embed/{ID}"), "invalid_video_id"),
        (_bili("https://bilibili.com.evil.com/video/BV1"), "invalid_bilibili_url"),
        (_bili("http://www.bilibili.com/video/BV1"), "invalid_bilibili_url"),
        (_bili("https://evil.com/video/BV1"), "invalid_bilibili_url"),
        (
            {"title": "x", "source": "spotify", "url": "https://open.spotify.com/x"},
            "invalid_source",
        ),
        ({"source": "youtube", "video_id": ID}, "invalid_pick"),
        (_yt(tags="calm"), "invalid_pick"),
        (_yt(tier="famous"), "invalid_pick"),
        (_yt(arc="up"), "invalid_pick"),
        (_yt(evidence={"url": "javascript:alert(1)", "label": "x"}), "invalid_pick"),
        (_yt(evidence={"url": "http://example.com/r"}), "invalid_pick"),
        (_yt(evidence="https://example.com/r"), "invalid_pick"),
        ("not an object", "invalid_pick"),
    ],
)
def test_one_bad_pick_refuses_the_whole_queue(ctx, pick, code) -> None:
    status, body = _call(ctx, "POST", "/queue", {"source": "r1", "picks": [_yt(), pick]})
    assert (status, body["code"]) == (400, code)
    assert not _state_file(ctx).exists()


@pytest.mark.parametrize(
    "body",
    [
        {"mood": ""},
        {"mood": "   "},
        {},
        {"mood": 3},
        {"mood": "x" * 201},
        {"mood": "calm", "tags": "calm"},
        {"mood": "calm", "tags": [""]},
    ],
)
def test_an_empty_or_malformed_mood_is_refused(ctx, body) -> None:
    status, payload = _call(ctx, "POST", "/moments", body)
    assert status == 400 and payload["code"]
    assert not _state_file(ctx).exists()


def test_an_unknown_mood_word_is_just_text(ctx) -> None:
    status, moment = _call(ctx, "POST", "/moments", {"mood": "something-no-chip-names"})
    assert status == 201 and moment["mood"] == "something-no-chip-names"


@pytest.mark.parametrize(
    "body",
    [
        {"picks": [_yt()]},
        {"source": "r1", "picks": []},
        {"source": "r1", "picks": [_yt()] * 13},
        {"source": "r1", "picks": [_yt()], "moment_id": "../x"},
        [1, 2],
    ],
)
def test_a_malformed_queue_request_is_refused(ctx, body) -> None:
    assert _call(ctx, "POST", "/queue", body)[0] == 400


def test_feedback_checks_the_id_and_the_verdict(ctx) -> None:
    assert _call(ctx, "PUT", "/queue/not-an-id/feedback", {"verdict": "liked"})[0] == 400
    (pick,) = _call(ctx, "POST", "/queue", {"source": "r", "picks": [_yt()]})[1]["queue"]
    assert _call(ctx, "PUT", f"/queue/{pick['id']}/feedback", {"verdict": "loved"})[0] == 400
    assert _call(ctx, "PUT", f"/queue/{'0' * 32}/feedback", {"verdict": "liked"})[0] == 404


ROUTES = [
    ("GET", "/state", None, "read_state"),
    ("POST", "/moments", {"mood": "calm"}, "add_moment"),
    ("POST", "/queue", {"source": "r1", "picks": [_yt()]}, "set_queue"),
    ("PUT", f"/queue/{'0' * 32}/feedback", {"verdict": "liked"}, "feedback"),
]


@pytest.mark.parametrize(("method", "path", "body", "op"), ROUTES)
def test_a_non_owner_dashboard_caller_is_refused(ctx, method, path, body, op) -> None:
    status, payload = _call(ctx, method, path, body, user="allowlisted-2")
    assert (status, payload.get("code")) == (403, "owner_only")
    assert ctx.owner_checks == [op]
    assert not _state_file(ctx).exists()


@pytest.mark.parametrize(("method", "path", "body", "op"), ROUTES)
def test_a_request_with_no_app_claim_is_refused(ctx, method, path, body, op) -> None:
    status, payload = _call(ctx, method, path, body, app=NO_APP_CLAIM)
    assert (status, payload.get("code")) == (403, "owner_only")


@pytest.mark.parametrize(("method", "path", "body", "op"), ROUTES)
def test_an_app_token_keeps_its_grant(ctx, method, path, body, op) -> None:
    status, _ = _call(ctx, method, path, body, user="app:mood-music", app="mood-music")
    assert status in (200, 201, 404)
    assert ctx.owner_checks == []


@pytest.mark.parametrize(("method", "path", "body", "op"), ROUTES)
def test_a_gateway_without_the_owner_seam_refuses_everyone(
    tmp_path: Path, method, path, body, op
) -> None:
    legacy = LegacyCtx(tmp_path)
    status, payload = _call(legacy, method, path, body)
    assert (status, payload.get("code")) == (403, "owner_only")
    assert legacy.health.status == "degraded"
