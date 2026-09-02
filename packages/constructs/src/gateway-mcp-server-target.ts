/**
 * GatewayMcpServerTarget — a vendor-hosted (remote) MCP server as a gateway
 * target, no Lambda in between.
 *
 * Complements GatewayToolTarget (Lambda-backed executors): when a tool
 * provider already speaks MCP (e.g. Tavily's hosted server), the gateway
 * federates it directly. The provider's tools appear in the gateway's
 * tools/list under this target's prefix exactly like Lambda-target tools.
 *
 * API-key auth uses the AgentCore token vault: an ApiKeyCredentialProvider
 * holds the key (sourced from a SecretValue — pass a Secrets Manager
 * reference, never a literal) and the gateway injects it per request as a
 * header or query parameter. Agents and harness roles never see the key,
 * preserving the same credential-isolation property as the Lambda path.
 */
import * as agentcore from 'aws-cdk-lib/aws-bedrockagentcore';
import type { SecretValue } from 'aws-cdk-lib';
import { Construct } from 'constructs';

export interface GatewayMcpServerApiKeyAuth {
  /**
   * The API key. Use SecretValue.secretsManager(...) so the key material
   * stays out of the synthesized template (resolved by CloudFormation at
   * deploy time; the referenced secret must exist).
   */
  readonly key: SecretValue;
  /**
   * Where the gateway injects the key on outbound calls. Default:
   * Authorization header. For servers keyed by query parameter, pass
   * agentcore.ApiKeyCredentialLocation.queryParameter({
   *   credentialParameterName: '<param>' }).
   */
  readonly location?: agentcore.ApiKeyCredentialLocation;
  /** Token-vault provider name. Default: CDK-generated. */
  readonly providerName?: string;
}

export interface GatewayMcpServerTargetProps {
  /** The gateway this MCP server registers into. */
  readonly gateway: agentcore.IGateway;
  /** HTTPS endpoint of the remote MCP server, e.g. https://mcp.tavily.com/mcp/ */
  readonly endpoint: string;
  /** API-key auth. Omit for servers that need no credentials. */
  readonly apiKey?: GatewayMcpServerApiKeyAuth;
  /** Agent names permitted to call these tools (future Cedar wiring). */
  readonly cedarScope?: string[];
}

export class GatewayMcpServerTarget extends Construct {
  public readonly target: agentcore.GatewayTarget;
  /** Present when apiKey auth is configured. */
  public readonly credentialProvider?: agentcore.ApiKeyCredentialProvider;
  /** Recorded scoping intent, consumed by the future PolicyEngine wiring. */
  public readonly cedarScope: string[];

  constructor(scope: Construct, id: string, props: GatewayMcpServerTargetProps) {
    super(scope, id);

    this.cedarScope = props.cedarScope ?? [];

    let credentialConfigs: agentcore.ICredentialProviderConfig[] | undefined;
    if (props.apiKey) {
      this.credentialProvider = new agentcore.ApiKeyCredentialProvider(
        this,
        'ApiKey',
        {
          apiKey: props.apiKey.key,
          ...(props.apiKey.providerName
            ? { apiKeyCredentialProviderName: props.apiKey.providerName }
            : {}),
        },
      );
      credentialConfigs = [
        agentcore.GatewayCredentialProvider.fromApiKeyIdentity(
          this.credentialProvider,
          props.apiKey.location
            ? { credentialLocation: props.apiKey.location }
            : {},
        ),
      ];
    }

    this.target = new agentcore.GatewayTarget(this, 'Target', {
      gateway: props.gateway,
      targetConfiguration: agentcore.McpServerTargetConfiguration.create(
        props.endpoint,
      ),
      ...(credentialConfigs
        ? { credentialProviderConfigurations: credentialConfigs }
        : {}),
    });
  }
}
