"""Saved playlists (``backend/playlists.py``): save, from liked songs, caps, delete, play.

The rules each test pins: a list is checked like a queue (one bad song refuses
it whole), the caps answer a clear code and store nothing, playing a list
replaces the queue and plays on through it in parts that keep the playing song
in place, the buddy is asked for more only once the list ran out and only when
the person allowed it, and every route is owner-only.
"""

from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from backend import playlists
from backend.store import MAX_QUEUE, MoodStore
from tests.harness import LegacyCtx, make_ctx
from tests.test_playback import FakeSlots, ended, fire, played
from tests.test_routes import NO_APP_CLAIM, _call

VID = "dQw4w9WgXcQ"
X = "0" * 32


def song(n: int, **over: Any) -> dict[str, Any]:
    return {"title": f"Song {n}", "artist": f"Artist {n}", "source": "youtube", "video_id": VID, "tags": ["calm"], **over}


@pytest.fixture
def ctx(tmp_path: Path):
    return make_ctx(tmp_path)


def _file(ctx: Any) -> Path:
    return Path(ctx.data_dir) / "playlists.json"


def _mood(ctx: Any) -> MoodStore:
    return MoodStore(Path(ctx.data_dir) / "state.json")


def _make(ctx: Any, count: int, name: str = "Rainy") -> dict[str, Any]:
    status, body = _call(ctx, "POST", "/playlists", {"name": name, "songs": [song(i) for i in range(count)]})
    assert status == 201, body
    return body


# ── save ──


def test_saving_the_queue_keeps_its_songs_in_order_with_plain_fields(ctx) -> None:
    _call(ctx, "POST", "/queue", {"source": "r1", "picks": [song(1, why="soft", tier="anchor"), song(2)]})
    queue = _call(ctx, "GET", "/state")[1]["queue"]
    status, body = _call(ctx, "POST", "/playlists", {"name": "  平静 · 11/22  ", "songs": queue})
    assert status == 201
    assert body["name"] == "平静 · 11/22"
    assert [s["title"] for s in body["songs"]] == ["Song 1", "Song 2"]
    first = body["songs"][0]
    # The queue's own id, feedback and tier stay behind; the list gives its own id.
    assert set(first) == {"id", "title", "artist", "why", "tags", "source", "video_id"}
    assert first["id"] != queue[0]["id"]
    listed = _call(ctx, "GET", "/playlists")[1]
    assert [p["name"] for p in listed["lists"]] == ["平静 · 11/22"]
    assert listed["then_buddy"] is False and listed["active"] is None
    assert listed["limits"] == {"lists": 50, "songs": 200}


def test_liked_songs_with_no_link_become_a_list_and_twins_are_kept_once(ctx) -> None:
    liked = [
        {"title": "苏州河", "artist": "薛凯琪", "source": "bilibili", "tags": ["missing"]},
        {"title": "Holocene", "artist": "Bon Iver", "source": "youtube"},
        {"title": " holocene ", "artist": "BON IVER", "source": "youtube"},
    ]
    status, body = _call(ctx, "POST", "/playlists", {"name": "Liked", "songs": liked})
    assert status == 201
    assert [(s["title"], s["source"]) for s in body["songs"]] == [("苏州河", "bilibili"), ("Holocene", "youtube")]


@pytest.mark.parametrize(
    ("body", "code"),
    [
        ({"songs": [song(1)]}, "invalid_field_type"),
        ({"name": "  ", "songs": [song(1)]}, "missing_required_field"),
        ({"name": "x" * 81, "songs": [song(1)]}, "field_too_long"),
        ({"name": "two\nlines", "songs": [song(1)]}, "invalid_field_type"),
        ({"name": "x", "songs": []}, "invalid_field_type"),
        ({"name": "x", "songs": "Song 1"}, "invalid_field_type"),
        ({"name": "x", "songs": [song(1), {"title": "", "source": "youtube"}]}, "invalid_pick"),
        ({"name": "x", "songs": [song(1, source="netease")]}, "invalid_source"),
        ({"name": "x", "songs": [song(1, video_id="javascript:alert(1)")]}, "invalid_video_id"),
        ({"name": "x", "songs": [song(1, source="bilibili", url="https://evil.example/BV1")]}, "invalid_bilibili_url"),
    ],
)
def test_a_bad_list_is_refused_whole_and_nothing_is_stored(ctx, body, code) -> None:
    status, payload = _call(ctx, "POST", "/playlists", body)
    assert (status, payload["code"]) == (400, code)
    assert not _file(ctx).exists()


