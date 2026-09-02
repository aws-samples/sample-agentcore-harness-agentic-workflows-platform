#!/usr/bin/env node
import { App, RemovalPolicy } from 'aws-cdk-lib';
import { MarketingWorkflowStack } from '../lib/marketing-workflow-stack';

const app = new App();

const modelId =
  (app.node.tryGetContext('modelId') as string | undefined) ??
  process.env.MARKETING_MODEL_ID;
if (!modelId) {
  throw new Error(
    'Model id required: pass -c modelId=<ap-southeast-2 inference profile> ' +
      '(or MARKETING_MODEL_ID env). List candidates with `aws bedrock ' +
      'list-inference-profiles`; nothing is guessed for you.',
  );
}

// Optional complexity tiers for per-task model assignment (D-18). When at
// least one is provided, the planner is offered a model menu and may set
// modelOverride per task; with neither, per-task selection stays off and
// every task uses its worker's default model.
const fastModelId =
  (app.node.tryGetContext('fastModelId') as string | undefined) ??
  process.env.MARKETING_FAST_MODEL_ID;
const deepModelId =
  (app.node.tryGetContext('deepModelId') as string | undefined) ??
  process.env.MARKETING_DEEP_MODEL_ID;
const modelCatalog =
  fastModelId || deepModelId
    ? [
        ...(fastModelId
          ? [
              {
                modelId: fastModelId,
                description:
                  'fast/low-cost — simple extraction, lookups, single-source summaries',
              },
            ]
          : []),
        {
          modelId,
          description:
            'balanced (worker default) — standard research and analysis tasks',
        },
        ...(deepModelId
          ? [
              {
                modelId: deepModelId,
                description:
                  'most capable — deep multi-source synthesis, quantitative reasoning, ambiguous scoping',
              },
            ]
          : []),
      ]
    : undefined;

// Test/dev accounts pass -c removalPolicy=destroy so `cdk destroy` cleans up
// stateful resources; production keeps the RETAIN default.
const destroyOnRemove =
  (app.node.tryGetContext('removalPolicy') as string | undefined) === 'destroy';

// Region is an explicit deploy-time decision, like modelId (D-10/D-28):
// `-c region=us-west-2` beats everything. Do NOT lean on exporting
// CDK_DEFAULT_REGION — the CDK CLI overwrites it with the region it
// resolves from your profile (live finding: a deploy intended for
// us-west-2 silently landed in the profile's default region).
const region =
  (app.node.tryGetContext('region') as string | undefined) ??
  process.env.CDK_DEFAULT_REGION ??
  'ap-southeast-2';
new MarketingWorkflowStack(app, 'MarketingWorkflow', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region,
  },
  defaultModelId: modelId,
  ...(modelCatalog ? { modelCatalog } : {}),
  // Plan quality drives every downstream task: run the planner on the
  // deep-tier model whenever one is provided.
  ...(deepModelId ? { plannerModelId: deepModelId } : {}),
  // Optional: -c alarmEmail=<address> subscribes to the workload alarms.
  ...((app.node.tryGetContext('alarmEmail') as string | undefined)
    ? { alarmEmail: app.node.tryGetContext('alarmEmail') as string }
    : {}),
  ...(destroyOnRemove ? { removalPolicy: RemovalPolicy.DESTROY } : {}),
});
