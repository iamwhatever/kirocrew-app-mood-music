"""The link check: a pick reaches the page only when YouTube or bilibili confirms it.

No test opens a socket to either host. The lookups are a ``fetch`` the tests
hand in, and the one real fetcher is exercised against a fake aiohttp session,
so what it would send (URL, redirects, cookies) is pinned without the network.
"""

from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

import aiohttp
import pytest

from backend import verify
from backend.store import MoodStore

ID = "dQw4w9WgXcQ"
BV = "BV1xx411c7mD"


def _yt(title: str = "苏州河", **over: Any) -> dict[str, Any]:
    return {"title": title, "artist": "薛凯琪", "source": "youtube", "video_id": ID, **over}


def _bili(url: str = f"https://www.bilibili.com/video/{BV}", **over: Any) -> dict[str, Any]:
    return {"title": "苏州河", "artist": "薛凯琪", "source": "bilibili", "url": url, **over}


def _fetch(answers: dict[str, Any]):
    calls: list[str] = []

    async def fetch(url: str) -> Any:
        calls.append(url)
        for prefix, answer in answers.items():
            if url.startswith(prefix):
                if isinstance(answer, BaseException):
                    raise answer
                if answer == "slow":
                    await asyncio.sleep(5)
                return answer
        return None

    return fetch, calls


OEMBED_OK = {"title": "薛凱琪 Fiona Sit - 蘇州河 MV", "author_name": "Fiona Sit"}
BILI_OK = {"code": 0, "data": {"title": "薛凯琪《苏州河》现场", "owner": {"name": "someone"}}}


def _run(picks, fetch, **avoid):
    return asyncio.run(verify.verify_picks(picks, fetch, **avoid))


class TestTitleMatch:
    @pytest.mark.parametrize(
        ("title", "found", "author"),
        [
            ("苏州河", "薛凱琪 Fiona Sit - 蘇州河 MV", ""),  # traditional characters in the video title
            ("Love Song", "Sara Bareilles - Love Song (Official Video)", ""),
            ("Holocene", "Holocene", "Bon Iver"),
            ("Café", "café — live", ""),
        ],
    )
    def test_a_real_title_matches(self, title, found, author) -> None:
        assert verify.title_matches(title, found, author)

    @pytest.mark.parametrize(
        ("title", "found"),
        [
            ("苏州河", "Rick Astley - Never Gonna Give You Up"),
            ("Love Song", "Lofi beats to study to"),
            ("", "anything"),
        ],
    )
    def test_an_unrelated_title_does_not(self, title, found) -> None:
        assert not verify.title_matches(title, found)


class TestVerifyPicks:
    def test_a_confirmed_pick_is_kept_and_the_rest_are_counted(self) -> None:
        fetch, calls = _fetch({verify.YOUTUBE_OEMBED: OEMBED_OK, verify.BILIBILI_VIEW: BILI_OK})
        kept, dropped = _run([_yt(), _bili()], fetch)
        assert kept == [_yt(), _bili()] and dropped == {}
        assert calls[0] == (
            "https://www.youtube.com/oembed?url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3D"
            f"{ID}&format=json"
        )
        assert calls[1] == f"https://api.bilibili.com/x/web-interface/view?bvid={BV}"

    def test_a_missing_or_unembeddable_video_is_dropped(self) -> None:
        fetch, _ = _fetch({verify.YOUTUBE_OEMBED: None})
        assert _run([_yt()], fetch) == ([], {"not_found": 1})

    def test_a_title_that_does_not_match_the_video_is_dropped(self) -> None:
        fetch, _ = _fetch({verify.YOUTUBE_OEMBED: {"title": "Never Gonna Give You Up", "author_name": "Rick"}})
        assert _run([_yt()], fetch) == ([], {"title_mismatch": 1})

    def test_a_bilibili_video_that_404s_is_dropped(self) -> None:
        fetch, _ = _fetch({verify.BILIBILI_VIEW: {"code": -404, "message": "啥都木有"}})
        assert _run([_bili()], fetch) == ([], {"not_found": 1})

    def test_a_short_link_cannot_be_checked_so_it_is_dropped(self) -> None:
        fetch, calls = _fetch({})
        assert _run([_bili("https://b23.tv/abc123")], fetch) == ([], {"unverifiable": 1})
        assert calls == []

    def test_a_timeout_drops_the_pick_and_never_lets_it_through(self, monkeypatch) -> None:
        monkeypatch.setattr(verify, "TIMEOUT", 0.05)
        fetch, _ = _fetch({verify.YOUTUBE_OEMBED: "slow", verify.BILIBILI_VIEW: BILI_OK})
        kept, dropped = _run([_yt(), _bili()], fetch)
        assert kept == [_bili()] and dropped == {"timeout": 1}

    def test_a_network_error_drops_the_pick(self) -> None:
        fetch, _ = _fetch({verify.YOUTUBE_OEMBED: aiohttp.ClientConnectionError("down")})
        assert _run([_yt()], fetch) == ([], {"lookup_failed": 1})

    def test_known_songs_are_never_explore_and_skipped_songs_never_return(self) -> None:
        fetch, calls = _fetch({verify.YOUTUBE_OEMBED: OEMBED_OK})
        known = [verify.song_key("苏州河", "薛凯琪")]
        picks = [_yt(tier="explore"), _yt(tier="deep"), _yt(tier="anchor")]
        kept, dropped = _run(picks, fetch, known=known)
        assert kept == [_yt(tier="anchor")] and dropped == {"known": 2}
        assert len(calls) == 1  # a dropped pick is not looked up
        kept, dropped = _run([_yt(tier="anchor")], fetch, skipped=[verify.song_key("苏 州 河!", "")])
        assert kept == [] and dropped == {"skipped": 1}

    def test_an_anchor_shown_in_the_last_30_days_is_not_an_anchor_again(self) -> None:
        fetch, _ = _fetch({verify.YOUTUBE_OEMBED: OEMBED_OK})
        recent = [verify.song_key("苏州河", "薛凯琪")]
        assert _run([_yt(tier="anchor")], fetch, recent_anchors=recent) == ([], {"recent_anchor": 1})


