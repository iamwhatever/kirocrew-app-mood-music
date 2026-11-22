"""Saved playlists: the person's own named lists of songs, kept apart from the main store.

One small JSON document, ``playlists.json``, in the app's data directory,
written atomically like ``state.json`` (``store.py``). It holds:

* ``lists``: at most :data:`MAX_LISTS` lists of at most :data:`MAX_SONGS` songs.
* ``active``: the list now playing, if any, and how far into it the queue got.
* ``then_buddy``: whether, once a playing list runs out, the buddy is asked for
  more songs. Off by default: a list is songs the person chose, so it ends where
  they made it end, and asking the buddy would start a model turn nobody asked for.

The queue holds at most ``store.MAX_QUEUE`` songs, so a longer list plays in
parts. Playing a list replaces the queue with its first part. When the page (or,
with the page closed, ``playback.py``) would ask the buddy for more songs,
:func:`extend` first adds the list's next part after the song about to play, so
that song keeps its place (and its now-playing marker) in the queue. A list is
"active" only while the queue is still its own: once anything else replaces or
refills the queue (``last_source`` changes), the list is over.

A list's name is shown on the page as text and is never put into a message to
the buddy. A song is checked by the queue route's own check (``routes._pick``)
before it is kept, and only its plain fields are kept.

Every route is owner-only (``routes._owner_only``), reads included.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import tempfile
import threading
import time
import uuid
from pathlib import Path
from typing import Any

from aiohttp import web

from .store import MAX_QUEUE, MoodStore

logger = logging.getLogger(__name__)

MAX_LISTS = 50
MAX_SONGS = 200
MAX_NAME = 80
#: The fields a saved song keeps: enough to show it and to play it.
SONG_FIELDS = ("title", "artist", "why", "tags", "source", "video_id", "url")
_ID_RE = re.compile(r"[0-9a-f]{32}")
_NAME_BAD_RE = re.compile(r"[\x00-\x1f\x7f\u2028\u2029]")
_SOURCE_PREFIX = "playlist:"

_LOCKS: dict[str, threading.Lock] = {}
_LOCKS_GUARD = threading.Lock()


def _lock_for(path: Path) -> threading.Lock:
    with _LOCKS_GUARD:
        return _LOCKS.setdefault(str(path), threading.Lock())


class PlaylistsFull(Exception):
    """There are already :data:`MAX_LISTS` lists."""


def _empty() -> dict[str, Any]:
    return {"lists": [], "active": None, "then_buddy": False}


def _song_key(song: dict[str, Any]) -> tuple[str, str]:
    return (str(song.get("title", "")).strip().casefold(), str(song.get("artist", "")).strip().casefold())


class PlaylistStore:
    """``playlists.json``, behind a lock. Callers check input first."""

    def __init__(self, path: Path, *, now: Any = time.time) -> None:
        self._path = path
        self._now = now
        self._lock = _lock_for(path)

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
            logger.warning("mood music playlists were unreadable; moved aside")
            return _empty()
        doc = _empty()
        lists = data.get("lists") if isinstance(data.get("lists"), list) else []
        for entry in lists[:MAX_LISTS]:
            if isinstance(entry, dict) and isinstance(entry.get("id"), str) and isinstance(entry.get("songs"), list):
                entry["songs"] = [s for s in entry["songs"] if isinstance(s, dict)][:MAX_SONGS]
                doc["lists"].append(entry)
        active = data.get("active")
        if isinstance(active, dict) and isinstance(active.get("next"), int) and isinstance(active.get("source"), str):
            doc["active"] = active
        if isinstance(data.get("then_buddy"), bool):
            doc["then_buddy"] = data["then_buddy"]
        return doc

    def _write(self, doc: dict[str, Any]) -> None:
        self._path.parent.mkdir(parents=True, exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=self._path.parent, prefix=".playlists-", suffix=".tmp")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as fh:
                fh.write(json.dumps(doc, ensure_ascii=False))
                fh.flush()
                os.fsync(fh.fileno())
            os.replace(tmp, self._path)
        except BaseException:
            try:
                os.unlink(tmp)
            except OSError:
                pass
            raise

    @staticmethod
    def _find(doc: dict[str, Any], list_id: str) -> dict[str, Any] | None:
        return next((p for p in doc["lists"] if p.get("id") == list_id), None)

    # ── reads ──

    def summary(self) -> dict[str, Any]:
        with self._lock:
            doc = self._read()
        active = doc["active"]
        return {
            "lists": doc["lists"],
            "active": {"id": active.get("id", ""), "next": active["next"]} if active else None,
            "then_buddy": doc["then_buddy"],
            "limits": {"lists": MAX_LISTS, "songs": MAX_SONGS},
        }

    # ── writes ──

    def create(self, name: str, songs: list[dict[str, Any]]) -> dict[str, Any]:
        """Keep a new list, newest first; raises :class:`PlaylistsFull` at the cap."""
        entry = {
            "id": uuid.uuid4().hex,
            "name": name,
            "created_at": self._now(),
            "songs": [{**s, "id": uuid.uuid4().hex} for s in songs],
        }
        with self._lock:
            doc = self._read()
            if len(doc["lists"]) >= MAX_LISTS:
                raise PlaylistsFull()
            doc["lists"].insert(0, entry)
            self._write(doc)
        return entry

    def rename(self, list_id: str, name: str) -> dict[str, Any] | None:
        with self._lock:
            doc = self._read()
            entry = self._find(doc, list_id)
            if entry is None:
                return None
            entry["name"] = name
            self._write(doc)
        return entry

    def delete(self, list_id: str) -> bool:
        with self._lock:
            doc = self._read()
            rest = [p for p in doc["lists"] if p.get("id") != list_id]
            if len(rest) == len(doc["lists"]):
                return False
            doc["lists"] = rest
            if doc["active"] and doc["active"].get("id") == list_id:
                doc["active"] = None
            self._write(doc)
        return True

    def remove_song(self, list_id: str, song_id: str) -> dict[str, Any] | None:
        """Drop one song; ``None`` when there is no such list or song."""
        with self._lock:
            doc = self._read()
            entry = self._find(doc, list_id)
            if entry is None:
                return None
            at = next((i for i, s in enumerate(entry["songs"]) if s.get("id") == song_id), -1)
            if at < 0:
                return None
            del entry["songs"][at]
            active = doc["active"]
            # A song before the playing list's next part moves that part up by one.
            if active and active.get("id") == list_id and at < active["next"]:
                active["next"] -= 1
            self._write(doc)
        return entry

    def set_then_buddy(self, on: bool) -> bool:
        with self._lock:
            doc = self._read()
            doc["then_buddy"] = on
            self._write(doc)
        return on

    # ── playing ──

    def start(self, list_id: str, mood: MoodStore) -> list[dict[str, Any]] | None:
        """Replace the queue with the list's first part; ``None`` with no such list.

        The return is the new queue; an empty list plays nothing and returns ``[]``.
        """
        with self._lock:
            doc = self._read()
            entry = self._find(doc, list_id)
            if entry is None:
                return None
            if not entry["songs"]:
                return []
            source = f"{_SOURCE_PREFIX}{list_id}:{uuid.uuid4().hex[:8]}"
            part = [_as_pick(s) for s in entry["songs"][:MAX_QUEUE]]
            queue = mood.set_queue(part, source=source, mood_tags=[])
            doc["active"] = {"id": list_id, "next": len(part), "source": source}
            self._write(doc)
        return queue

    def extend(self, mood: MoodStore, pick_id: str) -> dict[str, Any]:
        """Before a refill: add the playing list's next part after *pick_id*.

        ``active`` is false when no list plays (the caller then refills as it
        always did). Otherwise ``added`` is how many songs were queued, and
        ``ask_buddy`` says whether the caller may still ask the buddy for more:
        only once the list ran out, nothing was added now, and the person
        allowed it (``then_buddy``).
        """
        inactive = {"active": False, "added": 0, "ask_buddy": True}
        with self._lock:
            doc = self._read()
            active = doc["active"]
            if not active:
                return inactive
            snap = mood.snapshot()
            entry = self._find(doc, str(active.get("id", "")))
            if entry is None or snap.get("last_source") != active["source"]:
                # The queue is no longer this list's own: the list is over.
                doc["active"] = None
                self._write(doc)
                return inactive
            queue = snap.get("queue") or []
            at = next((i for i, p in enumerate(queue) if p.get("id") == pick_id), 0)
            # set_queue keeps the newest MAX_QUEUE: only songs before *pick_id* make room.
            room = MAX_QUEUE - (len(queue) - at)
            part = entry["songs"][active["next"]:active["next"] + max(room, 0)]
            if part:
                mood.set_queue([_as_pick(s) for s in part], source=active["source"], mood_tags=[], append=True)
                active["next"] += len(part)
                self._write(doc)
            done = active["next"] >= len(entry["songs"])
            return {"active": True, "added": len(part), "ask_buddy": done and not part and doc["then_buddy"]}


def _as_pick(song: dict[str, Any]) -> dict[str, Any]:
    """A saved song as a queue pick: its own id stays with the list."""
    return {k: v for k, v in song.items() if k in SONG_FIELDS}


def playlist_store(ctx: Any) -> PlaylistStore:
    return PlaylistStore(Path(ctx.data_dir) / "playlists.json")


def extend_for(ctx: Any, pick_id: str) -> dict[str, Any]:
    """:meth:`PlaylistStore.extend` against this app's own two files."""
    from .routes import _store  # noqa: PLC0415 - routes imports this module

    return playlist_store(ctx).extend(_store(ctx), pick_id)


