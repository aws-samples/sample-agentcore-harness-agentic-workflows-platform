/**
 * AgenticApi — the workflow management API construct.
 *
 * Serverless: HTTP API (JWT-authorized on every route) → router Lambda →
 * DynamoDB/S3/SFN/Scheduler, plus the async planner-job Lambda for plan
 * drafting (202 + poll). Cognito user pool + client provide auth; the SPA
 * signs in via InitiateAuth (USER_PASSWORD_AUTH) and sends the id token.
 *
 * IAM posture: the router can start the ONE interpreter,
 * manage schedules in the ONE group passing the ONE fixed role, presign
 * bucket reads, and invoke the planner-job Lambda. The planner-job can
 * invoke the ONE planner harness. Nothing here can create infrastructure.
 */
import * as path from 'node:path';
import { existsSync } from 'node:fs';
import { CfnOutput, Duration, RemovalPolicy, Stack } from 'aws-cdk-lib';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpJwtAuthorizer } from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';
import { AgenticFoundation, HarnessAgent } from '@agentic-platform/constructs';

export interface AgenticApiProps {
  readonly foundation: AgenticFoundation;
  /**
   * Planner harness for plan drafting. Default: the foundation's agent named
   * 'planner'. Required — the goal→plan flow is the API's core capability.
   */
  readonly planner?: HarnessAgent;
  /** CORS origins for the SPA. Default: ['*'] (tighten per deployment). */
  readonly corsOrigins?: string[];
  /** Default: DESTROY — the pool holds demo users, not business data. */
  readonly userPoolRemovalPolicy?: RemovalPolicy;
  /**
   * Customer-owned feature routes mounted on the same HTTP API behind the
   * same Cognito JWT authorizer (docs/python-developers.md): Python-first
   * teams extend the API with their own Lambdas instead of forking the
   * router. Explicit routes take precedence over the router's {proxy+}
   * catch-all; paths may not shadow the platform's reserved prefixes.
   */
  readonly additionalRoutes?: AdditionalRoute[];
}

export interface AdditionalRoute {
  readonly method: apigwv2.HttpMethod;
  /** Route path, e.g. '/reports/summary' or '/exports/{exportId}'. */
  readonly path: string;
  /** Customer-owned handler (any Lambda runtime — Python included). */
  readonly handler: lambda.IFunction;
}

/** First path segments owned by the platform router — not shadowable. */
const RESERVED_ROUTE_PREFIXES = [
  'workflows',
  'runs',
  'settings',
  'plan-drafts',
];

export class AgenticApi extends Construct {
  public readonly httpApi: apigwv2.HttpApi;
  public readonly userPool: cognito.UserPool;
  public readonly userPoolClient: cognito.UserPoolClient;
  public readonly routerFunction: lambda.Function;
  public readonly plannerJobFunction: lambda.Function;

  constructor(scope: Construct, id: string, props: AgenticApiProps) {
    super(scope, id);

    const foundation = props.foundation;
    const planner = props.planner ?? foundation.agents['planner'];
    if (!planner) {
      throw new Error(
        'AgenticApi requires a planner harness: add an agent named "planner" to the foundation or pass props.planner',
      );
    }

    // ── Auth ────────────────────────────────────────────────────
    this.userPool = new cognito.UserPool(this, 'Users', {
      selfSignUpEnabled: false,
      signInAliases: { username: true, email: true },
      passwordPolicy: {
        minLength: 12,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
      },
      removalPolicy: props.userPoolRemovalPolicy ?? RemovalPolicy.DESTROY,
    });
    this.userPoolClient = this.userPool.addClient('WebClient', {
      authFlows: { userPassword: true },
      idTokenValidity: Duration.hours(8),
      accessTokenValidity: Duration.hours(8),
    });
    // Org administrators (D-19): membership grants org-settings and agent
    // prompt editing, plus editing any workflow. The group lands in the id
    // token's cognito:groups claim; the router enforces it server-side.
    // Add members: aws cognito-idp admin-add-user-to-group --group-name admin
    new cognito.CfnUserPoolGroup(this, 'AdminsGroup', {
      userPoolId: this.userPool.userPoolId,
      groupName: 'admin',
      description:
        'Organization administrators: edit org settings, agent prompts, and any workflow',
    });

    // ── Lambdas ────────────────────────────────────────────────────────
    // The worker catalog (real tool names so the planner can't invent them,
    // D-14) is deploy-seeded into the table by AgenticFoundation and read
    // at runtime — rich descriptions exceeded Lambda's 4KB env limit (live
    // deploy finding). Only the compact name→ARN map travels via env.
    const workerMapJson = JSON.stringify(foundation.workflow.workerArns);
    // Same D-14 grounding for per-task model assignment (D-18): only set when
    // the workload offers a model menu.
    const modelCatalogEnv: Record<string, string> =
      foundation.workflow.modelCatalog.length > 0
        ? { MODEL_CATALOG: JSON.stringify(foundation.workflow.modelCatalog) }
        : {};

    this.plannerJobFunction = new lambda.Function(this, 'PlannerJobFn', {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(handlersRoot(), 'planner-job')),
      timeout: Duration.minutes(10),
      memorySize: 512,
      environment: {
        TABLE_NAME: foundation.table.tableName,
        PLANNER_HARNESS_ARN: planner.harnessArn,
        WORKER_HARNESS_MAP: workerMapJson,
        ...modelCatalogEnv,
      },
      description: 'Agentic API: async plan drafting via the planner harness',
      // Sampled trace context for planner invocations (GenAI Observability
      // capture — live finding: PassThrough left every draft untraced).
      tracing: lambda.Tracing.ACTIVE,
      // Bounded retention (WA review: default is never-expire).
      logRetention: logs.RetentionDays.THREE_MONTHS,
    });
    foundation.table.grantReadWriteData(this.plannerJobFunction);
    planner.grantInvoke(this.plannerJobFunction);

