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

from backend import buddy, play_request, playback, verify
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
        #: Answers for the next turns, in order; then ``reply`` for every turn after.
        self.replies: list[str] = []

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

        answer = self.replies.pop(0) if self.replies else self.reply

        async def turn() -> None:
            if answer:
                slot.messages.append({"role": "assistant", "content": answer})

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
        # A tracked task may track another (a refill asking for more): wait for all.
        while tracked and not all(t.done() for t in tracked):
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


def busy_ending(ctx: Any, monkeypatch: Any, meanwhile: Any = None) -> None:
    """An ending while a turn runs; *meanwhile* runs during that turn, then the turn ends."""
    monkeypatch.setattr(playback, "BUSY_POLL_S", 0.01)
    ctx.chat_slots.slot.running = True

    async def go() -> None:
        await playback.on_media_ended(ctx, ended())
        await asyncio.sleep(0.05)
        # A turn already out goes first: nothing sent, nothing claimed yet.
        assert ctx.chat_slots.sent == []
        assert store(ctx).snapshot()["playback"]["ended_for"] == ""
        if meanwhile:
            meanwhile()
        ctx.chat_slots.slot.running = False
        await asyncio.gather(*ctx.chat_slots.tracked)
        await asyncio.gather(*ctx.chat_slots.tracked)

    asyncio.run(go())


def test_an_ending_during_a_turn_wakes_the_buddy_once_that_turn_is_over(ctx, monkeypatch) -> None:
    q = queue(ctx)
    ctx.chat_slots.reply = played()
    busy_ending(ctx, monkeypatch)
    assert len(ctx.chat_slots.sent) == 1
    assert 'Play in Crew Browser: "Song 2" - Artist 2' in ctx.chat_slots.sent[0]
    assert store(ctx).snapshot()["playback"]["pick_id"] == q[1]["id"]


def test_an_ending_during_a_turn_the_page_claimed_meanwhile_wakes_nobody_twice(ctx, monkeypatch) -> None:
    q = queue(ctx)
    busy_ending(ctx, monkeypatch, lambda: store(ctx).claim_ended(q[0]["id"]))
    assert ctx.chat_slots.sent == []


def test_an_ending_during_a_turn_that_played_another_song_is_not_claimed_for_it(ctx, monkeypatch) -> None:
    q = queue(ctx)
    # The running turn was the person picking Song 3: its ending is not Song 1's.
    busy_ending(ctx, monkeypatch, lambda: store(ctx).set_playback(pick_id=q[2]["id"]))
    assert ctx.chat_slots.sent == []
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


def test_a_refill_holds_when_stay_only_was_never_set(ctx) -> None:
    queue(ctx, 2)
    assert "stay_only" not in store(ctx).snapshot()["settings"]
    fire(ctx, ended())
    # A refill never climbs again from stay: it holds where the queue ended.
    assert "Arc: hold. Keep the energy where the queue ended" in ctx.chat_slots.sent[0]
    assert "stay -> turn -> lift" not in ctx.chat_slots.sent[0]
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


# ── a queue replaced while a song plays ──


def test_a_song_from_a_replaced_list_ends_into_the_new_lists_first_pick(ctx) -> None:
    queue(ctx)
    # The person asked for a fresh list while Song 1 still plays: the tab keeps it.
    new = store(ctx).set_queue([pick(11), pick(12), pick(13), pick(14), pick(15)], source="r1")
    ctx.chat_slots.reply = played()
    fire(ctx, ended())
    sent = ctx.chat_slots.sent
    assert len(sent) == 1
    assert 'Play in Crew Browser: "Song 11" - Artist 11' in sent[0]
    assert store(ctx).snapshot()["playback"]["pick_id"] == new[0]["id"]


def new_list_reply() -> str:
    """The buddy's answer to the person asking for another list: picks, no play result."""
    data = {"mood_tags": ["爵士"], "picks": [
        {"title": f"Song {n}", "artist": f"Artist {n}", "source": "youtube", "video_id": VID} for n in (11, 12, 13)
    ]}
    return "Here is jazz.\n```mood-music\n" + json.dumps(data, ensure_ascii=False) + "\n```"


def answered_with_a_new_list(ctx: Any) -> str:
    """The person's turn is over and its new list is in the chat, not yet in the queue."""
    reply = new_list_reply()
    ctx.chat_slots.slot.messages += [
        {"role": "user", "content": "[Mood Music]\nMessage: play jazz instead"},
        {"role": "assistant", "content": reply},
    ]
    return reply


