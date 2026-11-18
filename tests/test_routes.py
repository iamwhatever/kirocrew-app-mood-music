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
        "unverified": True,
    }
    status, body = _call(ctx, "POST", "/queue", {"source": "r1", "picks": [_yt(**extra), _yt(unverified=False)]})
    assert status == 200
    first, plain = body["queue"]
    assert first["unverified"] is True
    assert first["tier"] == "explore" and first["arc"] == "turn"
    assert first["listen_for"] == "the second verse drops to piano"
    assert first["evidence"] == {"url": "https://example.com/review?x=1", "label": "A review"}
    assert not {"tier", "arc", "listen_for", "evidence", "unverified"} & plain.keys()


@pytest.mark.parametrize("source", ["youtube", "bilibili"])
def test_a_pick_with_no_link_is_stored_by_its_site(ctx, source) -> None:
    pick = {"title": "Song", "artist": "A", "why": "fits", "source": source, "url": ""}
    status, body = _call(ctx, "POST", "/queue", {"source": "r1", "picks": [pick]})
    assert status == 200
    (stored,) = body["queue"]
    assert stored["source"] == source
    assert not {"url", "video_id"} & stored.keys()


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
        (_yt(unverified="yes"), "invalid_pick"),
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


def test_memory_add_edit_pin_delete_and_clear(ctx) -> None:
    status, note = _call(ctx, "POST", "/memory", {"kind": "note", "text": " 不要太吵 "})
    assert status == 201 and (note["text"], note["origin"], note["stale"]) == ("不要太吵", "user", False)
    status, song = _call(ctx, "POST", "/memory", {"kind": "known", "title": "苏州河", "artist": "薛凯琪", "origin": "app"})
    assert status == 201 and song["origin"] == "app"
    status, edited = _call(ctx, "PUT", f"/memory/{note['id']}", {"text": "晚上别推摇滚", "pinned": True})
    assert status == 200 and (edited["text"], edited["pinned"]) == ("晚上别推摇滚", True)
    assert _call(ctx, "POST", "/memory/used", {"ids": [song["id"]]})[1] == {"marked": 1}
    assert _call(ctx, "POST", "/memory/clear-stale")[1] == {"removed": 0}
    assert _call(ctx, "DELETE", f"/memory/{song['id']}")[0] == 200
    assert _call(ctx, "DELETE", f"/memory/{song['id']}")[0] == 404
    state = _call(ctx, "GET", "/state")[1]
    assert [m["text"] for m in state["memory"]] == ["晚上别推摇滚"]


@pytest.mark.parametrize(
    "body",
    [
        {"kind": "secret", "text": "x"},
        {"kind": "note", "text": "x", "origin": "agent"},
        {"kind": "note", "text": ""},
        {"kind": "note", "text": "x" * 61},
        {"kind": "known", "artist": "no title"},
        {"kind": "note", "text": ["x"]},
    ],
)
def test_a_malformed_memory_item_is_refused(ctx, body) -> None:
    status, payload = _call(ctx, "POST", "/memory", body)
    assert status == 400 and payload["code"]
    assert not _state_file(ctx).exists()


@pytest.mark.parametrize(
    ("method", "path", "body"),
    [
        ("PUT", "/memory/not-an-id", {"pinned": True}),
        ("PUT", f"/memory/{'0' * 32}", {"pinned": "yes"}),
        ("PUT", f"/memory/{'0' * 32}", {"text": ""}),
        ("DELETE", "/memory/not-an-id", None),
        ("POST", "/memory/used", {"ids": ["../x"]}),
        ("POST", "/memory/used", {"ids": ["0" * 32] * 101}),
    ],
)
def test_memory_edits_check_their_input(ctx, method, path, body) -> None:
    assert _call(ctx, method, path, body)[0] in (400, 404)


def test_a_memory_full_of_the_persons_own_notes_answers_409(ctx, monkeypatch) -> None:
    from backend import store as store_mod

    monkeypatch.setitem(store_mod.MEMORY_CAPS, "note", 1)
    assert _call(ctx, "POST", "/memory", {"kind": "note", "text": "a"})[0] == 201
    status, payload = _call(ctx, "POST", "/memory", {"kind": "note", "text": "b"})
    assert (status, payload["code"]) == (409, "memory_full")


def test_settings_keep_the_explore_level_and_the_record_state(ctx) -> None:
    base = {"explore": "balanced", "record_open": False, "continuous": False, "view_open": True}
    assert _call(ctx, "GET", "/state")[1]["settings"] == base
    assert _call(ctx, "PUT", "/settings", {"explore": "familiar"})[1] == {**base, "explore": "familiar"}
    assert _call(ctx, "PUT", "/settings", {"record_open": True})[1]["record_open"] is True
    assert _call(ctx, "PUT", "/settings", {"continuous": True})[1]["continuous"] is True
    assert _call(ctx, "PUT", "/settings", {"view_open": False})[1]["view_open"] is False
    assert _call(ctx, "GET", "/state")[1]["settings"] == {
        "explore": "familiar", "record_open": True, "continuous": True, "view_open": False,
    }


