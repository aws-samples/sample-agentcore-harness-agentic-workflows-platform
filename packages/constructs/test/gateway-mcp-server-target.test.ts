import { App, SecretValue, Stack } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import * as agentcore from 'aws-cdk-lib/aws-bedrockagentcore';
import { describe, expect, it } from 'vitest';
import { GatewayMcpServerTarget } from '../src/gateway-mcp-server-target';

function synth(build: (stack: Stack, gateway: agentcore.Gateway) => void): Template {
  const app = new App();
  const stack = new Stack(app, 'Test');
  const gateway = new agentcore.Gateway(stack, 'Gw', {
    gatewayName: 'test-tools',
    authorizerConfiguration: new agentcore.IamAuthorizer(),
  });
  build(stack, gateway);
  return Template.fromStack(stack);
}

describe('GatewayMcpServerTarget', () => {
  it('registers a remote MCP server with query-parameter API-key auth', () => {
    const template = synth((stack, gateway) => {
      new GatewayMcpServerTarget(stack, 'Tavily', {
        gateway,
        endpoint: 'https://mcp.tavily.com/mcp/',
        apiKey: {
          key: SecretValue.secretsManager('marketing-workflow/tavily-api-key'),
          location: agentcore.ApiKeyCredentialLocation.queryParameter({
            credentialParameterName: 'tavilyApiKey',
          }),
        },
      });
    });

    // Token-vault provider holds the key (no Lambda anywhere).
    template.resourceCountIs('AWS::BedrockAgentCore::ApiKeyCredentialProvider', 1);
    template.resourceCountIs('AWS::Lambda::Function', 0);

    template.hasResourceProperties('AWS::BedrockAgentCore::GatewayTarget', {
      TargetConfiguration: {
        Mcp: { McpServer: { Endpoint: 'https://mcp.tavily.com/mcp/' } },
      },
      CredentialProviderConfigurations: Match.arrayWith([
        Match.objectLike({
          CredentialProviderType: 'API_KEY',
          CredentialProvider: Match.objectLike({
            ApiKeyCredentialProvider: Match.objectLike({
              CredentialLocation: 'QUERY_PARAMETER',
              CredentialParameterName: 'tavilyApiKey',
            }),
          }),
        }),
      ]),
    });
  });

  it('supports keyless MCP servers (no credential provider emitted)', () => {
    const template = synth((stack, gateway) => {
      new GatewayMcpServerTarget(stack, 'Public', {
        gateway,
        endpoint: 'https://mcp.example.com/mcp',
      });
    });
    template.resourceCountIs('AWS::BedrockAgentCore::ApiKeyCredentialProvider', 0);
    template.hasResourceProperties('AWS::BedrockAgentCore::GatewayTarget', {
      TargetConfiguration: {
        Mcp: { McpServer: { Endpoint: 'https://mcp.example.com/mcp' } },
      },
    });
  });

  it('rejects non-HTTPS endpoints', () => {
    expect(() =>
      synth((stack, gateway) => {
        new GatewayMcpServerTarget(stack, 'Bad', {
          gateway,
          endpoint: 'http://insecure.example.com/mcp',
        });
      }),
    ).toThrow(/HTTPS/);
  });
});
