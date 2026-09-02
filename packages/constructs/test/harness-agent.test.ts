import { App, Stack } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import * as iam from 'aws-cdk-lib/aws-iam';
import { describe, expect, it } from 'vitest';
import { HarnessAgent } from '../src/harness-agent';

const MODEL_ID = 'apac.anthropic.claude-sonnet-test';
const GATEWAY_ARN =
  'arn:aws:bedrock-agentcore:ap-southeast-2:123456789012:gateway/marketing-tools-abcdefghij';

function stack(): Stack {
  return new Stack(new App(), 'TestStack');
}

describe('HarnessAgent', () => {
  it('renders a CfnHarness from the typed config', () => {
    const s = stack();
    new HarnessAgent(s, 'Worker', {
      config: {
        name: 'web_research',
        instructions: 'You research the web for the company.',
        modelId: MODEL_ID,
        temperature: 0.4,
        tools: [
          { type: 'agentcore_gateway', gatewayArn: GATEWAY_ARN },
          { type: 'agentcore_browser' },
        ],
        memory: { enabled: true, eventExpiryDays: 30 },
        limits: { maxIterations: 30, timeoutSeconds: 1800, maxTokens: 8192 },
      },
    });

    const template = Template.fromStack(s);
    template.resourceCountIs('AWS::BedrockAgentCore::Harness', 1);
    template.hasResourceProperties('AWS::BedrockAgentCore::Harness', {
      HarnessName: 'web_research',
      SystemPrompt: [{ Text: 'You research the web for the company.' }],
      Model: {
        BedrockModelConfig: Match.objectLike({
          ModelId: MODEL_ID,
          Temperature: 0.4,
          MaxTokens: 8192,
        }),
      },
      MaxIterations: 30,
      TimeoutSeconds: 1800,
      Memory: {
        ManagedMemoryConfiguration: Match.objectLike({
          Strategies: ['SEMANTIC'],
          EventExpiryDuration: 30,
        }),
      },
      Tools: Match.arrayWith([
        Match.objectLike({
          Type: 'agentcore_gateway',
          Config: { AgentCoreGateway: { GatewayArn: GATEWAY_ARN } },
        }),
        Match.objectLike({ Type: 'agentcore_browser' }),
      ]),
    });
  });

  it('disables cross-session memory when memory is not opted in', () => {
    const s = stack();
    new HarnessAgent(s, 'Worker', {
      config: { name: 'planner', instructions: 'You plan.', modelId: MODEL_ID },
    });
    // Omitting Memory lets the service default to [SEMANTIC, SUMMARIZATION];
    // SEMANTIC leaks actor-scoped facts across sessions (live-verified
    // cross-workflow contamination). CFN requires ≥1 strategy, so non-opted
    // agents pin session-scoped SUMMARIZATION only.
    Template.fromStack(s).hasResourceProperties(
      'AWS::BedrockAgentCore::Harness',
      {
        Memory: { ManagedMemoryConfiguration: { Strategies: ['SUMMARIZATION'] } },
      },
    );
  });

  it('creates an execution role scoped to the declared tool families', () => {
    const s = stack();
    new HarnessAgent(s, 'Worker', {
      config: {
        name: 'web_research',
        instructions: 'x',
        modelId: MODEL_ID,
        tools: [{ type: 'agentcore_gateway', gatewayArn: GATEWAY_ARN }],
      },
    });
    const template = Template.fromStack(s);
    template.hasResourceProperties('AWS::IAM::Role', {
      AssumeRolePolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Principal: { Service: 'bedrock-agentcore.amazonaws.com' },
          }),
        ]),
      }),
    });
    const policies = JSON.stringify(template.findResources('AWS::IAM::Policy'));
    expect(policies).toContain('bedrock-agentcore:InvokeGateway');
    // No browser/code-interpreter permissions when those tools are absent.
    expect(policies).not.toContain('StartBrowserSession');
    expect(policies).not.toContain('InvokeCodeInterpreter');
  });

  it('throws when neither config.modelId nor defaultModelId is provided', () => {
    expect(
      () =>
        new HarnessAgent(stack(), 'Worker', {
          config: { name: 'no_model', instructions: 'x' },
        }),
    ).toThrow(/no modelId/);
  });

  it('rejects invalid configs at synth time (zod)', () => {
    expect(
      () =>
        new HarnessAgent(stack(), 'Worker', {
          config: { name: '9 bad name!', instructions: 'x', modelId: MODEL_ID },
        }),
    ).toThrow();
  });

  it('grantInvoke grants InvokeHarness on the harness and endpoints', () => {
    const s = stack();
    const agent = new HarnessAgent(s, 'Worker', {
      config: { name: 'w', instructions: 'x', modelId: MODEL_ID },
    });
    const role = new iam.Role(s, 'Caller', {
      assumedBy: new iam.ServicePrincipal('states.amazonaws.com'),
    });
    agent.grantInvoke(role);
    const policies = JSON.stringify(
      Template.fromStack(s).findResources('AWS::IAM::Policy'),
    );
    expect(policies).toContain('bedrock-agentcore:InvokeHarness');
  });
});
