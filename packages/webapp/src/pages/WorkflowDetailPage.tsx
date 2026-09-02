/**
 * Workflow detail: hero header with actions (demo-style), overview key-value
 * pairs, plan drafting (202 + 3s poll), plan review/edit, schedule form, and
 * the runs table (5s auto-refresh). "Delete workflow" (owner-or-admin) hard
 * deletes via DELETE /workflows/{id} behind a type-to-confirm modal.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type { PlanDocument } from '@agentic-platform/plan-schema';
import Alert from '@cloudscape-design/components/alert';
import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import ButtonDropdown from '@cloudscape-design/components/button-dropdown';
import Container from '@cloudscape-design/components/container';
import ContentLayout from '@cloudscape-design/components/content-layout';
import FormField from '@cloudscape-design/components/form-field';
import Header from '@cloudscape-design/components/header';
import Input from '@cloudscape-design/components/input';
import KeyValuePairs from '@cloudscape-design/components/key-value-pairs';
import Link from '@cloudscape-design/components/link';
import Modal from '@cloudscape-design/components/modal';
import RadioGroup from '@cloudscape-design/components/radio-group';
import SpaceBetween from '@cloudscape-design/components/space-between';
import Spinner from '@cloudscape-design/components/spinner';
import StatusIndicator from '@cloudscape-design/components/status-indicator';
import Table from '@cloudscape-design/components/table';
import Textarea from '@cloudscape-design/components/textarea';
import Toggle from '@cloudscape-design/components/toggle';
import {
  api,
  ApiError,
  type FailurePolicy,
  type PlanDraftJob,
  type RunSummary,
  type WorkflowSummary,
} from '../api';
import { isAdminUser, tokenClaims } from '../auth';
import PlanEditor from '../components/PlanEditor';
import { RunStatus } from '../components/status';
import { formatDateTime } from '../format';
import { useRecordVisit } from '../recents';
import { useShell } from '../shell/AppShell';

const DRAFT_POLL_MS = 3_000;
const RUNS_POLL_MS = 5_000;

interface PlanRow {
  id: string;
  name: string;
  worker: string;
  tools: string;
  model: string;
  after: string;
}

export default function WorkflowDetailPage() {
  const { workflowId = '' } = useParams();
  const navigate = useNavigate();
  const { setBreadcrumbs, notify } = useShell();
  const [workflow, setWorkflow] = useState<WorkflowSummary | null>(null);
  const [plan, setPlan] = useState<PlanDocument | null>(null);
  const [draft, setDraft] = useState<PlanDocument | null>(null);
  const [draftJob, setDraftJob] = useState<PlanDraftJob | null>(null);
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [scheduleExpr, setScheduleExpr] = useState('rate(7 days)');
  const [scheduleEnabled, setScheduleEnabled] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  // Hard delete: confirmation modal with type-to-confirm (destructive).
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteConfirmText, setDeleteConfirmText] = useState('');
  // Owner edit (D-19/D-20): name/goal/planMode/failure policy after creation.
  const [editOpen, setEditOpen] = useState(false);
  const [editName, setEditName] = useState('');
  const [editGoal, setEditGoal] = useState('');
  const [editPlanMode, setEditPlanMode] = useState<'static' | 'replan-each-run'>('static');
  const [editFailurePolicy, setEditFailurePolicy] = useState<FailurePolicy>('contain');
  const [editMaxAttempts, setEditMaxAttempts] = useState('3');
  const draftTimer = useRef<number | null>(null);
  // Don't let the 5s poll clobber in-progress schedule edits — form state
  // and server state stay separate.
  const scheduleTouched = useRef(false);

  const refresh = useCallback(async () => {
    const [wf, runList] = await Promise.all([
      api.getWorkflow(workflowId),
      api.listRuns(workflowId),
    ]);
    setWorkflow(wf.workflow);
    setPlan(wf.plan);
    setRuns(runList.runs);
    if (wf.workflow.schedule && !scheduleTouched.current) {
      setScheduleExpr(wf.workflow.schedule.expression);
      setScheduleEnabled(wf.workflow.schedule.enabled);
    }
  }, [workflowId]);

  useEffect(() => {
    refresh().catch((e) => setError(e instanceof Error ? e.message : 'load failed'));
    const timer = window.setInterval(() => {
      refresh().catch(() => undefined);
    }, RUNS_POLL_MS);
    return () => window.clearInterval(timer);
  }, [refresh]);

  useEffect(
    () => () => {
      if (draftTimer.current) {
        window.clearTimeout(draftTimer.current);
      }
    },
    [],
  );

  useEffect(() => {
    setBreadcrumbs([
      { text: 'Workflows', href: '/workflows' },
      { text: workflow?.name ?? '…', href: `/workflows/${workflowId}` },
    ]);
  }, [setBreadcrumbs, workflow?.name, workflowId]);

  useRecordVisit(
    workflow
      ? {
          kind: 'workflow',
          id: workflowId,
          name: workflow.name,
          href: `/workflows/${workflowId}`,
        }
      : null,
  );

  async function pollDraft(jobId: string) {
    try {
      const job = await api.getPlanDraft(jobId);
      setDraftJob(job);
      if (job.status === 'succeeded' && job.draft) {
        setDraft(job.draft);
      } else if (job.status === 'pending' || job.status === 'running') {
        draftTimer.current = window.setTimeout(() => void pollDraft(jobId), DRAFT_POLL_MS);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'draft polling failed');
    }
  }

  async function startDraft() {
    setBusy('draft');
    setError(null);
    setDraft(null);
    try {
      const { jobId } = await api.createPlanDraft(workflowId);
      setDraftJob({ jobId, workflowId, status: 'pending' });
      void pollDraft(jobId);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'draft failed');
    } finally {
      setBusy(null);
    }
  }

  async function saveDraft(edited: PlanDocument) {
    setError(null);
    try {
      const { version } = await api.savePlan(workflowId, edited);
      setDraft(null);
      setDraftJob(null);
      notify({ type: 'success', content: `Plan saved as v${version}.` });
      await refresh();
    } catch (e) {
      if (e instanceof ApiError && e.issues) {
        setError(`${e.message}: ${e.issues.join('; ')}`);
      } else {
        setError(e instanceof Error ? e.message : 'save failed');
      }
    }
  }

  async function saveSchedule() {
    setBusy('schedule');
    setError(null);
    try {
      await api.putSchedule(workflowId, scheduleExpr, scheduleEnabled);
      scheduleTouched.current = false;
      notify({ type: 'success', content: 'Schedule saved.' });
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'schedule failed');
    } finally {
      setBusy(null);
    }
  }

  async function runNow() {
    setBusy('run');
    setError(null);
    try {
      await api.runNow(workflowId);
      notify({
        type: 'success',
        content: 'Run started — it will appear in the list within a few seconds.',
      });
      await refresh();
    } catch (e) {
      if (e instanceof ApiError && e.issues) {
        // Stale-plan guard: show exactly which references went invalid.
        setError(`${e.message}: ${e.issues.join('; ')}`);
      } else {
        setError(e instanceof Error ? e.message : 'run failed');
      }
    } finally {
      setBusy(null);
    }
  }

  async function confirmDelete() {
    setBusy('delete');
    setError(null);
    try {
      await api.deleteWorkflow(workflowId);
      setDeleteOpen(false);
      notify({
        type: 'success',
        content: `Workflow "${workflow?.name ?? workflowId}" deleted.`,
      });
      navigate('/workflows');
    } catch (e) {
      setDeleteOpen(false);
      // 409: a run is still in flight — surface the server's explanation.
      setError(e instanceof Error ? e.message : 'delete failed');
    } finally {
      setBusy(null);
    }
  }

  // UX gating only; the API enforces owner-or-admin on PUT /workflows/{id}.
  const claims = tokenClaims();
  const me = (claims?.['cognito:username'] as string) ?? (claims?.sub as string);
  const canEdit = Boolean(
    isAdminUser() || (workflow?.createdBy && me && workflow.createdBy === me),
  );

  function openEdit() {
    if (!workflow) {
      return;
    }
    setEditName(workflow.name);
    setEditGoal(workflow.goal);
    setEditPlanMode(workflow.planMode);
    setEditFailurePolicy(workflow.failurePolicy ?? 'contain');
    setEditMaxAttempts(String(workflow.maxAttempts ?? 3));
    setEditOpen(true);
  }

  async function saveEdit() {
    setBusy('edit');
    setError(null);
    try {
      await api.updateWorkflow(workflowId, {
        name: editName,
        goal: editGoal,
        planMode: editPlanMode,
        failurePolicy: editFailurePolicy,
        ...(editFailurePolicy === 'retry-run'
          ? { maxAttempts: Math.min(Math.max(Number(editMaxAttempts) || 3, 1), 3) }
          : {}),
      });
      setEditOpen(false);
      notify({
        type: 'success',
        content:
          'Workflow updated. A changed goal applies to the next plan draft or replan-each-run execution.',
      });
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'update failed');
      setEditOpen(false);
    } finally {
      setBusy(null);
    }
  }

  if (!workflow) {
    return (
      <ContentLayout>
        {error ? (
          <Alert type="error" header="Couldn't load this workflow">
            {error}
          </Alert>
        ) : (
          <Box textAlign="center" padding="xxl">
            <Spinner size="large" />
          </Box>
        )}
      </ContentLayout>
    );
  }

  const drafting =
    !!draftJob && (draftJob.status === 'pending' || draftJob.status === 'running');
  const hasPlan = workflow.latestVersion >= 1;
  const planRows: PlanRow[] = plan
    ? [
        ...plan.tasks.map((task) => ({
          id: task.id,
          name: task.name,
          worker: task.worker,
          tools: task.allowedTools.join(', ') || '—',
          model: task.modelOverride ?? 'worker default',
          after: task.dependsOn.join(', ') || '—',
        })),
        {
          id: '__report',
          name: 'Report',
          worker: plan.report.worker,
          tools: '—',
          model: 'worker default',
          after: 'all tasks',
        },
      ]
    : [];

  return (
    <ContentLayout
      header={
        <Header
          variant="h1"
          description={workflow.goal}
          actions={
            <SpaceBetween direction="horizontal" size="xs">
              <ButtonDropdown
                items={[
                  {
                    id: 'edit',
                    text: 'Edit workflow',
                    disabled: !canEdit,
                    disabledReason:
                      'Only the workflow owner or an org admin can edit this workflow.',
                  },
                  { id: 'copy-link', text: 'Copy link' },
                  { id: 'refresh', text: 'Refresh' },
                  {
                    id: 'delete',
                    text: 'Delete workflow',
                    disabled: !canEdit,
                    disabledReason:
                      'Only the workflow owner or an org admin can delete this workflow.',
                  },
                ]}
                onItemClick={({ detail }) => {
                  if (detail.id === 'edit') {
                    openEdit();
                  } else if (detail.id === 'copy-link') {
                    void navigator.clipboard.writeText(window.location.href).then(() => {
                      notify({ type: 'success', content: 'Link copied to clipboard.' });
                    });
                  } else if (detail.id === 'refresh') {
                    void refresh().catch(() => undefined);
                  } else if (detail.id === 'delete') {
                    setDeleteConfirmText('');
                    setDeleteOpen(true);
                  }
                }}
              >
                Actions
              </ButtonDropdown>
              <Button
                variant="primary"
                onClick={() => void runNow()}
                loading={busy === 'run'}
                disabled={!hasPlan}
                disabledReason="Save a plan before running."
              >
                Run now
              </Button>
            </SpaceBetween>
          }
        >
          {workflow.name}
        </Header>
      }
    >
      <SpaceBetween size="l">
        {error && (
          <Alert type="error" dismissible onDismiss={() => setError(null)}>
            {error}
          </Alert>
        )}

        <Modal
          visible={editOpen}
          onDismiss={() => setEditOpen(false)}
          header="Edit workflow"
          footer={
            <Box float="right">
              <SpaceBetween direction="horizontal" size="xs">
                <Button variant="link" onClick={() => setEditOpen(false)}>
                  Cancel
                </Button>
                <Button
                  variant="primary"
                  loading={busy === 'edit'}
                  disabled={!editName.trim() || !editGoal.trim()}
                  onClick={() => void saveEdit()}
                >
                  Save changes
                </Button>
              </SpaceBetween>
            </Box>
          }
        >
          <SpaceBetween size="m">
            <FormField label="Name" stretch>
              <Input
                value={editName}
                onChange={({ detail }) => setEditName(detail.value)}
              />
            </FormField>
            <FormField
              label="Research goal"
              description="Applies to the next plan draft or replan-each-run execution. Already-saved plan versions keep the goal they were planned for."
              stretch
            >
              <Textarea
                value={editGoal}
                rows={5}
                onChange={({ detail }) => setEditGoal(detail.value)}
              />
            </FormField>
            <FormField label="Plan mode" stretch>
              <RadioGroup
                value={editPlanMode}
                onChange={({ detail }) =>
                  setEditPlanMode(detail.value as 'static' | 'replan-each-run')
                }
                items={[
                  {
                    value: 'static',
                    label: 'Static',
                    description: 'Every run executes the saved plan version.',
                  },
                  {
                    value: 'replan-each-run',
                    label: 'Replan each run',
                    description: 'The planner drafts a fresh plan from the goal on every run.',
                  },
                ]}
              />
            </FormField>
            <FormField
              label="On task failure"
              description="Applies to runs started after saving."
              stretch
            >
              <RadioGroup
                value={editFailurePolicy}
                onChange={({ detail }) =>
                  setEditFailurePolicy(detail.value as FailurePolicy)
                }
                items={[
                  {
                    value: 'contain',
                    label: 'Continue (contain)',
                    description:
                      'Skip dependent tasks and produce the report with gaps flagged.',
                  },
                  {
                    value: 'fail-fast',
                    label: 'Stop the whole job',
                    description: 'The first task failure stops the run. No report.',
                  },
                  {
                    value: 'retry-run',
                    label: 'Retry the job',
                    description:
                      'Re-run failed and skipped tasks (completed outputs are kept), up to the attempt limit.',
                  },
                ]}
              />
            </FormField>
            {editFailurePolicy === 'retry-run' && (
              <FormField
                label="Max attempts"
                description="Total passes including the first (1-3)."
              >
                <Input
                  type="number"
                  value={editMaxAttempts}
                  onChange={({ detail }) => setEditMaxAttempts(detail.value)}
                />
              </FormField>
            )}
          </SpaceBetween>
        </Modal>

        <Modal
          visible={deleteOpen}
          onDismiss={() => setDeleteOpen(false)}
          header="Delete workflow"
          footer={
            <Box float="right">
              <SpaceBetween direction="horizontal" size="xs">
                <Button variant="link" onClick={() => setDeleteOpen(false)}>
                  Cancel
                </Button>
                <Button
                  variant="primary"
                  loading={busy === 'delete'}
                  disabled={deleteConfirmText !== 'confirm'}
                  onClick={() => void confirmDelete()}
                >
                  Delete
                </Button>
              </SpaceBetween>
            </Box>
          }
        >
          <SpaceBetween size="m">
            <Box variant="span">
              Permanently delete workflow{' '}
              <Box variant="span" fontWeight="bold">
                {workflow.name}
              </Box>
              ? This removes its saved plan versions, run history, and
              schedule. This action can't be undone.
            </Box>
            <Alert type="info">
              Report artifacts already produced by past runs remain in the S3
              artifacts bucket.
            </Alert>
            <FormField
              label={
                <span>
                  To confirm, type{' '}
                  <Box variant="span" fontWeight="bold">
                    confirm
                  </Box>
                </span>
              }
              stretch
            >
              <Input
                value={deleteConfirmText}
                onChange={({ detail }) => setDeleteConfirmText(detail.value)}
                placeholder="confirm"
                onKeyDown={({ detail }) => {
                  if (detail.key === 'Enter' && deleteConfirmText === 'confirm') {
                    void confirmDelete();
                  }
                }}
              />
            </FormField>
          </SpaceBetween>
        </Modal>

        <Container header={<Header variant="h2">Overview</Header>}>
          <KeyValuePairs
            columns={4}
            items={[
              {
                label: 'Plan mode',
                value:
                  workflow.planMode === 'replan-each-run' ? 'Replan each run' : 'Static',
              },
              {
                label: 'Plan version',
                value: hasPlan ? (
                  <StatusIndicator type="success">v{workflow.latestVersion}</StatusIndicator>
                ) : (
                  <StatusIndicator type="pending">no plan yet</StatusIndicator>
                ),
              },
              {
                label: 'Schedule',
                value: workflow.schedule
                  ? `${workflow.schedule.expression}${workflow.schedule.enabled ? '' : ' (off)'}`
                  : '—',
              },
              {
                label: 'On task failure',
                value:
                  workflow.failurePolicy === 'fail-fast'
                    ? 'Stop the whole job'
                    : workflow.failurePolicy === 'retry-run'
                      ? `Retry the job (max ${workflow.maxAttempts ?? 3} attempts)`
                      : 'Continue with gaps (contain)',
              },
              { label: 'Created', value: formatDateTime(workflow.createdAt) },
            ]}
          />
        </Container>

        <Container
          header={
            <Header
              variant="h2"
              description="Draft with the planner, review and edit, then save. Saving creates a new plan version."
              actions={
                <SpaceBetween direction="horizontal" size="xs">
                  {plan && !draft && (
                    <Button onClick={() => setDraft(plan)} disabled={drafting}>
                      Edit plan
                    </Button>
                  )}
                  <Button
                    onClick={() => void startDraft()}
                    loading={busy === 'draft'}
                    disabled={drafting}
                  >
                    {plan ? 'Re-draft with planner' : 'Draft plan with planner'}
                  </Button>
                </SpaceBetween>
              }
            >
              Plan
            </Header>
          }
        >
          <SpaceBetween size="m">
            {drafting && (
              <StatusIndicator type="in-progress">
                Planner {draftJob?.status}… checking every {DRAFT_POLL_MS / 1000}s
              </StatusIndicator>
            )}
            {draftJob?.status === 'failed' && (
              <Alert
                type="error"
                header={`Planner failed after ${draftJob.attempts ?? '?'} attempt(s)`}
              >
                {(draftJob.issues ?? []).map((issue) => (
                  <div key={issue}>{issue}</div>
                ))}
              </Alert>
            )}
            {draft ? (
              <PlanEditor
                initial={draft}
                onSave={saveDraft}
                onCancel={() => {
                  setDraft(null);
                  setDraftJob(null);
                }}
              />
            ) : plan ? (
              <Table
                variant="embedded"
                items={planRows}
                trackBy="id"
                columnDefinitions={[
                  {
                    id: 'name',
                    header: 'Task',
                    cell: (row) =>
                      row.id === '__report' ? (
                        <Box fontWeight="bold">{row.name}</Box>
                      ) : (
                        row.name
                      ),
                  },
                  { id: 'worker', header: 'Worker', cell: (row) => row.worker },
                  { id: 'tools', header: 'Tools', cell: (row) => row.tools },
                  { id: 'model', header: 'Model', cell: (row) => row.model },
                  { id: 'after', header: 'After', cell: (row) => row.after },
                ]}
              />
            ) : (
              !drafting && (
                <Box color="text-body-secondary">
                  No plan yet. Draft one with the planner, review it, then save.
                </Box>
              )
            )}
          </SpaceBetween>
        </Container>

        <Container
          header={
            <Header
              variant="h2"
              description={
                hasPlan
                  ? 'Runs trigger through EventBridge Scheduler.'
                  : 'Save a plan before scheduling or running.'
              }
            >
              Schedule
            </Header>
          }
        >
          <SpaceBetween size="m">
            <FormField
              label="Schedule expression"
              constraintText="rate(<n> minutes|hours|days) or cron(…) — for example rate(7 days) or cron(0 9 1 * ? *)"
            >
              <Input
                value={scheduleExpr}
                onChange={({ detail }) => {
                  scheduleTouched.current = true;
                  setScheduleExpr(detail.value);
                }}
                placeholder="rate(7 days)"
                disabled={!hasPlan}
              />
            </FormField>
            <Toggle
              checked={scheduleEnabled}
              onChange={({ detail }) => {
                scheduleTouched.current = true;
                setScheduleEnabled(detail.checked);
              }}
              disabled={!hasPlan}
            >
              Enabled
            </Toggle>
            <Button
              onClick={() => void saveSchedule()}
              loading={busy === 'schedule'}
              disabled={!hasPlan}
              disabledReason="Save a plan before scheduling."
            >
              Save schedule
            </Button>
          </SpaceBetween>
        </Container>

        <Table
          items={runs}
          trackBy="runId"
          onRowClick={({ detail }) => navigate(`/runs/${detail.item.runId}`)}
          header={
            <Header
              variant="h2"
              counter={`(${runs.length})`}
              description={`Auto-refreshes every ${RUNS_POLL_MS / 1000} seconds.`}
            >
              Runs
            </Header>
          }
          columnDefinitions={[
            {
              id: 'started',
              header: 'Started',
              cell: (run) => (
                <Link
                  href={`/runs/${run.runId}`}
                  onFollow={(event) => {
                    event.preventDefault();
                    navigate(`/runs/${run.runId}`);
                  }}
                >
                  {formatDateTime(run.startedAt)}
                </Link>
              ),
            },
            { id: 'status', header: 'Status', cell: (run) => <RunStatus status={run.status} /> },
            { id: 'trigger', header: 'Trigger', cell: (run) => run.trigger },
            { id: 'plan', header: 'Plan', cell: (run) => `v${run.planVersion}` },
          ]}
          empty={
            <Box textAlign="center" color="inherit" padding="s">
              <Box color="text-body-secondary">No runs yet.</Box>
            </Box>
          }
        />
      </SpaceBetween>
    </ContentLayout>
  );
}
