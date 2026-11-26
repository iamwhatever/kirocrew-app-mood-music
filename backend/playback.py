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

The newest list the person asked for wins (0.2.19). An ending that comes after
the buddy answered with a new list, but before the page stored it, waits for it
(``LIST_WAIT_S`` at most), so the song after it is the new list's first. A
refill names the ``queue_gen`` it was asked on, and is dropped when the queue
was replaced since.

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

from . import buddy, links, playlists, sites, verify
from .play_request import (
    MORE_HEAD,
    REFILL_AT,
    REFILL_COUNT,
    build_more_request,
    build_play_request,
    memory_summary,
    reply_source,
)
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


#: A refill that keeps fewer new songs than this, after its repeats were dropped,
#: asks the buddy once for picks in their place (``MIN_NEW`` in the page).
MIN_NEW = 2


def _refill_of(snapshot: dict[str, Any]) -> dict[str, Any]:
    moments = snapshot.get("moments") or []
    return {
        "mood_tags": (moments[0].get("tags") if moments else None) or [],
        "queued": [
            {"title": p.get("title", ""), "artist": p.get("artist", ""), "arc": p.get("arc", "")}
            for p in snapshot.get("queue", [])
        ],
        "played": snapshot.get("played") or [],
    }


def play_message(
    snapshot: dict[str, Any], song: dict[str, Any], refill: bool,
    active: list[str] | None = None,
) -> tuple[str, list[str]]:
    """The page's play request for *song* after an ending, built from the stored state.

    *active* is the site list in force (``sites.active_sites``), or ``None``.

    With the ids of the memory items a refill request carried, marked used once
    its picks land, as the page marks the memory behind a queue.
    """
    settings = snapshot.get("settings") or {}
    memory = snapshot.get("memory") or []
    message = build_play_request(
        song=song,
        steps=((snapshot.get("play_steps") or {}).get(song.get("source")) or {}).get("steps") or [],
        why="ended",
        refill=_refill_of(snapshot) if refill else None,
        memory=memory,
        explore=settings.get("explore") or "balanced",
        # The page stores its "stay only" switch; off until the person sets it.
        stay_only=settings.get("stay_only") is True,
        profile=snapshot.get("profile"),
        sites=active,
    )
    return message, (memory_summary(memory, snapshot.get("profile"))[1] if refill else [])


def more_message(snapshot: dict[str, Any], count: int) -> str:
    """The request for *count* picks in place of a refill's repeats, from the stored state."""
    settings = snapshot.get("settings") or {}
    return build_more_request(
        count=count,
        refill=_refill_of(snapshot),
        memory=snapshot.get("memory") or [],
        explore=settings.get("explore") or "balanced",
        stay_only=settings.get("stay_only") is True,
        profile=snapshot.get("profile"),
    )


def needs_more(kept: int, dropped: dict[str, int]) -> int:
    """How many picks to ask for in place of a refill's repeats; 0 for none.

    Only when repeats were dropped and fewer than :data:`MIN_NEW` new songs are
    left: then the buddy is asked once, rather than the queue running dry.
    """
    if not dropped.get("recent") or kept >= MIN_NEW:
        return 0
    return REFILL_COUNT - kept


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


def _latest_ask(rows: list[Any]) -> str:
    """The text of the last user row, or ``""``."""
    for row in reversed(rows):
        if isinstance(row, dict) and row.get("role") == "user":
            content = row.get("content")
            return content if isinstance(content, str) else ""
    return ""


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
    memory_ids: list[str] | None = None, queue_gen: int | None = None,
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
    count = await _add_refill(store, parsed, reply, memory_ids, queue_gen)
    if count:
        await _ask_more(ctx, state, count, queue_gen)


async def _add_refill(
    store: Any, parsed: dict[str, Any] | None, reply: str,
    memory_ids: list[str] | None, queue_gen: int | None,
) -> int:
    """Check a refill's picks and add those kept after the queue.

    Returns how many picks to ask for in place of its repeats (:func:`needs_more`).
    """
    picks = (parsed or {}).get("picks") or []
    if not picks or parsed is None:
        return 0
    picks = [{k: v for k, v in p.items() if k != "unverified"} for p in picks]
    avoid = await asyncio.to_thread(store.avoid_lists)
    async with verify.http_fetch() as fetch:
        kept, dropped = await verify.verify_picks(picks, fetch, **avoid)
    if kept:
        # Asked on the list of *queue_gen*: a list the person asked for since wins,
        # and this refill is dropped rather than pushed after it.
        added = await asyncio.to_thread(lambda: store.set_queue(
            kept, source=reply_source(reply), mood_tags=parsed["mood_tags"], append=True,
            based_on=queue_gen))
        if not added:
            return 0
        if memory_ids:
            # The memory the refill request carried helped: keep it fresh (design §2.3).
            await asyncio.to_thread(lambda: store.mark_used(memory_ids))
    return needs_more(len(kept), dropped)


