/**
 * api-router — the workflow management API.
 *
 * One thin dispatch over pure helpers. Runtime AWS surface: DynamoDB, S3 presign, StartExecution on the one interpreter,
 * Scheduler CRUD in the one schedule group with the one fixed role, and
 * async-invoke of the planner-job Lambda. No control-plane calls.
 */
import {
  BatchWriteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import {
  DescribeExecutionCommand,
  SFNClient,
  StartExecutionCommand,
} from '@aws-sdk/client-sfn';
import {
  ConflictException,
  CreateScheduleCommand,
  DeleteScheduleCommand,
  ResourceNotFoundException,
  SchedulerClient,
  UpdateScheduleCommand,
} from '@aws-sdk/client-scheduler';
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { randomUUID } from 'node:crypto';
import {
  LIST_INDEX_NAME,
  parsePlanDocument,
  tableKeys,
  validatePlanAgainstCatalog,
} from '@agentic-platform/plan-schema';
import {
  loadDeployedWorkerCatalog,
  loadEffectiveModelCatalog,
} from '@agentic-platform/constructs/dist/handlers-src/lib/runtime-config';
import { ddb, nowIso, requireEnv } from './lib/common';
import { checkModelIds } from './lib/model-catalog-check';
import {
  badRequest,
  callerId,
  forbidden,
  isAdmin,
  json,
  notFound,
  parseBody,
  type HttpEvent,
  type HttpResponse,
} from './lib/http';
import { matchRoute } from '../src/routing';
import {
  artifactKeyBelongsToRun,
  isValidScheduleExpression,
  validateCreateWorkflow,
  validatePutAgentConfig,
  validatePutOrgSettings,
  validateUpdateWorkflow,
} from '../src/validation';

const s3 = new S3Client({});
const sfn = new SFNClient({});
const scheduler = new SchedulerClient({});
const lambda = new LambdaClient({});

const PRESIGN_TTL_SECONDS = 300; // clamped 60–900

export async function handler(event: HttpEvent): Promise<HttpResponse> {
  const method = event.requestContext.http.method;
  const match = matchRoute(method, event.rawPath);
  if (!match) {
    return notFound(`no route: ${method} ${event.rawPath}`);
  }
  try {
    switch (match.key) {
      case 'listWorkflows':
        return await listWorkflows();
      case 'createWorkflow':
        return await createWorkflow(event);
      case 'getWorkflow':
        return await getWorkflow(match.params.workflowId!);
      case 'updateWorkflow':
        return await updateWorkflow(match.params.workflowId!, event);
      case 'deleteWorkflow':
        return await deleteWorkflow(match.params.workflowId!, event);
      case 'createPlanDraft':
        return await createPlanDraft(match.params.workflowId!, event);
      case 'getPlanDraft':
        return await getPlanDraft(match.params.jobId!);
      case 'savePlan':
        return await savePlan(match.params.workflowId!, event);
      case 'putSchedule':
        return await putSchedule(match.params.workflowId!, event);
      case 'runNow':
        return await runNow(match.params.workflowId!, event);
      case 'listRuns':
        return await listRuns(match.params.workflowId!);
      case 'getRun':
        return await getRun(match.params.runId!);
      case 'getArtifactUrl':
        return await getArtifactUrl(match.params.runId!, event);
      case 'getSettings':
        return await getSettings(event);
      case 'putAgentConfig':
        return await putAgentConfig(match.params.agentName!, event);
      case 'putOrgSettings':
        return await putOrgSettings(event);
    }
  } catch (error) {
    console.error('api-router error', { path: event.rawPath, error });
    return json(500, { error: 'internal error' });
  }
}

/**
 * Owner-or-admin guard (security review SEC-H1). Spend and mutation routes
 * — savePlan, runNow, createPlanDraft, putSchedule — follow the same
 * authorization rule as updateWorkflow/deleteWorkflow: the recorded creator
 * or an org admin; records without a recorded creator are admin-only.
 * Reads stay open to all signed-in users (shared-workspace model).
 */
function requireOwnerOrAdmin(
  event: HttpEvent,
  meta: Record<string, unknown>,
  action: string,
): HttpResponse | undefined {
  const owner = typeof meta.createdBy === 'string' ? meta.createdBy : undefined;
  const caller = callerId(event);
  if (!isAdmin(event) && !(owner && caller && owner === caller)) {
    return forbidden(`only the workflow owner or an org admin may ${action}`);
  }
  return undefined;
}

async function listWorkflows(): Promise<HttpResponse> {
  const result = await ddb.send(
    new QueryCommand({
      TableName: requireEnv('TABLE_NAME'),
      IndexName: LIST_INDEX_NAME,
      KeyConditionExpression: 'gsi1pk = :pk',
      ExpressionAttributeValues: { ':pk': 'WORKFLOW' },
      ScanIndexForward: false,
      Limit: 100,
    }),
  );
  return json(200, { workflows: (result.Items ?? []).map(publicWorkflow) });
}

async function createWorkflow(event: HttpEvent): Promise<HttpResponse> {
  const validated = validateCreateWorkflow(parseBody(event));
  if (!validated.ok) {
    return badRequest(validated.error);
  }
  const workflowId = randomUUID();
  const createdAt = nowIso();
  await ddb.send(
    new PutCommand({
      TableName: requireEnv('TABLE_NAME'),
      Item: {
        ...tableKeys.workflowMeta(workflowId),
        ...tableKeys.workflowListIndex(createdAt, workflowId),
        entity: 'WORKFLOW',
        workflowId,
        name: validated.value.name,
        goal: validated.value.goal,
        planMode: validated.value.planMode,
        failurePolicy: validated.value.failurePolicy,
        maxAttempts: validated.value.maxAttempts,
        latestVersion: 0,
        createdAt,
        createdBy: callerId(event),
      },
      ConditionExpression: 'attribute_not_exists(pk)',
    }),
  );
  return json(201, { workflowId });
}

async function getWorkflow(workflowId: string): Promise<HttpResponse> {
  const tableName = requireEnv('TABLE_NAME');
  const meta = await ddb.send(
    new GetCommand({ TableName: tableName, Key: tableKeys.workflowMeta(workflowId) }),
  );
  if (!meta.Item) {
    return notFound(`workflow ${workflowId}`);
  }
  let plan: unknown;
  const latestVersion = Number(meta.Item.latestVersion ?? 0);
  if (latestVersion >= 1) {
    const version = await ddb.send(
      new GetCommand({
        TableName: tableName,
        Key: tableKeys.planVersion(workflowId, latestVersion),
      }),
    );
    plan = version.Item?.plan;
  }
  return json(200, { workflow: publicWorkflow(meta.Item), plan: plan ?? null });
}

/**
 * Owner edits after creation (D-19): name/goal/planMode. Authorization:
 * the recorded creator or an org admin; records without a recorded creator
 * are admin-editable only. A changed goal takes effect on the next plan
 * draft or replan-each-run execution — saved plan versions are immutable.
 */
async function updateWorkflow(
  workflowId: string,
  event: HttpEvent,
): Promise<HttpResponse> {
  const validated = validateUpdateWorkflow(parseBody(event));
  if (!validated.ok) {
    return badRequest(validated.error);
  }
  const tableName = requireEnv('TABLE_NAME');
  const meta = await ddb.send(
    new GetCommand({ TableName: tableName, Key: tableKeys.workflowMeta(workflowId) }),
  );
  if (!meta.Item) {
    return notFound(`workflow ${workflowId}`);
  }
  const owner =
    typeof meta.Item.createdBy === 'string' ? meta.Item.createdBy : undefined;
  const caller = callerId(event);
  if (!isAdmin(event) && !(owner && caller && owner === caller)) {
    return forbidden('only the workflow owner or an org admin may edit this workflow');
  }

  const names: Record<string, string> = {};
  const values: Record<string, unknown> = {
    ':updatedAt': nowIso(),
    ':updatedBy': caller ?? 'unknown',
  };
  const sets = ['updatedAt = :updatedAt', 'updatedBy = :updatedBy'];
  for (const [field, value] of Object.entries(validated.value)) {
    names[`#${field}`] = field;
    values[`:${field}`] = value;
    sets.push(`#${field} = :${field}`);
  }
  const updated = await ddb.send(
    new UpdateCommand({
      TableName: tableName,
      Key: tableKeys.workflowMeta(workflowId),
      UpdateExpression: `SET ${sets.join(', ')}`,
      ...(Object.keys(names).length > 0
        ? { ExpressionAttributeNames: names }
        : {}),
      ExpressionAttributeValues: values,
      ReturnValues: 'ALL_NEW',
    }),
  );
  return json(200, { workflow: publicWorkflow(updated.Attributes ?? {}) });
}

/**
 * Hard delete (owner-or-admin, same authz as updateWorkflow): removes the
 * workflow record, every saved plan version, the run-history list items,
 * each run's canonical record + task records, and the EventBridge schedule.
 * Refused (409) while a run is in flight — a live execution would keep
 * writing task records after the delete. S3 report artifacts are retained:
 * the bucket is versioned and KMS-encrypted; artifact lifecycle is a
 * data-retention concern, not a UI-delete concern.
 */
async function deleteWorkflow(
  workflowId: string,
  event: HttpEvent,
): Promise<HttpResponse> {
  const tableName = requireEnv('TABLE_NAME');
  const meta = await ddb.send(
    new GetCommand({ TableName: tableName, Key: tableKeys.workflowMeta(workflowId) }),
  );
  if (!meta.Item) {
    return notFound(`workflow ${workflowId}`);
  }
  const owner =
    typeof meta.Item.createdBy === 'string' ? meta.Item.createdBy : undefined;
  const caller = callerId(event);
  if (!isAdmin(event) && !(owner && caller && owner === caller)) {
    return forbidden(
      'only the workflow owner or an org admin may delete this workflow',
    );
  }

  // Collect the full WF# partition: META, VER#*, RUN#* list items.
  const workflowItems = await queryAllKeys(tableName, `WF#${workflowId}`);
  const runIds: string[] = [];
  for (const key of workflowItems) {
    // Run list items are RUN#<startedAtIso>#<runId>.
    if (key.sk.startsWith('RUN#')) {
      const runId = key.sk.split('#')[2];
      if (runId) {
        runIds.push(runId);
      }
    }
  }

  // In-flight guard: check canonical run records (list items can lag).
  for (const runId of runIds) {
    const run = await ddb.send(
      new GetCommand({ TableName: tableName, Key: tableKeys.run(runId) }),
    );
    if (run.Item?.status === 'running') {
      return json(409, {
        error: `run ${runId} is still in progress — wait for it to finish (or fail) before deleting this workflow`,
      });
    }
  }

  // Schedule first: stop future triggers before removing state.
  let scheduleDeleted = false;
  try {
    await scheduler.send(
      new DeleteScheduleCommand({
        Name: `wf-${workflowId}`,
        GroupName: requireEnv('SCHEDULE_GROUP_NAME'),
      }),
    );
    scheduleDeleted = true;
  } catch (error) {
    if (!(error instanceof ResourceNotFoundException)) {
      throw error;
    }
    // ResourceNotFound: the workflow never had a schedule — fine.
  }

  // Each run's canonical partition: META + TASK#*.
  const keys = [...workflowItems];
  for (const runId of runIds) {
    keys.push(...(await queryAllKeys(tableName, `RUN#${runId}`)));
  }
  await batchDelete(tableName, keys);

  return json(200, {
    workflowId,
    deleted: { items: keys.length, runs: runIds.length },
    scheduleDeleted,
  });
}

/** All primary keys in a partition (paginated, keys only). */
async function queryAllKeys(
  tableName: string,
  pk: string,
): Promise<Array<{ pk: string; sk: string }>> {
  const keys: Array<{ pk: string; sk: string }> = [];
  let cursor: Record<string, unknown> | undefined;
  do {
    const page = await ddb.send(
      new QueryCommand({
        TableName: tableName,
        KeyConditionExpression: 'pk = :pk',
        ExpressionAttributeValues: { ':pk': pk },
        ProjectionExpression: 'pk, sk',
        ...(cursor ? { ExclusiveStartKey: cursor } : {}),
      }),
    );
    for (const item of page.Items ?? []) {
      keys.push({ pk: String(item.pk), sk: String(item.sk) });
    }
    cursor = page.LastEvaluatedKey;
  } while (cursor);
  return keys;
}

/** Batch-delete keys in chunks of 25, retrying unprocessed items. */
async function batchDelete(
  tableName: string,
  keys: Array<{ pk: string; sk: string }>,
): Promise<void> {
  for (let i = 0; i < keys.length; i += 25) {
    let requests = keys
      .slice(i, i + 25)
      .map((key) => ({ DeleteRequest: { Key: key } }));
    for (let attempt = 0; requests.length > 0 && attempt < 5; attempt++) {
      const result = await ddb.send(
        new BatchWriteCommand({ RequestItems: { [tableName]: requests } }),
      );
      requests = (result.UnprocessedItems?.[tableName] ?? []) as typeof requests;
      if (requests.length > 0) {
        await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)));
      }
    }
    if (requests.length > 0) {
      throw new Error(`batch delete left ${requests.length} unprocessed item(s)`);
    }
  }
}

