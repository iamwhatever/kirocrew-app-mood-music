"""Mood Music — backend routes, served by the gateway's ``RouteRegistry``.

The manifest's ``backend.hooks.routes`` names :func:`register_routes`, which
returns relative paths; the registry serves them under ``/api/apps/mood-music/``
and only while the app is enabled. Every route is owner-only from the
dashboard, reads included (moments are how the person felt); an app token keeps
the access its manifest grant gives it.

  GET  /state               -> moments, queue, feedback
  POST /moments             -> record a mood moment
  POST /queue               -> replace the queue with new picks
  PUT  /queue/{id}/feedback -> like / skip / clear a pick
  POST /verify-picks        -> look each pick up on YouTube / bilibili (``verify.py``)
  POST /memory              -> remember a note, a song, a mood or a dislike (a song or a few words)
  PUT  /memory/{id}         -> edit a note's (or worded dislike's) text, or pin / unpin an item
  DELETE /memory/{id}       -> forget one item
  POST /memory/clear-stale  -> forget every "maybe stale" item
  POST /memory/used         -> mark items as used (keeps them fresh)
  PUT  /profile/lines/{id}  -> the person's own words for one taste-profile line (never folded over)
  DELETE /profile/lines/{id} -> forget one line
  DELETE /profile           -> forget the whole profile
  POST /profile/run         -> fold the taste profile again now, in the background (``taste.py``)
  PUT  /settings            -> the explore level, continuous play, stay only, and whether the full record is open
  PUT  /play-steps/{site}   -> keep the steps that just played a song in Kiro Crew's browser
  DELETE /play-steps/{site} -> forget them after they failed, so the buddy finds the way again
  POST /buddy               -> open the buddy's hidden chat through ``ctx.chat_slots`` (``buddy.py``)
  POST /buddy/send          -> send the buddy one turn there
  PUT  /playback            -> the song now in the tab, or the person's pause / play
  POST /playback/ended      -> claim one song's ending, so only one side wakes the buddy
  /playlists...             -> saved playlists, in their own file (``playlists.py``)

The manifest's ``backend.hooks.on_browser_media_ended`` is ``playback.on_media_ended``:
with the page closed, the backend wakes the buddy for the next song itself.

A pick names the site the buddy plays it on (``source``). Its link is optional:
the buddy finds the song by searching that site in Kiro Crew's browser when it
is played. A link that is sent is checked in ``links.py``: a YouTube pick keeps
its video id alone, a bilibili pick an https URL on an exact bilibili host. A
request carrying one bad pick is refused whole, so nothing half-checked is
stored.
"""

from __future__ import annotations

import asyncio
import json
import re
from functools import wraps
from pathlib import Path
from typing import Any

from aiohttp import web

from . import _host, buddy, links, playlists, taste, verify
from .store import (
    EXPLORE_LEVELS,
    MAX_QUEUE,
    MAX_STEP_CHARS,
    MAX_STEPS,
    MEMORY_KINDS,
    ORIGINS,
    PLAY_SITES,
    PROFILE_LINE_CHARS,
    SONG_KINDS,
    TASTE_KINDS,
    VERDICTS,
    MemoryFull,
    MoodStore,
)

_MAX_MOOD = 200
_MAX_NOTE = 1000
_MAX_TEXT = 200
_MAX_WHY = 400
_MAX_TAGS = 8
_MAX_TAG = 40
_MAX_SOURCE = 128
_ID_RE = re.compile(r"[0-9a-f]{32}")
#: How long the person's own words may be, per kind (a mood word the app records is shorter still).
_MAX_NOTE_TEXT = 200
_MAX_DISLIKE_TEXT = 100
_MAX_MOOD_TEXT = 60
_MAX_IDS = 100
_TIERS = ("anchor", "explore", "deep")
#: A control character, a code fence or a bracket in a step could fake a section of
#: the request the step is sent back in, so a step holding one is refused.
_STEP_BAD_RE = re.compile(r"[\x00-\x1f\x7f\u2028\u2029`\[\]]")
_ARCS = ("stay", "turn", "lift")


def _store(ctx: Any) -> MoodStore:
    """The store under the data directory the gateway hands this app."""
    return MoodStore(Path(ctx.data_dir) / "state.json")


def _bad_request(error: str, code: str) -> web.Response:
    """A 400 carrying a machine-readable ``code`` the page localizes."""
    return web.json_response({"error": error, "code": code}, status=400)


