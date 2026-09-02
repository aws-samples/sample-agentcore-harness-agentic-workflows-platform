# Runbook: New Agent in a Day

The two-loop path from idea to a governed, deployed agent. Validated by
walking it end-to-end; the time budget assumes the platform is already
deployed.

## Morning — inner loop (sandbox)

1. **Scaffold** (10 min)
   ```bash
   npm install -g @aws/agentcore
   agentcore create --name mynewagent --model-provider bedrock
   ```
2. **Iterate** (2–3 h) — `agentcore dev` opens the inspector: chat with the
   agent, watch traces, override model/prompt/tools per session. Iterate the
   instructions until behavior is right. Rules of the loop:
   - Sandbox account only — nothing from this loop ships directly.
   - For research agents, follow the RESEARCH PATTERN house style (hard tool
     budgets, inline citations, "(synthesis)" labels) — see the worker
     prompts in `examples/marketing-workflow/workload.yaml`.
3. **Capture** the settled config: model, instructions, tools, limits.

## Afternoon — outer loop (governed)

4. **Transfer the config** (20 min) — add an entry to your workload's
   `workload.yaml`. Names must match `^[a-zA-Z][a-zA-Z0-9_]{0,39}$`
   (no hyphens). The manifest is validated at `cdk synth`, so a typo fails
   fast with a field-precise error.
   ```yaml
   - name: my_new_agent
     description: One line — the planner sees this in its catalog
     instructions: |-
       <the settled prompt from the morning loop>
     tools:
       - gateway: default
         allowedTools: [tavily_search]
       - browser: true
     limits: { maxIterations: 20, timeoutSeconds: 1500 }
   ```
   (TypeScript-authored workloads pass a `HarnessConfigInput` object to the
   foundation's `agents` array instead — same schema, same validation. See
   `examples/second-workload`.)
5. **That's the whole wiring** — the worker map, IAM grants, planner
   catalog, and API validation all derive from that one entry.
6. **New tool too?** Two paths (~45 min):
   - Provider hosts an MCP server → federate it with `GatewayMcpServerTarget`
     (endpoint + API-key credential provider, no code).
   - Otherwise → write one executor as its own Lambda — Python
     (`tools-py/`, see [python-developers.md](python-developers.md)) or
     TypeScript (`packages/tools`, `createToolHandler`) — with a schema JSON,
     then register a `GatewayToolTarget` and grant exactly its secret.
   Either way, add the tool name to your agent's `allowedTools` and mention
   it in the instructions.
7. **Verify** (20 min)
   ```bash
   npm test        # synth assertions incl. the IAM guards
   npx cdk diff    # in your example app — review before deploy
   npx cdk deploy -c modelId=<your-inference-profile-id>
   ```
8. **Prove it** (15 min) — in the web app: create a workflow whose goal suits
   the new agent → the planner's draft should assign tasks to it (it reads
   the description from step 4) → review → save → run now → read the
   artifact.

## Exit criteria

- [ ] Agent config lives in source control; nothing was created by hand
- [ ] `npm test` green including the IAM guard assertions
- [ ] Planner drafts plans that use the agent, with narrowed `allowedTools`
- [ ] A run produced an artifact that passes the eval rubric spot-check
      (`evals/report-quality-rubric.md`)
