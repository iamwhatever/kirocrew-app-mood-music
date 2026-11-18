"""The buddy's chat through ``ctx.chat_slots``: hidden, the DJ agent, and plain refusals.

``FakeSlots`` stands in for the host seam with the shape PR #39246 gives it:
``open(state, key, *, hidden=False)`` and ``send(state, slot, message)``.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest

from backend import buddy
from tests.harness import make_ctx
from tests.test_routes import _call


class ChatSlotRefused(PermissionError):
    pass


class FakeSlot:
    def __init__(self, key: str, mode: str) -> None:
        self.key = key
        self.mode = mode
        self.agent = ""


class FakeSlots:
    def __init__(self, *, may_hide: bool = True) -> None:
        self.may_hide = may_hide
        self.slots: dict[str, FakeSlot] = {}
        self.opened: list[tuple[str, bool]] = []
        self.sent: list[tuple[str, str]] = []
        self.queue = False
        self.send_error: Exception | None = None

    async def open(self, state: Any, key: str, *, hidden: bool = False) -> tuple[FakeSlot, bool]:
        self.opened.append((key, hidden))
        if key in self.slots:
            return self.slots[key], False
        if hidden and not self.may_hide:
            raise ChatSlotRefused("may not hide")
        slot = self.slots[key] = FakeSlot(key, "mood-music" if hidden else "")
        return slot, True

    def send(self, state: Any, slot: FakeSlot, message: str) -> Any:
        if self.send_error:
            raise self.send_error
        self.sent.append((slot.key, message))
        return None if self.queue else object()


class OldSlots:
    """A host before #39246: ``open`` takes no ``hidden``."""

    async def open(self, state: Any, key: str) -> tuple[FakeSlot, bool]:
        raise AssertionError("an old host's open must not be called")


@pytest.fixture
def ctx(tmp_path: Path):
    c = make_ctx(tmp_path)
    c.chat_slots = FakeSlots()  # type: ignore[attr-defined]
    return c


def test_open_makes_a_hidden_chat_with_the_dj_agent(ctx) -> None:
    status, body = _call(ctx, "POST", "/buddy")
    assert (status, body) == (200, {"key": buddy.BUDDY_KEY})
    slot = ctx.chat_slots.slots[buddy.BUDDY_KEY]
    assert ctx.chat_slots.opened == [(buddy.BUDDY_KEY, True)]
    assert (slot.mode, slot.agent) == ("mood-music", buddy.DJ_AGENT)


def test_an_existing_chat_keeps_the_agent_the_person_switched_to(ctx) -> None:
    _call(ctx, "POST", "/buddy")
    ctx.chat_slots.slots[buddy.BUDDY_KEY].agent = "other"
    _call(ctx, "POST", "/buddy")
    assert ctx.chat_slots.slots[buddy.BUDDY_KEY].agent == "other"


def test_send_goes_through_chat_slots_to_the_hidden_chat(ctx) -> None:
    status, body = _call(ctx, "POST", "/buddy/send", {"message": "[Mood Music]\nMood: calm"})
    assert status == 200 and body == {"ok": True, "key": buddy.BUDDY_KEY, "queued": False}
    assert ctx.chat_slots.sent == [(buddy.BUDDY_KEY, "[Mood Music]\nMood: calm")]
    assert ctx.chat_slots.opened == [(buddy.BUDDY_KEY, True)]


def test_a_send_behind_a_running_turn_is_queued(ctx) -> None:
    ctx.chat_slots.queue = True
    assert _call(ctx, "POST", "/buddy/send", {"message": "hi"})[1]["queued"] is True


@pytest.mark.parametrize(
    "body", [{}, {"message": ""}, {"message": "  "}, {"message": 3}, {"message": "hi", "slot": "x"},
             {"message": "x" * (buddy.MAX_MESSAGE + 1)}, ["hi"]],
)
def test_bad_sends_are_refused_and_nothing_is_sent(ctx, body) -> None:
    status, payload = _call(ctx, "POST", "/buddy/send", body)
    assert (status, payload["code"]) == (400, "invalid_field_type")
    assert ctx.chat_slots.sent == []


def test_a_refused_hidden_chat_says_so_and_creates_nothing(ctx) -> None:
    ctx.chat_slots.may_hide = False
    for path, body in (("/buddy", None), ("/buddy/send", {"message": "hi"})):
        status, payload = _call(ctx, "POST", path, body)
        assert (status, payload["code"]) == (403, "hidden_refused")
    assert ctx.chat_slots.slots == {} and ctx.chat_slots.sent == []


@pytest.mark.parametrize("slots", [None, OldSlots()])
def test_an_old_host_says_update_kiro_crew(tmp_path: Path, slots) -> None:
    c = make_ctx(tmp_path)
    if slots is not None:
        c.chat_slots = slots  # type: ignore[attr-defined]
    for path, body in (("/buddy", None), ("/buddy/send", {"message": "hi"})):
        status, payload = _call(c, "POST", path, body)
        assert (status, payload["code"]) == (409, "old_host")


def test_a_slot_not_ready_is_a_plain_refusal(ctx) -> None:
    ctx.chat_slots.send_error = RuntimeError("rows unread")
    status, payload = _call(ctx, "POST", "/buddy/send", {"message": "hi"})
    assert (status, payload["code"]) == (409, "not_ready")


@pytest.mark.parametrize(("path", "body"), [("/buddy", None), ("/buddy/send", {"message": "hi"})])
def test_only_the_owner_reaches_the_buddy(ctx, path, body) -> None:
    status, payload = _call(ctx, "POST", path, body, user="someone-else")
    assert (status, payload["code"]) == (403, "owner_only")
    assert ctx.chat_slots.opened == [] and ctx.chat_slots.sent == []
