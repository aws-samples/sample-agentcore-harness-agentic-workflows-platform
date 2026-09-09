import { App, RemovalPolicy, Stack } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { AgenticFoundation } from '@agentic-platform/constructs';
import { describe, expect, it } from 'vitest';
import { AgenticApi } from '../src/agentic-api';

const MODEL_ID = 'apac.anthropic.claude-sonnet-test';

function synth() {
  const app = new App();
  const stack = new Stack(app, 'ApiTestStack');
  const foundation = new AgenticFoundation(stack, 'Workload', {
    workloadName: 'marketing-workflow',
    defaultModelId: MODEL_ID,
    agents: [
      { name: 'planner', instructions: 'Decompose goals into plans.' },
      { name: 'web_research', instructions: 'Research the web.' },
      { name: 'report_generator', instructions: 'Assemble briefs.' },
      { name: 'report_chat', instructions: 'Answer questions about reports.' },
    ],
    removalPolicy: RemovalPolicy.DESTROY,
  });
  const api = new AgenticApi(stack, 'Api', { foundation });
  return { template: Template.fromStack(stack), api };
}

describe('AgenticApi', () => {
  it('provisions HTTP API with a Cognito JWT authorizer on every route', () => {
    const { template } = synth();
    template.resourceCountIs('AWS::ApiGatewayV2::Api', 1);
    template.hasResourceProperties('AWS::ApiGatewayV2::Authorizer', {
      AuthorizerType: 'JWT',
    });
    template.hasResourceProperties('AWS::ApiGatewayV2::Route', {
      RouteKey: 'GET /{proxy+}',
      AuthorizationType: 'JWT',
    });
    template.hasResourceProperties('AWS::ApiGatewayV2::Route', {
      RouteKey: 'POST /{proxy+}',
      AuthorizationType: 'JWT',
    });
    // No OPTIONS route: preflights must fall through to the built-in CORS
    // handler, or the JWT authorizer 401s them (D-16).
    const routes = JSON.stringify(
      template.findResources('AWS::ApiGatewayV2::Route'),
    );
    expect(routes).not.toContain('OPTIONS /{proxy+}');
    expect(routes).not.toContain('ANY /{proxy+}');
    template.resourceCountIs('AWS::Cognito::UserPool', 1);
    template.hasResourceProperties('AWS::Cognito::UserPoolClient', {
      ExplicitAuthFlows: Match.arrayWith(['ALLOW_USER_PASSWORD_AUTH']),
    });
  });

  it('scopes the router to the narrow runtime surface', () => {
    const { template } = synth();
    const policies = JSON.stringify(template.findResources('AWS::IAM::Policy'));
    // Allowed narrow surface:
    expect(policies).toContain('scheduler:CreateSchedule');
    expect(policies).toContain('states:StartExecution');
    expect(policies).toContain('iam:PassedToService');
    // Forbidden control plane:
    expect(policies).not.toContain('CreateHarness');
    expect(policies).not.toContain('states:CreateStateMachine');
    expect(policies).not.toContain('iam:CreateRole');
    expect(policies).not.toContain('lambda:CreateFunction');
  });

  it('wires planner drafting: planner-job can invoke ONLY the planner harness', () => {
    const { template } = synth();
    const policies = template.findResources('AWS::IAM::Policy');
    const plannerJobPolicy = Object.values(policies).find((policy) =>
      JSON.stringify(policy).includes('PlannerJobFn'),
    );
    expect(JSON.stringify(plannerJobPolicy)).toContain(
      'bedrock-agentcore:InvokeHarness',
    );
  });

  it('grants the router harness invoke on ONLY the report_chat harness', () => {
    const { template } = synth();
    const policies = template.findResources('AWS::IAM::Policy');
    const routerPolicy = Object.values(policies).find((policy) =>
      JSON.stringify(policy).includes('RouterFn'),
    );
    const routerPolicyJson = JSON.stringify(routerPolicy);
    expect(routerPolicyJson).toContain('bedrock-agentcore:InvokeHarness');
    expect(routerPolicyJson).toContain('bedrock-agentcore:InvokeAgentRuntime');
    // Resolve logical ids by HarnessName so the assertion doesn't depend on
    // construct-path naming.
    const harnesses = template.findResources('AWS::BedrockAgentCore::Harness');
    const logicalIdFor = (name: string) =>
      Object.entries(harnesses).find(
        ([, res]) => (res as { Properties: { HarnessName: string } }).Properties.HarnessName === name,
      )![0];
    expect(routerPolicyJson).toContain(logicalIdFor('report_chat'));
    // Workers and the planner are never invokable from the API router.
    expect(routerPolicyJson).not.toContain(logicalIdFor('report_generator'));
    expect(routerPolicyJson).not.toContain(logicalIdFor('web_research'));
    expect(routerPolicyJson).not.toContain(logicalIdFor('planner'));
    // Router learns the chat harness via env.
    const functions = template.findResources('AWS::Lambda::Function');
    const router = Object.values(functions).find((fn) =>
      JSON.stringify(fn).includes('workflow/schedule/run/artifact routes'),
    );
    expect(JSON.stringify(router)).toContain('REPORT_CHAT_HARNESS_ARN');
  });

  it('provisions a response-streaming Function URL for chat with a read-only, single-harness grant (D-30)', () => {
    const { template, api } = synth();
    expect(api.chatStreamUrl).toBeDefined();
    template.resourceCountIs('AWS::Lambda::Url', 1);
    template.hasResourceProperties('AWS::Lambda::Url', {
      AuthType: 'NONE',
      InvokeMode: 'RESPONSE_STREAM',
      Cors: Match.objectLike({
        AllowMethods: ['POST'],
        AllowHeaders: ['authorization', 'content-type'],
      }),
    });
    // The public-invoke permission Lambda needs for a NONE-auth URL.
    template.hasResourceProperties('AWS::Lambda::Permission', {
      Action: 'lambda:InvokeFunctionUrl',
      Principal: '*',
      FunctionUrlAuthType: 'NONE',
    });
    const functions = template.findResources('AWS::Lambda::Function');
    const streamFn = Object.values(functions).find((fn) =>
      JSON.stringify(fn).includes('streaming report chat'),
    )!;
    const env = (streamFn as { Properties: { Environment: { Variables: Record<string, unknown> } } })
      .Properties.Environment.Variables;
    // In-handler JWT verification needs the pool + client; no write targets.
    expect(Object.keys(env).sort()).toEqual([
      'BUCKET_NAME',
      'CORS_ORIGIN',
      'REPORT_CHAT_HARNESS_ARN',
      'TABLE_NAME',
      'USER_POOL_CLIENT_ID',
      'USER_POOL_ID',
    ]);
    const policies = template.findResources('AWS::IAM::Policy');
    const streamPolicy = JSON.stringify(
      Object.values(policies).find((policy) => JSON.stringify(policy).includes('ChatStreamFn')),
    );
    expect(streamPolicy).toContain('bedrock-agentcore:InvokeHarness');
    expect(streamPolicy).toContain('dynamodb:GetItem');
    expect(streamPolicy).toContain('s3:GetObject');
    // Read-only: no table writes, no bucket writes, no state machine.
    expect(streamPolicy).not.toContain('dynamodb:PutItem');
    expect(streamPolicy).not.toContain('dynamodb:UpdateItem');
    expect(streamPolicy).not.toContain('s3:PutObject');
    expect(streamPolicy).not.toContain('states:');
  });

  it('synthesizes without report_chat (chat route disabled, no invoke grant)', () => {
    const app = new App();
    const stack = new Stack(app, 'NoChat');
    const foundation = new AgenticFoundation(stack, 'F', {
      workloadName: 'x',
      defaultModelId: MODEL_ID,
      agents: [
        { name: 'planner', instructions: 'plan' },
        { name: 'worker', instructions: 'work' },
      ],
      removalPolicy: RemovalPolicy.DESTROY,
    });
    new AgenticApi(stack, 'Api', { foundation });
    const template = Template.fromStack(stack);
    const routerPolicy = Object.values(template.findResources('AWS::IAM::Policy')).find(
      (policy) => JSON.stringify(policy).includes('RouterFn'),
    );
    expect(JSON.stringify(routerPolicy)).not.toContain('bedrock-agentcore:InvokeHarness');
    const router = Object.values(template.findResources('AWS::Lambda::Function')).find(
      (fn) => JSON.stringify(fn).includes('workflow/schedule/run/artifact routes'),
    );
    expect(JSON.stringify(router)).not.toContain('REPORT_CHAT_HARNESS_ARN');
    // No streaming endpoint either.
    template.resourceCountIs('AWS::Lambda::Url', 0);
  });

  it('mounts additionalRoutes behind the same JWT authorizer (python-developers seam)', () => {
    const app = new App();
    const stack = new Stack(app, 'ExtraRoutes');
    const foundation = new AgenticFoundation(stack, 'F', {
      workloadName: 'x',
      defaultModelId: MODEL_ID,
      agents: [
        { name: 'planner', instructions: 'plan' },
        { name: 'worker', instructions: 'work' },
      ],
      removalPolicy: RemovalPolicy.DESTROY,
    });
    const featureFn = new lambda.Function(stack, 'FeatureFn', {
      runtime: lambda.Runtime.PYTHON_3_13,
      handler: 'index.handler',
      code: lambda.Code.fromInline('def handler(e, c): return {}'),
    });
    new AgenticApi(stack, 'Api', {
      foundation,
      additionalRoutes: [
        { method: apigwv2.HttpMethod.GET, path: '/reports/summary', handler: featureFn },
      ],
    });
    const template = Template.fromStack(stack);
    template.hasResourceProperties('AWS::ApiGatewayV2::Route', {
      RouteKey: 'GET /reports/summary',
      AuthorizationType: 'JWT',
    });
  });

  it('rejects additionalRoutes that shadow platform prefixes', () => {
    const app = new App();
    const stack = new Stack(app, 'ShadowRoutes');
    const foundation = new AgenticFoundation(stack, 'F', {
      workloadName: 'x',
      defaultModelId: MODEL_ID,
      agents: [
        { name: 'planner', instructions: 'plan' },
        { name: 'worker', instructions: 'work' },
      ],
      removalPolicy: RemovalPolicy.DESTROY,
    });
    const featureFn = new lambda.Function(stack, 'FeatureFn', {
      runtime: lambda.Runtime.PYTHON_3_13,
      handler: 'index.handler',
      code: lambda.Code.fromInline('def handler(e, c): return {}'),
    });
    expect(
      () =>
        new AgenticApi(stack, 'Api', {
          foundation,
          additionalRoutes: [
            {
              method: apigwv2.HttpMethod.DELETE,
              path: '/workflows/backdoor',
              handler: featureFn,
            },
          ],
        }),
    ).toThrow(/shadows the platform's \/workflows routes/);
  });

  it('throws without a planner agent', () => {
    const app = new App();
    const stack = new Stack(app, 'NoPlanner');
    const foundation = new AgenticFoundation(stack, 'F', {
      workloadName: 'x',
      defaultModelId: MODEL_ID,
      agents: [{ name: 'web_research', instructions: 'r' }],
      removalPolicy: RemovalPolicy.DESTROY,
    });
    expect(() => new AgenticApi(stack, 'Api', { foundation })).toThrow(
      /planner/,
    );
  });
});