def test_an_ending_before_the_page_stores_the_new_list_plays_the_new_lists_first(ctx, monkeypatch) -> None:
    # 0.2.18: the ending was claimed at once, Song 2 of the OLD list played, and
    # the new list landed behind it.
    queue(ctx)
    reply = answered_with_a_new_list(ctx)
    monkeypatch.setattr(playback, "BUSY_POLL_S", 0.01)
    ctx.chat_slots.reply = played()
    new: list[dict[str, Any]] = []

    async def go() -> None:
        await playback.on_media_ended(ctx, ended())
        await asyncio.sleep(0.05)
        # The page is still checking the new picks: nothing is claimed yet.
        assert ctx.chat_slots.sent == []
        assert store(ctx).snapshot()["playback"]["ended_for"] == ""
        new.extend(store(ctx).set_queue([pick(11), pick(12), pick(13)], source=reply_source(reply)))
        await asyncio.gather(*ctx.chat_slots.tracked)
        await asyncio.gather(*ctx.chat_slots.tracked)

    asyncio.run(go())
    assert len(ctx.chat_slots.sent) == 1
    assert 'Play in Crew Browser: "Song 11" - Artist 11' in ctx.chat_slots.sent[0]
    assert store(ctx).snapshot()["playback"]["pick_id"] == new[0]["id"]


def test_a_new_list_the_page_never_stores_lets_the_old_list_play_on(ctx, monkeypatch) -> None:
    # The page closed (or dropped every pick): the stored list is the newest one.
    queue(ctx)
    answered_with_a_new_list(ctx)
    monkeypatch.setattr(playback, "BUSY_POLL_S", 0.01)
    monkeypatch.setattr(playback, "LIST_WAIT_S", 0.05)

    async def go() -> None:
        await playback.on_media_ended(ctx, ended())
        await asyncio.gather(*ctx.chat_slots.tracked)
        await asyncio.gather(*ctx.chat_slots.tracked)

    asyncio.run(go())
    assert len(ctx.chat_slots.sent) == 1
    assert 'Play in Crew Browser: "Song 2" - Artist 2' in ctx.chat_slots.sent[0]


def test_a_new_list_already_stored_does_not_hold_the_ending(ctx) -> None:
    queue(ctx)
    reply = answered_with_a_new_list(ctx)
    store(ctx).set_queue([pick(11), pick(12), pick(13)], source=reply_source(reply))
    fire(ctx, ended())
    assert 'Play in Crew Browser: "Song 11" - Artist 11' in ctx.chat_slots.sent[0]


def test_a_refill_asked_on_the_old_list_is_dropped_once_a_new_list_lands(ctx, monkeypatch) -> None:
    # 0.2.18: the old list's refill was added after the new list and pushed it out.
    queue(ctx, 2)
    new: list[dict[str, Any]] = []

    async def new_list_meanwhile(picks: list[dict[str, Any]], fetch: Any, **avoid: Any) -> tuple[list[dict[str, Any]], dict[str, int]]:
        # The person's new list is stored while the refill's picks are checked.
        new.extend(store(ctx).set_queue([pick(11 + i) for i in range(10)], source="r-new"))
        return picks, {}

    monkeypatch.setattr(verify, "verify_picks", new_list_meanwhile)
    ctx.chat_slots.reply = played(picks=[
        {"title": f"Old mood {n}", "artist": "Old", "source": "youtube", "video_id": VID} for n in range(4)
    ])
    fire(ctx, ended())
    assert "nearly empty" in ctx.chat_slots.sent[0]
    snap = store(ctx).snapshot()
    assert [p["id"] for p in snap["queue"]] == [p["id"] for p in new]
    assert snap["last_source"] == "r-new"


def test_a_skipped_song_that_ends_goes_on_to_the_one_after_it(ctx) -> None:
    q = queue(ctx)
    store(ctx).set_feedback(q[1]["id"], "skipped")
    store(ctx).set_playback(pick_id=q[1]["id"])
    song, _ = playback.next_pick(store(ctx).snapshot(), q[1]["id"])
    assert song is not None and song["id"] == q[2]["id"]


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
                                 memory=i["memory"], explore=i["explore"], stay_only=i["stay_only"],
                                 profile=i["profile"], sites=i.get("sites"))
        assert out == case["expected"], case["name"]
        assert memory_summary(i["memory"], i["profile"])[1] == case["summary_ids"], case["name"]
    for case in golden["more"]:
        assert play_request.build_more_request(**case["input"]) == case["expected"], case["name"]
    for source in golden["sources"]:
        assert reply_source(source["content"]) == source["expected"]


