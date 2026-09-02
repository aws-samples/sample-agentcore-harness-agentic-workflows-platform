# Well-Architected Review — production considerations

A six-pillar review of the platform as deployed by the marketing-workflow reference stack,
plus generative-AI-specific considerations. Each finding lists current state
(verified in code or live), the production gap, and a recommendation.
Severity: **H** (address before production), **M** (address early in
production), **L** (accepted trade-off to revisit).

Reviewed: September 2026, against the state of `main` after the marketing
roster, memory, cost-attribution, and observability changes.

## Summary — before production shortlist

| # | Finding | Pillar | Severity |
|---|---|---|---|
| 1 | No WAF on CloudFront or the HTTP API; no API throttling limits configured | Security | H |
| 2 | Prompt-injection surface: fetched web content flows into agent context untreated; no Bedrock Guardrails on output ([SEC-H2](#sec-h2--prompt-injection-has-no-output-side-control)) | Security (GenAI) | H |
| 3 | Per-task `allowedTools` not runtime-enforced (AgentCore D-24); Cedar scoping is recorded intent only | Security | H (external dependency) |
| 4 | No CI/CD pipeline in-repo; deploys are workstation-run `cdk deploy` | Operational Excellence | H |
| 5 | No per-run cost ceiling — a runaway plan is bounded only by maxIterations × maxTokens × task count | Cost | M |
| 6 | Cognito: no MFA, no advanced security mode; admin group is the only RBAC | Security | M |
| 7 | Single-region; DR = PITR + versioned bucket, no cross-region strategy | Reliability | M |
| 8 | Tool API keys in Secrets Manager without rotation | Security | M |

Items resolved since the initial review (tenancy enforcement, alarm
notification wiring, Lambda log retention, artifact lifecycle, bucket CORS,
SPA security headers) are recorded in the
[remediation log](#remediation-log) at the end of this document.

---

## 1. Operational Excellence

**In place (verified):**
- One-construct provisioning (`AgenticFoundation`) — infrastructure is reviewable configuration; 136 synth/unit tests including IAM guards; a headless UI smoke test (`scripts/browser-smoke.mjs`).
- CloudWatch dashboard per workload; execution-failure alarm; scheduler DLQ + alarm.
- Decision log (`docs/decisions.md`) capturing live-verified service behaviors — unusual and valuable.
- Runtime configuration (prompts, models, thinking effort) changeable without redeploy, with deployed defaults always restorable.

**Findings:**

- **M — Alarm coverage is minimal.** Run-failure and scheduler-DLQ alarms now notify the per-workload SNS topic (see remediation log), but that is the entire alarm set. Add alarms for API 5xx rate, planner-job failures, harness runtime errors (log metric filters or `aws/spans`), and Bedrock throttling.
- **H — No delivery pipeline.** All deploys this cycle were workstation-run. For production: a pipeline (CodePipeline/GitHub Actions) running build → tests → synth diff → staged deploy, with the direct-update caveat documented (change-set deploys false-negative on IAM tag-only changes — live finding).
- **M — Runbooks are partial.** `new-agent-in-a-day.md` covers authoring; there is no incident runbook (stuck run, zombie execution reconciliation exists in code but isn't documented for operators, harness "Internal Failure" on update, memory janitor timeout).
- **L — Report quality is a rubric, not a gate.** `evals/report-quality-rubric.md` is manual. Consider a scheduled LLM-as-judge eval over recent artifacts with a dashboard metric.

## 2. Security

**In place (verified):**
- Least-privilege IAM per harness (tool-family-derived) and per tool Lambda (exactly one secret each); runtime roles carry no control-plane permissions (tested: no `CreateHarness`/`CreateRole`/`CreateStateMachine`).
- Per-workload KMS CMK with rotation; DDB + S3 + logs encrypted; S3 block-public-access + SSL enforced; presigned URLs scoped to the run prefix.
- Cognito JWT on every route; self-signup disabled; 12-char password policy; admin mutations gated server-side.
- Secrets never reach agent configs or agent-readable env.

**Findings:**

- **H — No WAF, no throttling.** CloudFront (webapp) and the HTTP API have no WAF web ACL and no configured throttle (HTTP API account-default limits only). The API fronts expensive operations (plan drafting = deep-model invocation): add AWS WAF (managed rules + rate-based rule) and route-level throttling, especially `POST /workflows/*/plan-drafts` and `/run`.
- **H — Per-task tool scoping is not runtime-enforced.** The service-side `allowedTools` filter is disabled (any concrete list exposes zero tools — D-24) and Cedar policies are metadata. A prompt-injected worker can call any tool its harness carries. Mitigations until AWS fixes: keep harness-level tool grants minimal (done), monitor tool-call spans, revisit D-24 each AgentCore release.
- **M — Cognito hardening.** No MFA, no threat protection / advanced security mode, default token validity. Enable MFA (at least for `admin`), plus adaptive auth if moving beyond a demo user base.
- **M — Secret rotation.** Tool API keys are create-once. Tavily's key is read at deploy time by the gateway credential provider (rotation requires redeploy — document or automate); NewsAPI/EnsembleData keys are call-time reads and rotate cleanly.
- **L — S3 CORS `allowedOrigins: ['*']`** on the artifacts bucket (GET-only, presigned-auth). Tighten to the CloudFront origin for defense in depth.
- **L — CloudTrail/data events** — no explicit trail configuration in-repo; production accounts should ensure management + relevant data events (S3 artifacts bucket, DDB) per org policy.

Code-level security findings — tenancy enforcement, LLM-output rendering,
CORS/CSP, auth flow, dependencies, egress — are detailed in the
[Security review: detailed findings](#security-review-detailed-findings)
section below.

## 3. Reliability

**In place (verified):**
- Serverless/multi-AZ by construction; DDB PITR enabled; artifacts bucket versioned; on-demand capacity (no table throughput to size).
- Failure containment as a first-class design: per-task failure policies, skip propagation with reasons, reports that declare gaps, zombie-run reconciliation for uncatchable States.Runtime failures, idempotent token accounting (no double-count on SFN retries).
- Retries on harness invocation (throttle-friendly backoff); planner corrective retries in-session; memory janitor serializes async memory deletion against stack lifecycle.
- Stale-plan guard re-validates saved plans against current catalogs at run start (422 instead of deep failure).

**Findings:**

- **M — Single region, no DR posture.** PITR (35 days) + versioning is point-in-time restore, not DR. Define RTO/RPO; if they matter: cross-region S3 replication for artifacts, DDB backups (AWS Backup) or global tables, and a documented redeploy path (region is a context flag; AgentCore availability gates the choice).
- **M — Bedrock quota pressure is handled, not managed.** `maxConcurrency: 3` and SFN retries absorb throttling, but there is no visibility (no alarm on throttle-classified failures) and no per-model quota headroom tracking. Add a metric filter/alarm on ThrottlingException in harness logs.
- **L — Harness updates are fragile.** Live findings: tag-modifying harness updates fail with "Internal Failure"; the CFN handler is young. Treat harness-touching deploys as higher-risk changes (deploy in a quiet window; the roster-replacement path — delete + create — proved more reliable than in-place mutation).
- **L — No load/chaos validation.** Concurrency, quota, and failure-policy behavior are unit-tested but not exercised at production volumes.

## 4. Performance Efficiency

**In place (verified):**
- Parallel wave execution (Map state fan-out) directly against harnesses — no Lambda shim in the hot path; per-task model assignment (cheap models for cheap tasks, deep model where it pays); planner thinking budget spent where leverage is highest.
- Worker catalog moved to DynamoDB (removed the 4KB env constraint on descriptions — richer planner routing without transport limits).
- Session-scoped memory avoids unbounded context growth; dependency-input budgets (`MAX_DEP_CHARS`/`MAX_TOTAL_CHARS`) cap prompt size.

**Findings:**

- **M — Planner latency is user-facing.** Deep model + high thinking effort puts plan drafting at 1–3 minutes (202+poll hides it, but UX degrades). Consider exposing effort as a per-draft choice, or default to `medium` and let admins raise it.
- **L — `maxConcurrency: 3` is a demo posture.** Production should size wave fan-out against actual Bedrock TPS/TPM quotas per model, ideally per-model concurrency rather than one global cap.
- **L — Polling everywhere** (run status ≤5s, draft polling). Fine at low volume; WebSocket/AppSync push is the known v2 item.

## 5. Cost Optimization

**In place (verified):**
- Serverless idle floor (~$5/month); on-demand DDB; per-task/per-run token ledger (idempotent) surfaced in the UI; per-model token CloudWatch metrics.
- Per-agent Bedrock cost attribution via IAM-principal tags on execution roles (`agent`, `workload`, `managed-by`) — billing-grade split once activated; per-task model assignment steers spend down.

**Findings:**

- **M — No cost ceiling per run/workflow.** Bounded only by plan size (≤25 tasks, planner told 3–6) × `maxIterations` × `maxTokens`. A misbehaving scheduled workflow burns until noticed. Add: AWS Budgets alert on the workload tag, an alarm on token-usage rate, and (roadmap) a per-run token budget enforced by the interpreter.
- **L — Log retention gaps remain** for the workload tool Lambdas and the service-created harness runtime log groups (`/aws/bedrock-agentcore/runtimes/*`) — interpreter and API Lambdas are now bounded at 3 months (see remediation log). Harness runtime groups need `logs.LogGroup` pre-creation or a retention-setter.
- **M — Cost-attribution gaps to close (roadmap already agreed):** persist effective `modelId` per task, capture planner token usage from stream metadata, price table × ledger for dollars-per-step, cross-workflow usage rollup. Raw token data is captured; dollars are not yet computed.
- **L — Cost allocation activation is manual** per payer account and non-retroactive — documented in the README; keep it in the new-environment runbook.

## 6. Sustainability

- Serverless + on-demand everywhere; no idle compute. The dominant footprint is model inference: the per-task model assignment (small models for small tasks) and prompt budgets are the effective levers, both in place. Right-size `thinkingEffort` and model tiers per task rather than defaulting everything to the deep model. **L** overall.

## GenAI-specific considerations (beyond the six pillars)

- **H — Prompt injection.** Workers fetch arbitrary web pages (browser tool) and social content into their context. A hostile page can attempt tool misuse or exfiltration via report content. Current mitigations: minimal harness tool grants, no secrets in agent reach, output is a report reviewed by humans. Missing: Bedrock Guardrails (or equivalent) on worker/report output, an injection-aware fetch policy, and red-team evals.
- **M — Model invocation logging.** Bedrock invocation logging is not enabled; for audit/compliance in production, enable it (CloudWatch/S3) with the workload CMK — noting prompt content is sensitive.
- **M — Memory governance.** Cross-session memory is opt-in (post-incident posture) and events expire at 30 days, but there is no PII policy for what workers may store in semantic memory. Document what `brand_intelligence` may retain; keep the opt-in bar high.
- **L — Human-in-the-loop is a strength.** Plans are reviewed/edited before saving (static mode); keep `replan-each-run` for low-stakes workflows only, since it removes the review gate.
- **L — Eval automation.** The report rubric should become a scheduled judge run before production claims about output quality.

## Security review: detailed findings

A code-level review of the actual enforcement paths — authentication and
authorization in the API handlers, tenant isolation, rendering of LLM
output, token handling in the SPA, secret hygiene, IAM grants, and the
dependency tree. Complements the Security pillar above, which covers
architecture posture.

### Controls verified effective

| Control | Where | Verified |
|---|---|---|
| JWT required on every route | HTTP API default Cognito authorizer | Config + no unauthenticated routes |
| LLM output XSS defense | `webapp/components/Markdown.tsx` | All agent-generated markdown rendered through `marked` → **DOMPurify.sanitize** before `dangerouslySetInnerHTML` |
| Owner-or-admin on spend/mutation routes | `api-router.ts` shared `requireOwnerOrAdmin` guard on update, delete, savePlan, runNow, createPlanDraft, putSchedule | `createdBy` vs caller, admin override; creatorless records admin-only |
| Admin gating on privileged config | `putAgentConfig`, `putOrgSettings` | Server-side `cognito:groups` check; changes record `updatedBy`/`updatedAt` |
| Artifact access scoping | `getArtifactUrl` | Presigned GET, 300 s TTL, key must prefix-match the run (`artifactKeyBelongsToRun` rejects `..` traversal) — bytes never proxy through Lambda |
| Injection-safe data layer | all handlers | DynamoDB expression attribute values throughout; no string-built expressions |
| Planner output is untrusted input | `planner-client` / `savePlan` | Schema + semantic validation (workers, tools, models, no date literals) before any plan executes; corrective retries never bypass validation |
| Secret isolation | tool Lambdas, gateway | One secret per tool role (`marketing-workflow/<key>-*` exact-match ARNs); secrets never in agent configs or agent-readable env |
| No runtime control plane | all runtime roles | IAM guard tests assert no `CreateHarness`/`CreateRole`/`CreateStateMachine` |
| Token storage | `webapp/auth.ts` | `sessionStorage` (not `localStorage`); expiry enforced client-side; no refresh-token persistence |
| Repo hygiene | git | No hardcoded credentials in tracked files (pattern scan); `cdk.out` untracked |

### SEC-L4 · Tenancy is owner-or-admin on mutations, open on reads

Spend and mutation routes (`savePlan`, `runNow`, `createPlanDraft`,
`putSchedule`, plus the original update/delete) enforce owner-or-admin
(remediated — see log). Reads remain open to all signed-in users by design
(shared-workspace model). Residual considerations: any user can still read
every workflow, run, and artifact — fine for a single team, revisit for
multi-team tenancy; and runs/plan saves record `createdBy`/`savedBy` but
there is no per-mutation audit trail beyond that.

### SEC-H2 · Prompt injection has no output-side control

Workers ingest arbitrary web pages and social content; a hostile page can
steer tool use or smuggle content into reports. Current mitigations are
input-side (minimal harness tool grants, budgets) and human review of
reports. There is no Bedrock Guardrails (or equivalent) pass on worker and
report output, and per-task tool scoping is not runtime-enforced (AgentCore
D-24 — the service-side filter is broken, harnesses run `allowedTools: '*'`).
Combined, an injected worker can use any tool its harness carries and its
output flows unfiltered into the report. Add an output guardrail step and
track D-24 each AgentCore release.

### SEC-M1 · Wildcard CORS on the HTTP API

`AgenticApi` still defaults `allowOrigins: ['*']` (the artifacts bucket is
now scoped to CloudFront origins — see remediation log). Bearer-token auth
means CORS is not the authorization boundary, but a wildcard origin removes
a defense-in-depth layer against token-theft scenarios. Pass the CloudFront
origin as `corsOrigins`; note the same-stack circularity (the API is
created before the distribution), so this needs either a two-phase value, a
custom domain, or a `https://*.cloudfront.net` pattern if supported.

### SEC-M2 · No Content-Security-Policy on the SPA

The distribution now serves HSTS, `nosniff`, frame and referrer headers via
the managed security-headers policy (see remediation log), but no CSP.
DOMPurify remains the only XSS layer; a CSP (`script-src 'self'`,
`connect-src` API + Cognito endpoints) would make token theft via injected
script substantially harder — which matters because the ID token lives in
`sessionStorage`, readable by any script that does execute. Add a custom
`ResponseHeadersPolicy` with a tuned CSP.

### SEC-M3 · Authentication hardening

- The SPA calls Cognito with `USER_PASSWORD_AUTH` (password sent directly
  to Cognito over TLS). Acceptable; SRP (`USER_SRP_AUTH`) avoids
  transmitting the password at all and is the better default.
- No MFA and no Cognito threat protection (advanced security). Enable MFA
  at least for the `admin` group.
- Sessions are ID-token-only with ~1 h validity and no refresh token
  persisted — a security-positive trade (bounded token lifetime) with a UX
  cost; keep it deliberate.

### SEC-M4 · Dependency vulnerabilities and no audit cadence

`npm audit`: 2 moderate findings in `react-router`/`react-router-dom`
(open-redirect via backslash in `<Link>`/`useNavigate`; an SSR hydration
deserialization issue that does not apply to this client-rendered SPA).
Fix is a major-version upgrade. More important than the specific CVEs:
there is no Dependabot/renovate/audit gate in the repo. Add one alongside
the CI pipeline (shortlist item 4).

### SEC-M5 · Unmetered expensive endpoints

`POST /workflows/*/plan-drafts` and `/run` translate one HTTP request into
deep-model inference. Owner-gating (see remediation log) limits who can
trigger spend, but a single compromised owner/admin account can still
generate unbounded spend: no WAF, no route throttling. Rate-limit these
routes and alarm on drafting/run rates.

### SEC-L1 · Broad `bedrock:InvokeModel` grant

Harness execution roles allow `bedrock:InvokeModel*` on `*` (documented
fast-follow: inference profiles fan out across regional model ARNs).
Tighten to the specific profile/model ARNs once the profile set stabilizes
— it also hard-bounds which models a prompt-injected agent could invoke.

### SEC-L2 · Browser tool egress is unbounded

The AgentCore managed browser will fetch any URL a worker chooses; isolation
is the service sandbox. There is no egress allowlist/denylist. For
production consider a fetch-policy prompt contract plus monitoring of
fetched domains from the runtime spans; an infrastructure-level allowlist
is not currently offered by the managed browser.

### SEC-L3 · Audit trail gaps

Settings changes record `updatedBy`/`updatedAt` (good), but plan saves,
runs, and deletions record at most `createdBy`. Bedrock model-invocation
logging is off; CloudTrail data events for the artifacts bucket/table are
not configured in-repo. Decide the audit posture before production.

### Security fix priority

1. Output guardrails for worker/report content (SEC-H2).
2. WAF + route throttling on the two expensive endpoints (SEC-M5, with
   shortlist item 1).
3. CSP via a custom response-headers policy (SEC-M2) and API CORS
   tightening (SEC-M1).
4. Cognito MFA + SRP flow (SEC-M3).
5. Dependency upgrade + audit automation in CI (SEC-M4).
6. SEC-L items as the production checklist tail.

## Known service-dependency risks (live-verified)

Tracked here because they are AWS-side, not fixable in this repo:

| Behavior | Impact | Workaround in place |
|---|---|---|
| Harness `allowedTools` filter exposes zero tools when set (D-24) | Per-task tool scoping not runtime-enforced | `'*'` + validation/prompt-level scoping |
| Harness CFN handler fails tag-modifying updates ("Internal Failure") | Harness tags immutable post-create; stack tags unusable | Create-time tags only; README warning |
| CDK change-set diff/deploy false-negatives IAM tag-only changes | Silent no-op deploys | `--method=direct` when tags change |
| Managed memory defaults to actor-scoped SEMANTIC when unset | Cross-workflow context bleed | Explicit SUMMARIZATION-only default |
| `GetTemplate` mangles non-ASCII in returned templates | Confusing diffs during incident response | Compare via change sets, not GetTemplate |

## Remediation log

Fixes applied after the initial review, with the residual noted where the
fix was partial:

| Original finding | Fix | Residual |
|---|---|---|
| SEC-H1: `savePlan`/`runNow`/`createPlanDraft`/`putSchedule` lacked owner checks | Shared `requireOwnerOrAdmin` guard on all spend/mutation routes | Reads remain open by design; no per-mutation audit trail (SEC-L4) |
| OpEx: alarms had no notification targets | Per-workload SNS alarm topic wired to both alarms; optional `alarmEmail` prop / `-c alarmEmail`; `AlarmTopicArn` output | Alarm coverage itself is still minimal (API 5xx, planner-job, throttling) |
| Log retention never-expire | 3-month retention on interpreter and API Lambdas | Tool Lambdas and harness runtime log groups still unbounded |
| Artifacts accrue forever | Lifecycle rules: noncurrent versions expire at 30 d, incomplete multipart uploads at 7 d | — |
| SEC-M1: wildcard CORS on bucket + API | Bucket CORS scoped to CloudFront origins (`artifactsCorsOrigins` override for custom domains) | API CORS still `'*'` (same-stack circularity) |
| SEC-M2: no security headers on the SPA | Managed `SECURITY_HEADERS` response policy (HSTS, nosniff, frame, referrer) on CloudFront | No CSP yet (needs tuned connect-src) |
