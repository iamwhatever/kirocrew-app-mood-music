"""Continuous play with the page closed: ``backend.hooks.on_browser_media_ended``.

``FakeSlots`` has the ``ctx.chat_slots`` calls the hook makes, in the shape the
host gives them (``get``, ``reserve``, ``send(..., reservation=)``, ``transcript``,
``track``). The event is the one KiroCrew#40261 hands the hook. The class of
cases: a hook that fires twice, a pause, continuous play off, the page and the
hook both hearing one ending, a low queue that asks for more and gets it, and a
host without the hook or the slot seam.
"""

from __future__ import annotations

import asyncio
import json
import time
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from backend import buddy, playback, verify
from backend.play_request import build_play_request, memory_summary, reply_source
from backend.store import MoodStore
from tests.harness import make_ctx
from tests.test_routes import _call

GOLDEN = Path(__file__).parent / "fixtures" / "play_request_golden.json"
VID = "dQw4w9WgXcQ"
OLD = time.time() - 3600


def ended(key: str = buddy.BUDDY_KEY) -> dict[str, Any]:
    return {"event": "browser_media_ended", "session_key": key, "origin": "https://www.youtube.com", "duration": 213.4}


class FakeSlot:
    def __init__(self) -> None:
        self.key = buddy.BUDDY_KEY
        self.running = False
        self.messages: list[dict[str, Any]] = []


class FakeSlots:
    def __init__(self) -> None:
        self.slot: FakeSlot | None = FakeSlot()
        self.sent: list[str] = []
        self.reservations: list[Any] = []
        self.tracked: list[asyncio.Task[Any]] = []
        self.reply = ""

    def get(self, state: Any, key: str) -> FakeSlot | None:
        return self.slot if key == buddy.BUDDY_KEY else None

    def reserve(self, state: Any, slot: FakeSlot) -> Any:
        if slot.running:
            return None
        token = object()
        self.reservations.append(token)
        return token

    def send(self, state: Any, slot: FakeSlot, message: str, *, reservation: Any = None) -> Any:
        assert reservation is self.reservations[-1]
        self.sent.append(message)
        slot.messages.append({"role": "user", "content": message})

        async def turn() -> None:
            if self.reply:
                slot.messages.append({"role": "assistant", "content": self.reply})

        return asyncio.ensure_future(turn())

    async def transcript(self, state: Any, key: str) -> list[dict[str, Any]]:
        return list(self.slot.messages) if self.slot else []

    def track(self, state: Any, task: asyncio.Task[Any]) -> None:
        self.tracked.append(task)


def pick(n: int, **over: Any) -> dict[str, Any]:
    return {"title": f"Song {n}", "artist": f"Artist {n}", "why": "", "tags": [], "source": "youtube", "video_id": VID, **over}


@pytest.fixture
def ctx(tmp_path: Path):
    c = make_ctx(tmp_path)
    c.chat_slots = FakeSlots()  # type: ignore[attr-defined]
    c.http_app = {"state": SimpleNamespace(owner_id="owner")}  # type: ignore[attr-defined]
    return c


def store(ctx: Any) -> MoodStore:
    return MoodStore(Path(ctx.data_dir) / "state.json")


def queue(ctx: Any, count: int = 4) -> list[dict[str, Any]]:
    """A queue of *count* songs, the first one playing in the tab."""
    s = store(ctx)
    s.add_moment("calm", tags=["平静"])
    q = s.set_queue([pick(i + 1) for i in range(count)], source="r0")
    s.set_playback(pick_id=q[0]["id"])
    return q


def fire(ctx: Any, *events: dict[str, Any]) -> None:
    async def go() -> None:
        for event in events:
            await playback.on_media_ended(ctx, event)
        tracked = getattr(ctx.chat_slots, "tracked", None)
        if tracked:
            await asyncio.gather(*tracked)

    asyncio.run(go())


def played(steps: list[str] | None = None, **extra: Any) -> str:
    data = {"played": True, "site": "youtube", "steps": steps or ["open the results page"], **extra}
    return "Playing.\n```mood-music\n" + json.dumps(data, ensure_ascii=False) + "\n```"


# ── one wake per ending ──


