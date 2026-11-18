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
SONG_KINDS = ("liked", "skipped", "known")
MEMORY_KINDS = ("note", *SONG_KINDS, "mood")
ORIGINS = ("user", "app")
MEMORY_CAPS = {"note": 100, "liked": 300, "skipped": 300, "known": 300, "mood": 100}
#: An app item unused this long is "maybe stale".
STALE_AFTER = 90 * 86400
#: A song that was an anchor this recently is not an anchor again.
ANCHOR_WINDOW = 30 * 86400
MAX_ANCHORS = 100
#: The page's own choices (design §0.3, §1.9), with their defaults.
EXPLORE_LEVELS = ("familiar", "balanced", "explore")
#: Which site the person would rather play on; ``auto`` takes either. ``browser``
#: plays in Kiro Crew's own browser, driven by the buddy.
PLAYERS = ("auto", "youtube", "bilibili", "browser")
DEFAULT_SETTINGS = {"explore": "balanced", "record_open": False, "player": "auto", "continuous": False}
#: The sites the buddy plays on in Kiro Crew's browser, each with its own saved steps.
PLAY_SITES = ("bilibili", "youtube")
#: Saved steps per site: at most this many, each at most this long.
MAX_STEPS = 8
MAX_STEP_CHARS = 120


class MemoryFull(Exception):
    """A kind is at its cap and every item in it is the person's own or pinned."""


def _empty() -> dict[str, Any]:
    return {
        "moments": [],
        "queue": [],
        "feedback": [],
        "last_source": "",
        "memory": [],
        "anchors": [],
        "settings": dict(DEFAULT_SETTINGS),
        "play_steps": {},
    }


def _song_key(title: str, artist: str = "") -> tuple[str, str]:
    from .verify import song_key

    return song_key(title, artist)


def _same_item(item: dict[str, Any], kind: str, text: str, key: tuple[str, str]) -> bool:
    if item.get("kind") != kind:
        return False
    if kind in SONG_KINDS:
        from .verify import same_song

        return same_song(_song_key(item.get("title", ""), item.get("artist", "")), key)
    return str(item.get("text", "")).casefold() == text.casefold()


class MoodStore:
    """The app's one JSON document, behind a lock."""

    def __init__(self, path: Path, *, now: Callable[[], float] = time.time) -> None:
        self._path = path
        self._now = now
        self._lock = threading.Lock()

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
        for key in ("moments", "queue", "feedback", "memory", "anchors"):
            if isinstance(data.get(key), list):
                state[key] = [r for r in data[key] if isinstance(r, dict)]
        if isinstance(data.get("last_source"), str):
            state["last_source"] = data["last_source"]
        saved = data.get("settings") if isinstance(data.get("settings"), dict) else {}
        if saved.get("explore") in EXPLORE_LEVELS:
            state["settings"]["explore"] = saved["explore"]
        if isinstance(saved.get("record_open"), bool):
            state["settings"]["record_open"] = saved["record_open"]
        if saved.get("player") in PLAYERS:
            state["settings"]["player"] = saved["player"]
        if isinstance(saved.get("continuous"), bool):
            state["settings"]["continuous"] = saved["continuous"]
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
        state["memory"] = [{**m, "stale": self._stale(m, now)} for m in state["memory"]]
        state.pop("anchors", None)
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

    def set_settings(self, **changes: Any) -> dict[str, Any]:
        """Store the page's choices; callers pass only checked values."""
        with self._lock:
            state = self._read()
            state["settings"].update(changes)
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
            item = {"id": uuid.uuid4().hex, "kind": kind, "origin": origin, "pinned": False,
                    "created_at": now, "last_used_at": now}
            if kind in SONG_KINDS:
                item.update(title=title, artist=artist)
            else:
                item["text"] = text
            memory.insert(0, item)
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
        """Edit a note's text or any item's pin; ``None`` when there is no such item."""
        with self._lock:
            state = self._read()
            item = next((m for m in state["memory"] if m.get("id") == item_id), None)
            if item is None:
                return None
            if text is not None and item.get("kind") == "note":
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
        longer counts; anchors from the last 30 days are ``recent_anchors``.
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
        for a in state["anchors"]:
            if now - float(a.get("at") or 0) <= ANCHOR_WINDOW:
                out["recent_anchors"].append(_song_key(a.get("title", ""), a.get("artist", "")))
        return out

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
    ) -> list[dict[str, Any]]:
        """Replace the queue with the agent's new picks, or add them at its end.

        *source* names the reply the picks came from, so the page never queues
        the same reply twice. When *moment_id* names a moment, the picks and
        the mood tags are attached to it for the Moments tab. With *append* (a
        refill while songs play on), the new picks go after the old ones and the
        oldest leave first once the queue is full. The return is always the new
        picks alone.
        """
        queue = [{**pick, "id": uuid.uuid4().hex, "feedback": ""} for pick in picks[:MAX_QUEUE]]
        with self._lock:
            state = self._read()
            state["queue"] = [*state["queue"], *queue][-MAX_QUEUE:] if append else queue
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