def _reject_non_finite(value: str) -> Any:
    raise ValueError(f"non-finite number not allowed: {value}")


async def _json_object(
    request: web.Request,
) -> tuple[dict[str, Any] | None, web.Response | None]:
    """The body as a JSON object, or a 400."""
    try:
        body = await request.json(
            loads=lambda t: json.loads(t, parse_constant=_reject_non_finite)
        )
    except (LookupError, RecursionError, ValueError):
        return None, _bad_request("invalid JSON", "invalid_json")
    if not isinstance(body, dict):
        return None, _bad_request("body must be a JSON object", "body_not_object")
    return body, None


def _text(
    body: dict[str, Any], key: str, limit: int, *, required: bool = False
) -> tuple[str, web.Response | None]:
    """A stripped string field of at most *limit* characters."""
    value = body.get(key)
    if value is None:
        value = ""
    if not isinstance(value, str):
        return "", _bad_request(f"{key} must be a string", "invalid_field_type")
    value = value.strip()
    if required and not value:
        return "", _bad_request(f"{key} is required", "missing_required_field")
    if len(value) > limit:
        return "", _bad_request(f"{key} is too long", "field_too_long")
    return value, None


def _tags(value: Any) -> list[str] | None:
    """A short list of short non-empty strings, or ``None`` when the shape is wrong."""
    if value is None:
        return []
    if not isinstance(value, list) or len(value) > _MAX_TAGS:
        return None
    if not all(isinstance(t, str) and 0 < len(t.strip()) <= _MAX_TAG for t in value):
        return None
    return [t.strip() for t in value]


def _pick(raw: Any) -> tuple[dict[str, Any] | None, str]:
    """A checked pick, or ``(None, code)``."""
    if not isinstance(raw, dict):
        return None, "invalid_pick"
    out: dict[str, Any] = {}
    for key, limit, required in (
        ("title", _MAX_TEXT, True),
        ("artist", _MAX_TEXT, False),
        ("why", _MAX_WHY, False),
    ):
        value, err = _text(raw, key, limit, required=required)
        if err is not None:
            return None, "invalid_pick"
        out[key] = value
    tags = _tags(raw.get("tags"))
    if tags is None:
        return None, "invalid_pick"
    out["tags"] = tags
    # Design §0: optional fields an older page never sends.
    for key, allowed in (("tier", _TIERS), ("arc", _ARCS)):
        value = raw.get(key)
        if value is not None:
            if value not in allowed:
                return None, "invalid_pick"
            out[key] = value
    listen_for, err = _text(raw, "listen_for", _MAX_WHY)
    if err is not None:
        return None, "invalid_pick"
    if listen_for:
        out["listen_for"] = listen_for
    unverified = raw.get("unverified")
    if unverified is not None and not isinstance(unverified, bool):
        return None, "invalid_pick"
    if unverified:
        # The link check could not reach YouTube / bilibili for it (verify.py).
        out["unverified"] = True
    evidence = raw.get("evidence")
    if evidence is not None:
        if not isinstance(evidence, dict):
            return None, "invalid_pick"
        url = links.evidence_url(evidence.get("url"))
        label, err = _text(evidence, "label", _MAX_TEXT)
        if url is None or err is not None:
            return None, "invalid_pick"
        out["evidence"] = {"url": url, "label": label}
    source = raw.get("source")
    # No link at all is a pick the buddy finds by searching its site when it plays.
    video_id = raw.get("video_id")
    url = raw.get("url")
    if source == "youtube":
        out["source"] = "youtube"
        if video_id is None and url in (None, ""):
            return out, ""
        vid = (
            links.valid_video_id(video_id)
            if video_id is not None
            else links.youtube_video_id(url)
        )
        if vid is None:
            return None, "invalid_video_id"
        out["video_id"] = vid
    elif source == "bilibili":
        out["source"] = "bilibili"
        if url in (None, ""):
            return out, ""
        checked = links.bilibili_url(url)
        if checked is None:
            return None, "invalid_bilibili_url"
        out["url"] = checked
    elif source in PLAY_SITES:
        # A site with no link check: any link given is dropped, never opened.
        out["source"] = source
    else:
        return None, "invalid_source"
    return out, ""