def test_an_ending_wakes_the_buddy_once_for_the_next_song(ctx) -> None:
    q = queue(ctx)
    ctx.chat_slots.reply = played()
    fire(ctx, ended())
    sent = ctx.chat_slots.sent
    assert len(sent) == 1
    assert 'Play in Crew Browser: "Song 2" - Artist 2' in sent[0]
    assert "just ended" in sent[0]
    assert "nearly empty" not in sent[0]
    # The answer is kept as the page keeps it: the song plays, its steps are saved.
    snap = store(ctx).snapshot()
    assert snap["playback"] == {"pick_id": q[1]["id"], "ended_for": "", "paused": False}
    assert snap["play_steps"]["youtube"]["steps"] == ["open the results page"]
    assert any(m["kind"] == "known" and m["title"] == "Song 2" for m in snap["memory"])


def test_the_hook_firing_twice_for_one_ending_wakes_the_buddy_once(ctx) -> None:
    queue(ctx)
    fire(ctx, ended(), ended())
    assert len(ctx.chat_slots.sent) == 1


def test_a_second_ending_after_the_next_song_plays_wakes_it_again(ctx) -> None:
    queue(ctx)
    ctx.chat_slots.reply = played()
    fire(ctx, ended())
    ctx.chat_slots.tracked.clear()
    fire(ctx, ended())
    assert len(ctx.chat_slots.sent) == 2
    assert 'Play in Crew Browser: "Song 3" - Artist 3' in ctx.chat_slots.sent[1]


def test_a_pause_wakes_nobody(ctx) -> None:
    queue(ctx)
    status, _ = _call(ctx, "PUT", "/playback", {"paused": True})
    assert status == 200
    fire(ctx, ended())
    assert ctx.chat_slots.sent == []
    # Play again: the next ending wakes the buddy.
    _call(ctx, "PUT", "/playback", {"paused": False})
    fire(ctx, ended())
    assert len(ctx.chat_slots.sent) == 1


def test_continuous_play_off_wakes_nobody(ctx) -> None:
    queue(ctx)
    status, _ = _call(ctx, "PUT", "/settings", {"continuous": False})
    assert status == 200
    fire(ctx, ended())
    assert ctx.chat_slots.sent == []
    assert store(ctx).snapshot()["playback"]["ended_for"] == ""


def test_the_page_claim_first_leaves_the_hook_nothing_to_do(ctx) -> None:
    q = queue(ctx)
    assert _call(ctx, "POST", "/playback/ended", {"pick_id": q[0]["id"]}) == (200, {"claimed": True})
    fire(ctx, ended())
    assert ctx.chat_slots.sent == []


def test_the_hook_first_refuses_the_page_claim(ctx) -> None:
    q = queue(ctx)
    fire(ctx, ended())
    assert len(ctx.chat_slots.sent) == 1
    assert _call(ctx, "POST", "/playback/ended", {"pick_id": q[0]["id"]}) == (200, {"claimed": False})


def test_a_turn_already_out_wins(ctx) -> None:
    queue(ctx)
    ctx.chat_slots.slot.running = True
    fire(ctx, ended())
    assert ctx.chat_slots.sent == []
    # Nothing was claimed, so the page may still take this ending.
    assert store(ctx).snapshot()["playback"]["ended_for"] == ""


def test_another_slot_or_event_wakes_nobody(ctx) -> None:
    queue(ctx)
    fire(ctx, ended("mood-music-other"), {**ended(), "event": "other"}, "not a dict")  # type: ignore[arg-type]
    assert ctx.chat_slots.sent == []


def test_the_last_song_ending_wakes_nobody(ctx) -> None:
    q = queue(ctx, 1)
    fire(ctx, ended())
    assert ctx.chat_slots.sent == []
    assert store(ctx).snapshot()["playback"]["ended_for"] == q[0]["id"]


def test_a_song_not_played_keeps_its_place_and_forgets_the_steps(ctx) -> None:
    q = queue(ctx)
    store(ctx).set_play_steps("youtube", ["old way"])
    ctx.chat_slots.reply = 'No.\n```mood-music\n{"played": false, "site": "youtube", "reason": "moved"}\n```'
    fire(ctx, ended())
    snap = store(ctx).snapshot()
    assert "youtube" not in snap["play_steps"]
    assert snap["playback"]["pick_id"] == q[0]["id"]