/**
 * Runtime configuration read (D-19): agent prompts (defaults + overrides),
 * org settings, and the deployed model catalog fallback. Readable by every
 * signed-in user — the UI needs it to render; mutation is admin-gated.
 */
async function getSettings(event: HttpEvent): Promise<HttpResponse> {
  const result = await ddb.send(
    new QueryCommand({
      TableName: requireEnv('TABLE_NAME'),
      KeyConditionExpression: 'pk = :pk',
      ExpressionAttributeValues: { ':pk': 'CONFIG' },
    }),
  );
  const agents: Array<Record<string, unknown>> = [];
  let org: Record<string, unknown> = {};
  for (const item of result.Items ?? []) {
    const { pk: _pk, sk, entity: _entity, ...rest } = item;
    if (typeof sk === 'string' && sk.startsWith('AGENT#')) {
      agents.push(rest);
    } else if (sk === 'ORG') {
      org = rest;
    }
  }
  agents.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  const deployedJson = process.env.MODEL_CATALOG;
  return json(200, {
    agents,
    org,
    deployedModelCatalog: deployedJson ? JSON.parse(deployedJson) : [],
    isAdmin: isAdmin(event),
  });
}

/** Admin: set/clear an agent's prompt override (applied next invocation). */
async function putAgentConfig(
  agentName: string,
  event: HttpEvent,
): Promise<HttpResponse> {
  if (!isAdmin(event)) {
    return forbidden('admin group membership required to edit agent prompts');
  }
  const validated = validatePutAgentConfig(parseBody(event));
  if (!validated.ok) {
    return badRequest(validated.error);
  }
  const tableName = requireEnv('TABLE_NAME');
  const key = tableKeys.agentConfig(agentName);
  const existing = await ddb.send(
    new GetCommand({ TableName: tableName, Key: key }),
  );
  if (!existing.Item) {
    return notFound(`agent config ${agentName}`);
  }
  const patch = validated.value;
  // D-20 applies to agent model overrides too: an invalid id only surfaces
  // at run time as a harness RuntimeClientError, so verify at save time.
  if (typeof patch.modelOverride === 'string') {
    const check = await checkModelIds([patch.modelOverride]);
    if (check.invalid.length > 0) {
      return json(400, {
        error:
          'model id not found in Bedrock in this region (checked foundation models and inference profiles)',
        issues: check.invalid,
      });
    }
  }
  // Tri-state patch → one UpdateItem: set fields with values, REMOVE the
  // explicitly cleared ones, leave absent fields untouched.
  const sets: string[] = ['updatedAt = :now', 'updatedBy = :by'];
  const removes: string[] = [];
  const values: Record<string, unknown> = {
    ':now': nowIso(),
    ':by': callerId(event) ?? 'unknown',
  };
  const apply = (field: keyof typeof patch, placeholder: string) => {
    const raw = patch[field];
    if (raw === undefined) {
      return;
    }
    if (raw === null) {
      removes.push(field);
    } else {
      sets.push(`${field} = ${placeholder}`);
      values[placeholder] = raw;
    }
  };
  apply('instructionsOverride', ':instructions');
  apply('modelOverride', ':model');
  apply('thinkingEffortOverride', ':thinking');
  await ddb.send(
    new UpdateCommand({
      TableName: tableName,
      Key: key,
      UpdateExpression: `SET ${sets.join(', ')}${
        removes.length > 0 ? ` REMOVE ${removes.join(', ')}` : ''
      }`,
      ExpressionAttributeValues: values,
    }),
  );
  return json(200, { name: agentName, ...patch });
}