async def _checked_picks(
    body: dict[str, Any],
) -> tuple[list[dict[str, Any]], web.Response | None]:
    """``body["picks"]`` checked one by one; one bad pick refuses them all."""
    raw_picks = body.get("picks")
    if not isinstance(raw_picks, list) or not 0 < len(raw_picks) <= MAX_QUEUE:
        return [], _bad_request(
            f"picks must be a list of 1 to {MAX_QUEUE}", "invalid_field_type"
        )
    picks: list[dict[str, Any]] = []
    for raw in raw_picks:
        pick, code = _pick(raw)
        if pick is None:
            return [], _bad_request("a pick was refused", code)
        picks.append(pick)
    return picks, None


def _owner_only(operation: str, handler: _host.Handler) -> _host.Handler:
    """Refuse a non-owner dashboard caller before the handler runs.

    A dashboard request (``app == ""``) or one with no app claim at all goes
    through the host's owner gate, whose refusal is returned unchanged. An app
    token was already confined by the middleware to its manifest grant.
    """

    @wraps(handler)
    async def _wrapped(request: web.Request, ctx: Any) -> web.StreamResponse:
        if not request.get("app"):
            denied = await _host.require_owner(ctx, request, operation)
            if denied is not None:
                return denied
        return await handler(request, ctx)

    return _wrapped


async def _handle_state(request: web.Request, ctx: Any) -> web.Response:
    state = await asyncio.to_thread(lambda: _store(ctx).snapshot())
    return web.json_response(state)


async def _handle_add_moment(request: web.Request, ctx: Any) -> web.Response:
    body, err = await _json_object(request)
    if err is not None:
        return err
    assert body is not None
    mood, err = _text(body, "mood", _MAX_MOOD, required=True)
    if err is not None:
        return err
    note, err = _text(body, "note", _MAX_NOTE)
    if err is not None:
        return err
    tags = _tags(body.get("tags"))
    if tags is None:
        return _bad_request(
            "tags must be a short list of short strings", "invalid_field_type"
        )
    moment = await asyncio.to_thread(
        lambda: _store(ctx).add_moment(mood, note=note, tags=tags)
    )
    return web.json_response(moment, status=201)


async def _handle_set_queue(request: web.Request, ctx: Any) -> web.Response:
    body, err = await _json_object(request)
    if err is not None:
        return err
    assert body is not None
    source, err = _text(body, "source", _MAX_SOURCE, required=True)
    if err is not None:
        return err
    moment_id = body.get("moment_id") or ""
    if not isinstance(moment_id, str) or (moment_id and not _ID_RE.fullmatch(moment_id)):
        return _bad_request("moment_id is not an id", "invalid_field_type")
    mood_tags = _tags(body.get("mood_tags"))
    if mood_tags is None:
        return _bad_request(
            "mood_tags must be a short list of short strings", "invalid_field_type"
        )
    append = body.get("append", False)
    if not isinstance(append, bool):
        return _bad_request("append must be true or false", "invalid_field_type")
    picks, err = await _checked_picks(body)
    if err is not None:
        return err
    queue = await asyncio.to_thread(
        lambda: _store(ctx).set_queue(
            picks, source=source, moment_id=moment_id, mood_tags=mood_tags, append=append
        )
    )
    return web.json_response({"queue": queue})


async def _handle_feedback(request: web.Request, ctx: Any) -> web.Response:
    pick_id = request.match_info["id"]
    if not _ID_RE.fullmatch(pick_id):
        return _bad_request("not a pick id", "invalid_field_type")
    body, err = await _json_object(request)
    if err is not None:
        return err
    assert body is not None
    verdict = body.get("verdict")
    if verdict not in VERDICTS:
        return _bad_request(
            "verdict must be liked, skipped or empty", "invalid_field_type"
        )
    pick = await asyncio.to_thread(lambda: _store(ctx).set_feedback(pick_id, verdict))
    if pick is None:
        return web.json_response({"error": "no such pick", "code": "not_found"}, status=404)
    if verdict:
        taste.start(ctx, request.app.get("state"))
    return web.json_response(pick)


