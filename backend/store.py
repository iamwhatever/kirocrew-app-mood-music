"""Mood Music's own storage: moments, the current queue, like/skip feedback and memory.

One small JSON document in the app's data directory, written atomically. Every
record is bounded (:data:`MAX_MOMENTS`, :data:`MAX_FEEDBACK`, :data:`MAX_QUEUE`,
:data:`MEMORY_CAPS`) so the file stays a few hundred KB at most.

Memory (design §2) is what the person's music buddy knows about them: their own
notes, and songs and moods the app recorded. An item the person wrote
(``origin: "user"``) is never evicted and never marked stale. An item the app
recorded is "maybe stale" once it went 90 days unused, or once a newer verdict
on the same song replaced it; it stays until the person clears it. Callers validate input first
(``routes.py``); the store trusts the shapes it is handed.

A document that cannot be parsed is moved aside to ``state.json.bad`` before the
next write replaces it, so a damaged file is never silently overwritten.
"""

from __future__ import annotations

import json
import logging
import os
import tempfile
import threading
import time
import uuid
from collections.abc import Callable
from pathlib import Path
from typing import Any


logger = logging.getLogger(__name__)

MAX_MOMENTS = 200
MAX_FEEDBACK = 200
MAX_QUEUE = 12

#: The two feedback verdicts, and ``""`` to clear one.
VERDICTS = ("liked", "skipped", "")

#: Memory kinds; the song kinds carry ``title`` / ``artist``, the others ``text``.
#: A ``dislike`` carries either: a song (``title`` / ``artist``) or a few words (``text``).
SONG_KINDS = ("liked", "skipped", "known")
MEMORY_KINDS = ("note", *SONG_KINDS, "mood", "dislike")
ORIGINS = ("user", "app")
MEMORY_CAPS = {"note": 100, "liked": 300, "skipped": 300, "known": 300, "mood": 100, "dislike": 100}
#: A kind this full (share of its cap) is "nearly full" in the Memory tab.
NEAR_FULL = 0.9
#: The kinds the taste profile is folded from (``taste.py``).
TASTE_KINDS = ("liked", "skipped", "dislike")
#: Fold once this many new liked / skipped / dislike items came in since the last fold.
FOLD_EVERY = 20
#: A fold that started this long ago and never finished is given up (the gateway stopped).
FOLD_TIMEOUT = 10 * 60
#: Per side ("likes", "dislikes"): lines the model writes, and lines in all.
PROFILE_MODEL_LINES = 6
PROFILE_MAX_LINES = 12
PROFILE_LINE_CHARS = 120
PROFILE_MAX_SOURCES = 5
PROFILE_SIDES = ("likes", "dislikes")
#: After a fold, this many newest app-recorded songs of each folded kind stay as examples.
KEEP_RECENT = 5
#: Songs pruned (or evicted) from memory, kept as title / artist so they are never
#: picked as new again. Oldest leave first.
MAX_HEARD = 1000
#: An app item unused this long is "maybe stale".
STALE_AFTER = 90 * 86400
#: A song that was an anchor this recently is not an anchor again.
ANCHOR_WINDOW = 30 * 86400
MAX_ANCHORS = 100
#: The page's own choices (design §0.3, §1.9), with their defaults.
EXPLORE_LEVELS = ("familiar", "balanced", "explore")
DEFAULT_SETTINGS = {
    "explore": "balanced",
    "record_open": False,
    "continuous": True,
    "view_open": True,
}
#: The sites the buddy plays on in Kiro Crew's browser, each with its own saved steps.
#: Only bilibili and YouTube picks carry a checked link; on the others the buddy
#: always searches the site for the song when it plays.
PLAY_SITES = ("bilibili", "youtube", "spotify", "amazon_music", "apple_music", "soundcloud")
#: Saved steps per site: at most this many, each at most this long.
MAX_STEPS = 8
MAX_STEP_CHARS = 120


#: The song in the buddy's tab (a queue id), the one whose ending already woke the
#: buddy, and whether the person paused. Shared by the page and the backend hook
#: (``playback.py``), so one ending wakes the buddy once whoever hears it first.
_NO_PLAYBACK = {"pick_id": "", "ended_for": "", "paused": False}

#: One lock per state file: every request builds its own store, and the page's
#: claim and the backend hook's claim must not interleave.
_LOCKS: dict[str, threading.Lock] = {}
_LOCKS_GUARD = threading.Lock()


