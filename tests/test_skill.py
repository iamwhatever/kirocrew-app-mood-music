"""The buddy's skill and prompt know every play site (0.2.18): how to search it, how
it plays, and that sign-in, upgrade and payment walls are a stop, never a click."""

from __future__ import annotations

import json
import re
from pathlib import Path

import pytest

from backend.store import PLAY_SITES

ROOT = Path(__file__).resolve().parents[1]
SKILL = (ROOT / "skills" / "mood-music" / "SKILL.md").read_text(encoding="utf-8")
PROMPT = json.loads((ROOT / "agents" / "dj.json").read_text(encoding="utf-8"))["prompt"]
SITES = json.loads((ROOT / "app.json").read_text(encoding="utf-8"))["permissions"]["browserSites"]

SEARCH = {
    "youtube": "https://www.youtube.com/results?search_query=",
    "bilibili": "https://search.bilibili.com/all?keyword=",
    "spotify": "https://open.spotify.com/search/",
    "amazon_music": "https://music.amazon.com/search/",
    "apple_music": "https://music.apple.com/us/search?term=",
    "soundcloud": "https://soundcloud.com/search/sounds?q=",
}


def _table_rows() -> dict[str, str]:
    table = SKILL[SKILL.index("### The sites, their default pages"):]
    table = table[: table.index("\n\n", table.index("|"))]
    rows = re.findall(r"^\| `([a-z_]+)` \|(.*)$", table, flags=re.M)
    return {source: rest for source, rest in rows if source != "source"}


def test_the_skill_table_has_one_row_per_play_site() -> None:
    assert set(_table_rows()) == set(PLAY_SITES) == set(SEARCH)


@pytest.mark.parametrize("source", sorted(SEARCH))
def test_each_site_row_and_the_prompt_name_its_search_page(source: str) -> None:
    assert SEARCH[source] in _table_rows()[source]
    assert SEARCH[source] in PROMPT


@pytest.mark.parametrize("source", sorted(SEARCH))
def test_each_search_page_is_on_the_default_list(source: str) -> None:
    url = SEARCH[source] + "nujabes"  # the page the buddy opens, with a query
    host, _, rest = url[len("https://"):].partition("/")
    path = "/" + rest.split("?")[0]
    assert any(
        e.startswith(f"https://{host}/")
        and re.fullmatch(".*".join(re.escape(p) for p in e[len(f"https://{host}"):].split("*")), path)
        for e in SITES
    ), source


def test_the_source_rule_lists_every_play_site() -> None:
    line = SKILL[SKILL.index("- `source` is"):].split("\n- ", 1)[0]
    for source in PLAY_SITES:
        assert f"`{source}`" in line


@pytest.mark.parametrize("source", ["spotify", "amazon_music", "apple_music"])
def test_the_sign_in_sites_say_they_need_sign_in_and_a_plan(source: str) -> None:
    row = _table_rows()[source].lower()
    assert "sign" in row and ("premium" in row or "unlimited" in row or "subscription" in row)


def test_soundcloud_plays_in_its_widget_not_the_results_page() -> None:
    row = _table_rows()["soundcloud"]
    assert "https://w.soundcloud.com/player/?url=" in row and "Do not press Play on the results" in row


@pytest.mark.parametrize("text", [SKILL, PROMPT], ids=["skill", "prompt"])
def test_a_paywall_is_a_stop_never_a_click(text: str) -> None:
    lowered = text.lower()
    for word in ("upgrade", "subscribe", "trial", "pay"):
        assert word in lowered, word
    assert "never click" in lowered and "never sign in" in lowered
    assert "protected content" in lowered


def test_netease_is_left_out_and_the_skill_says_why() -> None:
    assert not any("163.com" in e for e in SITES)
    assert "NetEase Cloud Music (`music.163.com`) is not on the list" in SKILL


def test_saved_steps_stay_per_site() -> None:
    assert "they are kept per `source`" in SKILL
