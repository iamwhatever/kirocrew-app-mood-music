"""Continuous play with the page closed: the backend hears a song end and wakes the buddy.

Kiro Crew calls the manifest's ``backend.hooks.on_browser_media_ended`` with
``(ctx, {"event": "browser_media_ended", "session_key", "origin", "duration"})``
once per ending in the browser tab of one of this app's own slots, page open or
not (KiroCrew#40261). A Kiro Crew without the hook ignores the manifest key; the
page then wakes the buddy as before, from its own poll.

Who wakes the buddy for one ending is decided by one claim in the store
(``MoodStore.claim_ended``): the page claims through ``POST /playback/ended``,
the hook claims here, and only the first claim for that song wins. The claim is
also where continuous play off and the person's pause are honoured, so neither
side can wake the buddy past them. The page tells the store which song plays and
when the person pauses (``PUT /playback``).

The host reports one ending once. An ending that comes while a turn runs (the
person's own request) is not dropped: a tracked task claims it once the slot is
idle, for the song that ended then, so a turn that started another song meanwhile
claims nothing.

The side that woke the buddy reads its answer. Here that is a task held with the
gateway's background work (``chat_slots.track``): once the turn ends it keeps the
steps that worked (or forgets those that failed), records the song as playing and
heard, and adds the refill picks, checked as the page checks them, after the queue.
The hook itself only starts the turn, so it returns at once.

Nothing here imports ``kiro_crew``: every seam is read off the context.
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
from typing import Any

from . import buddy, links, verify
from .play_request import REFILL_AT, build_play_request, memory_summary, reply_source
from .store import PLAY_SITES, MemoryFull

logger = logging.getLogger(__name__)

EVENT = "browser_media_ended"

_FENCE_RE = re.compile(r"```mood-music[^\n]*\n([\s\S]*?)```")
_STEP_BAD_RE = re.compile(r"[\x00-\x1f\x7f\u2028\u2029`\[\]]")
_MAX_PICKS = 12
_TIERS = ("anchor", "explore", "deep")
_ARCS = ("stay", "turn", "lift")


def _gateway_state(ctx: Any) -> Any:
    """The dashboard state a slot call takes; a route reads it off ``request.app``."""
    http_app = getattr(ctx, "http_app", None)
    getter = getattr(http_app, "get", None)
    return getter("state") if callable(getter) else None


def next_pick(snapshot: dict[str, Any], pick_id: str) -> tuple[dict[str, Any] | None, bool]:
    """The pick after *pick_id* that is not skipped, and whether to ask for more.

    A song no longer in the queue came from a list since replaced: the new
    list's first pick is next.
    """
    queue = snapshot.get("queue", [])
    at = next((i for i, p in enumerate(queue) if p.get("id") == pick_id), -1)
    after = [p for p in queue[at + 1:] if p.get("feedback") != "skipped"]
    if not after:
        return None, False
    return after[0], len(after) - 1 <= REFILL_AT


def play_message(
    snapshot: dict[str, Any], song: dict[str, Any], refill: bool
) -> tuple[str, list[str]]:
    """The page's play request for *song* after an ending, built from the stored state.

    With the ids of the memory items a refill request carried, marked used once
    its picks land, as the page marks the memory behind a queue.
    """
    settings = snapshot.get("settings") or {}
    moments = snapshot.get("moments") or []
    memory = snapshot.get("memory") or []
    message = build_play_request(
        song=song,
        steps=((snapshot.get("play_steps") or {}).get(song.get("source")) or {}).get("steps") or [],
        why="ended",
        refill={
            "mood_tags": (moments[0].get("tags") if moments else None) or [],
            "queued": [
                {"title": p.get("title", ""), "artist": p.get("artist", "")}
                for p in snapshot.get("queue", [])
            ],
        } if refill else None,
        memory=memory,
        explore=settings.get("explore") or "balanced",
        # The page stores its "stay only" switch; off until the person sets it.
        stay_only=settings.get("stay_only") is True,
    )
    return message, (memory_summary(memory)[1] if refill else [])


# ── the reply ──


def _text(value: Any, limit: int) -> str:
    return value.strip()[:limit] if isinstance(value, str) else ""


def _tags(value: Any, limit: int = 40, count: int = 8) -> list[str]:
    if not isinstance(value, list):
        return []
    return [t.strip()[:limit] for t in value if isinstance(t, str) and t.strip()][:count]


def _reject_constant(value: str) -> Any:
    raise ValueError(value)


def parse_reply(content: str) -> dict[str, Any] | None:
    """The play result, mood tags and picks of the LAST ``mood-music`` block.

    Read as the page reads them (``parseDjReply``).

    Each pick is cut to the page's lengths and then checked by the queue route's
    own check (``routes._pick``); a pick that fails is dropped.
    """
    from .routes import _pick  # noqa: PLC0415 - routes imports this module

    blocks = _FENCE_RE.findall(content or "")
    if not blocks:
        return None
    try:
        data = json.loads(blocks[-1], parse_constant=_reject_constant)
    except (ValueError, RecursionError):
        return None
    if not isinstance(data, dict):
        return None
    play = None
    if isinstance(data.get("played"), bool) and data.get("site") in PLAY_SITES:
        raw = data.get("steps") if isinstance(data.get("steps"), list) else []
        steps = [s.strip() for s in raw if isinstance(s, str) and not _STEP_BAD_RE.search(s)]
        steps = [s for s in steps if 0 < len(s) <= 120][:8]
        play = {
            "played": data["played"],
            "site": data["site"],
            "steps": steps if data["played"] else [],
        }
    picks: list[dict[str, Any]] = []
    raw_picks = data.get("picks") if isinstance(data.get("picks"), list) else []
    for raw in raw_picks[:_MAX_PICKS]:
        if not isinstance(raw, dict):
            continue
        shaped: dict[str, Any] = {
            "title": _text(raw.get("title"), 200),
            "artist": _text(raw.get("artist"), 200),
            "why": _text(raw.get("why"), 400),
            "tags": _tags(raw.get("tags")),
            "source": raw.get("source", raw.get("platform")),
        }
        for key, allowed in (("tier", _TIERS), ("arc", _ARCS)):
            if raw.get(key) in allowed:
                shaped[key] = raw[key]
        listen_for = _text(raw.get("listen_for"), 400)
        if listen_for:
            shaped["listen_for"] = listen_for
        ev = raw.get("evidence")
        if isinstance(ev, dict) and links.evidence_url(ev.get("url")):
            shaped["evidence"] = {"url": ev["url"], "label": _text(ev.get("label"), 200)}
        for key in ("url", "video_id"):
            if key in raw:
                shaped[key] = raw[key]
        checked, _code = _pick(shaped)
        if checked is not None:
            picks.append(checked)
    if any(p.get("arc") for p in picks):
        rank = {a: i for i, a in enumerate(_ARCS)}
        picks.sort(key=lambda p: rank.get(p.get("arc"), len(_ARCS)))
    mood_tags = _tags(data.get("mood_tags", data.get("moods")))
    return {"play": play, "mood_tags": mood_tags, "picks": picks}


def _latest_reply(rows: list[Any]) -> str:
    """The buddy's answer to the turn this module started: after the last user row."""
    users = [i for i, r in enumerate(rows) if isinstance(r, dict) and r.get("role") == "user"]
    last_user = users[-1] if users else -1
    for row in reversed(rows[last_user + 1:]):
        if isinstance(row, dict) and row.get("role") == "assistant":
            content = row.get("content")
            if isinstance(content, str) and content.strip():
                return content
    return ""


