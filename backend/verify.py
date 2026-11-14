"""Check the DJ's picks against YouTube and bilibili before the page shows them.

The agent is told to use only links it found, but that is a request, not a
guarantee (design §0.5). So every pick is looked up again here, and a pick is
kept only when the lookup answers and its title matches:

* YouTube: ``https://www.youtube.com/oembed?url=<watch URL>&format=json``. A 401
  (embedding off) or 404 (gone) drops the pick.
* bilibili: ``https://api.bilibili.com/x/web-interface/view?bvid=<BV id>``. A
  ``code`` other than 0 drops the pick. A link with no BV id (a ``b23.tv`` short
  link) cannot be looked up without following it, so it is dropped.

Only those two fixed URLs are ever requested, built here from an id that was
already checked (``links.py``). No redirect is followed, no cookie is sent or
kept, the body read is capped, and every lookup has a deadline. A lookup that
fails or runs out of time drops the pick: nothing unverified gets through.

A pick whose song the person already knows or skipped is dropped too (design
§0.6): a skipped song never comes back, and a known song is never an
``explore`` or ``deep`` pick.
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
import unicodedata
from collections.abc import AsyncIterator, Awaitable, Callable, Iterable
from contextlib import asynccontextmanager
from typing import Any
from urllib.parse import quote, urlsplit

logger = logging.getLogger(__name__)

#: Seconds one lookup may take, connect to last byte.
TIMEOUT = 6.0
#: The most lookups in flight at once.
CONCURRENCY = 4
#: The most bytes read from one answer; both APIs answer in a few KB.
MAX_BODY = 256 * 1024

YOUTUBE_OEMBED = "https://www.youtube.com/oembed"
BILIBILI_VIEW = "https://api.bilibili.com/x/web-interface/view"
#: The only URLs a lookup may request, matched as prefixes.
ALLOWED_PREFIXES = (YOUTUBE_OEMBED + "?", BILIBILI_VIEW + "?")

_BVID_RE = re.compile(r"/video/(BV[0-9A-Za-z]{10})(?:/|$)")
_USER_AGENT = "Mozilla/5.0 (compatible; MoodMusic link check)"

#: How much of the agent's title must appear in the found title (see :func:`title_matches`).
MATCH_SHARE = 0.5

#: ``fetch(url)`` -> the parsed JSON object, or ``None`` when the host said no.
Fetch = Callable[[str], Awaitable[Any]]


# ── matching ──


def _norm(text: str) -> str:
    return unicodedata.normalize("NFKC", text or "").casefold()


def _tokens(text: str) -> list[str]:
    """Words for Latin-like scripts, single characters for CJK and other scripts without spaces."""
    out: list[str] = []
    for word in re.findall(r"\w+", _norm(text)):
        if word.isascii():
            out.append(word)
        else:
            out.extend(word)
    return out


def title_matches(title: str, found_title: str, found_author: str = "") -> bool:
    """Whether at least :data:`MATCH_SHARE` of *title*'s tokens appear in what the host returned.

    A video title usually carries more than the song ("Artist - Song (Official
    MV)"), and a Chinese title may be in traditional characters where the agent
    wrote simplified ones (``苏州河`` / ``蘇州河``), so this asks for a share of
    the tokens, not an exact match. A video with an unrelated title shares
    almost none.
    """
    want = _tokens(title)
    if not want:
        return False
    have = set(_tokens(found_title)) | set(_tokens(found_author))
    hits = sum(1 for tok in want if tok in have)
    return hits / len(want) >= MATCH_SHARE


def song_key(title: str, artist: str = "") -> tuple[str, str]:
    """The (title, artist) pair a song is remembered by, with spacing and punctuation gone."""
    squash = lambda s: "".join(re.findall(r"\w+", _norm(s)))  # noqa: E731
    return squash(title), squash(artist)


def same_song(a: tuple[str, str], b: tuple[str, str]) -> bool:
    """Same title, and the same artist when both name one."""
    return bool(a[0]) and a[0] == b[0] and (not a[1] or not b[1] or a[1] == b[1])


# ── lookups ──


def lookup_url(pick: dict[str, Any]) -> str | None:
    """The one URL that checks *pick*, or ``None`` when it cannot be checked."""
    if pick.get("source") == "youtube":
        watch = f"https://www.youtube.com/watch?v={pick['video_id']}"
        return f"{YOUTUBE_OEMBED}?url={quote(watch, safe='')}&format=json"
    if pick.get("source") == "bilibili":
        parts = urlsplit(pick.get("url") or "")
        if parts.hostname not in ("www.bilibili.com", "m.bilibili.com"):
            return None
        match = _BVID_RE.search(parts.path)
        return f"{BILIBILI_VIEW}?bvid={match.group(1)}" if match else None
    return None


def _found(pick: dict[str, Any], answer: Any) -> tuple[str, str] | None:
    """The (title, author) the host returned for *pick*, or ``None`` for a refusal."""
    if not isinstance(answer, dict):
        return None
    if pick["source"] == "youtube":
        title = answer.get("title")
        return (title, str(answer.get("author_name") or "")) if isinstance(title, str) else None
    if answer.get("code") != 0 or not isinstance(answer.get("data"), dict):
        return None
    data = answer["data"]
    owner = data.get("owner") if isinstance(data.get("owner"), dict) else {}
    title = data.get("title")
    return (title, str(owner.get("name") or "")) if isinstance(title, str) else None


async def _check(pick: dict[str, Any], fetch: Fetch, gate: asyncio.Semaphore) -> str:
    """``""`` when *pick* is real and its title matches, else why it was dropped."""
    url = lookup_url(pick)
    if url is None:
        return "unverifiable"
    async with gate:
        try:
            answer = await asyncio.wait_for(fetch(url), TIMEOUT)
        except asyncio.TimeoutError:
            return "timeout"
        except Exception:  # a network error is "not found", never a pass
            return "lookup_failed"
    found = _found(pick, answer)
    if found is None:
        return "not_found"
    if not title_matches(pick.get("title", ""), *found):
        return "title_mismatch"
    return ""


async def verify_picks(
    picks: list[dict[str, Any]],
    fetch: Fetch,
    *,
    known: Iterable[tuple[str, str]] = (),
    skipped: Iterable[tuple[str, str]] = (),
    recent_anchors: Iterable[tuple[str, str]] = (),
) -> tuple[list[dict[str, Any]], dict[str, int]]:
    """The picks that passed, in order, and a count of the others by reason.

    *known* songs may not be ``explore`` / ``deep``; *skipped* songs may not come
    back at all; *recent_anchors* were an anchor in the last 30 days and may not
    be one again.
    """
    known, skipped, recent_anchors = list(known), list(skipped), list(recent_anchors)
    reasons: list[str] = []
    to_check: list[int] = []
    for i, pick in enumerate(picks):
        key = song_key(pick.get("title", ""), pick.get("artist", ""))
        tier = pick.get("tier")
        if any(same_song(key, k) for k in skipped):
            reasons.append("skipped")
        elif tier in ("explore", "deep") and any(same_song(key, k) for k in known):
            reasons.append("known")
        elif tier == "anchor" and any(same_song(key, k) for k in recent_anchors):
            reasons.append("recent_anchor")
        else:
            reasons.append("")
            to_check.append(i)
    gate = asyncio.Semaphore(CONCURRENCY)
    results = await asyncio.gather(*(_check(picks[i], fetch, gate) for i in to_check))
    for i, reason in zip(to_check, results):
        reasons[i] = reason
    kept = [p for p, r in zip(picks, reasons) if not r]
    dropped: dict[str, int] = {}
    for reason in reasons:
        if reason:
            dropped[reason] = dropped.get(reason, 0) + 1
    # One line per check, so the made-up-link rate can be read back later.
    logger.info("mood music verify: kept %d of %d, dropped %s", len(kept), len(picks), dropped)
    return kept, dropped


@asynccontextmanager
async def http_fetch() -> AsyncIterator[Fetch]:
    """A :data:`Fetch` over one short-lived HTTP session: fixed hosts, no redirect, no cookie."""
    import aiohttp  # the gateway's own; imported here so matching stays importable alone

    session = aiohttp.ClientSession(
        timeout=aiohttp.ClientTimeout(total=TIMEOUT),
        cookie_jar=aiohttp.DummyCookieJar(),
        headers={"User-Agent": _USER_AGENT, "Accept": "application/json"},
    )

    async def fetch(url: str) -> Any:
        if not url.startswith(ALLOWED_PREFIXES):
            raise ValueError("not a lookup URL")
        async with session.get(url, allow_redirects=False) as resp:
            if resp.status != 200:
                return None
            body = await resp.content.read(MAX_BODY + 1)
        if len(body) > MAX_BODY:
            return None
        try:
            return json.loads(body)
        except ValueError:
            return None

    try:
        yield fetch
    finally:
        await session.close()
