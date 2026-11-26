"""Check the DJ's picks against YouTube and bilibili before the page shows them.

The agent is told to use only links it found, but that is a request, not a
guarantee (design §0.5). So every pick is looked up again here:

* YouTube: ``https://www.youtube.com/oembed?url=<watch URL>&format=json``.
* bilibili: ``https://api.bilibili.com/x/web-interface/view?bvid=<BV id>``.

Three outcomes:

* **Gone**: the host says the video does not exist or cannot be played (oEmbed
  400 / 401 / 404; bilibili HTTP 404 or a ``code`` in :data:`BILIBILI_GONE`), or
  it answers with a title that does not match. The pick is dropped.
* **Confirmed**: the host answers and the title matches. The pick is kept.
* **No link**: the pick names only its site; the buddy finds it there by
  searching in Kiro Crew's browser when it is played. Nothing is looked up and
  the pick is kept.
* **Unchecked**: the lookup could not say either way (rate limit, HTTP 412,
  another status, a timeout, a network error, a body that is not the answer,
  a ``b23.tv`` short link with no BV id to look up). The pick is kept and
  marked ``unverified``, so the page labels it. Its link already passed the
  exact-host checks in ``links.py``; those still apply to every pick.

Only those two fixed URLs are ever requested, built here from an id that was
already checked (``links.py``). No redirect is followed, no cookie is sent or
kept, the body read is capped, and every lookup has a deadline.

A pick whose song the person already knows or skipped is dropped too (design
§0.6): a skipped song never comes back, and a known song is never an
``explore`` or ``deep`` pick. A song played or queued lately never comes back
in any tier (0.2.20): that is the check, not only the request's words.
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

#: oEmbed statuses that say the video does not exist or may not be embedded.
YOUTUBE_GONE = frozenset({400, 401, 404})
#: bilibili view ``code`` values that say the video does not exist or is not visible.
BILIBILI_GONE = frozenset({-400, -404, 62002, 62004, 62012})

#: ``fetch(url)`` -> ``(HTTP status, parsed JSON or None)``.
Fetch = Callable[[str], Awaitable[tuple[int, Any]]]


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


#: A bracketed part of a title: a version note ("(Live)", "[Official MV]", "【中字】").
#: NFKC has already turned full-width brackets into ASCII ones.
_BRACKET_RE = re.compile(r"\([^()]*\)|\[[^\[\]]*\]|【[^【】]*】")
#: A featured artist and all after it: "Song feat. B", "A ft. B", "A featuring B".
_FEAT_RE = re.compile(r"(?:^|\s)(?:feat\.?|ft\.|featuring)\s.*$")


def _squash(text: str) -> str:
    return "".join(re.findall(r"\w+", text))


def _core(text: str) -> str:
    """*text* folded, without its featured artists and bracketed notes, when anything is left."""
    folded = _FEAT_RE.sub("", _norm(text))
    bare = _squash(_BRACKET_RE.sub(" ", folded))
    return bare or _squash(folded) or _squash(_norm(text))


def song_key(title: str, artist: str = "") -> tuple[str, str]:
    """The (title, artist) pair a song is remembered by.

    Case, width, spacing and punctuation are gone, and so are a featured artist
    and a bracketed note, so "Song (Live)", "SONG feat. B" and "Ｓｏｎｇ" are one song.
    """
    return _core(title), _core(artist)


def same_song(a: tuple[str, str], b: tuple[str, str]) -> bool:
    """Same title, and the same artist when both name one."""
    return bool(a[0]) and a[0] == b[0] and (not a[1] or not b[1] or a[1] == b[1])


def same_title(a: tuple[str, str], b: tuple[str, str]) -> bool:
    """Same title, whoever sings it: a recent song is matched on its title alone.

    The buddy writes one artist in more than one way ("周杰伦", "周杰倫", "Jay
    Chou"), so for a song heard minutes ago the title is the safer match. A
    different song with the same title is dropped too, and asked for again.
    """
    return bool(a[0]) and a[0] == b[0]


# ── lookups ──


def lookup_url(pick: dict[str, Any]) -> str | None:
    """The one URL that checks *pick*, or ``None`` when it cannot be checked."""
    if pick.get("source") == "youtube" and pick.get("video_id"):
        watch = f"https://www.youtube.com/watch?v={pick['video_id']}"
        return f"{YOUTUBE_OEMBED}?url={quote(watch, safe='')}&format=json"
    if pick.get("source") == "bilibili":
        parts = urlsplit(pick.get("url") or "")
        if parts.hostname not in ("www.bilibili.com", "m.bilibili.com"):
            return None
        match = _BVID_RE.search(parts.path)
        return f"{BILIBILI_VIEW}?bvid={match.group(1)}" if match else None
    return None


def _verdict(pick: dict[str, Any], status: int, answer: Any) -> str:
    """``"ok"``, ``"gone"``, ``"title_mismatch"`` or ``"unchecked"`` for one lookup's answer."""
    found: tuple[str, str] | None = None
    if pick["source"] == "youtube":
        if status in YOUTUBE_GONE:
            return "gone"
        if status == 200 and isinstance(answer, dict) and isinstance(answer.get("title"), str):
            found = (answer["title"], str(answer.get("author_name") or ""))
    else:
        if status == 404:
            return "gone"
        if status == 200 and isinstance(answer, dict):
            code = answer.get("code")
            if code in BILIBILI_GONE:
                return "gone"
            data = answer.get("data")
            if code == 0 and isinstance(data, dict) and isinstance(data.get("title"), str):
                owner = data.get("owner") if isinstance(data.get("owner"), dict) else {}
                found = (data["title"], str(owner.get("name") or ""))
    if found is None:
        return "unchecked"
    return "ok" if title_matches(pick.get("title", ""), *found) else "title_mismatch"


async def _check(pick: dict[str, Any], fetch: Fetch, gate: asyncio.Semaphore) -> str:
    """``"ok"``, a drop reason (``"not_found"``, ``"title_mismatch"``), or ``"unchecked:<why>"``."""
    if not pick.get("video_id") and not pick.get("url"):
        # No link to check: the buddy searches the site for it when it plays.
        return "ok"
    url = lookup_url(pick)
    if url is None:
        return "unchecked:no_lookup"
    async with gate:
        try:
            status, answer = await asyncio.wait_for(fetch(url), TIMEOUT)
        except asyncio.TimeoutError:
            return "unchecked:timeout"
        except Exception:  # a network error says nothing about the video
            return "unchecked:lookup_failed"
    verdict = _verdict(pick, status, answer)
    if verdict == "gone":
        return "not_found"
    if verdict == "unchecked":
        return f"unchecked:http_{status}"
    return verdict


async def verify_picks(
    picks: list[dict[str, Any]],
    fetch: Fetch,
    *,
    known: Iterable[tuple[str, str]] = (),
    skipped: Iterable[tuple[str, str]] = (),
    recent_anchors: Iterable[tuple[str, str]] = (),
    recent: Iterable[tuple[str, str]] = (),
    asked: str = "",
) -> tuple[list[dict[str, Any]], dict[str, int]]:
    """The picks kept, in order, and a count of the dropped ones by reason.

    A kept pick the host could not confirm carries ``unverified: True``.

    *known* songs may not be ``explore`` / ``deep``; *skipped* songs may not come
    back at all; *recent_anchors* were an anchor in the last 30 days and may not
    be one again. *recent* songs were played or queued lately
    (``MoodStore.avoid_lists``) and may not come back in any tier, matched on
    the title (:func:`same_title`). A song
    the person named in *asked*, their own words, is let through: they asked
    for it again.
    """
    known, skipped, recent_anchors = list(known), list(skipped), list(recent_anchors)
    recent = list(recent)
    wanted = _squash(_norm(asked))
    reasons: list[str] = []
    to_check: list[int] = []
    for i, pick in enumerate(picks):
        key = song_key(pick.get("title", ""), pick.get("artist", ""))
        tier = pick.get("tier")
        named = bool(wanted) and bool(key[0]) and key[0] in wanted
        if any(same_song(key, k) for k in skipped):
            reasons.append("skipped")
        elif not named and any(same_title(key, k) for k in recent):
            reasons.append("recent")
        elif tier in ("explore", "deep") and any(same_song(key, k) for k in known):
            reasons.append("known")
        elif tier == "anchor" and any(same_song(key, k) for k in recent_anchors):
            reasons.append("recent_anchor")
        else:
            reasons.append("ok")
            to_check.append(i)
    gate = asyncio.Semaphore(CONCURRENCY)
    results = await asyncio.gather(*(_check(picks[i], fetch, gate) for i in to_check))
    kept: list[dict[str, Any]] = []
    dropped: dict[str, int] = {}
    unchecked: dict[str, int] = {}
    for i, reason in zip(to_check, results):
        reasons[i] = reason
    for pick, reason in zip(picks, reasons):
        if reason == "ok":
            kept.append(pick)
        elif reason.startswith("unchecked:"):
            kept.append({**pick, "unverified": True})
            why = reason.split(":", 1)[1]
            unchecked[why] = unchecked.get(why, 0) + 1
        else:
            dropped[reason] = dropped.get(reason, 0) + 1
    # One line per check, so the made-up-link rate can be read back later.
    logger.info(
        "mood music verify: kept %d of %d, dropped %s, unverified %s",
        len(kept), len(picks), dropped, unchecked,
    )
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

    async def fetch(url: str) -> tuple[int, Any]:
        if not url.startswith(ALLOWED_PREFIXES):
            raise ValueError("not a lookup URL")
        async with session.get(url, allow_redirects=False) as resp:
            status = resp.status
            if status != 200:
                return status, None
            body = await resp.content.read(MAX_BODY + 1)
        if len(body) > MAX_BODY:
            return status, None
        try:
            return status, json.loads(body)
        except ValueError:
            return status, None

    try:
        yield fetch
    finally:
        await session.close()
