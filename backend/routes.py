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

A pick's link is checked in ``links.py``: a YouTube pick is stored as its video
id alone, a bilibili pick as an https URL on an exact bilibili host. A request
carrying one bad pick is refused whole, so nothing half-checked is stored.
"""

from __future__ import annotations

import asyncio
import json
import re
from functools import wraps
from pathlib import Path
from typing import Any

from aiohttp import web

from . import _host, links
from .store import MAX_QUEUE, VERDICTS, MoodStore

_MAX_MOOD = 200
_MAX_NOTE = 1000
_MAX_TEXT = 200
_MAX_WHY = 400
_MAX_TAGS = 8
_MAX_TAG = 40
_MAX_SOURCE = 128
_ID_RE = re.compile(r"[0-9a-f]{32}")
_TIERS = ("anchor", "explore", "deep")
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
    if source == "youtube":
        video_id = raw.get("video_id")
        vid = (
            links.valid_video_id(video_id)
            if video_id is not None
            else links.youtube_video_id(raw.get("url"))
        )
        if vid is None:
            return None, "invalid_video_id"
        out.update(source="youtube", video_id=vid)
    elif source == "bilibili":
        url = links.bilibili_url(raw.get("url"))
        if url is None:
            return None, "invalid_bilibili_url"
        out.update(source="bilibili", url=url)
    else:
        return None, "invalid_source"
    return out, ""


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
    raw_picks = body.get("picks")
    if not isinstance(raw_picks, list) or not 0 < len(raw_picks) <= MAX_QUEUE:
        return _bad_request(
            f"picks must be a list of 1 to {MAX_QUEUE}", "invalid_field_type"
        )
    picks: list[dict[str, Any]] = []
    for raw in raw_picks:
        pick, code = _pick(raw)
        if pick is None:
            return _bad_request("a pick was refused", code)
        picks.append(pick)
    queue = await asyncio.to_thread(
        lambda: _store(ctx).set_queue(
            picks, source=source, moment_id=moment_id, mood_tags=mood_tags
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
    return web.json_response(pick)


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
    ]