/** Admin: set/clear org-wide settings (model catalog override). */
async function putOrgSettings(event: HttpEvent): Promise<HttpResponse> {
  if (!isAdmin(event)) {
    return forbidden('admin group membership required to edit org settings');
  }
  const validated = validatePutOrgSettings(parseBody(event));
  if (!validated.ok) {
    return badRequest(validated.error);
  }
  const clears = validated.value.modelCatalog === null;
  // D-20: an invalid id only surfaces at run time as a harness
  // RuntimeClientError, so verify against Bedrock in-region at save time.
  let verified = false;
  if (!clears) {
    const check = await checkModelIds(
      validated.value.modelCatalog!.map((entry) => entry.modelId),
    );
    if (check.invalid.length > 0) {
      return json(400, {
        error:
          'model id(s) not found in Bedrock in this region (checked foundation models and inference profiles)',
        issues: check.invalid,
      });
    }
    verified = check.verified;
  }
  await ddb.send(
    new UpdateCommand({
      TableName: requireEnv('TABLE_NAME'),
      Key: tableKeys.orgSettings(),
      UpdateExpression: clears
        ? 'REMOVE modelCatalog SET entity = :entity, updatedAt = :now, updatedBy = :by'
        : 'SET entity = :entity, modelCatalog = :catalog, updatedAt = :now, updatedBy = :by',
      ExpressionAttributeValues: {
        ':entity': 'ORG_SETTINGS',
        ':now': nowIso(),
        ':by': callerId(event) ?? 'unknown',
        ...(clears ? {} : { ':catalog': validated.value.modelCatalog }),
      },
    }),
  );
  return json(200, {
    modelCatalog: validated.value.modelCatalog,
    // False when Bedrock listing was unavailable and the save proceeded
    // unverified — the UI can surface a caution.
    verified: clears ? undefined : verified,
  });
}

