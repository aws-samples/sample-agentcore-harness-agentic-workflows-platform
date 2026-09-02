# Report Quality Rubric

LLM-as-judge criteria for scoring report artifacts, designed for AgentCore
Evaluations (`OnlineEvaluationConfig` L2 with LLM-as-a-Judge evaluators once
wired — see docs/decisions.md D-08) and usable manually for review.

Score each criterion 1–5; overall = weighted mean. A run "passes" at ≥ 3.5
overall with no criterion below 2.

| # | Criterion | Weight | 5 looks like | 1 looks like |
|---|---|---|---|---|
| 1 | **Goal fidelity** | 25% | Every element of the stated goal is addressed; scope (market, geography, timeframe) respected | Answers a different or vaguer question than asked |
| 2 | **Evidence discipline** | 25% | Claims traceable to cited task outputs; synthesis labeled "(synthesis)"; no invented facts or citations | Unsourced assertions presented as researched fact |
| 3 | **Gap honesty** | 20% | Failed/skipped tasks surfaced verbatim in Coverage gaps; confidence adjusted in the executive summary | Gaps papered over; report reads complete when inputs were partial |
| 4 | **Decision usefulness** | 20% | Executive summary is decision-first; recommendations concrete, owned, and follow from findings | Generic advice detached from the evidence |
| 5 | **Structure & polish** | 10% | Matches the mandated structure; clean heading hierarchy; tables where they clarify | Missing sections, inconsistent formatting |

## Judge prompt template

> You are scoring a market-intelligence report produced by an automated
> workflow. You are given: the research GOAL, the REPORT, and the list of
> coverage GAPS the system recorded (may be empty).
> Score criteria 1–5 per the rubric table (embedded), each with a two-sentence
> justification quoting the report. Then compute the weighted overall score.
> Return JSON: `{ "scores": { "goalFidelity": n, "evidenceDiscipline": n,
> "gapHonesty": n, "decisionUsefulness": n, "structure": n },
> "justifications": { ... }, "overall": n.n, "pass": bool }`.

## Calibration anchors

- A report that explicitly says "pricing data unavailable — the pricing
  task failed" and lowers its confidence scores HIGHER on gap honesty than a
  fluent report that silently omits pricing.
- Inline "(synthesis)" labels are evidence discipline working as designed —
  do not penalize their presence; penalize their absence on non-cited claims.
