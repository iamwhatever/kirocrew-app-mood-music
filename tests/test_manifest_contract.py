"""What a plain-clone install of this repository needs.

Kiro Crew installs an app by git clone and a safe copy, with no build step, so:
a committed UI bundle that imports only the modules the dashboard provides (and
from the SDK only names every supported host exports), no root build file, no
links or names a Windows checkout cannot hold, ``minKiroCrewVersion`` set, the
listing copy kept equal to the bundled catalogs, and the YouTube player framed
only on the one exact origin ``ui.frameSources`` declares.
"""

from __future__ import annotations

import json
import os
import re
import unittest
from pathlib import Path

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

    def test_the_player_frames_only_the_declared_origin(self) -> None:
        """The bundle builds embed URLs on exactly the origin ``ui.frameSources`` names."""
        (origin,) = _manifest()["ui"]["frameSources"]
        self.assertIn(f"{origin}/embed/", _text())
        framed = set(re.findall(r"https://[a-z0-9.-]+/embed/", _text()))
        self.assertEqual(framed, {f"{origin}/embed/"})


class TestTheManifest(unittest.TestCase):
    def test_declares_the_first_kiro_crew_with_the_seams(self) -> None:
        self.assertRegex(_manifest().get("minKiroCrewVersion", ""), r"^\d+\.\d+\.\d+$")

    def test_frame_sources_are_exact_https_origins(self) -> None:
        """No path, port, wildcard, user info or IP: one exact https origin per entry."""
        sources = _manifest()["ui"]["frameSources"]
        self.assertEqual(sources, ["https://www.youtube-nocookie.com"])
        for source in sources:
            with self.subTest(source=source):
                self.assertRegex(source, r"^https://[a-z0-9-]+(\.[a-z0-9-]+)+$")
                self.assertNotRegex(source, r"\d+\.\d+\.\d+\.\d+$")

    def test_off_by_default_and_no_extra_powers(self) -> None:
        manifest = _manifest()
        self.assertIs(manifest["defaultEnabled"], False)
        self.assertNotIn("mcpServers", manifest)
        self.assertNotIn("agentTools", manifest)
        self.assertEqual(
            manifest["permissions"]["api"],
            ["/api/apps/mood-music", "/api/apps/mood-music/*", "/api/chat", "/api/chat/*"],
        )

    def test_the_dj_has_only_web_search_and_web_fetch(self) -> None:
        """Page text is untrusted, so the agent gets no browser, shell or file tool."""
        spec = json.loads((APP_ROOT / "agents" / "dj.json").read_text(encoding="utf-8"))
        self.assertEqual(spec["tools"], ["web_search", "web_fetch"])
        self.assertEqual(spec["mcpServers"], {})

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
        """A hardcoded model id fails for anyone not entitled to it; only ``auto``."""
        specs = sorted((APP_ROOT / "agents").glob("*.json"))
        self.assertTrue(specs)
        for spec in specs:
            with self.subTest(agent=spec.name):
                self.assertEqual(json.loads(spec.read_text(encoding="utf-8"))["model"], "auto")


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
