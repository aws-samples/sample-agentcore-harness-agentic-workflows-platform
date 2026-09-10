import { App, RemovalPolicy } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { MarketingWorkflowStack } from '../lib/marketing-workflow-stack';

const MODEL_ID = 'apac.anthropic.claude-sonnet-test';

function synth(): Template {
  const app = new App();
  const stack = new MarketingWorkflowStack(app, 'MarketingWorkflowTest', {
    defaultModelId: MODEL_ID,
    removalPolicy: RemovalPolicy.DESTROY,
    deployWebapp: false,
    env: { account: '123456789012', region: 'ap-southeast-2' },
  });
  return Template.fromStack(stack);
}

describe('MarketingWorkflowStack', () => {
  it('provisions the full marketing-workflow workload from configuration alone', () => {
    const template = synth();
    // 10 agents: planner + product_expert + 5 marketing workers + strategist
    // + report generator + report_chat (API-only, not a worker).
    template.resourceCountIs('AWS::BedrockAgentCore::Harness', 10);
    template.resourceCountIs('AWS::BedrockAgentCore::Gateway', 1);
    // Independent tool targets (D-25): Tavily's hosted MCP server + one
    // Lambda target per executor tool (incl. the Python currency_rates).
    template.resourceCountIs('AWS::BedrockAgentCore::GatewayTarget', 4);
    template.resourceCountIs('AWS::BedrockAgentCore::ApiKeyCredentialProvider', 1);
    // Interpreter + the memory-janitor provider's waiter state machine.
    template.resourceCountIs('AWS::StepFunctions::StateMachine', 2);
    template.resourceCountIs('AWS::ApiGatewayV2::Api', 1);
    template.resourceCountIs('AWS::Cognito::UserPool', 1);
    template.resourceCountIs('AWS::Scheduler::ScheduleGroup', 1);
  });

  it('keeps report_chat out of the worker map but wires it to the API router', () => {
    const template = synth();
    const functions = template.findResources('AWS::Lambda::Function');
    const router = Object.values(functions).find((fn) =>
      JSON.stringify(fn).includes('workflow/schedule/run/artifact routes'),
    );
    const routerJson = JSON.stringify(router);
    expect(routerJson).toContain('REPORT_CHAT_HARNESS_ARN');
    // WORKER_HARNESS_MAP is a JSON string in env; the reserved agents must
    // not appear as keys in it.
    const envVars = (router as { Properties: { Environment: { Variables: Record<string, unknown> } } })
      .Properties.Environment.Variables;
    const workerMap = JSON.stringify(envVars.WORKER_HARNESS_MAP);
    expect(workerMap).toContain('report_generator');
    expect(workerMap).not.toContain('report_chat');
    expect(workerMap).not.toContain('"planner"');
  });

  it('fronts the IAM streaming chat URL with CloudFront OAC as a same-origin /chat/* behavior (D-30)', () => {
    const app = new App();
    const stack = new MarketingWorkflowStack(app, 'WithWebapp', {
      defaultModelId: MODEL_ID,
      removalPolicy: RemovalPolicy.DESTROY,
      // deployWebapp defaults to true; only takes effect when the SPA dist
      // exists, so guard the assertions on that.
      env: { account: '123456789012', region: 'ap-southeast-2' },
    });
    const template = Template.fromStack(stack);
    const distributions = template.findResources('AWS::CloudFront::Distribution');
    if (Object.keys(distributions).length === 0) {
      return; // webapp not built in this environment — nothing to assert
    }
    const dist = JSON.stringify(Object.values(distributions)[0]);
    expect(dist).toContain('"PathPattern":"/chat/*"');
    // A Lambda-URL origin with an OAC attached, no caching.
    template.hasResourceProperties('AWS::CloudFront::OriginAccessControl', {
      OriginAccessControlConfig: Match.objectLike({
        OriginAccessControlOriginType: 'lambda',
        SigningBehavior: 'always',
        SigningProtocol: 'sigv4',
      }),
    });
    // OAC on a Lambda URL needs BOTH InvokeFunctionUrl and InvokeFunction for
    // the distribution principal (AWS docs; CDK adds only the first) — and
    // nothing anonymous.
    const cfPermissions = Object.values(template.findResources('AWS::Lambda::Permission'))
      .map((p) => (p as { Properties: { Principal: string; Action: string } }).Properties)
      .filter((p) => p.Principal === 'cloudfront.amazonaws.com')
      .map((p) => p.Action)
      .sort();
    expect(cfPermissions).toEqual(['lambda:InvokeFunction', 'lambda:InvokeFunctionUrl']);
    const permissions = JSON.stringify(template.findResources('AWS::Lambda::Permission'));
    expect(permissions).not.toContain('"FunctionUrlAuthType":"NONE"');
    template.hasResourceProperties('AWS::Lambda::Url', { AuthType: 'AWS_IAM' });
  });

  it('never exposes a Lambda publicly in the whole stack, with or without the webapp (threat model T004)', () => {
    // Runs even when the SPA dist is absent (the CI case) — the guard must
    // not depend on the webapp being built. A NONE-auth Function URL was
    // stripped by account guardrails within minutes during development
    // (D-30); this keeps it from being reintroduced silently.
    const template = Template.fromStack(
      new MarketingWorkflowStack(new App(), 'PublicExposureGuard', {
        defaultModelId: MODEL_ID,
        removalPolicy: RemovalPolicy.DESTROY,
        env: { account: '123456789012', region: 'ap-southeast-2' },
      }),
    );
    const urls = Object.values(template.findResources('AWS::Lambda::Url')) as Array<{
      Properties: { AuthType: string };
    }>;
    expect(urls.length).toBeGreaterThan(0); // the chat stream URL exists
    for (const url of urls) expect(url.Properties.AuthType).toBe('AWS_IAM');

    const permissions = Object.values(template.findResources('AWS::Lambda::Permission')) as Array<{
      Properties: { Principal: unknown; FunctionUrlAuthType?: string; SourceArn?: unknown; SourceAccount?: unknown };
    }>;
    expect(permissions.length).toBeGreaterThan(0);
    for (const { Properties: p } of permissions) {
      expect(p.Principal).not.toBe('*');
      expect(p.FunctionUrlAuthType).not.toBe('NONE');
      if (typeof p.Principal === 'string' && p.Principal.endsWith('.amazonaws.com')) {
        // e.g. cloudfront.amazonaws.com must be pinned to THIS distribution.
        expect(p.SourceArn ?? p.SourceAccount).toBeDefined();
      }
    }
  });

  it('registers the default tool subset and leaves patent_search unregistered', () => {
    const template = synth();
    const targets = JSON.stringify(
      template.findResources('AWS::BedrockAgentCore::GatewayTarget'),
    );
    // tavily_search arrives via Tavily's hosted MCP server, not a Lambda.
    template.hasResourceProperties('AWS::BedrockAgentCore::GatewayTarget', {
      TargetConfiguration: {
        Mcp: { McpServer: { Endpoint: 'https://mcp.tavily.com/mcp/' } },
      },
      CredentialProviderConfigurations: Match.arrayWith([
        Match.objectLike({ CredentialProviderType: 'API_KEY' }),
      ]),
    });
    expect(targets).toContain('news_search');
    expect(targets).toContain('social_search');
    expect(targets).toContain('currency_rates');
    expect(targets).not.toContain('patent_search');
  });

  it('runs the Python-authored tool on the Python runtime with no bundling (docs/python-developers.md)', () => {
    const template = synth();
    template.hasResourceProperties('AWS::Lambda::Function', {
      Runtime: 'python3.13',
      Handler: 'handlers.currency_rates.handler',
      Description: 'marketing-workflow gateway tool: currency_rates (Python, keyless)',
    });
  });

  it('gives each executor tool its own Lambda with exactly its own secret (D-25)', () => {
    const template = synth();
    const policies = JSON.stringify(template.findResources('AWS::IAM::Policy'));
    for (const secret of [
      'marketing-workflow/newsapi-api-key-*',
      'marketing-workflow/ensembledata-api-key-*',
    ]) {
      expect(policies).toContain(secret);
    }
    // The old shared-role wildcard is gone.
    expect(policies).not.toContain('marketing-workflow/*');
    // One function per executor tool.
    const fns = JSON.stringify(template.findResources('AWS::Lambda::Function'));
    for (const tool of ['news_search', 'social_search']) {
      expect(fns).toContain(`marketing-workflow gateway tool: ${tool}`);
    }
  });

  it('scopes worker harnesses: gateway + browser for research, analytics gets the code interpreter, experts get no tools', () => {
    const template = synth();
    template.hasResourceProperties('AWS::BedrockAgentCore::Harness', {
      HarnessName: 'audience_insight',
      Tools: Match.arrayWith([
        Match.objectLike({ Type: 'agentcore_gateway' }),
        Match.objectLike({ Type: 'agentcore_browser' }),
      ]),
      // D-24: any concrete AllowedTools list makes the service expose ZERO
      // tools (and the field is sticky once set); '*' is the only working,
      // update-safe value. Per-tool scoping stays at the catalog/plan level.
      AllowedTools: ['*'],
    });
    template.hasResourceProperties('AWS::BedrockAgentCore::Harness', {
      HarnessName: 'market_analytics',
      Tools: Match.arrayWith([
        Match.objectLike({ Type: 'agentcore_gateway' }),
        Match.objectLike({ Type: 'agentcore_code_interpreter' }),
      ]),
      AllowedTools: ['*'],
    });
    // Knowledge/synthesis agents carry no tools at all (and therefore no
    // Tools/AllowedTools fields — the base, override-free invoke path).
    const harnesses = template.findResources('AWS::BedrockAgentCore::Harness');
    for (const name of ['product_expert', 'campaign_strategist']) {
      const harness = Object.values(harnesses).find(
        (resource) => resource.Properties.HarnessName === name,
      );
      expect(harness, `harness ${name}`).toBeDefined();
      expect(harness!.Properties.Tools).toBeUndefined();
    }
    template.hasResourceProperties('AWS::BedrockAgentCore::Harness', {
      HarnessName: 'planner',
      SystemPrompt: [
        { Text: Match.stringLikeRegexp('ONLY the JSON object') },
      ],
    });
  });

  it('keeps the D10 posture across the whole app stack', () => {
    const template = synth();
    const policies = JSON.stringify(template.findResources('AWS::IAM::Policy'));
    expect(policies).not.toContain('CreateHarness');
    expect(policies).not.toContain('states:CreateStateMachine');
    expect(policies).not.toContain('iam:CreateRole');
  });

});