# ── caps ──


def test_a_list_holds_at_most_200_songs(ctx) -> None:
    assert _call(ctx, "POST", "/playlists", {"name": "x", "songs": [song(i) for i in range(200)]})[0] == 201
    status, payload = _call(ctx, "POST", "/playlists", {"name": "y", "songs": [song(i) for i in range(201)]})
    assert (status, payload["code"]) == (400, "too_many_songs")
    assert len(_call(ctx, "GET", "/playlists")[1]["lists"]) == 1


def test_at_50_lists_a_new_one_answers_409_and_none_is_lost(ctx, monkeypatch) -> None:
    monkeypatch.setattr(playlists, "MAX_LISTS", 3)
    for i in range(3):
        _make(ctx, 1, name=f"L{i}")
    status, payload = _call(ctx, "POST", "/playlists", {"name": "one more", "songs": [song(1)]})
    assert (status, payload["code"]) == (409, "playlists_full")
    assert [p["name"] for p in _call(ctx, "GET", "/playlists")[1]["lists"]] == ["L2", "L1", "L0"]


# ── rename, delete, remove a song ──


def test_rename_delete_and_remove_a_song(ctx) -> None:
    lst = _make(ctx, 3)
    lid, second = lst["id"], lst["songs"][1]["id"]
    assert _call(ctx, "PUT", f"/playlists/{lid}", {"name": "Night"})[1]["name"] == "Night"
    assert _call(ctx, "PUT", f"/playlists/{lid}", {"name": ""})[0] == 400
    body = _call(ctx, "DELETE", f"/playlists/{lid}/songs/{second}")[1]
    assert [s["title"] for s in body["songs"]] == ["Song 0", "Song 2"]
    assert _call(ctx, "DELETE", f"/playlists/{lid}/songs/{second}")[0] == 404
    assert _call(ctx, "DELETE", f"/playlists/{lid}")[1] == {"deleted": lid}
    assert _call(ctx, "GET", "/playlists")[1]["lists"] == []
    assert _call(ctx, "DELETE", f"/playlists/{lid}")[0] == 404
    assert _call(ctx, "PUT", f"/playlists/{lid}", {"name": "x"})[0] == 404
    assert _call(ctx, "DELETE", "/playlists/not-an-id")[0] == 400


def test_deleting_the_playing_list_ends_it_and_leaves_the_queue(ctx) -> None:
    lst = _make(ctx, 14)
    _call(ctx, "POST", f"/playlists/{lst['id']}/play")
    _call(ctx, "DELETE", f"/playlists/{lst['id']}")
    assert _call(ctx, "GET", "/playlists")[1]["active"] is None
    assert len(_call(ctx, "GET", "/state")[1]["queue"]) == MAX_QUEUE


# ── play ──


def test_playing_a_list_replaces_the_queue_with_its_first_part(ctx) -> None:
    _call(ctx, "POST", "/queue", {"source": "r1", "picks": [song(90), song(91)]})
    lst = _make(ctx, 14)
    status, body = _call(ctx, "POST", f"/playlists/{lst['id']}/play")
    assert status == 200
    queue = _call(ctx, "GET", "/state")[1]["queue"]
    assert [p["title"] for p in queue] == [f"Song {i}" for i in range(MAX_QUEUE)]
    assert [p["id"] for p in queue] == [p["id"] for p in body["queue"]]
    assert all(p["feedback"] == "" for p in queue)
    assert _call(ctx, "GET", "/playlists")[1]["active"] == {"id": lst["id"], "next": MAX_QUEUE}
    assert _call(ctx, "POST", f"/playlists/{X}/play")[0] == 404


