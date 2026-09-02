/**
 * MarketingWorkflowStack — the marketing-workflow reference workload: first instantiation of the
 * pattern, full stack in ap-southeast-2:
 *
 *   Gateway (IAM/SigV4) + per-tool targets (Tavily via its hosted MCP
 *   server; one Lambda per executor tool, exact-secret IAM)  →  5 harness agents
 *   →  AgenticFoundation (interpreter, scheduler, observability)
 *   →  AgenticApi (Cognito + HTTP API)  →  webapp hosting (CloudFront + S3)
 *
 * Everything here is configuration over published constructs — no construct
 * code is modified (the A1.10 reuse property).
 */
import * as path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import {
  ArnFormat,
  CfnOutput,
  Duration,
  RemovalPolicy,
  SecretValue,
  Stack,
  type StackProps,
} from 'aws-cdk-lib';
import * as agentcore from 'aws-cdk-lib/aws-bedrockagentcore';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import type { Construct } from 'constructs';
import {
  AgenticFoundation,
  GatewayMcpServerTarget,
  GatewayToolTarget,
  loadWorkloadManifest,
} from '@agentic-platform/constructs';
import type { CatalogModel } from '@agentic-platform/plan-schema';
import { AgenticApi } from '@agentic-platform/api';
import { TOOL_DEFINITIONS } from '@agentic-platform/tools';
import { toGatewayToolDefinitions } from './tool-schema-convert';

export interface MarketingWorkflowStackProps extends StackProps {
  /** ap-southeast-2 inference profile. */
  readonly defaultModelId: string;
  /**
   * Models the planner may assign per task by complexity (modelOverride,
   * D-18). Omit to disable per-task model selection.
   */
  readonly modelCatalog?: CatalogModel[];
  /**
   * Model for the planner harness itself (plan quality drives everything
   * downstream — bin/marketing-workflow.ts passes the deep-tier model when one is given).
   * Omit to run the planner on defaultModelId.
   */
  readonly plannerModelId?: string;
  /** Default RETAIN; tests/dev pass DESTROY. */
  readonly removalPolicy?: RemovalPolicy;
  /** Deploy the built webapp if its dist exists. Default: true. */
  readonly deployWebapp?: boolean;
  /** Email subscribed to the workload alarm topic (run failures, DLQ). */
  readonly alarmEmail?: string;
}

/** Secret name convention for the demo tool keys (populate before first run). */
export const MARKETING_SECRET_PREFIX = 'marketing-workflow/';