async def _handle_verify(request: web.Request, ctx: Any) -> web.Response:
    body, err = await _json_object(request)
    if err is not None:
        return err
    assert body is not None
    picks, err = await _checked_picks(body)
    if err is not None:
        return err
    # Whether a pick is confirmed is this route's answer, never the caller's.
    picks = [{k: v for k, v in p.items() if k != "unverified"} for p in picks]
    avoid = await asyncio.to_thread(lambda: _store(ctx).avoid_lists())
    async with verify.http_fetch() as fetch:
        kept, dropped = await verify.verify_picks(picks, fetch, **avoid)
    return web.json_response({"picks": kept, "dropped": dropped})


def _not_found() -> web.Response:
    return web.json_response({"error": "no such item", "code": "not_found"}, status=404)


async def _handle_add_memory(request: web.Request, ctx: Any) -> web.Response:
    body, err = await _json_object(request)
    if err is not None:
        return err
    assert body is not None
    kind, origin = body.get("kind"), body.get("origin", "user")
    if kind not in MEMORY_KINDS or origin not in ORIGINS:
        return _bad_request("kind or origin is not one this app knows", "invalid_field_type")
    fields: dict[str, str] = {}
    # A dislike is a song (title, artist) or a few words (text), never both.
    as_song = kind in SONG_KINDS or (kind == "dislike" and "text" not in body)
    if kind == "dislike" and "text" in body and ("title" in body or "artist" in body):
        return _bad_request("a dislike is a song or a few words, not both", "invalid_field_type")
    if as_song:
        for key, required in (("title", True), ("artist", False)):
            fields[key], err = _text(body, key, _MAX_TEXT, required=required)
            if err is not None:
                return err
    else:
        limit = {"dislike": _MAX_DISLIKE_TEXT, "mood": _MAX_MOOD_TEXT}.get(kind, _MAX_NOTE_TEXT)
        fields["text"], err = _text(body, "text", limit, required=True)
        if err is not None:
            return err
    try:
        item = await asyncio.to_thread(
            lambda: _store(ctx).add_memory(kind, origin=origin, **fields)
        )
    except MemoryFull:
        return _memory_full(kind)
    if kind in TASTE_KINDS:
        taste.start(ctx, request.app.get("state"))
    return web.json_response(item, status=201)


def _memory_full(kind: str) -> web.Response:
    """A 409 naming the kind, so the page says which list is full of the person's own items."""
    return web.json_response(
        {"error": f"{kind} memory is full of your own and pinned items", "code": "memory_full", "kind": kind},
        status=409,
    )


async def _handle_update_memory(request: web.Request, ctx: Any) -> web.Response:
    item_id = request.match_info["id"]
    if not _ID_RE.fullmatch(item_id):
        return _bad_request("not an item id", "invalid_field_type")
    body, err = await _json_object(request)
    if err is not None:
        return err
    assert body is not None
    text = None
    if "text" in body:
        # The store edits a note's or a worded dislike's text only; both fit this.
        text, err = _text(body, "text", _MAX_NOTE_TEXT, required=True)
        if err is not None:
            return err
    pinned = body.get("pinned")
    if pinned is not None and not isinstance(pinned, bool):
        return _bad_request("pinned must be true or false", "invalid_field_type")
    item = await asyncio.to_thread(
        lambda: _store(ctx).update_memory(item_id, text=text, pinned=pinned)
    )
    return web.json_response(item) if item is not None else _not_found()


async def _handle_delete_memory(request: web.Request, ctx: Any) -> web.Response:
    item_id = request.match_info["id"]
    if not _ID_RE.fullmatch(item_id):
        return _bad_request("not an item id", "invalid_field_type")
    gone = await asyncio.to_thread(lambda: _store(ctx).delete_memory(item_id))
    return web.json_response({"deleted": item_id}) if gone else _not_found()


async def _handle_clear_stale(request: web.Request, ctx: Any) -> web.Response:
    removed = await asyncio.to_thread(lambda: _store(ctx).clear_stale())
    return web.json_response({"removed": removed})


async def _handle_memory_used(request: web.Request, ctx: Any) -> web.Response:
    body, err = await _json_object(request)
    if err is not None:
        return err
    assert body is not None
    ids = body.get("ids")
    if (
        not isinstance(ids, list)
        or len(ids) > _MAX_IDS
        or not all(isinstance(i, str) and _ID_RE.fullmatch(i) for i in ids)
    ):
        return _bad_request("ids must be a short list of item ids", "invalid_field_type")
    marked = await asyncio.to_thread(lambda: _store(ctx).mark_used(ids))
    return web.json_response({"marked": marked})