def test_a_refill_holds_at_the_arc_the_last_queued_song_reached(ctx) -> None:
    s = store(ctx)
    s.add_moment("calm", tags=["平静"])
    q = s.set_queue([pick(1, arc="stay"), pick(2, arc="turn"), pick(3, arc="lift")], source="r0")
    s.set_playback(pick_id=q[1]["id"])
    fire(ctx, ended())
    sent = ctx.chat_slots.sent[0]
    assert "nearly empty" in sent
    assert "Arc: hold (the queue ended on a lift song)." in sent
    assert "never higher than a gentle lift" in sent
    assert "stay -> turn -> lift" not in sent


def test_a_refill_with_stay_only_still_says_stay_only_not_hold(ctx) -> None:
    s = store(ctx)
    q = s.set_queue([pick(1, arc="stay"), pick(2, arc="lift")], source="r0")
    s.set_playback(pick_id=q[0]["id"])
    s.set_settings(stay_only=True)
    fire(ctx, ended())
    assert "Arc: stay only" in ctx.chat_slots.sent[0]
    assert "Arc: hold" not in ctx.chat_slots.sent[0]


def test_a_song_on_spotify_is_asked_for_there_and_its_steps_are_kept(ctx) -> None:
    """0.2.18: a music-site pick has its own Site line and its own saved steps."""
    s = store(ctx)
    s.add_moment("calm", tags=["平静"])
    spotify = {"title": "Song 2", "artist": "Artist 2", "why": "", "tags": [], "source": "spotify"}
    q = s.set_queue([pick(1), spotify, pick(3), pick(4)], source="r0")
    s.set_playback(pick_id=q[0]["id"])
    s.set_play_steps("spotify", ["open https://open.spotify.com/search/ with the title and artist"])
    ctx.chat_slots.reply = "Playing.\n```mood-music\n" + json.dumps(
        {"played": True, "site": "spotify", "steps": ["open the search page", "click the row's Play"]}) + "\n```"
    fire(ctx, ended())
    sent = ctx.chat_slots.sent[0]
    assert "Site: spotify" in sent
    assert "Steps that played a song on spotify last time" in sent
    assert "1. open https://open.spotify.com/search/ with the title and artist" in sent
    assert store(ctx).snapshot()["play_steps"]["spotify"]["steps"] == ["open the search page", "click the row's Play"]


def test_a_sign_in_wall_on_a_music_site_forgets_only_that_sites_steps(ctx) -> None:
    s = store(ctx)
    s.add_moment("calm", tags=["平静"])
    q = s.set_queue([pick(1), {"title": "Song 2", "artist": "", "why": "", "tags": [], "source": "apple_music"}], source="r0")
    s.set_playback(pick_id=q[0]["id"])
    s.set_play_steps("apple_music", ["old way"])
    s.set_play_steps("youtube", ["open the results page"])
    ctx.chat_slots.reply = "```mood-music\n" + json.dumps(
        {"played": False, "site": "apple_music", "reason": "Sign in to Apple Music in Kiro Crew's browser"}) + "\n```"
    fire(ctx, ended())
    steps = store(ctx).snapshot()["play_steps"]
    assert "apple_music" not in steps and steps["youtube"]["steps"] == ["open the results page"]


# ── no repeats of songs played or queued lately (0.2.20) ──


def _song(title: str, artist: str = "", tier: str = "anchor", **over: Any) -> dict[str, Any]:
    """A pick with no link, so the check looks nothing up."""
    return {"title": title, "artist": artist, "source": "bilibili", "tier": tier, "arc": "stay", **over}


def _refill_reply(*picks: dict[str, Any]) -> str:
    return played(mood_tags=["平静"], picks=list(picks))


def _more_reply(*picks: dict[str, Any]) -> str:
    data = {"mood_tags": ["平静"], "picks": list(picks)}
    return "More.\n```mood-music\n" + json.dumps(data, ensure_ascii=False) + "\n```"


def _played_through(ctx: Any, titles: list[str]) -> list[dict[str, Any]]:
    """A queue of *titles*, each started in the tab in turn; the last one plays now."""
    s = store(ctx)
    s.add_moment("calm", tags=["平静"])
    q = s.set_queue([pick(0, title=t) for t in titles], source="r0")
    for p in q:
        s.set_playback(pick_id=p["id"])
    return q


