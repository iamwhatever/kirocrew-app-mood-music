"""The buddy's chat, opened and driven from this app's backend through ``ctx.chat_slots``.

A slot the backend opens carries this app's name (``slot._app``), and the host's
browser features key off that name: the page's live view (``BrowserView``), its
media buttons (``/api/browser/media``) and the approved ``browserSites``. A chat
the page opened with the owner's own request carries none, so the backend opens it.

``open(state, key, hidden=True)`` keeps the chat out of the session lists, as the
page's own hidden chat did; it needs ``permissions.hiddenSessions`` and an enabled,
trusted app, otherwise the host refuses (``ChatSlotRefused``, a ``PermissionError``)
and creates nothing. A host without ``chat_slots``, or whose ``open`` takes no
``hidden``, is too old: the page says to update Kiro Crew instead of failing quietly.

Nothing here imports ``kiro_crew``: the seam is read off the context.
"""

from __future__ import annotations

import inspect
import logging
from typing import Any

from aiohttp import web

logger = logging.getLogger(__name__)

#: The buddy's chat. A new key: the old page-opened chat (``mood-music-buddy``)
#: carries no app name, so the host would refuse to hand it to this app.
BUDDY_KEY = "mood-music-dj"
#: The app's own agent (``agents/dj.json``).
DJ_AGENT = "mood-music-dj"
#: The largest request the page sends; its prompt with memory is well under this.
MAX_MESSAGE = 32_000


class OldHost(Exception):
    """This Kiro Crew cannot open a hidden chat for an app."""


def _error(status: int, code: str, error: str) -> web.Response:
    return web.json_response({"code": code, "error": error}, status=status)


def _takes_hidden(open_fn: Any) -> bool | None:
    """Whether ``open`` accepts ``hidden``; ``None`` when its signature cannot be read."""
    try:
        return "hidden" in inspect.signature(open_fn).parameters
    except (TypeError, ValueError):
        return None


async def open_buddy(ctx: Any, state: Any) -> Any:
    """The buddy's hidden slot, created when absent, with the DJ agent on it."""
    slots = getattr(ctx, "chat_slots", None)
    open_fn = getattr(slots, "open", None)
    if not callable(open_fn) or _takes_hidden(open_fn) is False:
        raise OldHost("this Kiro Crew cannot open a hidden chat for an app")
    try:
        slot, created = await open_fn(state, BUDDY_KEY, hidden=True)
    except TypeError as exc:
        # A host whose signature could not be read and that has no ``hidden``.
        if "hidden" in str(exc):
            raise OldHost(str(exc)) from exc
        raise
    if created or not getattr(slot, "agent", ""):
        slot.agent = DJ_AGENT
    return slot


def _refusal(exc: Exception) -> web.Response:
    if isinstance(exc, OldHost):
        return _error(409, "old_host", "update Kiro Crew to open the buddy's hidden chat")
    # ChatSlotRefused: not declared, disabled or untrusted, or the key is someone else's.
    logger.warning("mood-music: buddy chat refused: %s", exc)
    return _error(403, "hidden_refused", "Kiro Crew refused to open the buddy's hidden chat")


async def handle_open(request: web.Request, ctx: Any) -> web.Response:
    """POST /buddy: open the buddy's chat and answer its key."""
    try:
        slot = await open_buddy(ctx, request.app["state"])
    except (OldHost, PermissionError) as exc:
        return _refusal(exc)
    return web.json_response({"key": str(getattr(slot, "key", BUDDY_KEY))})


async def handle_send(request: web.Request, ctx: Any) -> web.Response:
    """POST /buddy/send ``{"message"}``: one turn to the buddy, started or queued."""
    try:
        body = await request.json()
    except Exception:  # noqa: BLE001 - any unreadable body is a bad request
        return _error(400, "invalid_json", "send a JSON object")
    if not isinstance(body, dict) or set(body) != {"message"}:
        return _error(400, "invalid_field_type", "send message only")
    message = body["message"]
    if not isinstance(message, str) or not message.strip() or len(message) > MAX_MESSAGE:
        return _error(400, "invalid_field_type", f"message must be text of 1 to {MAX_MESSAGE}")
    state = request.app["state"]
    try:
        slot = await open_buddy(ctx, state)
        task = ctx.chat_slots.send(state, slot, message)
    except (OldHost, PermissionError) as exc:
        return _refusal(exc)
    except RuntimeError as exc:
        logger.warning("mood-music: buddy send refused: %s", exc)
        return _error(409, "not_ready", "the buddy's chat is not ready; try again")
    return web.json_response(
        {"ok": True, "key": str(getattr(slot, "key", BUDDY_KEY)), "queued": task is None}
    )
