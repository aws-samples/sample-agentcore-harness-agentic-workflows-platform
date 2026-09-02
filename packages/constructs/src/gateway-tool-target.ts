/**
 * GatewayToolTarget — one tool as one unit.
 *
 * Composes the stable Gateway L2s: a Lambda handler + its MCP tool schema
 * registered as a Gateway target, with optional credential-provider
 * configurations (Secrets Manager-backed API keys via the token vault,
 * docs/decisions.md D-07).
 *
 * Cedar scoping: the `cedarScope` prop is accepted and recorded as target
 * metadata now; PolicyEngine wiring is a planned fast-follow (the stable
 * Gateway L2 in aws-cdk-lib 2.266.0 does not yet expose a policy-engine
 * association — tracked in docs/decisions.md).
 */
import * as agentcore from 'aws-cdk-lib/aws-bedrockagentcore';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { Construct } from 'constructs';

export interface GatewayToolTargetProps {
  /** The gateway this tool registers into. */
  readonly gateway: agentcore.IGateway;
  /** Tool handler Lambda (ported ToolExecutor logic). */
  readonly handler: lambda.IFunction;
  /** MCP tool schema (name/description/inputSchema definitions). */
  readonly toolSchema: agentcore.ToolSchema;
  /** Outbound credential configuration (API key / OAuth providers). */
  readonly credentialProviderConfigurations?: agentcore.ICredentialProviderConfig[];
  /** Agent names permitted to call this tool (future Cedar wiring). */
  readonly cedarScope?: string[];
}

export class GatewayToolTarget extends Construct {
  public readonly target: agentcore.GatewayTarget;
  /** Recorded scoping intent, consumed by the future PolicyEngine wiring. */
  public readonly cedarScope: string[];

  constructor(scope: Construct, id: string, props: GatewayToolTargetProps) {
    super(scope, id);

    this.cedarScope = props.cedarScope ?? [];
    this.target = new agentcore.GatewayTarget(this, 'Target', {
      gateway: props.gateway,
      targetConfiguration: agentcore.LambdaTargetConfiguration.create(
        props.handler,
        props.toolSchema,
      ),
      ...(props.credentialProviderConfigurations
        ? {
            credentialProviderConfigurations:
              props.credentialProviderConfigurations,
          }
        : {}),
    });
  }
}