    this.routerFunction = new lambda.Function(this, 'RouterFn', {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(handlersRoot(), 'api-router')),
      timeout: Duration.seconds(29), // HTTP API integration cap is 30s
      memorySize: 512,
      environment: {
        TABLE_NAME: foundation.table.tableName,
        BUCKET_NAME: foundation.artifactsBucket.bucketName,
        WORKER_HARNESS_MAP: workerMapJson,
        ...modelCatalogEnv,
        PLANNER_JOB_FUNCTION_NAME: this.plannerJobFunction.functionName,
        ...foundation.scheduler.runtimeEnvironment(),
      },
      description: 'Agentic API: workflow/schedule/run/artifact routes',
      // Stitches API-originated chains (router → planner-job → harness).
      tracing: lambda.Tracing.ACTIVE,
      // Bounded retention (WA review: default is never-expire).
      logRetention: logs.RetentionDays.THREE_MONTHS,
    });
    foundation.table.grantReadWriteData(this.routerFunction);
    foundation.artifactsBucket.grantRead(this.routerFunction);
    foundation.workflow.grantStartExecution(this.routerFunction);
    // Zombie-run reconciliation (D-15): read-only on this SM's executions.
    foundation.workflow.stateMachine.grantExecution(
      this.routerFunction,
      'states:DescribeExecution',
    );
    foundation.scheduler.grantManageSchedules(this.routerFunction);
    this.plannerJobFunction.grantInvoke(this.routerFunction);
    // Model-id verification on org settings saves (D-20): list-only, and
    // these Bedrock list actions do not support resource scoping.
    this.routerFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['bedrock:ListFoundationModels', 'bedrock:ListInferenceProfiles'],
        resources: ['*'],
      }),
    );

    // ── HTTP API ────────────────────────────────────────────────
    const issuer = `https://cognito-idp.${Stack.of(this).region}.amazonaws.com/${this.userPool.userPoolId}`;
    const authorizer = new HttpJwtAuthorizer('JwtAuth', issuer, {
      jwtAudience: [this.userPoolClient.userPoolClientId],
    });
    this.httpApi = new apigwv2.HttpApi(this, 'Http', {
      defaultAuthorizer: authorizer,
      corsPreflight: {
        allowOrigins: props.corsOrigins ?? ['*'],
        allowMethods: [apigwv2.CorsHttpMethod.ANY],
        allowHeaders: ['authorization', 'content-type'],
        maxAge: Duration.hours(1),
      },
    });
    // Explicit methods, deliberately NOT ANY: an ANY route captures the
    // browser's OPTIONS preflight and the JWT authorizer 401s it (preflights
    // carry no token), which surfaces as "Failed to fetch" in the SPA.
    // Without an OPTIONS route, API Gateway's built-in CORS handler answers
    // preflights itself (live-verified, docs/decisions.md D-16).
    this.httpApi.addRoutes({
      path: '/{proxy+}',
      methods: [
        apigwv2.HttpMethod.GET,
        apigwv2.HttpMethod.POST,
        apigwv2.HttpMethod.PUT,
        apigwv2.HttpMethod.DELETE,
      ],
      integration: new HttpLambdaIntegration('Router', this.routerFunction),
    });

    // Customer feature routes: same API, same JWT authorizer, their Lambda.
    for (const [index, route] of (props.additionalRoutes ?? []).entries()) {
      const firstSegment = route.path.split('/').filter(Boolean)[0] ?? '';
      if (!route.path.startsWith('/') || firstSegment.length === 0) {
        throw new Error(
          `AgenticApi additionalRoutes[${index}]: path must start with '/' and have at least one segment (got "${route.path}")`,
        );
      }
      if (RESERVED_ROUTE_PREFIXES.includes(firstSegment)) {
        throw new Error(
          `AgenticApi additionalRoutes[${index}]: path "${route.path}" shadows the platform's /${firstSegment} routes — reserved prefixes: ${RESERVED_ROUTE_PREFIXES.map((p) => `/${p}`).join(', ')}`,
        );
      }
      this.httpApi.addRoutes({
        path: route.path,
        methods: [route.method],
        integration: new HttpLambdaIntegration(
          `AdditionalRoute${index}`,
          route.handler,
        ),
      });
    }

    new CfnOutput(this, 'ApiUrl', { value: this.httpApi.apiEndpoint });
    new CfnOutput(this, 'UserPoolId', { value: this.userPool.userPoolId });
    new CfnOutput(this, 'UserPoolClientId', {
      value: this.userPoolClient.userPoolClientId,
    });
  }
}

function handlersRoot(): string {
  const candidates = [
    path.join(__dirname, '..', 'handlers'), // compiled: dist/src → dist/handlers
    path.join(__dirname, '..', 'dist', 'handlers'), // ts-src (vitest): src → ../dist/handlers
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  throw new Error(
    'API handler bundles not found. Build @agentic-platform/api first (npm run build).',
  );
}
