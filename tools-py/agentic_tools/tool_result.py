"""tool_result — the Python twin of @agentic-platform/tools createToolHandler.

A gateway tool Lambda receives the tool's input arguments as the event and
the tool name via the Lambda client context, formatted
``<targetName>___<toolName>``. Results follow the platform's house contract:
errors are surfaced as structured content the agent can reason about, never
thrown at the gateway.

Usage (one Lambda per tool, D-25):

    from agentic_tools import tool_handler

    @tool_handler("currency_rates", via="frankfurter")
    def handler(event: dict) -> dict:
        ...return the tool's data (raise on failure)...

Discipline: standard library + boto3 only (both preinstalled in the Lambda
Python runtime). The moment a handler needs third-party packages it needs a
bundling step — keep executors dependency-free (docs/python-developers.md).
"""

from __future__ import annotations

import time
from typing import Any, Callable, Optional, TypedDict


class ToolResult(TypedDict, total=False):
    success: bool
    data: Any
    error: str
    via: str
    durationMs: int


def bare_tool_name(qualified: str) -> str:
    """Strip the ``targetName___`` prefix from a gateway tool name."""
    separator = qualified.rfind("___")
    return qualified[separator + 3 :] if separator >= 0 else qualified


def extract_tool_name(context: Any, fallback: Optional[str] = None) -> str:
    """Pull the invoked tool name from the Lambda client context.

    Falls back to ``fallback`` when no gateway context is present (direct
    invocations: tests, console) so handlers stay runnable everywhere.
    """
    custom: dict = {}
    client_context = getattr(context, "client_context", None)
    if client_context is not None:
        custom = getattr(client_context, "custom", None) or {}
    elif isinstance(context, dict):  # unit tests pass plain dicts
        custom = (context.get("client_context") or {}).get("custom") or {}
    for key in ("bedrockAgentCoreToolName", "bedrockagentcoreToolName", "toolName"):
        candidate = custom.get(key)
        if isinstance(candidate, str) and candidate:
            return bare_tool_name(candidate)
    if fallback:
        return fallback
    raise ValueError("Unable to determine tool name from gateway invocation context")


def tool_handler(
    tool_name: str,
    via: str | Callable[[Any], str] | None = None,
) -> Callable[[Callable[[dict], Any]], Callable[[Any, Any], ToolResult]]:
    """Wrap a single executor function in the platform ToolResult contract.

    The executor receives the raw event (the tool's input arguments) and
    returns the tool's data; raising surfaces the message as a structured
    error. A name check keeps target/handler wiring mistakes loud instead of
    silently running the wrong executor.
    """

    def decorator(executor: Callable[[dict], Any]) -> Callable[[Any, Any], ToolResult]:
        def handler(event: Any, context: Any = None) -> ToolResult:
            start = time.monotonic()

            def duration_ms() -> int:
                return int((time.monotonic() - start) * 1000)

            requested = extract_tool_name(context, fallback=tool_name)
            if requested != tool_name:
                return {
                    "success": False,
                    "data": None,
                    "error": f'this target serves only "{tool_name}" (invoked as "{requested}")',
                    "durationMs": duration_ms(),
                }
            try:
                data = executor(event or {})
                result: ToolResult = {
                    "success": True,
                    "data": data,
                    "durationMs": duration_ms(),
                }
                tag = via(data) if callable(via) else via
                if tag:
                    result["via"] = tag
                return result
            except Exception as error:  # noqa: BLE001 — contract: never throw at the gateway
                return {
                    "success": False,
                    "data": None,
                    "error": str(error),
                    "durationMs": duration_ms(),
                }

        handler.__wrapped__ = executor  # type: ignore[attr-defined]
        return handler

    return decorator
