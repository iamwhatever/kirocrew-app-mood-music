"""Mood Music's JSON store: bounded records, feedback, and no silent overwrite."""

from __future__ import annotations

from pathlib import Path

from backend import store as store_mod
from backend.store import MoodStore


def _pick(title: str = "Song") -> dict:
    return {
        "title": title,
        "artist": "A",
        "why": "w",
        "tags": [],
        "source": "youtube",
        "video_id": "dQw4w9WgXcQ",
    }


def _store(tmp_path: Path) -> MoodStore:
    return MoodStore(tmp_path / "state.json", now=lambda: 1000.0)


def test_an_empty_store_reads_empty(tmp_path: Path) -> None:
    assert _store(tmp_path).snapshot() == {
        "moments": [],
        "queue": [],
        "feedback": [],
        "last_source": "",
        "memory": [],
        "settings": {"explore": "balanced", "record_open": False},
    }


def test_moments_are_newest_first_and_bounded(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr(store_mod, "MAX_MOMENTS", 3)
    s = _store(tmp_path)
    for mood in ("a", "b", "c", "d"):
        s.add_moment(mood)
    assert [m["mood"] for m in s.snapshot()["moments"]] == ["d", "c", "b"]


def test_a_queue_attaches_its_songs_and_tags_to_the_moment(tmp_path: Path) -> None:
    s = _store(tmp_path)
    moment = s.add_moment("想念")
    queue = s.set_queue(
        [_pick("x"), _pick("y")], source="r1", moment_id=moment["id"], mood_tags=["温柔"]
    )
    snap = s.snapshot()
    assert [p["title"] for p in snap["queue"]] == ["x", "y"]
    assert all(p["feedback"] == "" and p["id"] for p in queue)
    assert snap["last_source"] == "r1"
    assert snap["moments"][0]["songs"] == [
        {"title": "x", "artist": "A"},
        {"title": "y", "artist": "A"},
    ]
    assert snap["moments"][0]["tags"] == ["温柔"]


def test_feedback_is_kept_after_the_queue_moves_on(tmp_path: Path) -> None:
    s = _store(tmp_path)
    (first,) = s.set_queue([_pick("liked one")], source="r1")
    marked = s.set_feedback(first["id"], "liked")
    assert marked is not None and marked["feedback"] == "liked"
    s.set_queue([_pick("next")], source="r2")
    feedback = s.snapshot()["feedback"]
    assert [(f["title"], f["verdict"]) for f in feedback] == [("liked one", "liked")]


def test_changing_or_clearing_a_verdict_leaves_one_entry_or_none(tmp_path: Path) -> None:
    s = _store(tmp_path)
    (pick,) = s.set_queue([_pick()], source="r1")
    s.set_feedback(pick["id"], "liked")
    s.set_feedback(pick["id"], "skipped")
    assert [f["verdict"] for f in s.snapshot()["feedback"]] == ["skipped"]
    s.set_feedback(pick["id"], "")
    assert s.snapshot()["feedback"] == []


def test_feedback_on_an_unknown_pick_changes_nothing(tmp_path: Path) -> None:
    s = _store(tmp_path)
    assert s.set_feedback("0" * 32, "liked") is None
    assert not (tmp_path / "state.json").exists()


def test_a_damaged_file_is_moved_aside_not_overwritten(tmp_path: Path) -> None:
    path = tmp_path / "state.json"
    path.write_text("{not json", encoding="utf-8")
    s = _store(tmp_path)
    assert s.snapshot()["moments"] == []
    assert (tmp_path / "state.json.bad").read_text(encoding="utf-8") == "{not json"
    s.add_moment("calm")
    assert [m["mood"] for m in s.snapshot()["moments"]] == ["calm"]


# ── memory (design §2) ──

DAY = 86400.0


class Clock:
    def __init__(self, t: float = 1000.0) -> None:
        self.t = t

    def __call__(self) -> float:
        return self.t


def _clocked(tmp_path: Path) -> tuple[MoodStore, Clock]:
    clock = Clock()
    return MoodStore(tmp_path / "state.json", now=clock), clock


def _memory(s: MoodStore, kind: str | None = None) -> list[dict]:
    return [m for m in s.snapshot()["memory"] if kind is None or m["kind"] == kind]


def test_likes_skips_and_mood_tags_are_remembered_by_the_app(tmp_path: Path) -> None:
    s, _ = _clocked(tmp_path)
    (a, b) = s.set_queue([_pick("a"), _pick("b")], source="r", mood_tags=["想念"])
    s.set_feedback(a["id"], "liked")
    s.set_feedback(b["id"], "skipped")
    kinds = {(m["kind"], m.get("title") or m.get("text"), m["origin"]) for m in _memory(s)}
    assert kinds == {("liked", "a", "app"), ("skipped", "b", "app"), ("mood", "想念", "app")}
    s.set_feedback(a["id"], "")
    assert not _memory(s, "liked")


def test_the_persons_own_items_never_go_stale_but_the_apps_do_after_90_days(tmp_path: Path) -> None:
    s, clock = _clocked(tmp_path)
    s.add_memory("note", text="不要太吵", origin="user")
    s.add_memory("known", title="苏州河", artist="薛凯琪", origin="app")
    clock.t += 89 * DAY
    assert not any(m["stale"] for m in _memory(s))
    clock.t += 2 * DAY
    stale = {m["kind"]: m["stale"] for m in _memory(s)}
    assert stale == {"note": False, "known": True}
    assert s.clear_stale() == 1
    assert [m["kind"] for m in _memory(s)] == ["note"]


def test_using_an_item_keeps_it_fresh(tmp_path: Path) -> None:
    s, clock = _clocked(tmp_path)
    item = s.add_memory("mood", text="疲惫", origin="app")
    clock.t += 80 * DAY
    assert s.mark_used([item["id"], "0" * 32]) == 1
    clock.t += 80 * DAY
    assert not _memory(s)[0]["stale"]


def test_a_newer_verdict_on_the_same_song_marks_the_older_one_stale(tmp_path: Path) -> None:
    s, _ = _clocked(tmp_path)
    (p,) = s.set_queue([_pick("x")], source="r")
    s.set_feedback(p["id"], "skipped")
    (q,) = s.set_queue([_pick("x")], source="r2")
    s.set_feedback(q["id"], "liked")
    by_kind = {m["kind"]: m["stale"] for m in _memory(s)}
    assert by_kind == {"skipped": True, "liked": False}
    assert s.avoid_lists()["skipped"] == []


def test_a_full_kind_evicts_the_oldest_app_item_and_never_a_user_one(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setitem(store_mod.MEMORY_CAPS, "known", 3)
    s, clock = _clocked(tmp_path)
    s.add_memory("known", title="mine", origin="user")
    for title in ("old", "mid"):
        clock.t += 1
        s.add_memory("known", title=title, origin="app")
    clock.t += 1
    s.add_memory("known", title="new", origin="app")
    assert {m["title"] for m in _memory(s)} == {"mine", "mid", "new"}


def test_a_kind_full_of_the_persons_own_items_refuses_rather_than_evicts(tmp_path: Path, monkeypatch) -> None:
    import pytest

    monkeypatch.setitem(store_mod.MEMORY_CAPS, "note", 2)
    s, _ = _clocked(tmp_path)
    s.add_memory("note", text="a", origin="user")
    s.add_memory("note", text="b", origin="user")
    with pytest.raises(store_mod.MemoryFull):
        s.add_memory("note", text="c", origin="user")
    assert {m["text"] for m in _memory(s)} == {"a", "b"}


def test_an_app_record_that_does_not_fit_is_dropped_quietly(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setitem(store_mod.MEMORY_CAPS, "liked", 1)
    s, _ = _clocked(tmp_path)
    mine = s.add_memory("liked", title="mine", origin="user")
    s.update_memory(mine["id"], pinned=True)
    (p,) = s.set_queue([_pick("x")], source="r")
    assert s.set_feedback(p["id"], "liked")["feedback"] == "liked"
    assert [m["title"] for m in _memory(s, "liked")] == ["mine"]


def test_200_plus_items_stay_bounded(tmp_path: Path) -> None:
    s, clock = _clocked(tmp_path)
    for i in range(320):
        clock.t += 1
        s.add_memory("known", title=f"song {i}", origin="app")
    known = _memory(s, "known")
    assert len(known) == store_mod.MEMORY_CAPS["known"]
    assert known[0]["title"] == "song 319"


def test_adding_the_same_thing_twice_keeps_one_item(tmp_path: Path) -> None:
    s, _ = _clocked(tmp_path)
    s.add_memory("known", title="苏州河", artist="薛凯琪", origin="app")
    s.add_memory("known", title="苏州河 ", artist="薛凯琪", origin="user")
    (item,) = _memory(s)
    assert item["origin"] == "user"


def test_edit_pin_and_delete(tmp_path: Path) -> None:
    s, _ = _clocked(tmp_path)
    note = s.add_memory("note", text="喜欢粤语", origin="user")
    song = s.add_memory("known", title="x", origin="user")
    assert s.update_memory(note["id"], text="喜欢粤语老歌", pinned=True)["text"] == "喜欢粤语老歌"
    assert "text" not in s.update_memory(song["id"], text="ignored")
    assert s.update_memory("0" * 32, pinned=True) is None
    assert s.delete_memory(song["id"]) and not s.delete_memory(song["id"])
    (left,) = _memory(s)
    assert left["pinned"] is True


def test_an_anchor_is_remembered_for_30_days(tmp_path: Path) -> None:
    s, clock = _clocked(tmp_path)
    s.set_queue([{**_pick("x"), "tier": "anchor"}, {**_pick("y"), "tier": "explore"}], source="r")
    assert s.avoid_lists()["recent_anchors"] == [("x", "a")]
    clock.t += 31 * DAY
    assert s.avoid_lists()["recent_anchors"] == []


def test_a_file_from_before_memory_turns_its_likes_and_skips_into_memory(tmp_path: Path) -> None:
    import json

    (tmp_path / "state.json").write_text(json.dumps({
        "moments": [], "queue": [], "last_source": "",
        "feedback": [{"pick_id": "p", "title": "old love", "artist": "B", "tags": [], "verdict": "liked", "at": 5}],
    }), encoding="utf-8")
    s, _ = _clocked(tmp_path)
    (item,) = _memory(s)
    assert (item["kind"], item["title"], item["origin"]) == ("liked", "old love", "app")