class _FakeResponse:
    def __init__(self, status: int, body: bytes) -> None:
        self.status = status
        self.content = self
        self._body = body

    async def read(self, n: int) -> bytes:
        return self._body[:n]

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False


class _FakeSession:
    made: list[dict[str, Any]] = []
    gets: list[tuple[str, dict[str, Any]]] = []
    reply = (200, b'{"title": "x"}')

    def __init__(self, **kwargs: Any) -> None:
        _FakeSession.made.append(kwargs)

    def get(self, url: str, **kwargs: Any) -> _FakeResponse:
        _FakeSession.gets.append((url, kwargs))
        return _FakeResponse(*_FakeSession.reply)

    async def close(self) -> None:
        pass


class TestTheRealFetcher:
    @pytest.fixture(autouse=True)
    def fake_session(self, monkeypatch):
        _FakeSession.made, _FakeSession.gets = [], []
        _FakeSession.reply = (200, b'{"title": "x"}')
        monkeypatch.setattr(aiohttp, "ClientSession", _FakeSession)

    def _get(self, url: str) -> Any:
        async def go():
            async with verify.http_fetch() as fetch:
                return await fetch(url)

        return asyncio.run(go())

    def test_it_follows_no_redirect_keeps_no_cookie_and_has_a_deadline(self) -> None:
        url = verify.lookup_url(_yt())
        assert self._get(url) == {"title": "x"}
        (made,) = _FakeSession.made
        assert isinstance(made["cookie_jar"], aiohttp.DummyCookieJar)
        assert made["timeout"].total == verify.TIMEOUT
        assert _FakeSession.gets == [(url, {"allow_redirects": False})]

    @pytest.mark.parametrize(
        "url",
        [
            "https://evil.example/oembed?url=x",
            "https://www.youtube.com.evil.example/oembed?url=x",
            "http://www.youtube.com/oembed?url=x",
            "https://api.bilibili.com/x/other?bvid=x",
        ],
    )
    def test_it_requests_only_the_two_fixed_urls(self, url) -> None:
        with pytest.raises(ValueError):
            self._get(url)
        assert _FakeSession.gets == []

    @pytest.mark.parametrize(
        "reply", [(302, b"{}"), (401, b"{}"), (200, b"not json"), (200, b"{" + b" " * verify.MAX_BODY + b"}")]
    )
    def test_a_redirect_a_refusal_junk_or_a_huge_body_reads_as_not_found(self, reply) -> None:
        _FakeSession.reply = reply
        assert self._get(verify.lookup_url(_yt())) is None


def test_the_store_names_liked_songs_known_and_skipped_ones_skipped(tmp_path: Path) -> None:
    store = MoodStore(tmp_path / "state.json")
    queue = store.set_queue(
        [{"title": "A", "artist": "x", "source": "youtube", "video_id": ID, "tags": [], "why": ""},
         {"title": "B", "artist": "", "source": "youtube", "video_id": ID, "tags": [], "why": ""}],
        source="r",
    )
    store.set_feedback(queue[0]["id"], "liked")
    store.set_feedback(queue[1]["id"], "skipped")
    lists = store.avoid_lists()
    assert lists["known"] == [("a", "x")] and lists["skipped"] == [("b", "")]


@asynccontextmanager
async def _fake_http_fetch():
    async def fetch(url: str) -> Any:
        return OEMBED_OK if url.startswith(verify.YOUTUBE_OEMBED) else None

    yield fetch


def test_the_route_returns_the_kept_picks_and_the_drop_counts(tmp_path: Path, monkeypatch) -> None:
    from aiohttp.test_utils import TestClient, TestServer

    from tests.harness import PREFIX, build_app, identity, make_ctx

    monkeypatch.setattr(verify, "http_fetch", _fake_http_fetch)
    ctx = make_ctx(tmp_path)

    async def go():
        app = build_app(ctx, middlewares=[identity("owner-1", "")], owner_id="owner-1")
        async with TestClient(TestServer(app)) as client:
            body = {"picks": [{**_yt(), "url": f"https://youtu.be/{ID}"}, _bili()]}
            resp = await client.post(PREFIX + "/verify-picks", json=body)
            return resp.status, await resp.json()

    status, body = asyncio.run(go())
    assert status == 200
    assert [p["title"] for p in body["picks"]] == ["苏州河"]
    assert body["picks"][0]["video_id"] == ID
    assert body["dropped"] == {"not_found": 1}
    assert ctx.owner_checks == ["verify_picks"]