export class MarketingWorkflowStack extends Stack {
  constructor(scope: Construct, id: string, props: MarketingWorkflowStackProps) {
    super(scope, id, props);

    // Cost attribution (N4): AgenticFoundation tags its own subtree at
    // CREATE time. Stack-level tags are deliberately NOT used — CDK lifts
    // them into CloudFormation STACK TAGS, which CFN propagates to every
    // taggable resource itself (bypassing aspect excludeResourceTypes), and
    // the Harness CFN handler fails any tag-modifying update with an opaque
    // "Internal Failure" (live finding: three consecutive rollbacks). The
    // gateway, tool Lambdas, API, and webapp therefore stay untagged until
    // the handler supports tag updates; Bedrock inference costs were never
    // tag-attributable anyway (see application inference profiles).

    // ── Tool layer: Gateway + research-tools target ─────────────────────
    const gateway = new agentcore.Gateway(this, 'Gateway', {
      gatewayName: 'marketing-tools',
      authorizerConfiguration: new agentcore.IamAuthorizer(),
    });

    // Independent tool targets (D-25): one gateway target per tool. Vendors
    // that host their own MCP server federate directly (no Lambda); the
    // rest run as per-tool Lambdas whose roles read exactly one secret.

    // tavily_search — Tavily's hosted MCP server, federated natively. The
    // token vault injects the key as the tavilyApiKey query parameter; the
    // referenced secret must exist before deploy. Tavily's server also
    // exposes its sibling tools (tavily_extract, tavily_crawl, ...) — the
    // planner only offers workers what their configs declare, so extras on
    // the gateway are inert until a worker opts in.
    new GatewayMcpServerTarget(this, 'TavilyMcp', {
      gateway,
      endpoint: 'https://mcp.tavily.com/mcp/',
      apiKey: {
        key: SecretValue.secretsManager(`${MARKETING_SECRET_PREFIX}tavily-api-key`),
        location: agentcore.ApiKeyCredentialLocation.queryParameter({
          credentialParameterName: 'tavilyApiKey',
        }),
      },
      cedarScope: [
        'audience_insight',
        'brand_intelligence',
        'competitor_intelligence',
        'compliance_check',
      ],
    });

    // Executor-backed tools: no vendor MCP server, so each ships as its own
    // Lambda (bundled per handler in @agentic-platform/tools).
    const executorTools: Array<{
      /** Tool name in TOOL_DEFINITIONS and the handler bundle dir. */
      tool: string;
      construct: string;
      env: Record<string, string>;
      /** Secret name this tool's role may read (exactly one). */
      secretName: string;
      cedarScope: string[];
      memorySize?: number;
    }> = [
      {
        tool: 'news_search',
        construct: 'NewsSearch',
        env: { NEWSAPI_SECRET_NAME: `${MARKETING_SECRET_PREFIX}newsapi-api-key` },
        secretName: `${MARKETING_SECRET_PREFIX}newsapi-api-key`,
        cedarScope: [
          'audience_insight',
          'brand_intelligence',
          'competitor_intelligence',
        ],
      },
      {
        tool: 'social_search',
        construct: 'SocialSearch',
        env: {
          ENSEMBLEDATA_SECRET_NAME: `${MARKETING_SECRET_PREFIX}ensembledata-api-key`,
        },
        secretName: `${MARKETING_SECRET_PREFIX}ensembledata-api-key`,
        cedarScope: ['audience_insight', 'brand_intelligence'],
        memorySize: 512, // social payloads are heavy pre-slimming
      },
    ];
    for (const spec of executorTools) {
      const handlerDir = spec.tool.replace(/_/g, '-');
      const fn = new lambda.Function(this, `${spec.construct}Fn`, {
        runtime: lambda.Runtime.NODEJS_22_X,
        handler: 'index.handler',
        code: lambda.Code.fromAsset(
          path.join(toolsPackageRoot(), 'dist', 'handlers', handlerDir),
        ),
        timeout: Duration.seconds(45), // tool fetches cap at 30s internally
        memorySize: spec.memorySize ?? 256,
        environment: spec.env,
        description: `marketing-workflow gateway tool: ${spec.tool}`,
      });
      fn.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ['secretsmanager:GetSecretValue'],
          // Exact secret only (trailing -* covers the random ARN suffix).
          resources: [
            this.formatArn({
              service: 'secretsmanager',
              resource: 'secret',
              resourceName: `${spec.secretName}-*`,
              arnFormat: ArnFormat.COLON_RESOURCE_NAME,
            }),
          ],
        }),
      );
      new GatewayToolTarget(this, spec.construct, {
        gateway,
        handler: fn,
        toolSchema: agentcore.ToolSchema.fromInline(
          toGatewayToolDefinitions(
            TOOL_DEFINITIONS.filter((tool) => tool.name === spec.tool),
          ),
        ),
        cedarScope: spec.cedarScope,
      });
    }

    // Python-authored tool (docs/python-developers.md): same GatewayToolTarget
    // pattern, Python runtime. Stdlib-only handlers need no bundling —
    // Code.fromAsset on the tools-py directory is the whole packaging story.
    // The schema JSON lives next to the handler so Python developers never
    // touch TypeScript.
    const currencyRatesFn = new lambda.Function(this, 'CurrencyRatesFn', {
      runtime: lambda.Runtime.PYTHON_3_13,
      handler: 'handlers.currency_rates.handler',
      code: lambda.Code.fromAsset(pythonToolsRoot(), {
        exclude: ['tests', '**/__pycache__', '.pytest_cache', 'pyproject.toml'],
      }),
      timeout: Duration.seconds(30),
      memorySize: 256,
      description: 'marketing-workflow gateway tool: currency_rates (Python, keyless)',
    });
    new GatewayToolTarget(this, 'CurrencyRates', {
      gateway,
      handler: currencyRatesFn,
      toolSchema: agentcore.ToolSchema.fromInline(
        toGatewayToolDefinitions([
          JSON.parse(
            readFileSync(
              path.join(pythonToolsRoot(), 'handlers', 'currency_rates.schema.json'),
              'utf-8',
            ),
          ),
        ]),
      ),
      cedarScope: ['market_analytics'],
    });

    // patent_search is shipped but not registered by default — its handler
    // bundle (patent-search) already builds. To enable it, append one entry
    // to executorTools above. It needs PATENTSVIEW_SECRET_NAME plus
    // TAVILY_SECRET_NAME (the keyless Google Patents fallback rides on
    // Tavily), so grant both secrets on that one function.

    // ── Agent + workflow layer ──────────────────────────────────────────
    // Agents are data: workload.yaml is the developer-editable surface
    // (Python-first teams never touch TS), validated against the same zod
    // schema TS configs use — a bad manifest fails synth, not deploy.
    const manifest = loadWorkloadManifest(
      path.join(workloadRoot(), 'workload.yaml'),
      { gateways: { default: gateway.gatewayArn } },
    );
    // Planner model is a deploy-time choice (the deep-tier inference profile
    // comes from CDK context, which YAML can't reference). Admins can still
    // repoint it at runtime from Settings (modelOverride).
    const agents = manifest.map((agent) =>
      agent.name === 'planner' && props.plannerModelId
        ? { ...agent, modelId: props.plannerModelId }
        : agent,
    );
    const foundation = new AgenticFoundation(this, 'Workload', {
      workloadName: 'marketing-workflow',
      defaultModelId: props.defaultModelId,
      ...(props.modelCatalog ? { modelCatalog: props.modelCatalog } : {}),
      agents,
      maxConcurrency: 3, // demo-friendly Bedrock quota posture
      ...(props.removalPolicy ? { removalPolicy: props.removalPolicy } : {}),
      ...(props.alarmEmail ? { alarmEmail: props.alarmEmail } : {}),
    });

    // ── API + web app ───────────────────────────────────────────────────
    const api = new AgenticApi(this, 'Api', { foundation });

    if (props.deployWebapp !== false) {
      this.deployWebapp(api);
    }

    new CfnOutput(this, 'GatewayArn', { value: gateway.gatewayArn });
  }

  private deployWebapp(api: AgenticApi): void {
    const webappDist = path.join(webappPackageRoot(), 'dist');
    if (!existsSync(webappDist)) {
      // Synth-safe when the SPA has not been built (e.g. construct tests).
      new CfnOutput(this, 'WebAppUrl', {
        value: 'webapp not built — run `npm run build -w @agentic-platform/webapp` and redeploy',
      });
      return;
    }
    const siteBucket = new s3.Bucket(this, 'WebAppBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });
    const distribution = new cloudfront.Distribution(this, 'WebApp', {
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(siteBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        // Security headers (SEC-M2): HSTS, nosniff, frame-deny, referrer
        // policy via the AWS managed policy. (A CSP is a follow-up — it
        // needs connect-src tuned to the API + Cognito endpoints.)
        responseHeadersPolicy:
          cloudfront.ResponseHeadersPolicy.SECURITY_HEADERS,
      },
      defaultRootObject: 'index.html',
      // SPA rewrite is safe globally here: the API is a separate origin, so
      // backend errors never pass through this distribution (serving the SPA
      // and the API from one distribution would rewrite API errors to 200s).
      errorResponses: [
        { httpStatus: 403, responseHttpStatus: 200, responsePagePath: '/index.html' },
        { httpStatus: 404, responseHttpStatus: 200, responsePagePath: '/index.html' },
      ],
    });
    new s3deploy.BucketDeployment(this, 'WebAppDeploy', {
      destinationBucket: siteBucket,
      distribution,
      sources: [
        s3deploy.Source.asset(webappDist),
        s3deploy.Source.jsonData('config.json', {
          apiUrl: api.httpApi.apiEndpoint,
          region: this.region,
          userPoolClientId: api.userPoolClient.userPoolClientId,
        }),
      ],
    });
    new CfnOutput(this, 'WebAppUrl', {
      value: `https://${distribution.distributionDomainName}`,
    });
  }
}