# ── a low queue asks for more ──


def test_a_low_queue_asks_for_more_and_adds_the_checked_picks(ctx, monkeypatch) -> None:
    queue(ctx, 2)

    async def keep_all(picks: list[dict[str, Any]], fetch: Any, **avoid: Any) -> tuple[list[dict[str, Any]], dict[str, int]]:
        return picks, {}

    monkeypatch.setattr(verify, "verify_picks", keep_all)
    ctx.chat_slots.reply = played(mood_tags=["平静"], picks=[
        {"title": "Fresh", "artist": "New", "source": "youtube", "url": f"https://youtu.be/{VID}", "tier": "explore", "arc": "lift"},
        {"title": "Calm", "artist": "Old", "platform": "bilibili", "arc": "stay"},
        {"title": "Bad", "source": "youtube", "url": "https://evil.example/x"},
    ])
    fire(ctx, ended())
    assert "nearly empty" in ctx.chat_slots.sent[0]
    assert "Mood so far: 平静" in ctx.chat_slots.sent[0]
    snap = store(ctx).snapshot()
    # Added after the queue, in arc order, the bad link dropped.
    assert [p["title"] for p in snap["queue"]] == ["Song 1", "Song 2", "Calm", "Fresh"]
    assert snap["last_source"] == reply_source(ctx.chat_slots.reply)


def test_stay_only_set_on_the_page_then_page_closed_then_refill_follows_it(ctx) -> None:
    queue(ctx, 2)
    # The person turned "stay only" on in the page, then closed it.
    assert _call(ctx, "PUT", "/settings", {"stay_only": True})[0] == 200
    fire(ctx, ended())
    assert "nearly empty" in ctx.chat_slots.sent[0]
    assert "Arc: stay only" in ctx.chat_slots.sent[0]


def test_a_refill_uses_the_default_arc_when_stay_only_was_never_set(ctx) -> None:
    queue(ctx, 2)
    assert "stay_only" not in store(ctx).snapshot()["settings"]
    fire(ctx, ended())
    assert "Arc: stay -> turn -> lift" in ctx.chat_slots.sent[0]
    # Turned off again on the page: the default arc again.
    _call(ctx, "PUT", "/settings", {"stay_only": True})
    _call(ctx, "PUT", "/settings", {"stay_only": False})
    assert store(ctx).snapshot()["settings"]["stay_only"] is False


def test_stay_only_must_be_true_or_false(ctx) -> None:
    status, body = _call(ctx, "PUT", "/settings", {"stay_only": "yes"})
    assert (status, body["code"]) == (400, "invalid_field_type")


def _old_memory(ctx: Any) -> list[str]:
    """Two memory items last used an hour ago (not stale, so a request carries them); their ids."""
    clock = {"now": OLD}
    old = MoodStore(Path(ctx.data_dir) / "state.json", now=lambda: clock["now"])
    ids = [old.add_memory("note", text="likes piano", origin="user")["id"],
           old.add_memory("liked", title="苏州河", artist="薛凯琪", origin="app")["id"]]
    return ids


def test_a_backend_refill_marks_the_memory_it_carried_used(ctx, monkeypatch) -> None:
    ids = _old_memory(ctx)
    queue(ctx, 2)

    async def keep_all(picks: list[dict[str, Any]], fetch: Any, **avoid: Any) -> Any:
        return picks, {}

    monkeypatch.setattr(verify, "verify_picks", keep_all)
    ctx.chat_slots.reply = played(picks=[{"title": "Fresh", "artist": "New", "source": "youtube"}])
    fire(ctx, ended())
    assert "likes piano" in ctx.chat_slots.sent[0]
    used = {m["id"]: m["last_used_at"] for m in store(ctx).snapshot()["memory"]}
    assert all(used[i] > OLD for i in ids)