# ── routes ──


def _name(body: dict[str, Any]) -> tuple[str, web.Response | None]:
    from .routes import _bad_request  # noqa: PLC0415

    value = body.get("name")
    if not isinstance(value, str):
        return "", _bad_request("name must be a string", "invalid_field_type")
    value = value.strip()
    if not value:
        return "", _bad_request("name is required", "missing_required_field")
    if len(value) > MAX_NAME:
        return "", _bad_request("name is too long", "field_too_long")
    if _NAME_BAD_RE.search(value):
        return "", _bad_request("name must be one line of text", "invalid_field_type")
    return value, None


def _not_found() -> web.Response:
    return web.json_response({"error": "no such playlist", "code": "not_found"}, status=404)


def _ids(request: web.Request, *keys: str) -> list[str] | None:
    values = [request.match_info[k] for k in keys]
    return values if all(_ID_RE.fullmatch(v) for v in values) else None


async def _handle_list(request: web.Request, ctx: Any) -> web.Response:
    return web.json_response(await asyncio.to_thread(playlist_store(ctx).summary))


async def _handle_create(request: web.Request, ctx: Any) -> web.Response:
    from .routes import _bad_request, _json_object, _pick  # noqa: PLC0415

    body, err = await _json_object(request)
    if err is not None:
        return err
    assert body is not None
    name, err = _name(body)
    if err is not None:
        return err
    raw = body.get("songs")
    if not isinstance(raw, list) or not raw:
        return _bad_request("songs must be a list of at least one song", "invalid_field_type")
    songs: list[dict[str, Any]] = []
    seen: set[tuple[str, str]] = set()
    for item in raw[: MAX_SONGS * 2]:
        pick, code = _pick(item)
        if pick is None:
            return _bad_request("a song was refused", code)
        key = _song_key(pick)
        if key not in seen:
            seen.add(key)
            songs.append({k: v for k, v in pick.items() if k in SONG_FIELDS})
    if len(raw) > MAX_SONGS * 2 or len(songs) > MAX_SONGS:
        return _bad_request(f"a playlist holds at most {MAX_SONGS} songs", "too_many_songs")
    try:
        entry = await asyncio.to_thread(lambda: playlist_store(ctx).create(name, songs))
    except PlaylistsFull:
        return web.json_response(
            {"error": f"there are already {MAX_LISTS} playlists", "code": "playlists_full"}, status=409
        )
    return web.json_response(entry, status=201)