async def after_turn(
    ctx: Any, state: Any, turn: asyncio.Task[Any], song: dict[str, Any],
    memory_ids: list[str] | None = None,
) -> None:
    """Read the buddy's answer to a wake and keep what it says, as the page's ``afterPlay`` does."""
    from .routes import _store  # noqa: PLC0415

    try:
        await turn
    except BaseException:  # noqa: BLE001 - a stopped or failed turn played nothing we know of
        return
    rows = await ctx.chat_slots.transcript(state, buddy.BUDDY_KEY)
    reply = _latest_reply(rows)
    parsed = parse_reply(reply) if reply else None
    store = _store(ctx)
    result = (parsed or {}).get("play")
    site = song.get("source")
    if result is None or result["played"]:
        # No readable answer: the song is likely there all the same, so its own
        # ending is the next one to claim. Its steps are not known, so none are kept.
        await asyncio.to_thread(lambda: store.set_playback(pick_id=song["id"]))
    if result and result["played"]:
        if result["steps"] and site in PLAY_SITES:
            await asyncio.to_thread(lambda: store.set_play_steps(site, result["steps"]))
        try:
            await asyncio.to_thread(lambda: store.add_memory(
                "known", title=song.get("title", ""), artist=song.get("artist", ""), origin="app"))
        except MemoryFull:
            pass
    elif result and site in PLAY_SITES:
        await asyncio.to_thread(lambda: store.forget_play_steps(site))
    picks = (parsed or {}).get("picks") or []
    if not picks:
        return
    picks = [{k: v for k, v in p.items() if k != "unverified"} for p in picks]
    avoid = await asyncio.to_thread(store.avoid_lists)
    async with verify.http_fetch() as fetch:
        kept, _dropped = await verify.verify_picks(picks, fetch, **avoid)
    if kept:
        await asyncio.to_thread(lambda: store.set_queue(
            kept, source=reply_source(reply), mood_tags=parsed["mood_tags"], append=True))
        if memory_ids:
            # The memory the refill request carried helped: keep it fresh (design §2.3).
            await asyncio.to_thread(lambda: store.mark_used(memory_ids))