def test_a_refill_that_adds_nothing_marks_nothing_used(ctx, monkeypatch) -> None:
    ids = _old_memory(ctx)
    queue(ctx, 2)

    async def drop_all(picks: list[dict[str, Any]], fetch: Any, **avoid: Any) -> Any:
        return [], {"not_found": len(picks)}

    monkeypatch.setattr(verify, "verify_picks", drop_all)
    ctx.chat_slots.reply = played(picks=[{"title": "Gone", "artist": "X", "source": "youtube"}])
    fire(ctx, ended())
    used = {m["id"]: m["last_used_at"] for m in store(ctx).snapshot()["memory"]}
    assert all(used[i] == OLD for i in ids)


def test_an_empty_queue_after_the_next_song_asks_for_more(ctx) -> None:
    q = queue(ctx, 2)
    song, refill = playback.next_pick(store(ctx).snapshot(), q[0]["id"])
    assert song is not None and song["id"] == q[1]["id"] and refill is True
    song, refill = playback.next_pick(store(ctx).snapshot(), q[1]["id"])
    assert (song, refill) == (None, False)


# ── an older Kiro Crew ──


def test_a_host_without_the_slot_seam_does_nothing(ctx) -> None:
    queue(ctx)
    ctx.chat_slots = None
    fire(ctx, ended())
    assert store(ctx).snapshot()["playback"]["ended_for"] == ""


def test_without_the_hook_the_page_claims_each_ending_as_before(ctx) -> None:
    q = queue(ctx)
    # Kiro Crew without #40261 never calls the hook: the page's claim always wins once.
    assert _call(ctx, "POST", "/playback/ended", {"pick_id": q[0]["id"]}) == (200, {"claimed": True})
    assert _call(ctx, "POST", "/playback/ended", {"pick_id": q[0]["id"]}) == (200, {"claimed": False})
    # A replay of the same song lets its next ending wake the buddy again.
    _call(ctx, "PUT", "/playback", {"pick_id": q[0]["id"]})
    assert _call(ctx, "POST", "/playback/ended", {"pick_id": q[0]["id"]}) == (200, {"claimed": True})


def test_a_claim_for_a_song_that_is_not_playing_is_refused(ctx) -> None:
    q = queue(ctx)
    assert _call(ctx, "POST", "/playback/ended", {"pick_id": q[2]["id"]}) == (200, {"claimed": False})


def test_the_manifest_declares_the_hook_next_to_the_routes() -> None:
    manifest = json.loads((Path(__file__).parent.parent / "app.json").read_text(encoding="utf-8"))
    hooks = manifest["backend"]["hooks"]
    assert hooks["on_browser_media_ended"] == "backend.playback:on_media_ended"
    assert callable(playback.on_media_ended)


# ── the routes ──


@pytest.mark.parametrize("body", [
    {}, {"pick_id": "x"}, {"paused": "yes"}, {"other": 1}, [],
])
def test_playback_refuses_a_bad_body(ctx, body: Any) -> None:
    status, _ = _call(ctx, "PUT", "/playback", body)
    assert status == 400


@pytest.mark.parametrize("body", [{}, {"pick_id": 1}, {"pick_id": "a" * 32, "x": 1}])
def test_ended_refuses_a_bad_body(ctx, body: Any) -> None:
    status, _ = _call(ctx, "POST", "/playback/ended", body)
    assert status == 400


@pytest.mark.parametrize("path, method", [("/playback", "PUT"), ("/playback/ended", "POST")])
def test_playback_routes_are_owner_only(ctx, path: str, method: str) -> None:
    status, body = _call(ctx, method, path, {"pick_id": "a" * 32}, user="someone-else")
    assert (status, body["code"]) == (403, "owner_only")


# ── the same words as the page ──


def test_the_play_request_and_reply_id_match_the_page_word_for_word() -> None:
    golden = json.loads(GOLDEN.read_text(encoding="utf-8"))
    for case in golden["cases"]:
        i = case["input"]
        out = build_play_request(song=i["song"], steps=i["steps"], why=i["why"], refill=i["refill"],
                                 memory=i["memory"], explore=i["explore"], stay_only=i["stay_only"])
        assert out == case["expected"], case["name"]
        assert memory_summary(i["memory"])[1] == case["summary_ids"], case["name"]
    for source in golden["sources"]:
        assert reply_source(source["content"]) == source["expected"]