def _line_id(request: web.Request) -> str | None:
    line_id = request.match_info["id"]
    return line_id if _ID_RE.fullmatch(line_id) else None


async def _handle_edit_line(request: web.Request, ctx: Any) -> web.Response:
    line_id = _line_id(request)
    if line_id is None:
        return _bad_request("not a line id", "invalid_field_type")
    body, err = await _json_object(request)
    if err is not None:
        return err
    assert body is not None
    if set(body) != {"text"}:
        return _bad_request("send text only", "invalid_field_type")
    text, err = _text(body, "text", PROFILE_LINE_CHARS, required=True)
    if err is not None:
        return err
    line = await asyncio.to_thread(lambda: _store(ctx).edit_profile_line(line_id, text))
    return web.json_response(line) if line is not None else _not_found()


async def _handle_delete_line(request: web.Request, ctx: Any) -> web.Response:
    line_id = _line_id(request)
    if line_id is None:
        return _bad_request("not a line id", "invalid_field_type")
    gone = await asyncio.to_thread(lambda: _store(ctx).delete_profile_line(line_id))
    return web.json_response({"deleted": line_id}) if gone else _not_found()


async def _handle_delete_profile(request: web.Request, ctx: Any) -> web.Response:
    gone = await asyncio.to_thread(lambda: _store(ctx).delete_profile())
    return web.json_response({"deleted": gone})


async def _handle_run_profile(request: web.Request, ctx: Any) -> web.Response:
    """Fold again now; the answer is only whether a fold started (it runs in the background)."""
    started = taste.start(ctx, request.app.get("state"), force=True)
    return web.json_response({"started": started})


async def _handle_settings(request: web.Request, ctx: Any) -> web.Response:
    body, err = await _json_object(request)
    if err is not None:
        return err
    assert body is not None
    changes: dict[str, Any] = {}
    if "explore" in body:
        if body["explore"] not in EXPLORE_LEVELS:
            return _bad_request("explore is not a level this app knows", "invalid_field_type")
        changes["explore"] = body["explore"]
    for flag in ("record_open", "continuous", "view_open", "stay_only"):
        if flag in body:
            if not isinstance(body[flag], bool):
                return _bad_request(f"{flag} must be true or false", "invalid_field_type")
            changes[flag] = body[flag]
    allowed = {"explore", "record_open", "continuous", "view_open", "stay_only"}
    if not changes or set(body) - allowed:
        return _bad_request(
            "send explore, record_open, continuous, view_open and/or stay_only only",
            "invalid_field_type",
        )
    settings = await asyncio.to_thread(lambda: _store(ctx).set_settings(**changes))
    return web.json_response(settings)


def _play_site(request: web.Request) -> str | None:
    site = request.match_info["site"]
    return site if site in PLAY_SITES else None


async def _handle_set_steps(request: web.Request, ctx: Any) -> web.Response:
    site = _play_site(request)
    if site is None:
        return _bad_request(f"site must be one of {', '.join(PLAY_SITES)}", "invalid_field_type")
    body, err = await _json_object(request)
    if err is not None:
        return err
    assert body is not None
    raw = body.get("steps")
    if not isinstance(raw, list) or not 0 < len(raw) <= MAX_STEPS or set(body) - {"steps"}:
        return _bad_request(f"steps must be a list of 1 to {MAX_STEPS}", "invalid_field_type")
    steps: list[str] = []
    for step in raw:
        if not isinstance(step, str) or _STEP_BAD_RE.search(step):
            return _bad_request("a step must be one line of plain text", "invalid_field_type")
        step = step.strip()
        if not step or len(step) > MAX_STEP_CHARS:
            return _bad_request(
                f"a step must be 1 to {MAX_STEP_CHARS} characters", "field_too_long"
            )
        steps.append(step)
    entry = await asyncio.to_thread(lambda: _store(ctx).set_play_steps(site, steps))
    return web.json_response({"site": site, **entry})


async def _handle_forget_steps(request: web.Request, ctx: Any) -> web.Response:
    site = _play_site(request)
    if site is None:
        return _bad_request(f"site must be one of {', '.join(PLAY_SITES)}", "invalid_field_type")
    gone = await asyncio.to_thread(lambda: _store(ctx).forget_play_steps(site))
    return web.json_response({"site": site, "forgotten": gone})