async function createPlanDraft(
  workflowId: string,
  event: HttpEvent,
): Promise<HttpResponse> {
  const tableName = requireEnv('TABLE_NAME');
  const meta = await ddb.send(
    new GetCommand({ TableName: tableName, Key: tableKeys.workflowMeta(workflowId) }),
  );
  if (!meta.Item) {
    return notFound(`workflow ${workflowId}`);
  }
  // Plan drafting invokes the deep-model planner — spend, so owner-gated.
  const denied = requireOwnerOrAdmin(event, meta.Item, 'draft plans for this workflow');
  if (denied) {
    return denied;
  }
  const jobId = randomUUID();
  await ddb.send(
    new PutCommand({
      TableName: tableName,
      Item: {
        ...tableKeys.plannerJob(jobId),
        entity: 'PLANNER_JOB',
        jobId,
        workflowId,
        status: 'pending',
        createdAt: nowIso(),
      },
    }),
  );
  await lambda.send(
    new InvokeCommand({
      FunctionName: requireEnv('PLANNER_JOB_FUNCTION_NAME'),
      InvocationType: 'Event',
      Payload: JSON.stringify({
        jobId,
        workflowId,
        goal: String(meta.Item.goal ?? ''),
      }),
    }),
  );
  // Async 202 + poll — planner latency exceeds synchronous budgets.
  return json(202, { jobId });
}