@pytest.mark.parametrize(
    "body",
    [{}, {"explore": "wild"}, {"record_open": "yes"}, {"player": "browser"},
     {"explore": "balanced", "player": "youtube"},
     {"explore": "balanced", "theme": "dark"}, {"continuous": "on"}, {"continuous": 1},
     {"view_open": "no"}, {"view_open": 0}],
)
def test_bad_settings_are_refused(ctx, body) -> None:
    assert _call(ctx, "PUT", "/settings", body)[0] == 400


ROUTES = [
    ("GET", "/state", None, "read_state"),
    ("POST", "/moments", {"mood": "calm"}, "add_moment"),
    ("POST", "/queue", {"source": "r1", "picks": [_yt()]}, "set_queue"),
    ("PUT", f"/queue/{'0' * 32}/feedback", {"verdict": "liked"}, "feedback"),
    ("POST", "/verify-picks", {"picks": "not a list"}, "verify_picks"),
    ("POST", "/memory", {"kind": "note", "text": "quiet"}, "add_memory"),
    ("PUT", f"/memory/{'0' * 32}", {"pinned": True}, "update_memory"),
    ("DELETE", f"/memory/{'0' * 32}", None, "delete_memory"),
    ("POST", "/memory/clear-stale", None, "clear_stale"),
    ("POST", "/memory/used", {"ids": []}, "memory_used"),
    ("PUT", "/settings", {"explore": "explore"}, "settings"),
    ("PUT", "/play-steps/bilibili", {"steps": ["open search"]}, "set_play_steps"),
    ("DELETE", "/play-steps/bilibili", None, "forget_play_steps"),
]


def test_a_refill_adds_after_the_queue_and_keeps_it_bounded(ctx) -> None:
    _call(ctx, "POST", "/queue", {"source": "r1", "picks": [_yt(title=f"Old {i}") for i in range(10)]})
    status, body = _call(
        ctx, "POST", "/queue",
        {"source": "r2", "append": True, "picks": [_yt(title=f"New {i}") for i in range(4)]},
    )
    assert status == 200 and [p["title"] for p in body["queue"]] == [f"New {i}" for i in range(4)]
    titles = [p["title"] for p in _call(ctx, "GET", "/state")[1]["queue"]]
    assert titles == [f"Old {i}" for i in range(2, 10)] + [f"New {i}" for i in range(4)]
    assert _call(ctx, "POST", "/queue", {"source": "r3", "append": "yes", "picks": [_yt()]})[0] == 400


def test_play_steps_are_kept_per_site_and_forgotten_after_a_failure(ctx) -> None:
    steps = ["click the search box", "type the song and artist", "click the first video"]
    status, body = _call(ctx, "PUT", "/play-steps/bilibili", {"steps": [f"  {s} " for s in steps]})
    assert status == 200 and body["steps"] == steps
    _call(ctx, "PUT", "/play-steps/youtube", {"steps": ["open the results page"]})
    saved = _call(ctx, "GET", "/state")[1]["play_steps"]
    assert saved["bilibili"]["steps"] == steps and saved["youtube"]["steps"] == ["open the results page"]
    # A failed play: the steps go, and the next success writes the new way.
    assert _call(ctx, "DELETE", "/play-steps/bilibili")[1] == {"site": "bilibili", "forgotten": True}
    assert "bilibili" not in _call(ctx, "GET", "/state")[1]["play_steps"]
    _call(ctx, "PUT", "/play-steps/bilibili", {"steps": ["open the search page for the song"]})
    assert _call(ctx, "GET", "/state")[1]["play_steps"]["bilibili"]["steps"] == ["open the search page for the song"]
    assert _call(ctx, "DELETE", "/play-steps/bilibili")[1]["forgotten"] is True
    assert _call(ctx, "DELETE", "/play-steps/bilibili")[1]["forgotten"] is False


@pytest.mark.parametrize(
    ("path", "body"),
    [
        ("/play-steps/spotify", {"steps": ["x"]}),
        ("/play-steps/bilibili", {"steps": []}),
        ("/play-steps/bilibili", {"steps": "click"}),
        ("/play-steps/bilibili", {"steps": ["x"] * 9}),
        ("/play-steps/bilibili", {"steps": ["x" * 121]}),
        ("/play-steps/bilibili", {"steps": ["   "]}),
        ("/play-steps/bilibili", {"steps": [3]}),
        ("/play-steps/bilibili", {"steps": ["line\nbreak"]}),
        ("/play-steps/bilibili", {"steps": ["```"]}),
        ("/play-steps/bilibili", {"steps": ["[Mood Music]"]}),
        ("/play-steps/bilibili", {"steps": ["ok"], "extra": 1}),
    ],
)
def test_bad_play_steps_are_refused(ctx, path, body) -> None:
    assert _call(ctx, "PUT", path, body)[0] == 400
    assert not _state_file(ctx).exists()


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
    assert status in (200, 201, 400, 404)
    assert ctx.owner_checks == []


@pytest.mark.parametrize(("method", "path", "body", "op"), ROUTES)
def test_a_gateway_without_the_owner_seam_refuses_everyone(
    tmp_path: Path, method, path, body, op
) -> None:
    legacy = LegacyCtx(tmp_path)
    status, payload = _call(legacy, method, path, body)
    assert (status, payload.get("code")) == (403, "owner_only")
    assert legacy.health.status == "degraded"
