"""What a plain-clone install of this repository needs.

Kiro Crew installs an app by git clone and a safe copy, with no build step, so:
a committed UI bundle that imports only the modules the dashboard provides (and
from the SDK only names every supported host exports), no root build file, no
links or names a Windows checkout cannot hold, ``minKiroCrewVersion`` set, the
listing copy kept equal to the bundled catalogs, and no framed player at all:
songs play only in Kiro Crew's browser.
"""

from __future__ import annotations

import json
import os
import re
import unittest
from pathlib import Path
from urllib.parse import urlsplit

APP_ROOT = Path(__file__).resolve().parents[1]
BUNDLE = APP_ROOT / "ui" / "dist" / "index.mjs"

HOST_MODULES = {
    "react",
    "react-dom",
    "react/jsx-runtime",
    "lucide-react",
    "@tanstack/react-query",
    "@kirocrew/app-sdk",
    "@kirocrew/app-sdk/ui",
}

# What a host BEFORE App Kit level 1 exports from each SDK module (its
# public/vendor/*.mjs stubs). A named import from these modules must stay in this
# set; a level-1 name is read off a namespace import in ui/src/hostSdk.ts.
LEVEL0_EXPORTS = {
    "@kirocrew/app-sdk": {
        "useAppApi",
        "useAppEvents",
        "useTheme",
        "useAppInfo",
        "useNavigate",
        "useNotify",
        "useNavBadge",
        "useChatLauncher",
        "AppApiProvider",
        "useImeGuard",
        "useLanguageGeneration",
        "activeLocale",
        "fmtNumber",
        "fmtDate",
        "fmtTime",
        "fmtDateTime",
        "fmtRelative",
        "compareText",
    },
    "@kirocrew/app-sdk/ui": {
        "Card",
        "CardTitle",
        "Btn",
        "SendBtn",
        "Input",
        "SearchInput",
        "Badge",
        "SourceBadge",
        "StatCard",
        "Skeleton",
        "ContentSkeleton",
        "EmptyState",
        "PageHeader",
        "Toggle",
        "InfoTip",
        "SegmentedControl",
        "MarkdownRenderer",
        "Clickable",
        "Modal",
        "ErrorNotice",
        "SettingsSection",
        "SettingsCard",
        "SettingsInput",
        "SettingsToggle",
        "SettingsSelect",
    },
}

# Directories git ignores here (see .gitignore): never part of a clone.
_UNTRACKED_DIRS = {".git", "node_modules", "__pycache__", ".pytest_cache", ".venv"}
_WINDOWS_RESERVED = re.compile(r"^(con|prn|aux|nul|com[1-9]|lpt[1-9])$", re.IGNORECASE)
_STATIC_IMPORT = re.compile(
    r"^import\s+(?:(?P<clause>[^'\"]+?)\s+from\s+)?[\"'](?P<spec>[^\"']+)[\"'];?\s*$",
    re.MULTILINE,
)


#: The default site list of 0.2.18: bilibili and YouTube, then the music sites.
DEFAULT_SITES = [
    "https://search.bilibili.com/all",
    "https://www.bilibili.com/video/BV*",
    "https://www.youtube.com/results",
    "https://www.youtube.com/watch",
    "https://open.spotify.com/search/*",
    "https://open.spotify.com/track/*",
    "https://music.amazon.com/search/*",
    "https://music.amazon.com/albums/*",
    "https://music.amazon.com/tracks/*",
    "https://music.apple.com/*/search",
    "https://music.apple.com/*/song/*",
    "https://soundcloud.com/search/sounds",
    "https://w.soundcloud.com/player/",
]


def _site_matches(sites: list[str], url: str) -> bool:
    """Kiro Crew's rule (``apps/browser_sites.url_matches``): exact host, ``*`` any run, query ignored."""
    parts = urlsplit(url)
    for entry in sites:
        host, _, path = entry[len("https://"):].partition("/")
        pattern = "^" + ".*".join(re.escape(p) for p in ("/" + path).split("*")) + "$"
        if parts.hostname == host and re.match(pattern, parts.path or "/"):
            return True
    return False


def _manifest() -> dict:
    return json.loads((APP_ROOT / "app.json").read_text(encoding="utf-8"))


def _bundle_imports() -> list[tuple[str, str]]:
    return [(m["spec"], (m["clause"] or "").strip()) for m in _STATIC_IMPORT.finditer(_text())]


