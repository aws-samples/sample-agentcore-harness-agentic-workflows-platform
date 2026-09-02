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
