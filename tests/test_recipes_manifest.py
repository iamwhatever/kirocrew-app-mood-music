"""The app's browser recipes (0.2.21, KiroCrew#41783, App Kit level 15).

``permissions.browserRecipes`` holds fixed clicks Kiro Crew runs on the buddy's tab
with no model asked. These checks hold the manifest to Kiro Crew's own rules
(``kiro_crew/apps/browser_recipes.py`` on main: names, sites, steps, waits) and to
this app's own limit: only the player's play button and YouTube's "Skip ad", never
a sign-in, upgrade or payment target, and the names the page asks for are the ones
declared.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MANIFEST = json.loads((ROOT / "app.json").read_text(encoding="utf-8"))
PERMS = MANIFEST["permissions"]
RECIPES = PERMS["browserRecipes"]
PAGE = (ROOT / "ui" / "src" / "recipes.ts").read_text(encoding="utf-8")

NAME = re.compile(r"[a-z][a-z0-9_]{0,31}")
# Words no recipe target of this app may hold: it only plays and skips ads.
FORBIDDEN = re.compile(
    r"login|sign|pay|upgrade|premium|subscri|buy|trial|account"
    r"|input|textarea|comment|like|coin|follow",
    re.I,
)


def test_each_recipe_follows_kiro_crews_rules() -> None:
    assert 0 < len(RECIPES) <= 16
    names = [r["name"] for r in RECIPES]
    assert len(set(names)) == len(names)
    for r in RECIPES:
        assert set(r) <= {"name", "site", "steps", "watch"}, r
        assert NAME.fullmatch(r["name"]), r["name"]
        # A recipe runs only on a page that matches its site AND the app's sites.
        assert r["site"] in PERMS["browserSites"], r["site"]
        assert 1 <= len(r["steps"]) <= 8
        total = 0.0
        for step in r["steps"]:
            assert set(step) in ({"click"}, {"waitFor", "timeout"}), step
            selector = step.get("click") or step.get("waitFor")
            assert isinstance(selector, str) and 0 < len(selector) <= 200
            if "timeout" in step:
                assert 0 < step["timeout"] <= 10
                total += step["timeout"]
        assert total <= 15


def test_recipes_only_play_and_skip_ads() -> None:
    for r in RECIPES:
        for step in r["steps"]:
            selector = step.get("click") or step.get("waitFor")
            assert not FORBIDDEN.search(selector), (r["name"], selector)


def test_only_skip_ad_runs_by_itself() -> None:
    watch = [r for r in RECIPES if r.get("watch")]
    assert [r["name"] for r in watch] == ["youtube_skip_ad"]
    # A watch recipe runs when its first click's element shows.
    assert set(watch[0]["steps"][0]) == {"click"}
    assert "skip" in watch[0]["steps"][0]["click"]


def test_the_page_asks_for_declared_recipes() -> None:
    asked = set(re.findall(r"'([a-z][a-z0-9_]*_(?:play|skip_ad))'", PAGE))
    declared = {r["name"] for r in RECIPES}
    assert asked == declared, (asked, declared)
    for r in RECIPES:
        if r["name"].endswith("_play"):
            assert not r.get("watch")
            # A play recipe waits for the button, then presses it.
            assert [set(s) for s in r["steps"]] == [{"waitFor", "timeout"}, {"click"}]
            assert r["steps"][0]["waitFor"] == r["steps"][1]["click"]


def test_an_older_kiro_crew_still_installs_it() -> None:
    # Recipes are optional (the page feature-checks App Kit level 15), so the
    # minimum stays at the level the sites need.
    assert MANIFEST["minKiroCrewVersion"] == "0.14.0"
    assert "/api/browser/media" in PERMS["api"]