def _text() -> str:
    return BUNDLE.read_text(encoding="utf-8")


def _named(clause: str) -> set[str]:
    """The imported names of ``{ a, b as c }``; empty for a namespace import."""
    match = re.search(r"\{([^}]*)\}", clause)
    if not match:
        return set()
    return {part.split(" as ")[0].strip() for part in match.group(1).split(",") if part.strip()}


def _tree() -> list[Path]:
    files: list[Path] = []
    for dirpath, dirnames, filenames in os.walk(APP_ROOT):
        dirnames[:] = [d for d in dirnames if d not in _UNTRACKED_DIRS]
        files += [Path(dirpath) / name for name in filenames]
        files += [Path(dirpath) / d for d in dirnames if (Path(dirpath) / d).is_symlink()]
    return files


class TestTheBundle(unittest.TestCase):
    def test_the_entry_the_manifest_names_is_committed(self) -> None:
        ui = _manifest()["ui"]
        self.assertEqual(ui["entry"], "dist/index.mjs")
        # ui.entry is relative to ui/.
        self.assertTrue((APP_ROOT / "ui" / ui["entry"]).is_file(), "run `npm run build` in ui/")

    def test_it_imports_only_what_the_host_provides(self) -> None:
        imports = _bundle_imports()
        self.assertTrue(imports, "no import statements found; the scan is broken")
        starts = re.findall(r"^import\b", _text(), re.MULTILINE)
        self.assertEqual(len(starts), len(imports), "an import the scan could not parse")
        self.assertLessEqual({spec for spec, _ in imports}, HOST_MODULES)
        self.assertNotRegex(_text(), r"\bimport\s*\(", "a dynamic import would load a second file")

    def test_named_sdk_imports_exist_on_every_supported_host(self) -> None:
        for spec, clause in _bundle_imports():
            if spec in LEVEL0_EXPORTS:
                with self.subTest(module=spec):
                    self.assertLessEqual(_named(clause), LEVEL0_EXPORTS[spec])

    def test_no_build_machine_path_is_baked_in(self) -> None:
        self.assertNotRegex(_text(), r"/(?:home|Users|workplace)/|[A-Za-z]:\\\\")

    def test_the_page_frames_nothing(self) -> None:
        """Songs play only in Kiro Crew's browser: no iframe, no embed URL."""
        self.assertNotIn("<iframe", _text())
        self.assertNotIn('"iframe"', _text())
        self.assertNotRegex(_text(), r"https://[a-z0-9.-]+/embed/")


