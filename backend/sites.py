"""The sites the buddy may browse, read by the backend for a play with the page closed.

Kiro Crew keeps the app's browsing list: the declared ``permissions.browserSites``
plus the sites the owner added in the Sites tab, minus the ones turned off or
removed (KiroCrew#40727, App Kit level 13). The page reads it through the host's
``useBrowserSites``; here the backend reads the same list with the app's own token,
``GET /api/apps/mood-music/browser-sites`` (``permissions.api`` already covers
``/api/apps/mood-music/*``), so the play request it builds names the same pages.

READ ONLY. Nothing in this app changes the list from the backend: Kiro Crew refuses
the app token on the ``POST`` (``app_token_forbidden``), and only the owner's
dashboard may edit it. Any failure answers ``None``, and the request then names no
pages, exactly as on an older Kiro Crew.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any
from urllib.parse import urlsplit

import aiohttp

from ._host import sdk_level

logger = logging.getLogger(__name__)

#: The level that brought the list and its route.
SITES_SDK_LEVEL = 13
SITES_PATH = "/api/apps/mood-music/browser-sites"
TIMEOUT_S = 5.0


async def active_sites(ctx: Any) -> list[str] | None:
    """The sites in force now, or ``None`` when Kiro Crew cannot say."""
    token_of = getattr(ctx, "app_token", None)
    origin_of = getattr(ctx, "gateway_origin", None)
    if sdk_level(ctx) < SITES_SDK_LEVEL or not callable(token_of) or not callable(origin_of):
        return None
    try:
        origin = origin_of()
        token = await token_of()
        if not isinstance(origin, str) or not origin or not isinstance(token, str) or not token:
            return None
        cookies = {f"mc_token_{urlsplit(origin).port}": token}
        async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=TIMEOUT_S)) as http:
            async with http.get(origin + SITES_PATH, cookies=cookies) as resp:
                if resp.status != 200:
                    return None
                body = await resp.json()
    except (aiohttp.ClientError, asyncio.TimeoutError, OSError, ValueError) as exc:
        logger.info("mood-music: the site list could not be read: %s", exc)
        return None
    active = body.get("active") if isinstance(body, dict) else None
    if not isinstance(active, list):
        return None
    return [s for s in active if isinstance(s, str)]
