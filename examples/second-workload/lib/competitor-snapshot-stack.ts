/**
 * CompetitorSnapshotStack — the REUSE PROOF: a second, unrelated workload instantiated from the published
 * constructs and its own configuration only. No construct code is modified;
 * this file is the entire workload.
 *
 * It is deliberately small: a new workload of this shape (plus one Gateway
 * tool registration) is an under-an-hour exercise.
 */
import { RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import { AgenticFoundation } from '@agentic-platform/constructs';
import type { HarnessConfigInput } from '@agentic-platform/plan-schema';

export interface CompetitorSnapshotStackProps extends StackProps {
  readonly defaultModelId: string;
  /** Attach an existing gateway (e.g. the marketing-workflow example's) to give workers search tools. */
  readonly gatewayArn?: string;
  readonly removalPolicy?: RemovalPolicy;
}

export class CompetitorSnapshotStack extends Stack {
  constructor(
    scope: Construct,
    id: string,
    props: CompetitorSnapshotStackProps,
  ) {
    super(scope, id, props);

    const agents: HarnessConfigInput[] = [
      {
        name: 'planner',
        description: 'Plans competitor snapshot workflows',
        instructions:
          'You plan competitor snapshot workflows. Decompose the goal into 2-4 focused tasks over the available workers and return ONLY a JSON plan document (version 1: goal, tasks[{id,name,worker,allowedTools,prompt,dependsOn}], report{worker,format,instructions}). Independent tasks must run in parallel (empty dependsOn). The report step is automatic — configure it, do not add a task for it.',
        // No temperature: model defaults apply (D-21 — explicit temperature
        // is rejected by newer Claude generations).
        limits: { maxIterations: 8, timeoutSeconds: 600 },
      },
      {
        name: 'competitor_research',
        description: 'Researches one competitor: positioning, moves, coverage',
        instructions:
          'You research one competitor per task: recent moves, positioning, pricing signals, and coverage. Use at most 2 searches and 2 browser fetches; cite fetched sources inline and label training-knowledge claims "(synthesis)". Output structured Markdown with a Sources section.',
        tools: [
          ...(props.gatewayArn
            ? [
                {
                  type: 'agentcore_gateway' as const,
                  gatewayArn: props.gatewayArn,
                  allowedTools: ['tavily_search', 'news_search'],
                },
              ]
            : []),
          { type: 'agentcore_browser' as const },
        ],
        limits: { maxIterations: 20, timeoutSeconds: 1500 },
      },
      {
        name: 'report_generator',
        description: 'Assembles competitor snapshots into a comparison brief',
        instructions:
          'Assemble the task outputs into a competitor comparison brief: Executive summary, per-competitor snapshots, comparison table, watch items, coverage gaps (verbatim, if provided), sources. Synthesise only from the provided outputs.',
        limits: { maxIterations: 6, timeoutSeconds: 1200 },
      },
    ];

    new AgenticFoundation(this, 'CompetitorSnapshot', {
      workloadName: 'competitor-snapshot',
      defaultModelId: props.defaultModelId,
      agents,
      maxConcurrency: 3,
      ...(props.removalPolicy ? { removalPolicy: props.removalPolicy } : {}),
    });
  }
}
