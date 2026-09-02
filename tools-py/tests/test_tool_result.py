"""tool_result contract tests — mirrors packages/tools handler-factory tests."""

from agentic_tools import bare_tool_name, extract_tool_name, tool_handler


def gateway_context(target: str, tool: str) -> dict:
    return {"client_context": {"custom": {"bedrockAgentCoreToolName": f"{target}___{tool}"}}}


def test_bare_tool_name_strips_target_prefix():
    assert bare_tool_name("GatewayTarget123___currency_rates") == "currency_rates"
    assert bare_tool_name("currency_rates") == "currency_rates"


def test_extract_tool_name_falls_back_for_direct_invocations():
    assert extract_tool_name(None, fallback="currency_rates") == "currency_rates"


def test_handler_wraps_executor_in_the_house_shape():
    @tool_handler("echo", via="test")
    def handler(event):
        return {"echoed": event["value"]}

    result = handler({"value": 42}, gateway_context("Target1", "echo"))
    assert result["success"] is True
    assert result["data"] == {"echoed": 42}
    assert result["via"] == "test"
    assert result["durationMs"] >= 0


def test_handler_rejects_mismatched_tool_names_loudly():
    @tool_handler("echo")
    def handler(event):
        return "never"

    result = handler({}, gateway_context("Target1", "other_tool"))
    assert result["success"] is False
    assert 'serves only "echo"' in result["error"]


def test_errors_surface_as_structured_content_never_raise():
    @tool_handler("boom")
    def handler(event):
        raise RuntimeError("upstream API error: 429")

    result = handler({}, None)
    assert result["success"] is False
    assert "429" in result["error"]


def test_via_may_derive_from_data():
    @tool_handler("dyn", via=lambda data: data["source"])
    def handler(event):
        return {"source": "fallback-path"}

    assert handler({}, None)["via"] == "fallback-path"