def _lock_for(path: Path) -> threading.Lock:
    with _LOCKS_GUARD:
        return _LOCKS.setdefault(str(path), threading.Lock())


class MemoryFull(Exception):
    """A kind is at its cap and every item in it is the person's own or pinned."""


def _empty() -> dict[str, Any]:
    return {
        "moments": [],
        "queue": [],
        # Bumped each time the queue is replaced (a new list), never by an append:
        # a refill asked for on an older list names the one it was asked on.
        "queue_gen": 0,
        "feedback": [],
        "last_source": "",
        "memory": [],
        "anchors": [],
        "settings": dict(DEFAULT_SETTINGS),
        "play_steps": {},
        "playback": dict(_NO_PLAYBACK),
        "profile": None,
        "heard": [],
        "taste": {"pending": 0, "running_at": 0, "started_pending": 0, "error": ""},
    }


def _song_key(title: str, artist: str = "") -> tuple[str, str]:
    from .verify import song_key

    return song_key(title, artist)


def _is_song(kind: str, item: dict[str, Any]) -> bool:
    return kind in SONG_KINDS or (kind == "dislike" and bool(item.get("title")))


def _same_item(item: dict[str, Any], kind: str, text: str, key: tuple[str, str]) -> bool:
    if item.get("kind") != kind:
        return False
    if kind == "dislike" and bool(item.get("title")) != bool(key[0]):
        return False
    if _is_song(kind, item):
        from .verify import same_song

        return same_song(_song_key(item.get("title", ""), item.get("artist", "")), key)
    return str(item.get("text", "")).casefold() == text.casefold()


def _room(memory: list[dict[str, Any]]) -> dict[str, dict[str, int]]:
    """Per kind: how many items, its cap, and how many are the person's own or pinned.

    ``own`` at the cap means the kind is full: nothing can be evicted to add one.
    """
    room = {k: {"count": 0, "cap": cap, "own": 0} for k, cap in MEMORY_CAPS.items()}
    for m in memory:
        r = room.get(str(m.get("kind")))
        if r is None:
            continue
        r["count"] += 1
        if m.get("origin") == "user" or m.get("pinned"):
            r["own"] += 1
    return room


def _fold_running(taste: dict[str, Any], now: float) -> bool:
    started = float(taste.get("running_at") or 0)
    return bool(started) and now - started < FOLD_TIMEOUT


def _remember_heard(state: dict[str, Any], items: list[dict[str, Any]]) -> None:
    """Keep the title / artist of songs leaving memory, so they are not picked as new."""
    heard = [
        {"title": str(m.get("title")), "artist": str(m.get("artist") or ""), "verdict": str(m.get("kind"))}
        for m in items
        if m.get("title")
    ]
    if heard:
        state["heard"] = [*heard, *state["heard"]][:MAX_HEARD]


def _read_line(raw: Any) -> dict[str, Any] | None:
    if not isinstance(raw, dict):
        return None
    text, origin, line_id = raw.get("text"), raw.get("origin"), raw.get("id")
    if not (isinstance(text, str) and 0 < len(text) <= PROFILE_LINE_CHARS and origin in ORIGINS
            and isinstance(line_id, str) and line_id):
        return None
    sources = []
    for src in raw.get("sources") if isinstance(raw.get("sources"), list) else []:
        if isinstance(src, dict) and isinstance(src.get("title"), str) and src["title"]:
            sources.append({
                "id": str(src.get("id") or ""),
                "title": src["title"][:200],
                "artist": str(src.get("artist") or "")[:200],
            })
    return {"id": line_id, "text": text, "origin": origin, "sources": sources[:PROFILE_MAX_SOURCES]}


def _read_profile(raw: Any) -> dict[str, Any] | None:
    """A stored profile, each line checked; ``None`` for none or a damaged one."""
    if not isinstance(raw, dict):
        return None
    out: dict[str, Any] = {}
    for side in PROFILE_SIDES:
        lines = raw.get(side) if isinstance(raw.get(side), list) else []
        out[side] = [ln for ln in (_read_line(r) for r in lines) if ln][:PROFILE_MAX_LINES]
    for key in ("updated_at", "folded", "pruned"):
        value = raw.get(key)
        out[key] = value if isinstance(value, (int, float)) and not isinstance(value, bool) else 0
    return out