/** Repo-root tools-py/ (Python gateway tools; ts-src and dist/lib layouts). */
function pythonToolsRoot(): string {
  const candidates = [
    path.join(__dirname, '..', '..', '..', 'tools-py'), // lib/ (ts source)
    path.join(__dirname, '..', '..', '..', '..', 'tools-py'), // dist/lib/
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  throw new Error('tools-py/ not found — Python gateway tools directory missing');
}

/** The example root holding workload.yaml (lib/ in ts-src, dist/lib/ built). */
function workloadRoot(): string {
  const candidates = [
    path.join(__dirname, '..'), // lib/ (ts source, vitest)
    path.join(__dirname, '..', '..'), // dist/lib/ (compiled)
  ];
  for (const candidate of candidates) {
    if (existsSync(path.join(candidate, 'workload.yaml'))) {
      return candidate;
    }
  }
  throw new Error('workload.yaml not found next to the marketing-workflow stack');
}

function toolsPackageRoot(): string {
  return path.dirname(
    require.resolve('@agentic-platform/tools/package.json'),
  );
}

function webappPackageRoot(): string {
  // webapp is private/unpublished; resolve it relative to this example within
  // the monorepo. Two candidates because compilation adds a dist/ level:
  const candidates = [
    path.join(__dirname, '..', '..', '..', 'packages', 'webapp'), // lib/ (ts source)
    path.join(__dirname, '..', '..', '..', '..', 'packages', 'webapp'), // dist/lib/
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return candidates[0]!;
}