def test_the_next_part_goes_after_the_song_about_to_play_which_keeps_its_place(ctx) -> None:
    lst = _make(ctx, 30)
    queue = _call(ctx, "POST", f"/playlists/{lst['id']}/play")[1]["queue"]
    about = queue[-1]
    status, body = _call(ctx, "POST", "/playlists-next", {"pick_id": about["id"]})
    assert (status, body) == (200, {"active": True, "added": MAX_QUEUE - 1, "ask_buddy": False})
    after = _call(ctx, "GET", "/state")[1]["queue"]
    # The song about to play is still there, with the same id, so the marker stays on it.
    assert after[0]["id"] == about["id"]
    assert [p["title"] for p in after] == [f"Song {i}" for i in range(11, 11 + MAX_QUEUE)]
    assert _call(ctx, "GET", "/playlists")[1]["active"]["next"] == 2 * MAX_QUEUE - 1


def test_a_list_that_ran_out_asks_the_buddy_only_when_allowed(ctx) -> None:
    lst = _make(ctx, 2)
    queue = _call(ctx, "POST", f"/playlists/{lst['id']}/play")[1]["queue"]
    last = {"pick_id": queue[-1]["id"]}
    assert _call(ctx, "POST", "/playlists-next", last)[1] == {"active": True, "added": 0, "ask_buddy": False}
    assert _call(ctx, "PUT", "/playlists-settings", {"then_buddy": True})[1] == {"then_buddy": True}
    assert _call(ctx, "POST", "/playlists-next", last)[1] == {"active": True, "added": 0, "ask_buddy": True}
    assert _call(ctx, "GET", "/playlists")[1]["then_buddy"] is True


def test_a_queue_the_buddy_replaced_ends_the_list(ctx) -> None:
    lst = _make(ctx, 14)
    _call(ctx, "POST", f"/playlists/{lst['id']}/play")
    _call(ctx, "POST", "/queue", {"source": "reply-2", "picks": [song(50), song(51)]})
    pid = _call(ctx, "GET", "/state")[1]["queue"][-1]["id"]
    assert _call(ctx, "POST", "/playlists-next", {"pick_id": pid})[1] == {"active": False, "added": 0, "ask_buddy": True}
    assert _call(ctx, "GET", "/playlists")[1]["active"] is None
    assert [p["title"] for p in _call(ctx, "GET", "/state")[1]["queue"]] == ["Song 50", "Song 51"]


def test_no_list_playing_leaves_the_refill_to_the_buddy(ctx) -> None:
    assert _call(ctx, "POST", "/playlists-next", {"pick_id": X})[1] == {"active": False, "added": 0, "ask_buddy": True}


def test_removing_a_song_already_queued_moves_the_next_part_up(ctx) -> None:
    lst = _make(ctx, 14)
    _call(ctx, "POST", f"/playlists/{lst['id']}/play")
    _call(ctx, "DELETE", f"/playlists/{lst['id']}/songs/{lst['songs'][0]['id']}")
    assert _call(ctx, "GET", "/playlists")[1]["active"]["next"] == MAX_QUEUE - 1


@pytest.mark.parametrize(
    ("method", "path", "body"),
    [
        ("POST", "/playlists-next", {}),
        ("POST", "/playlists-next", {"pick_id": "x"}),
        ("POST", "/playlists-next", {"pick_id": X, "more": 1}),
        ("PUT", "/playlists-settings", {"then_buddy": "yes"}),
        ("PUT", "/playlists-settings", {}),
        ("DELETE", f"/playlists/{X}/songs/nope", None),
    ],
)
def test_bad_play_requests_are_refused(ctx, method, path, body) -> None:
    assert _call(ctx, method, path, body)[0] == 400


def test_a_damaged_file_is_moved_aside_not_overwritten(ctx) -> None:
    _file(ctx).parent.mkdir(parents=True, exist_ok=True)
    _file(ctx).write_text("{not json", encoding="utf-8")
    assert _call(ctx, "GET", "/playlists")[1]["lists"] == []
    assert (_file(ctx).parent / "playlists.json.bad").read_text(encoding="utf-8") == "{not json"