def test_a_refill_drops_songs_played_or_queued_lately_in_any_tier(ctx) -> None:
    """The owner's report: a refill repeated a song heard minutes ago."""
    s = store(ctx)
    s.add_moment("calm", tags=["平静"])
    # 晴天 played from an earlier list, now replaced: the queue no longer lists it.
    old = s.set_queue([pick(0, title="晴天", artist="周杰伦")], source="r-old")
    s.set_playback(pick_id=old[0]["id"])
    q = s.set_queue([pick(1), pick(2)], source="r0")
    s.set_playback(pick_id=q[0]["id"])
    ctx.chat_slots.replies = [_refill_reply(
        # Played lately, written another way, as an anchor (known songs only block explore).
        _song("晴天 (Live)", "Jay Chou"),
        # Still in the queue, as an explore pick it never played as.
        _song("SONG 2", "Artist 2", tier="explore"),
        _song("New A"), _song("New B"),
    )]
    fire(ctx, ended())
    sent = ctx.chat_slots.sent
    assert 'Played lately, do not pick again: "晴天" - 周杰伦' in sent[0]
    titles = [p["title"] for p in store(ctx).snapshot()["queue"]]
    assert titles == ["Song 1", "Song 2", "New A", "New B"]
    # Two new songs came: enough, so nobody is asked again.
    assert len(sent) == 1


def test_a_refill_of_mostly_repeats_asks_once_for_songs_in_their_place(ctx) -> None:
    _played_through(ctx, ["Song A", "Song B"])
    s = store(ctx)
    q = s.snapshot()["queue"]
    s.set_playback(pick_id=q[0]["id"])
    ctx.chat_slots.replies = [
        _refill_reply(_song("song a"), _song("Song B feat. X"), _song("Only New")),
        _more_reply(_song("Song A"), _song("Second New"), _song("Third New")),
    ]
    fire(ctx, ended())
    sent = ctx.chat_slots.sent
    assert len(sent) == 2
    assert sent[1].startswith("[Mood Music]\nMore songs: 3 in place of songs played lately")
    assert "do not open the browser" in sent[1]
    titles = [p["title"] for p in store(ctx).snapshot()["queue"]]
    # The repeat in the second answer is dropped too, and nobody is asked a third time.
    assert titles == ["Song A", "Song B", "Only New", "Second New", "Third New"]


def test_a_second_answer_of_repeats_is_not_asked_for_again(ctx) -> None:
    q = _played_through(ctx, ["Song A", "Song B"])
    store(ctx).set_playback(pick_id=q[0]["id"])
    ctx.chat_slots.replies = [_refill_reply(_song("Song A")), _more_reply(_song("Song B"))]
    fire(ctx, ended())
    assert len(ctx.chat_slots.sent) == 2
    assert [p["title"] for p in store(ctx).snapshot()["queue"]] == ["Song A", "Song B"]


def test_a_refill_dropped_for_another_reason_asks_nobody_again(ctx) -> None:
    q = _played_through(ctx, ["Song A", "Song B"])
    store(ctx).set_playback(pick_id=q[0]["id"])
    ctx.chat_slots.replies = [_refill_reply(_song("Loud"))]
    store(ctx).add_memory("skipped", title="Loud", artist="", origin="user")
    fire(ctx, ended())
    assert len(ctx.chat_slots.sent) == 1


def test_an_ending_does_not_wait_for_a_more_songs_answer_as_a_new_list(ctx) -> None:
    q = queue(ctx)
    slots = ctx.chat_slots
    slots.slot.messages.extend([
        {"role": "user", "content": "[Mood Music]\nMore songs: 3 in place of songs played lately\n"},
        {"role": "assistant", "content": _more_reply(_song("Not Stored"))},
    ])
    slots.reply = played()

    async def go() -> list[str]:
        await playback.on_media_ended(ctx, ended())
        # Claimed at once: a list on its way would hold the ending (and send nothing yet).
        sent_now = list(slots.sent)
        await asyncio.gather(*slots.tracked)
        return sent_now

    sent_now = asyncio.run(go())
    assert len(sent_now) == 1 and 'Play in Crew Browser: "Song 2"' in sent_now[0]
    assert store(ctx).snapshot()["playback"]["pick_id"] == q[1]["id"]
