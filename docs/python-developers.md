# For Python developers

The platform's internals are TypeScript, but the surfaces a workload team
edits are not. If your team builds agents in Python and frontends in React
(the common Bedrock Agents team shape), your day-to-day here is **YAML +
Python**, with React unchanged.

## Coming from Amazon Bedrock Agents

| Bedrock Agents concept | Platform equivalent | You write |
|---|---|---|
| Agent (instructions, model) | Harness agent entry in `workload.yaml` | ~15 lines of YAML |
| Action group + OpenAPI schema | Gateway tool: schema JSON + handler | One Python file + one JSON file |
| Action group Lambda (Python) | Gateway tool Lambda (Python) | Same skill — simpler event contract |
| Agent aliases / versions | Harness versions + endpoints | Nothing (platform-managed) |
| Orchestration (ReAct trace) | Planner → Step Functions plan interpreter | Nothing (platform-managed) |
| Knowledge bases | Not in v1 (roadmap) | — |

Three things get **smaller** than Bedrock Agents:

1. No OpenAPI wrangling — a tool's input schema is a small JSON file.
2. No event parsing — the Lambda event *is* the tool's input arguments.
3. No IAM authoring — the stack derives per-tool least-privilege from config.

## Adding an agent (YAML)

Agents live in the workload's `workload.yaml` (see `examples/marketing-workflow/`).
Append an entry:

```yaml
agents:
  - name: supply_chain_analysis          # [a-zA-Z][a-zA-Z0-9_]*, max 40
    description: Logistics and supply-chain signal analysis
    model: default                        # or a specific inference profile id
    instructions: |-
      You are a supply-chain analyst...

      {{snippet:temporal_anchor}}         # shared prompt blocks, defined once
    tools:
      - gateway: default                  # the workload's gateway
        allowedTools: [tavily_search, news_search]
      - browser: true                     # native AgentCore browser
    memory: true
    limits: { maxIterations: 16, timeoutSeconds: 900 }
```

Then `npm run build && npx cdk deploy ...` from the example directory. The
manifest is validated at `cdk synth` against the same zod schema TypeScript
configs use — a typo'd field or over-limit timeout fails synth with an
agent-and-field-precise error, never a deploy. The worker registry, IAM,
planner catalog, and API validation all derive from the entry; the planner
can assign tasks to the new agent on the next plan draft.

Prompts are also runtime-editable by org admins in the web app (Settings →
agent prompts); the YAML holds the deployed defaults.

## Adding a tool (Python)

Tools are one Lambda each, behind the AgentCore Gateway. The contract:

- the **event** is the tool's input arguments (already parsed),
- the tool name arrives in the Lambda client context (`target___tool`),
- return a `ToolResult` JSON; **raise** on failure — the helper converts it
  to a structured error the agent can reason about (never throw at the
  gateway).

`tools-py/handlers/currency_rates.py` is the reference. The pattern:

```python
# tools-py/handlers/my_tool.py
from agentic_tools import tool_handler

@tool_handler("my_tool", via="my-upstream")
def handler(event: dict) -> dict:
    query = event["query"]                # schema-validated by the gateway
    ...call your API (urllib.request + Secrets Manager via boto3)...
    return {"results": [...]}
```

Next to it, `my_tool.schema.json` declares the MCP schema:

```json
{
  "name": "my_tool",
  "description": "What the agent should know about when to use it.",
  "inputSchema": {
    "type": "object",
    "properties": { "query": { "type": "string", "description": "..." } },
    "required": ["query"]
  }
}
```

Register it in the workload stack (one entry, same shape as
`CurrencyRatesFn` in `examples/marketing-workflow/lib/marketing-workflow-stack.ts`), grant the agent the
tool in `workload.yaml` (`allowedTools`), and add a line to the agent's
instructions saying when to use it. Test with pytest — see
`tools-py/tests/` for the house style (mock `urllib`, assert the URL and the
`ToolResult` shape):

```bash
cd tools-py && python3 -m pytest
```

### Packaging discipline (the one rule)

**Standard library + boto3 only.** Both ship in the Lambda Python runtime,
so `Code.fromAsset` on the directory is the entire packaging story — no
Docker, no layers, no requirements.txt. The moment a handler imports
`requests` or `pydantic`, you need a bundling step; keep executors
dependency-free instead. Secrets go in Secrets Manager (read with boto3 at
call time), never in code or environment-variable values.

### Vendor already speaks MCP? Skip the Lambda

If the tool provider hosts an MCP server (as Tavily does), federate it
directly with `GatewayMcpServerTarget` — endpoint plus an API-key credential
provider, no code at all. See D-25 in `docs/decisions.md`.

## Adding backend feature APIs (Python)

Your React app may need endpoints beyond the platform's workflow routes.
Mount your own Python Lambdas on the same HTTP API, behind the same Cognito
JWT authorizer, with `additionalRoutes`:

```ts
new AgenticApi(this, 'Api', {
  foundation,
  additionalRoutes: [
    { method: HttpMethod.GET, path: '/reports/summary', handler: myPythonFn },
  ],
});
```

Explicit routes win over the platform's catch-all, and reserved prefixes
(`/workflows`, `/runs`, `/settings`, `/plan-drafts`) are rejected at synth so
a feature route can never shadow platform behavior. Your handler receives
the standard HTTP API v2 Lambda event; the JWT is already validated, with
claims at `event.requestContext.authorizer.jwt.claims`.

## What stays TypeScript (and why)

The constructs library, plan interpreter, platform API router, and the React
webapp. Workload teams don't edit these — they're the platform, like Bedrock
Agents' control plane wasn't yours to edit either. The React app shares its
types with the platform via `plan-schema`; UI features are TypeScript
end-to-end by design.