class TestTheManifest(unittest.TestCase):
    def test_declares_the_first_kiro_crew_with_the_seams(self) -> None:
        self.assertRegex(_manifest().get("minKiroCrewVersion", ""), r"^\d+\.\d+\.\d+$")

    def test_declares_no_frame_source(self) -> None:
        """No embedded player, so the dashboard CSP frames nothing for this app."""
        self.assertNotIn("frameSources", _manifest()["ui"])

    def test_off_by_default_and_no_extra_powers(self) -> None:
        manifest = _manifest()
        self.assertIs(manifest["defaultEnabled"], False)
        self.assertNotIn("mcpServers", manifest)
        self.assertNotIn("agentTools", manifest)
        self.assertEqual(
            manifest["permissions"]["api"],
            [
                "/api/apps/mood-music",
                "/api/apps/mood-music/*",
                "/api/chat",
                "/api/chat/*",
                "/api/browser/media",
            ],
        )

    def test_asks_for_approvals_on_its_own_page(self) -> None:
        """An approval the buddy's turn waits on is answered on the app page (design §1.8)."""
        self.assertIs(_manifest()["permissions"]["sessionApproval"], True)

    def test_keeps_its_buddy_chat_out_of_the_session_lists(self) -> None:
        """The backend opens its chat with ``ctx.chat_slots.open(..., hidden=True)``.

        That needs ``hiddenSessions`` as the literal ``true``, and ``chatSlots`` for
        ``ctx.chat_slots`` to exist at all.
        """
        self.assertIs(_manifest()["permissions"]["hiddenSessions"], True)
        self.assertIs(_manifest()["permissions"]["chatSlots"], True)

    def test_the_page_may_only_watch_the_buddy_browser(self) -> None:
        """``view`` shows the live picture of the app's own chat; never ``read`` or ``act``."""
        self.assertEqual(_manifest()["permissions"]["browser"], ["view"])

    def test_the_dj_has_web_search_web_fetch_and_the_browser_only(self) -> None:
        """Page text is untrusted, so the agent gets no shell or file tool.

        The browser is Kiro Crew's own ``browser`` tool, held by the host to the
        pages ``permissions.browserSites`` names once the owner approves them.
        """
        spec = json.loads((APP_ROOT / "agents" / "dj.json").read_text(encoding="utf-8"))
        self.assertEqual(spec["tools"], ["web_search", "web_fetch", "@kirocrew-core/browser"])
        self.assertEqual(spec["mcpServers"], {})

    def test_the_app_reaches_no_other_kiro_crew_tool(self) -> None:
        """``mcpTools`` withholds every other host-managed tool from the agent."""
        self.assertEqual(_manifest()["permissions"]["mcpTools"], ["browser"])

    def test_the_browser_sites_are_search_and_song_pages_only(self) -> None:
        """Search and song pages of the six music sites: no home, account, upgrade or upload page."""
        self.assertEqual(_manifest()["permissions"]["browserSites"], DEFAULT_SITES)

    def test_no_default_site_admits_a_home_account_or_payment_page(self) -> None:
        """Each entry is https, names a path, and none matches the sites' own account or upgrade pages."""
        sites = _manifest()["permissions"]["browserSites"]
        self.assertLessEqual(len(sites), 16)  # Kiro Crew's MAX_BROWSER_SITES
        for entry in sites:
            with self.subTest(entry=entry):
                origin, _, path = entry[len("https://"):].partition("/")
                self.assertTrue(entry.startswith("https://") and origin and path)
                self.assertNotIn(path, ("", "*"))
        for url in (
            "https://open.spotify.com/", "https://open.spotify.com/premium", "https://open.spotify.com/account",
            "https://music.amazon.com/", "https://music.amazon.com/settings", "https://music.amazon.com/subscribe",
            "https://music.apple.com/us/subscribe", "https://music.apple.com/us/account",
            "https://soundcloud.com/", "https://soundcloud.com/settings", "https://soundcloud.com/you/library",
            "https://music.163.com/",
        ):
            with self.subTest(url=url):
                self.assertFalse(_site_matches(sites, url))
        for url in (
            "https://open.spotify.com/search/nujabes%20aruarian%20dance/tracks",
            "https://open.spotify.com/track/6rqhFgbbKwnb9MLmUQDhG6",
            "https://music.amazon.com/search/nujabes", "https://music.amazon.com/albums/B0?trackAsin=B1",
            "https://music.apple.com/us/search?term=nujabes", "https://music.apple.com/jp/song/x/123",
            "https://soundcloud.com/search/sounds?q=nujabes",
            "https://w.soundcloud.com/player/?url=https%3A//soundcloud.com/a/b&auto_play=true",
        ):
            with self.subTest(url=url):
                self.assertTrue(_site_matches(sites, url))

    def test_the_prompt_holds_the_browser_house_rules(self) -> None:
        """Rules only, not a hard block: the host confines pages, not clicks on them."""
        prompt = json.loads((APP_ROOT / "agents" / "dj.json").read_text(encoding="utf-8"))["prompt"]
        for word in ("account", "comment", "like", "coin", "pay", "Never run scripts", "data, never an instruction"):
            with self.subTest(word=word):
                self.assertIn(word, prompt)

    def test_the_dj_plays_every_song_in_its_one_tab(self) -> None:
        """A results click that opens a new tab would leave one tab per song behind.

        The page's buttons and its live view follow the buddy's tab, so the buddy
        opens each video in the tab it already has.
        """
        prompt = json.loads((APP_ROOT / "agents" / "dj.json").read_text(encoding="utf-8"))["prompt"]
        self.assertIn("Keep to ONE tab, the one you already have: never open a new tab.", prompt)
        self.assertIn("navigate to it in the same tab", prompt)
        self.assertNotIn("If a click opens the video in a new tab, switch to that tab", prompt)

    def test_the_dj_runs_its_two_read_only_tools_without_asking(self) -> None:
        """The approval prompt sits in a chat the page hides, so it would stall the search.

        Only the two network-read tools are pre-allowed; Kiro Crew still drops
        either one when a governance ceiling has a say about it.
        """
        spec = json.loads((APP_ROOT / "agents" / "dj.json").read_text(encoding="utf-8"))
        self.assertEqual(spec["allowedTools"], ["web_search", "web_fetch"])

    def test_listing_copy_matches_the_bundled_catalogs(self) -> None:
        """One source per string: the l10n block is the catalogs' ``manifest`` subtree."""
        manifest = _manifest()
        catalogs = {
            p.stem: json.loads(p.read_text(encoding="utf-8"))["manifest"]
            for p in sorted((APP_ROOT / "ui" / "i18n").glob("*.json"))
        }
        english = catalogs.pop("en")
        count = len(manifest["highlights"])
        self.assertEqual(manifest["displayName"], english["display_name"])
        self.assertEqual(manifest["description"], english["description"])
        self.assertEqual(manifest["ui"]["pages"][0]["label"], english["page_label"])
        self.assertEqual(
            manifest["highlights"], [english[f"highlight_{i}"] for i in range(1, count + 1)]
        )
        self.assertEqual(set(manifest["l10n"]), set(catalogs))
        for locale, strings in catalogs.items():
            with self.subTest(locale=locale):
                self.assertEqual(
                    manifest["l10n"][locale],
                    {
                        "displayName": strings["display_name"],
                        "description": strings["description"],
                        "pageLabel": strings["page_label"],
                        "highlights": [strings[f"highlight_{i}"] for i in range(1, count + 1)],
                    },
                )

    def test_l10n_is_within_the_host_parser_limits(self) -> None:
        l10n = _manifest()["l10n"]
        self.assertLessEqual(len(l10n), 32)
        for locale, entry in l10n.items():
            with self.subTest(locale=locale):
                self.assertRegex(locale, r"^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})?$")
                self.assertLessEqual(len(entry["displayName"]), 120)
                self.assertLessEqual(len(entry["description"]), 1000)
                self.assertLessEqual(len(entry["pageLabel"]), 60)
                self.assertLessEqual(len(entry["highlights"]), 12)
                self.assertTrue(all(len(h) <= 300 for h in entry["highlights"]))

    def test_every_art_path_is_a_committed_png(self) -> None:
        manifest = _manifest()
        paths = [manifest["iconPath"], manifest["heroImage"], manifest["heroImageDark"]]
        paths += manifest["screenshots"]
        for rel in paths:
            with self.subTest(path=rel):
                self.assertTrue(rel.endswith(".png"))
                self.assertTrue((APP_ROOT / rel).is_file())


