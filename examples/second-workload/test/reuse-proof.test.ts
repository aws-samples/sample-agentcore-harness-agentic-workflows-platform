import { App, RemovalPolicy } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { CompetitorSnapshotStack } from '../lib/competitor-snapshot-stack';

describe('Reuse proof', () => {
  it('a second workload deploys from published constructs + config only', () => {
    const app = new App();
    const stack = new CompetitorSnapshotStack(app, 'Snapshot', {
      defaultModelId: 'apac.anthropic.claude-sonnet-test',
      gatewayArn:
        'arn:aws:bedrock-agentcore:ap-southeast-2:123456789012:gateway/marketing-tools-abcdefghij',
      removalPolicy: RemovalPolicy.DESTROY,
      env: { account: '123456789012', region: 'ap-southeast-2' },
    });
    const template = Template.fromStack(stack);

    // Complete workload: agents, interpreter, scheduling, observability.
    template.resourceCountIs('AWS::BedrockAgentCore::Harness', 3);
    // Interpreter + the memory-janitor provider's waiter state machine.
    template.resourceCountIs('AWS::StepFunctions::StateMachine', 2);
    template.resourceCountIs('AWS::Scheduler::ScheduleGroup', 1);
    template.resourceCountIs('AWS::CloudWatch::Dashboard', 1);
    template.resourceCountIs('AWS::DynamoDB::Table', 1);

    // Distinct workload identity (tags → cost attribution).
    const tables = JSON.stringify(template.findResources('AWS::DynamoDB::Table'));
    expect(tables).toContain('competitor-snapshot');

    // Same governance posture as the first workload (D10).
    const policies = JSON.stringify(template.findResources('AWS::IAM::Policy'));
    expect(policies).not.toContain('CreateHarness');
    expect(policies).not.toContain('states:CreateStateMachine');
  });
});