async def _handle_rename(request: web.Request, ctx: Any) -> web.Response:
    from .routes import _bad_request, _json_object  # noqa: PLC0415

    ids = _ids(request, "id")
    if ids is None:
        return _bad_request("not a playlist id", "invalid_field_type")
    body, err = await _json_object(request)
    if err is not None:
        return err
    assert body is not None
    name, err = _name(body)
    if err is not None:
        return err
    entry = await asyncio.to_thread(lambda: playlist_store(ctx).rename(ids[0], name))
    return web.json_response(entry) if entry is not None else _not_found()


async def _handle_delete(request: web.Request, ctx: Any) -> web.Response:
    from .routes import _bad_request  # noqa: PLC0415

    ids = _ids(request, "id")
    if ids is None:
        return _bad_request("not a playlist id", "invalid_field_type")
    gone = await asyncio.to_thread(lambda: playlist_store(ctx).delete(ids[0]))
    return web.json_response({"deleted": ids[0]}) if gone else _not_found()


async def _handle_remove_song(request: web.Request, ctx: Any) -> web.Response:
    from .routes import _bad_request  # noqa: PLC0415

    ids = _ids(request, "id", "song")
    if ids is None:
        return _bad_request("not a playlist or song id", "invalid_field_type")
    entry = await asyncio.to_thread(lambda: playlist_store(ctx).remove_song(ids[0], ids[1]))
    return web.json_response(entry) if entry is not None else _not_found()