async function getPlanDraft(jobId: string): Promise<HttpResponse> {
  const job = await ddb.send(
    new GetCommand({
      TableName: requireEnv('TABLE_NAME'),
      Key: tableKeys.plannerJob(jobId),
    }),
  );
  if (!job.Item) {
    return notFound(`plan draft job ${jobId}`);
  }
  const { pk: _pk, sk: _sk, entity: _entity, ...publicJob } = job.Item;
  return json(200, publicJob);
}

async function savePlan(
  workflowId: string,
  event: HttpEvent,
): Promise<HttpResponse> {
  const body = parseBody(event) as { plan?: unknown } | null;
  if (!body || body.plan === undefined) {
    return badRequest('body must be { plan: <plan document> }');
  }
  const parsed = parsePlanDocument(body.plan);
  if (!parsed.ok) {
    return json(422, { error: 'plan failed validation', issues: parsed.issues });
  }
  // Full semantic validation: workers, tool names, AND model ids must be
  // real (D-14, D-18). Catalog is deploy-seeded in the table (4KB env
  // limit, live finding); WORKER_HARNESS_MAP is the names-only fallback.
  const catalog =
    (await loadDeployedWorkerCatalog(requireEnv('TABLE_NAME'))) ??
    Object.keys(
      JSON.parse(requireEnv('WORKER_HARNESS_MAP')) as Record<string, string>,
    ).map((name) => ({ name }));
  // Effective catalog: org admin override wins over the deployed default.
  const modelCatalog = await loadEffectiveModelCatalog(requireEnv('TABLE_NAME'));
  const semanticIssues = validatePlanAgainstCatalog(
    parsed.plan,
    catalog,
    modelCatalog,
  );
  if (semanticIssues.length > 0) {
    return json(422, {
      error: 'plan references unknown workers, tools, or models',
      issues: semanticIssues,
    });
  }

  const tableName = requireEnv('TABLE_NAME');
  const meta = await ddb.send(
    new GetCommand({ TableName: tableName, Key: tableKeys.workflowMeta(workflowId) }),
  );
  if (!meta.Item) {
    return notFound(`workflow ${workflowId}`);
  }
  // Replacing the plan changes what future runs execute — owner-gated.
  const denied = requireOwnerOrAdmin(event, meta.Item, 'save plans for this workflow');
  if (denied) {
    return denied;
  }
  const version = Number(meta.Item.latestVersion ?? 0) + 1;
  await ddb.send(
    new PutCommand({
      TableName: tableName,
      Item: {
        ...tableKeys.planVersion(workflowId, version),
        entity: 'PLAN_VERSION',
        workflowId,
        version,
        plan: parsed.plan,
        savedAt: nowIso(),
        savedBy: callerId(event),
      },
      ConditionExpression: 'attribute_not_exists(pk) OR attribute_not_exists(sk)',
    }),
  );
  await ddb.send(
    new UpdateCommand({
      TableName: tableName,
      Key: tableKeys.workflowMeta(workflowId),
      UpdateExpression: 'SET latestVersion = :version',
      ExpressionAttributeValues: { ':version': version },
    }),
  );
  return json(200, { version });
}