async def on_media_ended(ctx: Any, event: Any) -> None:
    """``backend.hooks.on_browser_media_ended``: wake the buddy once for the next song."""
    from .routes import _store  # noqa: PLC0415

    if not isinstance(event, dict) or event.get("event") != EVENT:
        return
    if event.get("session_key") != buddy.BUDDY_KEY:
        return
    slots = getattr(ctx, "chat_slots", None)
    state = _gateway_state(ctx)
    if slots is None or state is None:
        return
    # The song that ended: a turn running now may start another before this one is claimed.
    snapshot = await asyncio.to_thread(_store(ctx).snapshot)
    pick_id = str((snapshot.get("playback") or {}).get("pick_id") or "")
    if not pick_id:
        return
    if await _wake(ctx, state, slots, pick_id) == "busy":
        # A turn already out (the person's own request) goes first. The host
        # reports an ending once, so it is claimed after that turn, not dropped.
        follow = asyncio.ensure_future(_wake_after_turn(ctx, state, slots, pick_id))
        track = getattr(slots, "track", None)
        if callable(track):
            track(state, follow)


#: How often a wake held up by a running turn looks again, and for how long at most.
#: shortcut: polls the slot; a host turn-ended signal for apps would replace it.
BUSY_POLL_S = 2.0
BUSY_WAIT_S = 30 * 60.0


async def _wake_after_turn(ctx: Any, state: Any, slots: Any, pick_id: str) -> None:
    """Claim *pick_id*'s ending once the running turn is over (and any after it)."""
    waited = 0.0
    while waited < BUSY_WAIT_S:
        await asyncio.sleep(BUSY_POLL_S)
        waited += BUSY_POLL_S
        if await _wake(ctx, state, slots, pick_id) != "busy":
            return
    logger.info("mood-music: the buddy stayed busy; a song ending was not claimed")


async def _wake(ctx: Any, state: Any, slots: Any, pick_id: str) -> str:
    """Claim *pick_id*'s ending and wake the buddy for the next song.

    ``busy`` when a turn is running, so nothing was claimed; ``done`` otherwise.
    """
    from .routes import _store  # noqa: PLC0415

    slot = slots.get(state, buddy.BUDDY_KEY)
    if slot is None:
        return "done"
    if getattr(slot, "running", False):
        return "busy"
    reserve = getattr(slots, "reserve", None)
    # Held across the awaits below, so a page send meanwhile queues behind this wake.
    reservation = reserve(state, slot) if callable(reserve) else None
    if callable(reserve) and reservation is None:
        return "busy"
    store = _store(ctx)
    snapshot = await asyncio.to_thread(store.snapshot)
    if not await asyncio.to_thread(lambda: store.claim_ended(pick_id)):
        return "done"
    song, refill = next_pick(snapshot, pick_id)
    if song is None:
        return "done"
    message, memory_ids = play_message(snapshot, song, refill)
    try:
        turn = slots.send(state, slot, message,
                          **({"reservation": reservation} if reservation is not None else {}))
    except (PermissionError, RuntimeError) as exc:
        logger.warning("mood-music: the buddy could not be woken: %s", exc)
        return "done"
    if turn is None:
        return "done"
    follow = asyncio.ensure_future(after_turn(ctx, state, turn, song, memory_ids))
    track = getattr(slots, "track", None)
    if callable(track):
        track(state, follow)
    return "done"
