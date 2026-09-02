/**
 * MemoryJanitor — makes destroy → redeploy reliable for harness workloads.
 *
 * Every AgentCore harness auto-creates a managed memory named
 * `<harnessName>-<suffix>`, and DELETES IT ASYNCHRONOUSLY: harness deletion
 * returns while the memory is still in DELETING state. Because the memory
 * name derives from the fixed harness name, a `cdk destroy` followed by a
 * deploy (or a failed-deploy rollback followed by a retry) fails with
 * "Memory with name <x> already exists" (live-verified; docs/decisions.md).
 *
 * This construct closes the race from both sides. Harnesses depend on it,
 * which in CloudFormation ordering means:
 *
 *  - on CREATE it runs before any harness and waits until no leftover
 *    memory for these agent names is still DELETING;
 *  - on DELETE it runs after every harness is gone and holds the stack
 *    delete open until their memories have fully disappeared — so the next
 *    deploy starts from a clean slate.
 *
 * It never deletes anything itself: an ACTIVE memory under one of these
 * names (e.g. orphaned by a RETAIN teardown) is out of scope — harness
 * creation will fail on it with a clear service error, and deciding
 * ownership is not something a janitor should guess at.
 */
import { Duration } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as cr from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';
import { CustomResource } from 'aws-cdk-lib';

export interface MemoryJanitorProps {
  /** Harness names whose managed memories the janitor watches. */
  readonly agentNames: string[];
  /** How long to keep polling before giving up. Default: 15 minutes. */
  readonly totalTimeout?: Duration;
}

/** Returns immediately; all waiting happens in the isComplete handler. */
const ON_EVENT_CODE = `
def handler(event, context):
    # Stable physical id: updates must not trigger a Delete of the old id.
    return {"PhysicalResourceId": "memory-janitor"}
`;

/**
 * isComplete contract (CDK provider framework): {"IsComplete": bool}.
 * Create: complete when none of our names has a memory stuck in DELETING.
 * Delete: complete when no memory for our names exists at all.
 * Update: nothing to wait for.
 */
const IS_COMPLETE_CODE = `
import boto3

client = boto3.client("bedrock-agentcore-control")


def handler(event, context):
    request_type = event["RequestType"]
    if request_type == "Update":
        return {"IsComplete": True}
    names = set(event["ResourceProperties"]["AgentNames"])
    paginator = client.get_paginator("list_memories")
    for page in paginator.paginate():
        for memory in page.get("memories", []):
            # Memory ids look like "<harnessName>-<10charSuffix>".
            base = memory["id"].rsplit("-", 1)[0]
            if base not in names:
                continue
            if request_type == "Delete":
                # Still exists (any status): keep the stack delete open.
                return {"IsComplete": False}
            if memory.get("status") == "DELETING":
                # Leftover from a previous teardown/rollback: wait it out
                # before harnesses try to recreate the same name.
                return {"IsComplete": False}
    return {"IsComplete": True}
`;

export class MemoryJanitor extends Construct {
  /** Depend on this from each harness to get the create/delete ordering. */
  public readonly resource: CustomResource;

  constructor(scope: Construct, id: string, props: MemoryJanitorProps) {
    super(scope, id);

    const onEvent = new lambda.Function(this, 'OnEvent', {
      runtime: lambda.Runtime.PYTHON_3_13,
      handler: 'index.handler',
      code: lambda.Code.fromInline(ON_EVENT_CODE),
      timeout: Duration.seconds(30),
      description: 'Memory janitor: no-op event handler',
      logRetention: logs.RetentionDays.ONE_MONTH,
    });

    const isComplete = new lambda.Function(this, 'IsComplete', {
      runtime: lambda.Runtime.PYTHON_3_13,
      handler: 'index.handler',
      code: lambda.Code.fromInline(IS_COMPLETE_CODE),
      timeout: Duration.seconds(60),
      description:
        'Memory janitor: waits for async AgentCore memory deletion',
      logRetention: logs.RetentionDays.ONE_MONTH,
    });
    isComplete.addToRolePolicy(
      new iam.PolicyStatement({
        // ListMemories is a list operation and does not support
        // resource-level scoping — '*' is as tight as this one gets.
        actions: ['bedrock-agentcore:ListMemories'],
        resources: ['*'],
      }),
    );

    const provider = new cr.Provider(this, 'Provider', {
      onEventHandler: onEvent,
      isCompleteHandler: isComplete,
      queryInterval: Duration.seconds(15),
      totalTimeout: props.totalTimeout ?? Duration.minutes(15),
      logRetention: logs.RetentionDays.ONE_MONTH,
    });

    this.resource = new CustomResource(this, 'Resource', {
      serviceToken: provider.serviceToken,
      resourceType: 'Custom::AgentCoreMemoryJanitor',
      properties: {
        AgentNames: [...props.agentNames].sort(),
      },
    });
  }
}