async def _handle_play(request: web.Request, ctx: Any) -> web.Response:
    from .routes import _bad_request, _store  # noqa: PLC0415

    ids = _ids(request, "id")
    if ids is None:
        return _bad_request("not a playlist id", "invalid_field_type")
    queue = await asyncio.to_thread(lambda: playlist_store(ctx).start(ids[0], _store(ctx)))
    if queue is None:
        return _not_found()
    if not queue:
        return _bad_request("this playlist has no songs", "empty_playlist")
    return web.json_response({"queue": queue})


async def _handle_next(request: web.Request, ctx: Any) -> web.Response:
    from .routes import _bad_request, _json_object  # noqa: PLC0415

    body, err = await _json_object(request)
    if err is not None:
        return err
    assert body is not None
    pick_id = body.get("pick_id")
    if set(body) != {"pick_id"} or not isinstance(pick_id, str) or not _ID_RE.fullmatch(pick_id):
        return _bad_request("send pick_id only", "invalid_field_type")
    return web.json_response(await asyncio.to_thread(lambda: extend_for(ctx, pick_id)))


async def _handle_settings(request: web.Request, ctx: Any) -> web.Response:
    from .routes import _bad_request, _json_object  # noqa: PLC0415

    body, err = await _json_object(request)
    if err is not None:
        return err
    assert body is not None
    if set(body) != {"then_buddy"} or not isinstance(body["then_buddy"], bool):
        return _bad_request("send then_buddy (true or false) only", "invalid_field_type")
    on = await asyncio.to_thread(lambda: playlist_store(ctx).set_then_buddy(body["then_buddy"]))
    return web.json_response({"then_buddy": on})


def routes(route: Any, owner_only: Any) -> list[Any]:
    """This module's routes, each behind the app's owner gate."""
    return [
        route("GET", "/playlists", owner_only("list_playlists", _handle_list)),
        route("POST", "/playlists", owner_only("create_playlist", _handle_create)),
        route("PUT", "/playlists/{id}", owner_only("rename_playlist", _handle_rename)),
        route("DELETE", "/playlists/{id}", owner_only("delete_playlist", _handle_delete)),
        route(
            "DELETE", "/playlists/{id}/songs/{song}",
            owner_only("remove_playlist_song", _handle_remove_song),
        ),
        route("POST", "/playlists/{id}/play", owner_only("play_playlist", _handle_play)),
        route("POST", "/playlists-next", owner_only("playlist_next", _handle_next)),
        route("PUT", "/playlists-settings", owner_only("playlist_settings", _handle_settings)),
    ]