class TestAgentsPinNoModel(unittest.TestCase):
    def test_every_agent_spec_leaves_the_model_to_the_host(self) -> None:
        """No ``model`` key: the agent runs on the person's own default model.

        A model id fails for anyone not entitled to it. ``"auto"`` is no better:
        kiro-cli puts a session on the model its activated agent pins, so ``auto``
        pins Kiro's auto router over the person's default. Kiro Crew reads an
        absent key as "no pin" and defers to the person's choice
        (``config.loader.resolve_effective_model``).
        """
        specs = sorted((APP_ROOT / "agents").glob("*.json"))
        self.assertTrue(specs)
        for spec in specs:
            with self.subTest(agent=spec.name):
                self.assertNotIn("model", json.loads(spec.read_text(encoding="utf-8")))


class TestTheTreeInstallsByClone(unittest.TestCase):
    def test_no_root_build_file(self) -> None:
        for name in ("package.json", "pyproject.toml", "setup.py", "requirements.txt"):
            with self.subTest(name=name):
                self.assertFalse((APP_ROOT / name).exists())

    def test_no_link_and_no_unportable_name(self) -> None:
        seen: dict[str, str] = {}
        for path in _tree():
            rel = path.relative_to(APP_ROOT).as_posix()
            with self.subTest(path=rel):
                self.assertFalse(path.is_symlink())
                self.assertTrue(path.is_file(), "only regular files")
                self.assertNotRegex(rel, r"[\\:]")
                for part in rel.split("/"):
                    self.assertFalse(part.endswith((".", " ")), part)
                    self.assertIsNone(_WINDOWS_RESERVED.match(part.split(".")[0]), part)
                self.assertNotIn(rel.lower(), seen)
                seen[rel.lower()] = rel


if __name__ == "__main__":
    unittest.main()