async def _ask_more(ctx: Any, state: Any, count: int, queue_gen: int | None) -> None:
    """Ask the buddy once for *count* picks in place of repeats, and add what it finds."""
    from .routes import _store  # noqa: PLC0415

    slots = ctx.chat_slots
    slot = slots.get(state, buddy.BUDDY_KEY)
    if slot is None or getattr(slot, "running", False):
        return
    reserve = getattr(slots, "reserve", None)
    reservation = reserve(state, slot) if callable(reserve) else None
    if callable(reserve) and reservation is None:
        return
    store = _store(ctx)
    snapshot = await asyncio.to_thread(store.snapshot)
    if queue_gen is not None and snapshot.get("queue_gen") != queue_gen:
        return
    try:
        turn = slots.send(state, slot, more_message(snapshot, count),
                          **({"reservation": reservation} if reservation is not None else {}))
    except (PermissionError, RuntimeError) as exc:
        logger.warning("mood-music: the buddy could not be asked for more: %s", exc)
        return
    if turn is None:
        return

    async def follow() -> None:
        try:
            await turn
        except BaseException:  # noqa: BLE001 - a stopped turn added nothing
            return
        reply = _latest_reply(await slots.transcript(state, buddy.BUDDY_KEY))
        # Added if it fits; never asked for again, so one refill asks once.
        await _add_refill(store, parse_reply(reply) if reply else None, reply, None, queue_gen)

    task = asyncio.ensure_future(follow())
    track = getattr(slots, "track", None)
    if callable(track):
        track(state, task)


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
    if await _wake(ctx, state, slots, pick_id) in ("busy", "list"):
        # A turn already out (the person's own request) goes first, and so does
        # the new list it brought. The host reports an ending once, so it is
        # claimed after them, not dropped.
        follow = asyncio.ensure_future(_wake_after_turn(ctx, state, slots, pick_id))
        track = getattr(slots, "track", None)
        if callable(track):
            track(state, follow)


#: How often a wake held up by a running turn looks again, and for how long at most.
#: shortcut: polls the slot; a host turn-ended signal for apps would replace it.
BUSY_POLL_S = 2.0
BUSY_WAIT_S = 30 * 60.0
#: How long an ending waits for the page to store the new list the buddy just
#: answered with (the page checks its links first, a few seconds). After that
#: the page is taken to be gone, and the list stored is the one that plays on.
LIST_WAIT_S = 60.0


async def _wake_after_turn(ctx: Any, state: Any, slots: Any, pick_id: str) -> None:
    """Claim *pick_id*'s ending once the running turn is over (and any after it)."""
    waited = listed = 0.0
    while waited < BUSY_WAIT_S:
        await asyncio.sleep(BUSY_POLL_S)
        waited += BUSY_POLL_S
        outcome = await _wake(ctx, state, slots, pick_id, wait_for_list=listed < LIST_WAIT_S)
        if outcome == "list":
            listed += BUSY_POLL_S
        elif outcome != "busy":
            return
    logger.info("mood-music: the buddy stayed busy; a song ending was not claimed")


async def _list_on_its_way(ctx: Any, state: Any, slots: Any, snapshot: dict[str, Any]) -> bool:
    """Whether the buddy's newest answer is a new list the page has not stored yet.

    The person's own request ends with picks and no play result; the page then
    checks them and replaces the queue (``last_source`` becomes that reply's id).
    Until it has, the queue is the old list, and an ending claimed now would
    play on from it.
    """
    transcript = getattr(slots, "transcript", None)
    if not callable(transcript):
        return False
    rows = await transcript(state, buddy.BUDDY_KEY)
    if _latest_ask(rows).startswith(f"[Mood Music]\n{MORE_HEAD}: "):
        # Picks in place of a refill's repeats go after the queue: no new list.
        return False
    reply = _latest_reply(rows)
    parsed = parse_reply(reply) if reply else None
    if not parsed or parsed["play"] is not None or not parsed["picks"]:
        return False
    return reply_source(reply) != snapshot.get("last_source")


async def _wake(ctx: Any, state: Any, slots: Any, pick_id: str, *, wait_for_list: bool = True) -> str:
    """Claim *pick_id*'s ending and wake the buddy for the next song.

    ``busy`` when a turn is running and ``list`` while the new list it brought
    is not stored yet, so nothing was claimed; ``done`` otherwise.
    """
    from .routes import _store  # noqa: PLC0415

    slot = slots.get(state, buddy.BUDDY_KEY)
    if slot is None:
        return "done"
    if getattr(slot, "running", False):
        return "busy"
    if wait_for_list and await _list_on_its_way(
        ctx, state, slots, await asyncio.to_thread(_store(ctx).snapshot)
    ):
        return "list"
    # Read before the slot is held: the pages the owner allows now (read only).
    active = await sites.active_sites(ctx)
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
    if refill:
        # A saved playlist playing: its next part comes first, and the buddy is
        # asked for more only once it ran out and the person allowed it.
        part = await asyncio.to_thread(lambda: playlists.extend_for(ctx, song["id"]))
        if part["active"]:
            refill = part["ask_buddy"]
    message, memory_ids = play_message(snapshot, song, refill, active)
    try:
        turn = slots.send(state, slot, message,
                          **({"reservation": reservation} if reservation is not None else {}))
    except (PermissionError, RuntimeError) as exc:
        logger.warning("mood-music: the buddy could not be woken: %s", exc)
        return "done"
    if turn is None:
        return "done"
    follow = asyncio.ensure_future(
        after_turn(ctx, state, turn, song, memory_ids, snapshot.get("queue_gen")))
    track = getattr(slots, "track", None)
    if callable(track):
        track(state, follow)
    return "done"