class MoodStore:
    """The app's one JSON document, behind a lock."""

    def __init__(self, path: Path, *, now: Callable[[], float] = time.time) -> None:
        self._path = path
        self._now = now
        self._lock = _lock_for(path)

    # ── file ──

    def _read(self) -> dict[str, Any]:
        try:
            raw = self._path.read_text(encoding="utf-8")
        except FileNotFoundError:
            return _empty()
        try:
            data = json.loads(raw)
        except ValueError:
            data = None
        if not isinstance(data, dict):
            # Keep the damaged bytes rather than overwrite them on the next write.
            self._path.replace(self._path.with_name(self._path.name + ".bad"))
            logger.warning("mood music state was unreadable; moved aside")
            return _empty()
        state = _empty()
        for key in ("moments", "queue", "feedback", "memory", "anchors", "heard"):
            if isinstance(data.get(key), list):
                state[key] = [r for r in data[key] if isinstance(r, dict)]
        if isinstance(data.get("last_source"), str):
            state["last_source"] = data["last_source"]
        gen = data.get("queue_gen")
        if isinstance(gen, int) and not isinstance(gen, bool) and gen >= 0:
            state["queue_gen"] = gen
        saved = data.get("settings") if isinstance(data.get("settings"), dict) else {}
        if saved.get("explore") in EXPLORE_LEVELS:
            state["settings"]["explore"] = saved["explore"]
        for flag in ("record_open", "view_open"):
            if isinstance(saved.get(flag), bool):
                state["settings"][flag] = saved[flag]
        # The page's "stay only" switch, kept here so a refill with the page closed
        # follows it. Absent until the person sets it: readers default to off.
        if isinstance(saved.get("stay_only"), bool):
            state["settings"]["stay_only"] = saved["stay_only"]
        # Continuous play is on unless the person turned it off. Up to 0.2.6 the
        # file kept the old default (off) for everyone, so a stored ``false`` is
        # read only once it is the person's own choice (``continuous_choice``).
        choice = data.get("continuous_choice")
        if isinstance(choice, bool):
            state["continuous_choice"] = choice
            state["settings"]["continuous"] = choice
        steps = data.get("play_steps") if isinstance(data.get("play_steps"), dict) else {}
        for site in PLAY_SITES:
            entry = steps.get(site)
            if (
                isinstance(entry, dict)
                and isinstance(entry.get("steps"), list)
                and 0 < len(entry["steps"]) <= MAX_STEPS
                and all(isinstance(t, str) and 0 < len(t) <= MAX_STEP_CHARS for t in entry["steps"])
            ):
                state["play_steps"][site] = {
                    "steps": list(entry["steps"]),
                    "updated_at": entry.get("updated_at") if isinstance(entry.get("updated_at"), (int, float)) else 0,
                }
        played = data.get("playback") if isinstance(data.get("playback"), dict) else {}
        for key in ("pick_id", "ended_for"):
            if isinstance(played.get(key), str):
                state["playback"][key] = played[key]
        if isinstance(played.get("paused"), bool):
            state["playback"]["paused"] = played["paused"]
        state["profile"] = _read_profile(data.get("profile"))
        taste = data.get("taste") if isinstance(data.get("taste"), dict) else {}
        for key in ("pending", "running_at", "started_pending"):
            if isinstance(taste.get(key), (int, float)) and not isinstance(taste.get(key), bool):
                state["taste"][key] = taste[key]
        if isinstance(taste.get("error"), str):
            state["taste"]["error"] = taste["error"][:40]
        if not isinstance(data.get("memory"), list):
            # A file from before memory: its likes and skips become memory items.
            for f in reversed(state["feedback"]):
                if f.get("verdict") in ("liked", "skipped"):
                    self._put(state, f["verdict"], title=f.get("title", ""),
                              artist=f.get("artist", ""), origin="app", at=f.get("at"))
        return state

    def _write(self, state: dict[str, Any]) -> None:
        """Replace the file atomically: a crash leaves the old or the new, never half."""
        self._path.parent.mkdir(parents=True, exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=self._path.parent, prefix=".state-", suffix=".tmp")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as fh:
                fh.write(json.dumps(state, ensure_ascii=False))
                fh.flush()
                os.fsync(fh.fileno())
            os.replace(tmp, self._path)
        except BaseException:
            try:
                os.unlink(tmp)
            except OSError:
                pass
            raise

    # ── reads ──

    def snapshot(self) -> dict[str, Any]:
        """Everything the page shows: newest moments, feedback and memory first.

        Each memory item carries ``stale``, worked out now rather than stored.
        """
        with self._lock:
            state = self._read()
        now = self._now()
        state["memory_room"] = _room(state["memory"])
        state["memory"] = [{**m, "stale": self._stale(m, now)} for m in state["memory"]]
        taste = state.pop("taste")
        state["taste_status"] = {
            "pending": int(taste["pending"]),
            "every": FOLD_EVERY,
            "running": _fold_running(taste, now),
            "error": taste["error"],
        }
        for private in ("anchors", "continuous_choice", "heard"):
            state.pop(private, None)
        return state

    def set_play_steps(self, site: str, steps: list[str]) -> dict[str, Any]:
        """Keep the steps that just played a song on *site*, replacing older ones."""
        entry = {"steps": list(steps), "updated_at": self._now()}
        with self._lock:
            state = self._read()
            state["play_steps"][site] = entry
            self._write(state)
        return entry

    def forget_play_steps(self, site: str) -> bool:
        """Drop *site*'s steps after they failed, so the buddy finds the way again."""
        with self._lock:
            state = self._read()
            if site not in state["play_steps"]:
                return False
            del state["play_steps"][site]
            self._write(state)
        return True

    def set_playback(
        self, *, pick_id: str | None = None, paused: bool | None = None
    ) -> dict[str, Any]:
        """A song (re)started in the tab, and/or the person's pause or play.

        A start clears the ending already handled and the pause, so this song's
        own ending wakes the buddy again, a replay of the same song included.
        """
        with self._lock:
            state = self._read()
            playback = state["playback"]
            if pick_id is not None:
                playback.update(pick_id=pick_id, ended_for="", paused=False)
            if paused is not None:
                playback["paused"] = paused
            self._write(state)
            return dict(playback)

    def claim_ended(self, pick_id: str) -> bool:
        """Whether the ending of *pick_id* may wake the buddy; at most once per ending.

        Refused with continuous play off, after the person's pause, for a song
        that is not the one in the tab, and for an ending already claimed. The
        first claim records it, so the page and the backend never both wake.
        """
        with self._lock:
            state = self._read()
            playback = state["playback"]
            if (
                not pick_id
                or not state["settings"].get("continuous", True)
                or playback["paused"]
                or playback["ended_for"] == pick_id
                or (playback["pick_id"] and playback["pick_id"] != pick_id)
            ):
                return False
            playback.update(pick_id=pick_id, ended_for=pick_id)
            self._write(state)
            return True

    def set_settings(self, **changes: Any) -> dict[str, Any]:
        """Store the page's choices; callers pass only checked values."""
        with self._lock:
            state = self._read()
            state["settings"].update(changes)
            if "continuous" in changes:
                state["continuous_choice"] = changes["continuous"]
            self._write(state)
            return dict(state["settings"])

    # ── memory ──

    @staticmethod
    def _stale(item: dict[str, Any], now: float) -> bool:
        if item.get("origin") == "user":
            return False
        if item.get("superseded_at"):
            return True
        last = item.get("last_used_at") or item.get("created_at") or 0
        return now - float(last) > STALE_AFTER

    def _put(
        self,
        state: dict[str, Any],
        kind: str,
        *,
        text: str = "",
        title: str = "",
        artist: str = "",
        origin: str,
        at: float | None = None,
    ) -> dict[str, Any]:
        """Add one item to *state* (or refresh its twin) and return it; may raise MemoryFull."""
        now = float(at) if isinstance(at, (int, float)) else self._now()
        key = _song_key(title, artist)
        memory: list[dict[str, Any]] = state["memory"]
        twin = next((m for m in memory if _same_item(m, kind, text, key)), None)
        if twin is not None:
            twin["last_used_at"] = now
            twin.pop("superseded_at", None)
            if origin == "user":
                twin["origin"] = "user"
            item = twin
        else:
            same_kind = [m for m in memory if m.get("kind") == kind]
            if len(same_kind) >= MEMORY_CAPS[kind]:
                evictable = [m for m in same_kind if m.get("origin") != "user" and not m.get("pinned")]
                if not evictable:
                    raise MemoryFull(kind)
                oldest = min(evictable, key=lambda m: m.get("last_used_at") or 0)
                memory.remove(oldest)
                _remember_heard(state, [oldest])
            item = {"id": uuid.uuid4().hex, "kind": kind, "origin": origin, "pinned": False,
                    "created_at": now, "last_used_at": now}
            if kind in SONG_KINDS or (kind == "dislike" and title):
                item.update(title=title, artist=artist)
            else:
                item["text"] = text
            memory.insert(0, item)
        if kind in TASTE_KINDS:
            state["taste"]["pending"] = int(state["taste"]["pending"]) + 1
        # A newer like replaces an older skip of the same song, and the other way round.
        other = {"liked": "skipped", "skipped": "liked"}.get(kind)
        if other:
            for m in memory:
                if _same_item(m, other, "", key) and m.get("origin") != "user":
                    m["superseded_at"] = now
        return item

    def add_memory(
        self, kind: str, *, text: str = "", title: str = "", artist: str = "", origin: str
    ) -> dict[str, Any]:
        """Remember one thing; raises :class:`MemoryFull` when it cannot fit."""
        with self._lock:
            state = self._read()
            item = self._put(state, kind, text=text, title=title, artist=artist, origin=origin)
            self._write(state)
        return {**item, "stale": self._stale(item, self._now())}

    def update_memory(
        self, item_id: str, *, text: str | None = None, pinned: bool | None = None
    ) -> dict[str, Any] | None:
        """Edit a note's (or a worded dislike's) text or any item's pin; ``None`` when there is none."""
        with self._lock:
            state = self._read()
            item = next((m for m in state["memory"] if m.get("id") == item_id), None)
            if item is None:
                return None
            if text is not None and (item.get("kind") == "note"
                                     or (item.get("kind") == "dislike" and not item.get("title"))):
                item["text"] = text
            if pinned is not None:
                item["pinned"] = pinned
            self._write(state)
        return {**item, "stale": self._stale(item, self._now())}

    def delete_memory(self, item_id: str) -> bool:
        with self._lock:
            state = self._read()
            rest = [m for m in state["memory"] if m.get("id") != item_id]
            if len(rest) == len(state["memory"]):
                return False
            state["memory"] = rest
            self._write(state)
        return True

    def clear_stale(self) -> int:
        """Remove every "maybe stale" item; the person's own are never stale."""
        now = self._now()
        with self._lock:
            state = self._read()
            rest = [m for m in state["memory"] if not self._stale(m, now)]
            removed = len(state["memory"]) - len(rest)
            if removed:
                state["memory"] = rest
                self._write(state)
        return removed

    def mark_used(self, ids: list[str]) -> int:
        """The items were in a request whose picks the person liked or played: not stale."""
        now = self._now()
        wanted = set(ids)
        with self._lock:
            state = self._read()
            hit = [m for m in state["memory"] if m.get("id") in wanted]
            for m in hit:
                m["last_used_at"] = now
            if hit:
                self._write(state)
        return len(hit)

    def _remember_quietly(self, state: dict[str, Any], kind: str, **fields: Any) -> None:
        """An app record that may not fit: the person's own items always win."""
        try:
            self._put(state, kind, origin="app", **fields)
        except MemoryFull:
            logger.info("mood music memory: %s is full of the person's own items", kind)

    def avoid_lists(self) -> dict[str, list[tuple[str, str]]]:
        """The songs a check drops (``verify.verify_picks`` keywords).

        Liked and known songs are ``known``; a skip a later like replaced no
        longer counts; a disliked song is ``skipped``; the "already heard" list
        (songs pruned after a fold) keeps its verdict; anchors from the last 30
        days are ``recent_anchors``.
        """
        with self._lock:
            state = self._read()
        now = self._now()
        out: dict[str, list[tuple[str, str]]] = {"known": [], "skipped": [], "recent_anchors": []}
        for m in state["memory"]:
            key = _song_key(m.get("title", ""), m.get("artist", ""))
            if m.get("kind") in ("liked", "known"):
                out["known"].append(key)
            elif m.get("kind") == "skipped" and not m.get("superseded_at"):
                out["skipped"].append(key)
            elif m.get("kind") == "dislike" and m.get("title"):
                out["skipped"].append(key)
        # Songs pruned after a fold (or evicted at the cap) still count: a liked or
        # known one is never new again, a skipped or disliked one never comes back.
        for h in state["heard"]:
            key = _song_key(str(h.get("title") or ""), str(h.get("artist") or ""))
            out["skipped" if h.get("verdict") in ("skipped", "dislike") else "known"].append(key)
        for a in state["anchors"]:
            if now - float(a.get("at") or 0) <= ANCHOR_WINDOW:
                out["recent_anchors"].append(_song_key(a.get("title", ""), a.get("artist", "")))
        return out

    # ── the taste profile (``taste.py``) ──

    def begin_fold(self, *, force: bool = False) -> list[dict[str, Any]] | None:
        """The liked, skipped and disliked items to fold, and the fold marked running.

        ``None`` when a fold runs already, when fewer than :data:`FOLD_EVERY` new
        items came in (unless *force*, the person's "run again"), or when there is
        nothing to fold. A skip a later like replaced is left out.
        """
        now = self._now()
        with self._lock:
            state = self._read()
            taste = state["taste"]
            if _fold_running(taste, now) or (not force and taste["pending"] < FOLD_EVERY):
                return None
            items = [m for m in state["memory"]
                     if m.get("kind") in TASTE_KINDS and not m.get("superseded_at")]
            if not items:
                return None
            taste.update(running_at=now, started_pending=taste["pending"])
            self._write(state)
        return items

    def finish_fold(
        self,
        lines: dict[str, list[dict[str, Any]]] | None,
        folded: list[dict[str, Any]],
        *,
        error: str = "bad_output",
    ) -> bool:
        """Keep the model's checked *lines* and prune the app songs they folded.

        *lines* ``None`` (bad output, or no model to ask: *error* says which):
        the old profile stays and nothing is pruned. Lines the person edited are theirs and stay; the model's lines
        replace the model's old ones. Then every app-recorded, unpinned liked /
        skipped item in *folded* leaves memory, except the :data:`KEEP_RECENT`
        newest of each kind and every song a line cites; a song that leaves is
        kept in the "already heard" list. Nothing the person wrote or pinned is
        removed. Counted either way: the new items it saw no longer wait.
        """
        now = self._now()
        with self._lock:
            state = self._read()
            taste = state["taste"]
            # Items that came in while it ran still wait for the next fold.
            seen = int(taste["started_pending"] or 0)
            taste.update(running_at=0, started_pending=0, pending=max(0, int(taste["pending"]) - seen))
            if lines is None:
                taste["error"] = error
                self._write(state)
                return False
            taste["error"] = ""
            old = state["profile"] or {}
            profile: dict[str, Any] = {}
            for side in PROFILE_SIDES:
                mine = [ln for ln in old.get(side, []) if ln.get("origin") == "user"]
                own_text = {ln["text"].casefold() for ln in mine}
                fresh = [ln for ln in lines.get(side, []) if ln["text"].casefold() not in own_text]
                room = max(0, PROFILE_MAX_LINES - len(mine))
                profile[side] = [*mine, *fresh[:min(room, PROFILE_MODEL_LINES)]]
            cited = {src["id"] for side in PROFILE_SIDES for ln in profile[side] for src in ln["sources"]}
            folded_ids = {m.get("id") for m in folded}
            keep: set[Any] = set()
            for kind in ("liked", "skipped"):
                app_items = [m for m in state["memory"] if m.get("kind") == kind and m.get("origin") == "app"]
                app_items.sort(key=lambda m: -float(m.get("last_used_at") or 0))
                keep.update(m.get("id") for m in app_items[:KEEP_RECENT])
            gone = [
                m for m in state["memory"]
                if m.get("id") in folded_ids
                and m.get("kind") in ("liked", "skipped")
                and m.get("origin") == "app"
                and not m.get("pinned")
                and m.get("id") not in cited
                and m.get("id") not in keep
            ]
            gone_ids = {m.get("id") for m in gone}
            state["memory"] = [m for m in state["memory"] if m.get("id") not in gone_ids]
            _remember_heard(state, gone)
            profile.update(updated_at=now, folded=len(folded), pruned=len(gone))
            state["profile"] = profile
            self._write(state)
        return True

    def edit_profile_line(self, line_id: str, text: str) -> dict[str, Any] | None:
        """The person's words for one line: it is theirs now and no fold replaces it."""
        with self._lock:
            state = self._read()
            profile = state["profile"]
            for side in PROFILE_SIDES:
                for line in (profile or {}).get(side, []):
                    if line["id"] == line_id:
                        line.update(text=text, origin="user")
                        self._write(state)
                        return dict(line)
        return None

    def delete_profile_line(self, line_id: str) -> bool:
        with self._lock:
            state = self._read()
            profile = state["profile"]
            if not profile:
                return False
            for side in PROFILE_SIDES:
                rest = [ln for ln in profile[side] if ln["id"] != line_id]
                if len(rest) != len(profile[side]):
                    profile[side] = rest
                    self._write(state)
                    return True
        return False

    def delete_profile(self) -> bool:
        """Forget the whole profile, the person's own lines too (they pressed delete)."""
        with self._lock:
            state = self._read()
            if state["profile"] is None:
                return False
            state["profile"] = None
            self._write(state)
        return True

    # ── writes ──

    def add_moment(
        self, mood: str, *, note: str = "", tags: list[str] | None = None
    ) -> dict[str, Any]:
        """Record how the user feels right now."""
        moment = {
            "id": uuid.uuid4().hex,
            "mood": mood,
            "note": note,
            "tags": list(tags or []),
            "songs": [],
            "at": self._now(),
        }
        with self._lock:
            state = self._read()
            state["moments"] = [moment, *state["moments"]][:MAX_MOMENTS]
            self._write(state)
        return moment

    def set_queue(
        self,
        picks: list[dict[str, Any]],
        *,
        source: str,
        moment_id: str = "",
        mood_tags: list[str] | None = None,
        append: bool = False,
        based_on: int | None = None,
    ) -> list[dict[str, Any]]:
        """Replace the queue with the agent's new picks, or add them at its end.

        *source* names the reply the picks came from, so the page never queues
        the same reply twice. When *moment_id* names a moment, the picks and
        the mood tags are attached to it for the Moments tab. With *append* (a
        refill while songs play on), the new picks go after the old ones and the
        oldest leave first once the queue is full. The return is always the new
        picks alone.

        *based_on* is the ``queue_gen`` a refill was asked on. When the queue was
        replaced since (the person asked for a new list), the refill belongs to
        the old list: nothing is stored and the return is ``[]``, so a refill
        never pushes the newer list out.
        """
        queue = [{**pick, "id": uuid.uuid4().hex, "feedback": ""} for pick in picks[:MAX_QUEUE]]
        with self._lock:
            state = self._read()
            if append and based_on is not None and based_on != state["queue_gen"]:
                return []
            if append:
                state["queue"] = [*state["queue"], *queue][-MAX_QUEUE:]
            else:
                state["queue"] = queue
                state["queue_gen"] = int(state["queue_gen"]) + 1
            state["last_source"] = source
            now = self._now()
            anchors = [{"title": p["title"], "artist": p.get("artist", ""), "at": now}
                       for p in queue if p.get("tier") == "anchor"]
            state["anchors"] = [*anchors, *state["anchors"]][:MAX_ANCHORS]
            for tag in mood_tags or []:
                self._remember_quietly(state, "mood", text=tag)
            for moment in state["moments"]:
                if moment.get("id") == moment_id:
                    moment["songs"] = [{"title": p["title"], "artist": p["artist"]} for p in queue]
                    if mood_tags:
                        moment["tags"] = list(mood_tags)
                    break
            self._write(state)
        return queue

    def set_feedback(self, pick_id: str, verdict: str) -> dict[str, Any] | None:
        """Mark a queued pick liked or skipped (``""`` clears it); ``None`` if unknown."""
        with self._lock:
            state = self._read()
            pick = next((p for p in state["queue"] if p.get("id") == pick_id), None)
            if pick is None:
                return None
            before = pick.get("feedback")
            pick["feedback"] = verdict
            song = {"title": pick.get("title", ""), "artist": pick.get("artist", "")}
            if verdict:
                self._remember_quietly(state, verdict, **song)
            elif before in ("liked", "skipped"):
                key = _song_key(song["title"], song["artist"])
                state["memory"] = [m for m in state["memory"]
                                   if not (m.get("origin") == "app" and _same_item(m, before, "", key))]
            rest = [f for f in state["feedback"] if f.get("pick_id") != pick_id]
            if verdict:
                entry = {
                    "pick_id": pick_id,
                    "title": pick.get("title", ""),
                    "artist": pick.get("artist", ""),
                    "tags": pick.get("tags", []),
                    "verdict": verdict,
                    "at": self._now(),
                }
                rest = [entry, *rest]
            state["feedback"] = rest[:MAX_FEEDBACK]
            self._write(state)
            return pick
