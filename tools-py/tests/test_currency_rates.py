"""currency_rates tests — HTTP mocked; validates input handling + mapping."""

import io
import json
from unittest.mock import patch

from handlers.currency_rates import handler


class FakeResponse(io.BytesIO):
    status = 200

    def __init__(self, payload: dict):
        super().__init__(json.dumps(payload).encode())

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False


def test_fetches_latest_rates_with_defaults():
    payload = {"base": "AUD", "date": "2026-08-29", "rates": {"USD": 0.66, "EUR": 0.61}}
    with patch("handlers.currency_rates.urllib.request.urlopen") as urlopen:
        urlopen.return_value = FakeResponse(payload)
        result = handler({}, None)
        url = urlopen.call_args[0][0].full_url

    assert result["success"] is True
    assert result["via"] == "frankfurter"
    assert result["data"]["rates"] == {"USD": 0.66, "EUR": 0.61}
    assert "frankfurter.dev/v1/latest" in url
    assert "base=AUD" in url and "USD,EUR,GBP,CNY" in url


def test_supports_historical_dates_and_custom_base():
    payload = {"base": "USD", "date": "2026-01-02", "rates": {"AUD": 1.5}}
    with patch("handlers.currency_rates.urllib.request.urlopen") as urlopen:
        urlopen.return_value = FakeResponse(payload)
        result = handler({"base": "usd", "symbols": ["aud"], "date": "2026-01-02"}, None)
        url = urlopen.call_args[0][0].full_url

    assert result["success"] is True
    assert "/v1/2026-01-02?base=USD&symbols=AUD" in url


def test_invalid_input_surfaces_as_structured_error():
    result = handler({"base": "AUSD"}, None)
    assert result["success"] is False
    assert "3-letter currency code" in result["error"]

    result = handler({"date": "yesterday"}, None)
    assert result["success"] is False
    assert "YYYY-MM-DD" in result["error"]
