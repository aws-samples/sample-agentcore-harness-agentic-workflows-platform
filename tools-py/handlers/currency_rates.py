"""currency_rates — reference Python gateway tool (docs/python-developers.md).

Exchange rates from the ECB via the keyless Frankfurter API
(https://frankfurter.dev): latest or dated reference rates for a base
currency. Useful for grounding export-market pricing analysis (AUD vs
USD/EUR/GBP/CNY) without an API key — which also makes it the live
demonstration that a Python tool runs through the gateway end to end.

Discipline: standard library only — no bundling step needed
(lambda.Code.fromAsset on this directory, done).
"""

from __future__ import annotations

import json
import re
import urllib.request

from agentic_tools import tool_handler

BASE_URL = "https://api.frankfurter.dev/v1"
CURRENCY = re.compile(r"^[A-Za-z]{3}$")
DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
TIMEOUT_SECONDS = 10


def currency_rates(event: dict) -> dict:
    base = str(event.get("base") or "AUD").upper()
    if not CURRENCY.match(base):
        raise ValueError(f'currency_rates: "base" must be a 3-letter currency code (got "{base}")')

    symbols = event.get("symbols") or ["USD", "EUR", "GBP", "CNY"]
    if not isinstance(symbols, list) or not all(
        isinstance(s, str) and CURRENCY.match(s) for s in symbols
    ):
        raise ValueError('currency_rates: "symbols" must be a list of 3-letter currency codes')

    date = str(event.get("date") or "latest")
    if date != "latest" and not DATE.match(date):
        raise ValueError('currency_rates: "date" must be "latest" or YYYY-MM-DD')

    url = f"{BASE_URL}/{date}?base={base}&symbols={','.join(s.upper() for s in symbols)}"
    request = urllib.request.Request(
        url,
        headers={
            "Accept": "application/json",
            # frankfurter.dev's CDN blocks the default python-urllib UA (403).
            "User-Agent": "agentic-platform-tools/0.1",
        },
    )
    with urllib.request.urlopen(request, timeout=TIMEOUT_SECONDS) as response:
        if response.status != 200:
            raise RuntimeError(f"Frankfurter API error: HTTP {response.status}")
        payload = json.loads(response.read().decode("utf-8"))

    return {
        "base": payload.get("base", base),
        "date": payload.get("date"),
        "rates": payload.get("rates", {}),
        "source": "European Central Bank reference rates via frankfurter.dev",
    }


handler = tool_handler("currency_rates", via="frankfurter")(currency_rates)
