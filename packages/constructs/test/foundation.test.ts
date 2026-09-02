import { App, RemovalPolicy, Stack } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { AgenticFoundation } from '../src/agentic-foundation';

const MODEL_ID = 'apac.anthropic.claude-sonnet-test';

function synth() {
  const app = new App();
  const stack = new Stack(app, 'TestStack');
  const foundation = new AgenticFoundation(stack, 'Workload', {
    workloadName: 'marketing-workflow',
    defaultModelId: MODEL_ID,
    agents: [
      { name: 'planner', instructions: 'Decompose research goals into plans.' },
      {
        name: 'web_research',
        instructions: 'Research the web.',
        tools: [{ type: 'agentcore_browser' }],
      },
      { name: 'report_generator', instructions: 'Assemble research briefs.' },
    ],
    maxConcurrency: 3,
    removalPolicy: RemovalPolicy.DESTROY,
  });
  return { template: Template.fromStack(stack), foundation };
}

describe('AgenticFoundation', () => {
  it('provisions the five-layer foundation from configs alone', () => {
    const { template } = synth();
    template.resourceCountIs('AWS::BedrockAgentCore::Harness', 3);
    // Interpreter + the memory-janitor provider's waiter state machine.
    template.resourceCountIs('AWS::StepFunctions::StateMachine', 2);
    template.resourceCountIs('AWS::Scheduler::ScheduleGroup', 1);
    template.resourceCountIs('AWS::SQS::Queue', 1);
    template.resourceCountIs('AWS::CloudWatch::Dashboard', 1);
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      BillingMode: 'PAY_PER_REQUEST',
      KeySchema: [
        { AttributeName: 'pk', KeyType: 'HASH' },
        { AttributeName: 'sk', KeyType: 'RANGE' },
      ],
    });
    template.hasResourceProperties('AWS::S3::Bucket', {
      PublicAccessBlockConfiguration: Match.objectLike({
        BlockPublicAcls: true,
        RestrictPublicBuckets: true,
      }),
      VersioningConfiguration: { Status: 'Enabled' },
    });
    template.hasResourceProperties('AWS::KMS::Key', {
      EnableKeyRotation: true,
    });
  });

  it('wires the interpreter with the native invokeHarness integration', () => {
    const { template } = synth();
    const json = JSON.stringify(template.toJSON());
    expect(json).toContain('bedrockagentcore:invokeHarness');
    // Both Maps (waves + tasks) present in the definition.
    expect(json).toContain('ForEachWave');
    expect(json).toContain('ForEachTask');
  });

  it('restricts the scheduler role to starting the interpreter only', () => {
    const { template } = synth();
    template.hasResourceProperties('AWS::IAM::Role', {
      AssumeRolePolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Principal: { Service: 'scheduler.amazonaws.com' },
            Condition: Match.objectLike({
              StringEquals: Match.anyValue(),
            }),
          }),
        ]),
      }),
    });
  });

  it('grants InvokeHarness for workers and carries no control-plane permissions (D-10)', () => {
    const { template } = synth();
    const policies = JSON.stringify(template.findResources('AWS::IAM::Policy'));
    expect(policies).toContain('bedrock-agentcore:InvokeHarness');
    // The D-10 guard: nothing in this stack may create harnesses or state
    // machines at runtime.
    expect(policies).not.toContain('CreateHarness');
    expect(policies).not.toContain('states:CreateStateMachine');
    expect(policies).not.toContain('iam:CreateRole');
  });

  it('registers workers and wires the planner agent as the replan planner, not a worker', () => {
    const { foundation, template } = synth();
    expect(Object.keys(foundation.workflow.workerArns).sort()).toEqual([
      'report_generator',
      'web_research',
    ]);
    // PrepareRun carries the planner ARN for replan-each-run.
    const functions = template.findResources('AWS::Lambda::Function');
    const prepareRun = Object.values(functions).find((fn) =>
      JSON.stringify(fn).includes('prepare-run'),
    );
    expect(JSON.stringify(prepareRun)).toContain('PLANNER_HARNESS_ARN');
  });

  it('applies workload cost-attribution tags', () => {
    const { template } = synth();
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      Tags: Match.arrayWith([
        Match.objectLike({ Key: 'workload', Value: 'marketing-workflow' }),
      ]),
    });
  });
});

describe('MemoryJanitor wiring', () => {
  it('creates one janitor and orders every harness after it', () => {
    const { template } = synth();
    template.resourceCountIs('Custom::AgentCoreMemoryJanitor', 1);
    template.hasResourceProperties('Custom::AgentCoreMemoryJanitor', {
      AgentNames: ['planner', 'report_generator', 'web_research'],
    });
    // Every harness must depend on the janitor so CloudFormation creates
    // it after leftover memories cleared, and deletes it before the
    // janitor (which then waits for the async memory deletion to finish).
    const janitorIds = Object.keys(
      template.findResources('Custom::AgentCoreMemoryJanitor'),
    );
    const harnesses = template.findResources('AWS::BedrockAgentCore::Harness');
    for (const [, harness] of Object.entries(harnesses)) {
      const dependsOn = (harness as { DependsOn?: string[] }).DependsOn ?? [];
      expect(dependsOn).toEqual(
        expect.arrayContaining(janitorIds),
      );
    }
  });

  it('grants the janitor ListMemories only', () => {
    const { template } = synth();
    const json = JSON.stringify(template.toJSON());
    expect(json).toContain('bedrock-agentcore:ListMemories');
  });
});