async function putSchedule(
  workflowId: string,
  event: HttpEvent,
): Promise<HttpResponse> {
  const body = parseBody(event) as {
    expression?: string;
    enabled?: boolean;
  } | null;
  const expression = body?.expression?.trim() ?? '';
  const enabled = body?.enabled !== false;
  if (!isValidScheduleExpression(expression)) {
    return badRequest(
      'expression must be rate(<n> <unit>) or cron(<fields>) — e.g. rate(7 days)',
    );
  }
  const tableName = requireEnv('TABLE_NAME');
  const meta = await ddb.send(
    new GetCommand({ TableName: tableName, Key: tableKeys.workflowMeta(workflowId) }),
  );
  if (!meta.Item) {
    return notFound(`workflow ${workflowId}`);
  }
  // Schedules trigger recurring model spend — owner-gated (SEC-H1).
  const denied = requireOwnerOrAdmin(event, meta.Item, 'schedule this workflow');
  if (denied) {
    return denied;
  }
  if (Number(meta.Item.latestVersion ?? 0) < 1) {
    return badRequest('save a plan before scheduling the workflow');
  }

  const scheduleInput = {
    Name: `wf-${workflowId}`,
    GroupName: requireEnv('SCHEDULE_GROUP_NAME'),
    ScheduleExpression: expression,
    FlexibleTimeWindow: { Mode: 'OFF' as const },
    State: (enabled ? 'ENABLED' : 'DISABLED') as 'ENABLED' | 'DISABLED',
    Target: {
      Arn: requireEnv('STATE_MACHINE_ARN'),
      RoleArn: requireEnv('SCHEDULER_ROLE_ARN'),
      Input: JSON.stringify({ workflowId, trigger: 'schedule' }),
      DeadLetterConfig: { Arn: requireEnv('SCHEDULER_DLQ_ARN') },
      RetryPolicy: { MaximumRetryAttempts: 2 },
    },
  };
  try {
    await scheduler.send(new CreateScheduleCommand(scheduleInput));
  } catch (error) {
    if (error instanceof ConflictException) {
      await scheduler.send(new UpdateScheduleCommand(scheduleInput));
    } else {
      throw error;
    }
  }
  await ddb.send(
    new UpdateCommand({
      TableName: tableName,
      Key: tableKeys.workflowMeta(workflowId),
      UpdateExpression: 'SET schedule = :schedule',
      ExpressionAttributeValues: { ':schedule': { expression, enabled } },
    }),
  );
  return json(200, { workflowId, schedule: { expression, enabled } });
}

