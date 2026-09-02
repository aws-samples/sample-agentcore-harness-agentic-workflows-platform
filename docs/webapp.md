# The web app: a walkthrough

The platform ships a React web app (Cloudscape design system) for the whole
workflow lifecycle: describe a goal, review the plan the AI planner drafts,
run it, and read the report. This page walks the primary journey with
screenshots from the marketing-workflow reference workload — a marketing-intelligence
agent team for the fictional **Solera Estates** wine company.

Screenshots are captured against a live deployment by
[`scripts/capture-docs-shots.mjs`](../scripts/capture-docs-shots.mjs)
(Playwright; creates one real workflow and executes one real run).

## 1. Sign in

Authentication is Amazon Cognito. Self-sign-up is disabled by design —
users are created by an administrator (see the README's post-deploy steps).
Members of the `admin` group can additionally edit agent configuration and
org settings.

![Login](images/webapp/01-login.png)

## 2. Workflows

The workflow list is the home surface: every workflow with its schedule and
latest-run status. A workflow is a goal plus a saved, versioned plan.

![Workflows list](images/webapp/02-workflows.png)

## 3. Create a workflow from a goal

State the research goal in plain language — the planner does the
decomposition. Plan mode chooses between **Static** (every run executes the
reviewed plan; recommended) and **Replan each run** (the planner re-drafts
at execution time).

![Create workflow](images/webapp/03-create-workflow.png)

## 4. Draft and review the plan

"Draft plan with planner" invokes the planner harness live (a deep-tier
model at high adaptive-thinking effort in this workload). The draft comes back as an
editable task list. Note what the planner did with the campaign goal below:
it put the no-tools `product_expert` first for internal brand knowledge,
fanned four research specialists out **in parallel**, and gave the
`campaign_strategist` a `dependsOn` on all five — synthesis only runs once
the evidence exists.

Every task is editable before saving: the **prompt**, the **worker** (a
dropdown of the deployed agents; switching re-scopes the allowed tools),
the **allowed tools** (a multiselect of that worker's gateway tools), and
the **model** (from the org's model catalog — pick a stronger model for
deep synthesis, a lighter one for lookups). Saving validates server-side:
unknown workers, tools, or models are rejected with precise errors.

![Plan editor](images/webapp/04-plan-editor.png)

## 5. The saved workflow

Saving creates plan **v1** (each save is a new immutable version). From
here: run now, or attach a `rate(...)`/`cron(...)` schedule. The failure
policy (top right of Overview) governs runs: contain (default), fail-fast,
or retry-run.

![Workflow detail](images/webapp/05-workflow-detail.png)

## 6. Watch the run

The run page live-refreshes (5 s). The interpreter executes the plan in
dependency waves — here the first wave's independent research tasks run
concurrently while the dependent strategy and report tasks wait. Per-task
status, token usage, and duration fill in as tasks finish; task outputs are
viewable as soon as each lands.

![Run in progress](images/webapp/06-run-in-progress.png)

When the run completes, the overview shows totals — this demo run finished
7 tasks in ~7 minutes:

![Run complete](images/webapp/07-run-complete.png)

## 7. Read the report

The final task assembles every specialist output into one board-ready
brief, rendered in-app (and downloadable as Markdown). Failed or skipped
tasks are declared as coverage gaps rather than papered over — and note the
honest flagging in this example: the fictional brand has no real market
footprint, and the report says so prominently instead of inventing one.

![Report](images/webapp/08-report.png)

## 8. Settings: tune agents at runtime

The Settings page exposes the runtime configuration layer — no redeploy
needed, deployed defaults always restorable:

![Settings — agents](images/webapp/09-settings-agents.png)

Per agent (admin-gated): the **system prompt** (e.g. `product_expert`'s
maintained portfolio brief lives here), the **model override**
(Bedrock-verified at save), **thinking effort** for the planner, and
read-only **badges** showing each agent's deployed tool surface. Org-wide:
the **model catalog** the planner assigns from, with the complexity
guidance it reads verbatim.

![Settings — agent detail](images/webapp/10-settings-agent-detail.png)

## Regenerating these screenshots

```bash
APP_URL=<WebAppUrl> APP_USER=<user> APP_PASSWORD=<password> \
  node scripts/capture-docs-shots.mjs
```

The script signs in, creates a workflow named "Velvet Fox AU spring
campaign", drafts and saves a plan, executes a full run (Bedrock spend
applies), and writes the PNG set to `docs/images/webapp/`.