# ── the page closed: the backend plays on through the list ──


@pytest.fixture
def hook_ctx(tmp_path: Path):
    c = make_ctx(tmp_path)
    c.chat_slots = FakeSlots()  # type: ignore[attr-defined]
    c.http_app = {"state": SimpleNamespace(owner_id="owner")}  # type: ignore[attr-defined]
    return c


def _play_list(ctx: Any, count: int) -> list[dict[str, Any]]:
    entry = playlists.playlist_store(ctx).create("x", [{k: v for k, v in song(i).items()} for i in range(count)])
    queue = playlists.playlist_store(ctx).start(entry["id"], _mood(ctx))
    assert queue
    return queue


def test_with_the_page_closed_a_list_plays_on_without_asking_the_buddy_for_more(hook_ctx) -> None:
    queue = _play_list(hook_ctx, 14)
    _mood(hook_ctx).set_playback(pick_id=queue[-2]["id"])
    hook_ctx.chat_slots.reply = played()
    fire(hook_ctx, ended())
    sent = hook_ctx.chat_slots.sent
    assert len(sent) == 1 and '"Song 11"' in sent[0]
    assert "nearly empty" not in sent[0]
    assert [p["title"] for p in _mood(hook_ctx).snapshot()["queue"]][-3:] == ["Song 11", "Song 12", "Song 13"]


def test_with_the_page_closed_a_finished_list_asks_the_buddy_only_when_allowed(hook_ctx) -> None:
    queue = _play_list(hook_ctx, 2)
    _mood(hook_ctx).set_playback(pick_id=queue[0]["id"])
    fire(hook_ctx, ended())
    assert "nearly empty" not in hook_ctx.chat_slots.sent[-1]

    hook_ctx.chat_slots.tracked.clear()
    queue = _play_list(hook_ctx, 2)
    playlists.playlist_store(hook_ctx).set_then_buddy(True)
    _mood(hook_ctx).set_playback(pick_id=queue[0]["id"])
    fire(hook_ctx, ended())
    assert "nearly empty" in hook_ctx.chat_slots.sent[-1]


# ── owner-only ──

PLAYLIST_ROUTES = [
    ("GET", "/playlists", None, "list_playlists"),
    ("POST", "/playlists", {"name": "x", "songs": [song(1)]}, "create_playlist"),
    ("PUT", f"/playlists/{X}", {"name": "x"}, "rename_playlist"),
    ("DELETE", f"/playlists/{X}", None, "delete_playlist"),
    ("DELETE", f"/playlists/{X}/songs/{X}", None, "remove_playlist_song"),
    ("POST", f"/playlists/{X}/play", None, "play_playlist"),
    ("POST", "/playlists-next", {"pick_id": X}, "playlist_next"),
    ("PUT", "/playlists-settings", {"then_buddy": True}, "playlist_settings"),
]


@pytest.mark.parametrize(("method", "path", "body", "op"), PLAYLIST_ROUTES)
def test_a_non_owner_dashboard_caller_is_refused(ctx, method, path, body, op) -> None:
    status, payload = _call(ctx, method, path, body, user="allowlisted-2")
    assert (status, payload.get("code")) == (403, "owner_only")
    assert ctx.owner_checks == [op]
    assert not _file(ctx).exists()


@pytest.mark.parametrize(("method", "path", "body", "op"), PLAYLIST_ROUTES)
def test_a_request_with_no_app_claim_is_refused(ctx, method, path, body, op) -> None:
    assert _call(ctx, method, path, body, app=NO_APP_CLAIM)[1].get("code") == "owner_only"
    assert not _file(ctx).exists()


@pytest.mark.parametrize(("method", "path", "body", "op"), PLAYLIST_ROUTES)
def test_a_gateway_without_the_owner_seam_refuses_everyone(tmp_path: Path, method, path, body, op) -> None:
    assert _call(LegacyCtx(tmp_path), method, path, body)[0] == 403