async function runNow(
  workflowId: string,
  event: HttpEvent,
): Promise<HttpResponse> {
  const tableName = requireEnv('TABLE_NAME');
  const meta = await ddb.send(
    new GetCommand({
      TableName: tableName,
      Key: tableKeys.workflowMeta(workflowId),
    }),
  );
  if (!meta.Item) {
    return notFound(`workflow ${workflowId}`);
  }
  // Running a workflow triggers model spend — owner-gated (SEC-H1).
  const denied = requireOwnerOrAdmin(event, meta.Item, 'run this workflow');
  if (denied) {
    return denied;
  }
  const version = Number(meta.Item.latestVersion ?? 0);
  if (version < 1) {
    return badRequest('save a plan before running the workflow');
  }
  // Stale-plan guard: a saved plan can outlive the catalogs it was validated
  // against (live incident: a pre-validation plan carrying modelOverride
  // "o3" failed every run at ConverseStream depth). Re-validate at the run
  // action so the user gets an actionable 422 instead of a deep run failure.
  // Static plans only — replan-each-run drafts a fresh validated plan.
  if (meta.Item.planMode !== 'replan-each-run') {
    const versionItem = await ddb.send(
      new GetCommand({
        TableName: tableName,
        Key: tableKeys.planVersion(workflowId, version),
      }),
    );
    const parsed = parsePlanDocument(versionItem.Item?.plan);
    if (parsed.ok) {
      const catalog =
        (await loadDeployedWorkerCatalog(tableName)) ??
        Object.keys(
          JSON.parse(requireEnv('WORKER_HARNESS_MAP')) as Record<string, string>,
        ).map((name) => ({ name }));
      const modelCatalog = await loadEffectiveModelCatalog(tableName);
      const staleIssues = validatePlanAgainstCatalog(parsed.plan, catalog, modelCatalog);
      if (staleIssues.length > 0) {
        return json(422, {
          error: `plan v${version} is no longer valid against the current worker/model catalogs — use "Edit plan" to fix it (or update the catalogs) and save a new version`,
          issues: staleIssues,
        });
      }
    }
  }
  const execution = await sfn.send(
    new StartExecutionCommand({
      stateMachineArn: requireEnv('STATE_MACHINE_ARN'),
      input: JSON.stringify({ workflowId, trigger: 'manual' }),
    }),
  );
  return json(202, { executionArn: execution.executionArn });
}

async function listRuns(workflowId: string): Promise<HttpResponse> {
  const result = await ddb.send(
    new QueryCommand({
      TableName: requireEnv('TABLE_NAME'),
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :sk)',
      ExpressionAttributeValues: {
        ':pk': `WF#${workflowId}`,
        ':sk': 'RUN#',
      },
      ScanIndexForward: false,
      Limit: 50,
    }),
  );
  const runs = (result.Items ?? []).map((item) => {
    const { pk: _pk, sk: _sk, entity: _entity, ...run } = item;
    return run;
  });
  return json(200, { runs });
}

async function getRun(runId: string): Promise<HttpResponse> {
  const tableName = requireEnv('TABLE_NAME');
  let run = await ddb.send(
    new GetCommand({ TableName: tableName, Key: tableKeys.run(runId) }),
  );
  if (!run.Item) {
    return notFound(`run ${runId}`);
  }
  // Reconcile zombie runs (D-15): a States.Runtime failure bypasses every
  // Catch, so finalize never sweeps. If the execution ended while the record
  // says running, mark the run and its in-flight tasks accordingly.
  if (run.Item.status === 'running' && run.Item.sfnExecutionArn) {
    const reconciled = await reconcileDeadRun(
      tableName,
      runId,
      String(run.Item.workflowId ?? ''),
      String(run.Item.sfnExecutionArn),
      run.Item.startedAt ? String(run.Item.startedAt) : undefined,
    );
    if (reconciled) {
      run = await ddb.send(
        new GetCommand({ TableName: tableName, Key: tableKeys.run(runId) }),
      );
      if (!run.Item) {
        return notFound(`run ${runId}`);
      }
    }
  }
  const tasks = await ddb.send(
    new QueryCommand({
      TableName: tableName,
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :sk)',
      ExpressionAttributeValues: { ':pk': `RUN#${runId}`, ':sk': 'TASK#' },
    }),
  );
  const {
    pk: _pk,
    sk: _sk,
    entity: _entity,
    plan: _plan, // large; clients fetch the plan via the workflow endpoint
    ...publicRun
  } = run.Item;
  return json(200, {
    run: publicRun,
    tasks: (tasks.Items ?? []).map((item) => {
      const { pk: _tpk, sk: _tsk, entity: _tentity, ...task } = item;
      return task;
    }),
  });
}