def _pick_id(body: dict[str, Any], *, required: bool) -> tuple[str | None, web.Response | None]:
    value = body.get("pick_id")
    if value is None and not required:
        return None, None
    if not isinstance(value, str) or not _ID_RE.fullmatch(value):
        return None, _bad_request("pick_id is not a pick id", "invalid_field_type")
    return value, None


async def _handle_playback(request: web.Request, ctx: Any) -> web.Response:
    body, err = await _json_object(request)
    if err is not None:
        return err
    assert body is not None
    if not body or set(body) - {"pick_id", "paused"}:
        return _bad_request("send pick_id and/or paused only", "invalid_field_type")
    pick_id, err = _pick_id(body, required=False)
    if err is not None:
        return err
    paused = body.get("paused")
    if paused is not None and not isinstance(paused, bool):
        return _bad_request("paused must be true or false", "invalid_field_type")
    playback = await asyncio.to_thread(
        lambda: _store(ctx).set_playback(pick_id=pick_id, paused=paused)
    )
    return web.json_response(playback)


async def _handle_ended(request: web.Request, ctx: Any) -> web.Response:
    body, err = await _json_object(request)
    if err is not None:
        return err
    assert body is not None
    if set(body) != {"pick_id"}:
        return _bad_request("send pick_id only", "invalid_field_type")
    pick_id, err = _pick_id(body, required=True)
    if err is not None:
        return err
    assert pick_id is not None
    claimed = await asyncio.to_thread(lambda: _store(ctx).claim_ended(pick_id))
    return web.json_response({"claimed": claimed})


def register_routes(ctx: Any) -> list[_host.Route]:
    """The manifest's ``backend.hooks.routes``: this app's routes, unprefixed.

    A gateway below App Kit level 1 has no owner gate to hand out, so every
    route refuses; that is reported as degraded health rather than left for the
    operator to discover one refusal at a time.
    """
    if _host.sdk_level(ctx) < _host.REQUIRED_SDK_LEVEL:
        health = getattr(ctx, "health", None)
        mark_degraded = getattr(health, "mark_degraded", None)
        if callable(mark_degraded):
            mark_degraded(
                f"this Kiro Crew lacks App Kit level {_host.REQUIRED_SDK_LEVEL} "
                "(owner gate): every request is refused"
            )
    route = _host.app_route
    return [
        route("GET", "/state", _owner_only("read_state", _handle_state)),
        route("POST", "/moments", _owner_only("add_moment", _handle_add_moment)),
        route("POST", "/queue", _owner_only("set_queue", _handle_set_queue)),
        route("PUT", "/queue/{id}/feedback", _owner_only("feedback", _handle_feedback)),
        route("POST", "/verify-picks", _owner_only("verify_picks", _handle_verify)),
        route("POST", "/memory", _owner_only("add_memory", _handle_add_memory)),
        route("PUT", "/memory/{id}", _owner_only("update_memory", _handle_update_memory)),
        route("DELETE", "/memory/{id}", _owner_only("delete_memory", _handle_delete_memory)),
        route("POST", "/memory/clear-stale", _owner_only("clear_stale", _handle_clear_stale)),
        route("POST", "/memory/used", _owner_only("memory_used", _handle_memory_used)),
        route("PUT", "/profile/lines/{id}", _owner_only("edit_profile_line", _handle_edit_line)),
        route("DELETE", "/profile/lines/{id}", _owner_only("delete_profile_line", _handle_delete_line)),
        route("DELETE", "/profile", _owner_only("delete_profile", _handle_delete_profile)),
        route("POST", "/profile/run", _owner_only("run_profile", _handle_run_profile)),
        route("PUT", "/settings", _owner_only("settings", _handle_settings)),
        route("PUT", "/play-steps/{site}", _owner_only("set_play_steps", _handle_set_steps)),
        route(
            "DELETE", "/play-steps/{site}", _owner_only("forget_play_steps", _handle_forget_steps)
        ),
        route("POST", "/buddy", _owner_only("open_buddy", buddy.handle_open)),
        route("POST", "/buddy/send", _owner_only("send_buddy", buddy.handle_send)),
        route("PUT", "/playback", _owner_only("playback", _handle_playback)),
        route("POST", "/playback/ended", _owner_only("playback_ended", _handle_ended)),
        # Saved playlists (playlists.py), each behind the same owner gate.
        *playlists.routes(route, _owner_only),
    ]
