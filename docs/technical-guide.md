# Technical guide

The deep-dive companion to the [README](../README.md). Read this when you're past the quick start and want to understand how the platform is put together, tune agents and tools, build your own workload, or operate a deployment.

Contents:

- [How a run works, in full](#how-a-run-works-in-full)
- [Platform vs. workload](#platform-vs-workload)
- [Workload config: the agent manifest](#workload-config-the-agent-manifest)
- [Tool config: platform catalog, per-workload gateway](#tool-config-platform-catalog-per-workload-gateway)
- [How the planner works](#how-the-planner-works)
- [Runtime configuration (Settings)](#runtime-configuration-settings)
- [Edit or add workers](#edit-or-add-workers)
- [Add a tool](#add-a-tool)
- [Building your own workload](#building-your-own-workload)
- [Repository layout](#repository-layout)
- [Cost tagging and observability](#cost-tagging-and-observability)
- [Security posture](#security-posture)

## How a run works, in full

The README's seven steps, with the platform mechanics filled in:

1. A signed-in user submits a goal. Drafting is an **async job** — the API returns `202` and the app polls until the planner harness finishes the task graph.
2. The user reviews and edits the draft — per task: prompt, worker (dropdown), allowed tools (multiselect of that worker's tools), and model — then saves it as a versioned workflow.
3. A run starts via "run now" or an EventBridge Scheduler schedule. Both paths start the same Step Functions state machine; a **stale-plan guard** re-validates the saved plan against the current worker/model catalogs first (a renamed or removed worker produces an actionable 422, not a mid-run failure).
4. The interpreter executes the plan in dependency waves. Within a wave, independent tasks fan out in parallel (Map state) straight to worker harnesses using the native `invokeHarness` service integration — no Lambda shim around agent calls.
5. Workers call tools through the AgentCore Gateway (MCP); API keys stay in Secrets Manager, never visible to agents.
6. Every task output is persisted to S3, with a task record (status, timing, token usage) in DynamoDB. Dependent tasks receive their dependencies' outputs inlined into their prompts (budgeted per dependency and per prompt).
7. A report harness assembles all task outputs into the final artifact. Failed tasks are recorded, their dependents are skipped with a reason, and the report explicitly notes the gaps — partial results beat total failure.

Two plan modes: `static` (default — scheduled runs execute the reviewed, versioned plan) and `replan-each-run` (the planner re-runs at execution time). Failure handling is policy-driven per workflow: `contain` (default), `fail-fast`, or `retry-run` (≤3 attempts).

**Architecture diagram**: the editable source is [`architecture.drawio`](architecture.drawio) — open it with [draw.io](https://app.diagrams.net) or the Draw.io VS Code extension, and re-export [`architecture.svg`](architecture.svg) after changes.

## Platform vs. workload

The platform is written once; each workload is stamped out from it via configuration. Three things are constant across every workload: the plan-interpreter state machine (one deployed instance runs every plan), the plan-document contract, and the API surface. Everything else is data.

**Platform core components** (shared, in `packages/`):

| Component | Package | Role |
|---|---|---|
| `AgenticFoundation` | constructs | One-call workload provisioning: KMS key, DynamoDB table, artifact bucket, agents, interpreter, scheduler, observability, config seeding |
| `HarnessAgent` | constructs | An AgentCore harness from a typed config: least-privilege execution role, memory posture, model + token limits, per-agent cost tag |
| `AgenticWorkflow` | constructs | The Step Functions plan interpreter: dependency waves, parallel fan-out, failure containment, report assembly |
| `GatewayToolTarget` / `GatewayMcpServerTarget` | constructs | Register a Lambda executor or a federated hosted MCP server as a gateway tool, with scoped IAM and secret wiring |
| `WorkflowScheduler` / `ObservabilityPack` | constructs | EventBridge Scheduler group + fixed role; CloudWatch dashboard, alarms, DLQ |
| Plan schema | plan-schema | Zod contracts shared by synth, backend, and frontend: harness configs, plan document v1, run/task records, wave computation |
| `AgenticApi` | api | HTTP API + Cognito, router Lambda, async planner-job Lambda, artifact presigning |
| Tool catalog | tools, tools-py | Executor implementations any workload can register: `news_search`, `social_search`, `patent_search`, Python `currency_rates` |
| Web app | webapp | React SPA: workflows, plan editor, runs, artifacts, Settings |

**Workload components** (one per business use case, in `examples/<name>/` or your own repo):

| Concern | What the workload provides |
|---|---|
| Stack composition | A `Stack` wiring the platform constructs together (e.g. `MarketingWorkflowStack`) |
| Agent roster | `workload.yaml` (or TS configs): instructions, tools, memory, limits, thinking effort per agent. One agent named `planner` is auto-wired as the planning harness |
| Gateway + tool selection | Its own `agentcore.Gateway`, which catalog targets to attach, secret names, per-Lambda memory |
| Secret prefix | Namespace like `marketing-workflow/` — drives IAM scoping for that workload's tool Lambdas |
| Model choices | `defaultModelId`, optional planner model (`plannerModelId`), optional `modelCatalog` for per-task assignment |
| Workload identity | `workloadName` — resource naming, tagging, cost attribution |

## Workload config: the agent manifest

`workload.yaml` is the single developer-editable surface for agents, validated against the shared zod schema at `cdk synth` — a typo fails synth with an agent-and-field-precise error, never a deploy. Per agent:

```yaml
- name: audience_insight
  description: "Consumer research: segmentation, occasions, category trends. Web + social. Does NOT know our own portfolio (use product_expert)."
  instructions: |
    ... system prompt, with {{snippet:...}} for shared blocks ...
  tools:
    - gateway: default                  # resolves to the workload's gateway ARN
      allowedTools: [tavily_search, news_search, social_search]
    - browser: true                     # AgentCore managed browser
    # - codeInterpreter: true           # AgentCore code interpreter
  memory: true                          # OPT-IN cross-session memory (see below)
  limits: { maxIterations: 24, timeoutSeconds: 1800, maxTokens: 16384 }
  # thinkingEffort: high                # Anthropic adaptive thinking (planner uses this)
```

Three behaviors worth knowing, all learned from live incidents:

- **Descriptions are the planner's entire mental model of a worker** — it never sees the instructions. Write capabilities *and limits* into every description ("has NO web access — always give it dependsOn inputs"), or the planner will assign tasks the worker can't perform.
- **Cross-session memory is opt-in.** By default agents get session-scoped memory only (enough for within-session context; nothing carries between runs or workflows). `memory: true` enables semantic long-term memory — facts extracted from one session are recalled in later ones. Opt in deliberately: an early planner with default long-term memory leaked one workflow's topic into every other workflow's plans.
- **The derived worker catalog (names + descriptions + tool scopes) is seeded into DynamoDB on every deploy** and read at runtime — it outgrew Lambda's 4KB environment limit. `workload.yaml` remains the source of truth; edit → `cdk deploy` → catalog updates.

## Tool config: platform catalog, per-workload gateway

- **Platform ships the catalog** — target constructs (`GatewayMcpServerTarget` for federated hosted MCP servers, `GatewayToolTarget` for executor Lambdas) plus the executor implementations in `packages/tools/` and `tools-py/`. Any workload picks from this menu.
- **Each workload hosts its own gateway** and attaches only the targets it needs, wired to its own secret prefix. A workload can instead attach to another workload's gateway via `gatewayArn?` for shared quotas (how `examples/second-workload` reuses the marketing workflow's tools).

Tool access narrows at three levels: **gateway** (which targets the stack instantiates), **agent** (each harness's `allowedTools` and capability tools like browser/code interpreter), and **task** (the planner scopes each step's `allowedTools`; plan validation rejects anything outside the agent's list). Note the third level is validation + planner discipline today: the service-side per-tool runtime filter is disabled pending an AgentCore fix (decision D-24), and Cedar scoping is recorded intent pending PolicyEngine wiring.

**Key rotation**: after rotating `marketing-workflow/tavily-api-key`, redeploy — the gateway's credential provider reads the secret at deploy time, not per call. The Lambda-backed tools read their secrets at call time, so their rotations need no redeploy.

Adding a tool never touches platform construct code — see [Add a tool](#add-a-tool).

## How the planner works

The planner splits like the tool layer — the platform owns the machinery, the workload owns the domain prompt:

1. **Input assembly.** The planner harness receives the goal, today's date (a temporal anchor — it must phrase task recency relative to "today", never bake in dates), the **worker catalog** (names, descriptions, real tool names, read from the deploy-seeded table item), and the **model catalog** with complexity guidance so it can assign a cheaper or stronger model per task.
2. **Drafting.** The planner returns a JSON plan document: 3–6 tasks, parallel-first `dependsOn`, self-contained prompts, minimum `allowedTools` per task, plus report instructions. The marketing-workflow example runs its planner on the deep-tier model (`deepModelId`) at **high adaptive-thinking effort** — plan decomposition is the highest-leverage reasoning step in the system.
3. **Validation with corrective retries.** Each attempt is parsed against the plan schema (ids, cycles, waves) and semantically validated: workers must exist, task tools must be a subset of the worker's, model ids must be in the catalog, no literal calendar dates. Failures are fed back into the *same* planner session ("fix ALL of the issues below") for up to 2 retries — the interpreter only ever runs a contract-valid plan referencing real workers with real tools.
4. **Runtime overrides.** Admins can change any agent's system prompt, model, and (for the planner) thinking effort from the web app's Settings page — applied per-invocation from the next run, no redeploy, deployed defaults always restorable.

## Runtime configuration (Settings)

Everyone signed in can read; the Cognito `admin` group can edit. Per agent: system prompt override, model override (Bedrock-verified at save), thinking effort (planner), and read-only badges showing the agent's deployed tool surface. Org-wide: the model catalog offered to the planner. Changes apply from the next invocation; deploy-time defaults are re-seeded on every deploy and remain the fallback.

## Edit or add workers

Workers are entries in `examples/marketing-workflow/workload.yaml`. To change one: edit the YAML, `npm run build -w @agentic-platform/example-marketing-workflow`, `cdk deploy`. To add one, follow [`new-agent-in-a-day.md`](new-agent-in-a-day.md) — the worker map, IAM grants, planner catalog, config seeds, and API validation all derive from that one YAML entry. Checklist for a good worker:

- **Description states capabilities and limits** — it's all the planner sees. Say what the worker is for, what it can't do, and whether it needs `dependsOn` inputs.
- **Tools**: gateway tools by name, plus `browser: true` / `codeInterpreter: true` capabilities. Update the tool targets' `cedarScope` lists in the stack if you rename workers.
- **Memory**: leave off unless the agent genuinely benefits from remembering facts across runs.
- **Limits**: size `maxTokens` for the expected output (the platform carries it through per-task model overrides).
- Renaming or removing workers invalidates saved plans — the run action returns an actionable 422 and users re-draft (goals are preserved).

## Add a tool

Two paths, neither touches platform construct code:

- **Provider hosts an MCP server** → federate it with `GatewayMcpServerTarget` (endpoint + API-key credential provider, no Lambda). This is how Tavily's tools arrive.
- **Everything else** → drop an executor into `packages/tools/` (TypeScript, `createToolHandler`) or `tools-py/` (Python, stdlib-only) and register it with `GatewayToolTarget` in the workload stack — one Lambda per tool, its role scoped to exactly its own secret. Then grant it to workers via their `allowedTools` in `workload.yaml`.

## Building your own workload

The whole point of the platform: a new workload is configuration, not construct code. `examples/second-workload` is a complete competitor-monitoring workload in a single file:

```ts
import { AgenticFoundation } from '@agentic-platform/constructs';

new AgenticFoundation(this, 'CompetitorSnapshot', {
  workloadName: 'competitor-snapshot',
  defaultModelId: props.defaultModelId,
  agents, // planner, competitor_research, report_generator configs
  maxConcurrency: 3,
});
```

That one construct provisions the KMS key, DynamoDB table, artifact bucket, harness agents, plan-interpreter state machine, scheduler, observability pack, and runtime-config seeds — all cost-tagged. An agent named `planner` is automatically wired as the planning harness; everything else becomes a worker the planner can assign tasks to.

`second-workload` deliberately uses inline TypeScript agent configs to show the typed alternative to `workload.yaml` — both surfaces validate against the same zod schema.

## Tests and smoke test

```bash
npm test                          # 136 tests: schema, constructs, synth assertions, IAM guards
cd tools-py && python3 -m pytest  # 9 tests for the Python gateway tools
```

Against a deployed app, `node scripts/browser-smoke.mjs` walks every user-facing function headlessly (set `APP_URL`, `APP_USER`, `APP_PASSWORD`).

## Repository layout

```
agentic-platform/
├── packages/
│   ├── constructs/       # AgenticFoundation, HarnessAgent, AgenticWorkflow,
│   │                     # GatewayToolTarget, GatewayMcpServerTarget,
│   │                     # WorkflowScheduler, ObservabilityPack
│   ├── plan-schema/      # zod schemas: harness config, plan document, run/task
│   │                     # records, wave computation — shared by backend and frontend
│   ├── api/              # AgenticApi: HTTP API + Cognito + router/planner-job Lambdas
│   ├── tools/            # Gateway tool executors, bundled one Lambda per tool
│   └── webapp/           # React SPA: workflows, plan editor, runs, artifacts, Settings
├── tools-py/             # Python gateway tools (stdlib + boto3, no bundling)
├── examples/
│   ├── marketing-workflow/ # Reference workload: 9 marketing agents in workload.yaml
│   └── second-workload/  # Reuse proof: a complete second workload in one config file
├── docs/                 # Architecture diagram, runbooks, decision log
├── evals/                # Report quality rubric (LLM-as-judge criteria)
└── scripts/              # Playwright utilities: UI smoke test + docs screenshot capture
```

## Cost tagging and observability

### Per-run and per-task cost (in-app)

Token usage is captured from every worker invocation and stored idempotently: per task (`tokens` on the task record) and per run (input/output totals on the run record, shown on the run detail page). This is the complete ledger — use it for step- and workflow-level analysis.

### Bedrock cost attribution (billing)

Bedrock inference spend is attributed per agent via **IAM-principal cost allocation tags**: every harness has its own execution role, tagged `agent=<name>`, `workload=<name>`, `managed-by=agentic-platform` at creation. Bedrock propagates the calling principal's tags into Cost Explorer and CUR (`iamPrincipal/<key>` columns), splitting model spend per agent and per workload — no application inference profiles needed.

One-time activation per (payer) account, after the first tagged Bedrock call has been made (the key won't exist in Billing before that, and can take up to 24h to appear):

```bash
aws ce update-cost-allocation-tags-status --region us-east-1 \
  --cost-allocation-tags-status TagKey=agent,Status=Active \
    TagKey=workload,Status=Active TagKey=managed-by,Status=Active
```

Caveats: activation requires the Organizations **management account** (or a standalone account); attribution is **not retroactive** — only usage after activation is tagged; CUR/Cost Explorer data lags about a day.

> ⚠️ **Harness tags are immutable post-create.** The `AWS::BedrockAgentCore::Harness` CloudFormation handler currently fails any tag-modifying update, and CloudFormation *stack tags* propagate to all resources — so never add stack-level tags to a workload stack. Tags are applied as create-time properties by the constructs instead.

### Observability

- CloudWatch dashboard per workload (runs, failures, latency), failure alarms, DLQ + alarm on scheduled runs.
- **Traces**: the Step Functions state machine and every harness-calling Lambda run with active tracing, so harness invocations carry a sampled trace context into **CloudWatch GenAI Observability** (requires Transaction Search enabled in the account). The AgentCore runtimes emit full agent traces — model calls, tool calls, token usage per span.
- **Sampling**: capture follows your X-Ray sampling rules. With the default rule (5%, 1/sec reservoir) most low-volume invocations are traced but parallel task waves are sampled; add a scoped 100% rule for the workload's services if you want every invocation traced (trace pricing is negligible next to model tokens). Treat traces as the drill-down and the DynamoDB token ledger as the complete record.
- Per-model token totals are also emitted as CloudWatch metrics (`bedrock-agentcore` namespace, `gen_ai.client.token.usage`).

## Security posture

- Least-privilege IAM per harness and per tool Lambda, derived from each agent's declared tools
- Runtime roles carry **no control-plane permissions**: the app cannot create harnesses, state machines, or roles. The only resource ever created at runtime is a per-workflow EventBridge schedule (through one fixed, single-purpose role)
- One KMS customer-managed key per workload encrypting artifacts, tables, and logs; S3 public access blocked, SSL enforced
- Tool credentials live in Secrets Manager, resolved inside tool Lambdas — never in agent configs or agent-readable environment variables
- Every API route requires a Cognito JWT; artifact reads use short-lived presigned URLs scoped to the run prefix
- Cross-session agent memory is opt-in; the planner's memory is session-scoped by design
- Per-agent tool scoping via `allowedTools` at the worker-catalog and plan-validation level (the service-side harness filter is disabled pending an AgentCore fix — see decision D-24)

For the full production-readiness assessment — six pillars, GenAI considerations, a code-level security review, and the before-production shortlist — see the [Well-Architected review](well-architected-review.md).