async function getArtifactUrl(
  runId: string,
  event: HttpEvent,
): Promise<HttpResponse> {
  const key = event.queryStringParameters?.key;
  if (!key) {
    return badRequest('query parameter "key" is required');
  }
  const run = await ddb.send(
    new GetCommand({
      TableName: requireEnv('TABLE_NAME'),
      Key: tableKeys.run(runId),
    }),
  );
  if (!run.Item) {
    return notFound(`run ${runId}`);
  }
  const workflowId = String(run.Item.workflowId ?? '');
  if (!artifactKeyBelongsToRun(key, workflowId, runId)) {
    return json(403, { error: 'artifact key does not belong to this run' });
  }
  const url = await getSignedUrl(
    s3,
    new GetObjectCommand({ Bucket: requireEnv('BUCKET_NAME'), Key: key }),
    { expiresIn: PRESIGN_TTL_SECONDS },
  );
  return json(200, { url, expiresInSeconds: PRESIGN_TTL_SECONDS });
}

function publicWorkflow(item: Record<string, unknown>): Record<string, unknown> {
  const { pk: _pk, sk: _sk, gsi1pk: _g1, gsi1sk: _g2, entity: _entity, ...rest } =
    item;
  return rest;
}

/**
 * Marks a run failed when its execution ended without reaching FinalizeRun
 * (uncatchable States.Runtime failures, D-15). Returns true if reconciled.
 */
async function reconcileDeadRun(
  tableName: string,
  runId: string,
  workflowId: string,
  executionArn: string,
  startedAt?: string,
): Promise<boolean> {
  let executionStatus: string | undefined;
  try {
    const execution = await sfn.send(
      new DescribeExecutionCommand({ executionArn }),
    );
    executionStatus = execution.status;
  } catch {
    return false; // can't verify — leave the record alone
  }
  if (!executionStatus || executionStatus === 'RUNNING') {
    return false;
  }
  const finishedAt = new Date().toISOString();
  const reason = `execution ended (${executionStatus}) before finalize — uncaught workflow error`;

  const tasks = await ddb.send(
    new QueryCommand({
      TableName: tableName,
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :sk)',
      ExpressionAttributeValues: { ':pk': `RUN#${runId}`, ':sk': 'TASK#' },
    }),
  );
  for (const item of tasks.Items ?? []) {
    if (item.status === 'running' || item.status === 'pending') {
      await ddb.send(
        new UpdateCommand({
          TableName: tableName,
          Key: tableKeys.task(runId, String(item.taskId)),
          UpdateExpression:
            'SET #status = :status, statusReason = :reason, finishedAt = :now',
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: {
            ':status': item.status === 'running' ? 'failed' : 'skipped',
            ':reason': reason,
            ':now': finishedAt,
          },
        }),
      );
    }
  }
  await ddb.send(
    new UpdateCommand({
      TableName: tableName,
      Key: tableKeys.run(runId),
      UpdateExpression:
        'SET #status = :failed, statusReason = :reason, finishedAt = :now',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: {
        ':failed': 'failed',
        ':reason': reason,
        ':now': finishedAt,
      },
    }),
  );
  if (startedAt) {
    await ddb.send(
      new UpdateCommand({
        TableName: tableName,
        Key: tableKeys.runListItem(workflowId, startedAt, runId),
        UpdateExpression: 'SET #status = :failed, finishedAt = :now',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: { ':failed': 'failed', ':now': finishedAt },
      }),
    );
  }
  return true;
}
