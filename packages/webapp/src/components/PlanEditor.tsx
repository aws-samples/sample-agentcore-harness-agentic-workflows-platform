import { useEffect, useState } from 'react';
import type { PlanDocument } from '@agentic-platform/plan-schema';
import { parsePlanDocument } from '@agentic-platform/plan-schema';
import Alert from '@cloudscape-design/components/alert';
import Button from '@cloudscape-design/components/button';
import ExpandableSection from '@cloudscape-design/components/expandable-section';
import FormField from '@cloudscape-design/components/form-field';
import Multiselect from '@cloudscape-design/components/multiselect';
import Select from '@cloudscape-design/components/select';
import SpaceBetween from '@cloudscape-design/components/space-between';
import Textarea from '@cloudscape-design/components/textarea';
import { api, type AgentConfig, type CatalogModelEntry } from '../api';

interface PlanEditorProps {
  initial: PlanDocument;
  onSave: (plan: PlanDocument) => Promise<void>;
  onCancel?: () => void;
}

const WORKER_DEFAULT = '';

/**
 * Review/edit a draft plan before saving. Editable per task: prompt, worker
 * (dropdown from the deployed agent configs; switching re-scopes allowed
 * tools), allowed tools (multiselect of the worker's gateway tools), and
 * per-task model (D-18, from the org's model catalog). The report worker is
 * likewise selectable. Structure (ids, dependencies) stays read-only in v1.
 * Client-side validation reuses the shared schema so the save button can't
 * submit an invalid plan; workers, tools, and model ids are additionally
 * validated server-side against the deployed catalogs.
 */
export default function PlanEditor({ initial, onSave, onCancel }: PlanEditorProps) {
  const [plan, setPlan] = useState<PlanDocument>(initial);
  const [issues, setIssues] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [modelCatalog, setModelCatalog] = useState<CatalogModelEntry[]>([]);
  const [agents, setAgents] = useState<AgentConfig[]>([]);

  useEffect(() => {
    // Effective catalog (org override ?? deployed); no catalog → no selector.
    // Agent configs drive the worker dropdown and per-worker tool options.
    api
      .getSettings()
      .then((settings) => {
        setModelCatalog(settings.org.modelCatalog ?? settings.deployedModelCatalog ?? []);
        setAgents(settings.agents);
      })
      .catch(() => {
        setModelCatalog([]);
        setAgents([]);
      });
  }, []);

  /** Workers a plan task may target: every agent except the planner. */
  const workerOptions = agents
    .filter((agent) => agent.name !== 'planner')
    .map((agent) => ({
      label: agent.name,
      value: agent.name,
      ...(agent.description ? { description: agent.description } : {}),
    }));

  /**
   * Gateway tools a task's allowedTools may name for a worker. The
   * 'browser'/'code_interpreter' capability markers are excluded: they are
   * worker-level capabilities, not per-task grantable names — plan
   * validation (WORKER_CATALOG) rejects them in allowedTools.
   */
  function gatewayToolsFor(workerName: string): string[] {
    const agent = agents.find((entry) => entry.name === workerName);
    return (agent?.defaultTools ?? []).filter(
      (tool) => tool !== 'browser' && tool !== 'code_interpreter',
    );
  }

  function modelOptions(current: string | null | undefined) {
    const options = [
      {
        label: 'Worker default',
        value: WORKER_DEFAULT,
        description: "Use the worker agent's configured model.",
      },
      ...modelCatalog.map((model) => ({
        label: model.modelId,
        value: model.modelId,
        ...(model.description ? { description: model.description } : {}),
      })),
    ];
    if (current && !modelCatalog.some((model) => model.modelId === current)) {
      // Preserve a stale override visibly instead of silently dropping it;
      // the server rejects it on save unless the catalog re-includes it.
      options.push({
        label: `${current} (not in current catalog)`,
        value: current,
      });
    }
    return options;
  }

  function updateTask(index: number, patch: Partial<PlanDocument['tasks'][number]>) {
    setPlan((current) => ({
      ...current,
      tasks: current.tasks.map((task, i) => (i === index ? { ...task, ...patch } : task)),
    }));
  }

  async function save() {
    const validated = parsePlanDocument(plan);
    if (!validated.ok) {
      setIssues(validated.issues);
      return;
    }
    setIssues([]);
    setBusy(true);
    try {
      await onSave(validated.plan);
    } finally {
      setBusy(false);
    }
  }

  return (
    <SpaceBetween size="m">
      <Alert type="info">
        Review the draft before saving. Independent tasks run in parallel; dependent tasks receive
        their dependencies&rsquo; outputs. The report step assembles everything at the end.
      </Alert>
      {plan.tasks.map((task, index) => (
        <ExpandableSection
          key={task.id}
          defaultExpanded={index === 0}
          headerText={task.name}
          headerDescription={`worker: ${task.worker}${
            task.dependsOn.length > 0 ? ` · after: ${task.dependsOn.join(', ')}` : ''
          }`}
        >
          <SpaceBetween size="m">
            <FormField label="Prompt" stretch>
              <Textarea
                rows={5}
                value={task.prompt}
                onChange={({ detail }) => updateTask(index, { prompt: detail.value })}
              />
            </FormField>
            {workerOptions.length > 0 && (
              <FormField
                label="Worker"
                description="Which specialist runs this step. Changing it re-scopes the allowed tools; make sure the prompt fits the new worker's capabilities."
              >
                <Select
                  selectedOption={
                    workerOptions.find((option) => option.value === task.worker) ?? {
                      label: `${task.worker} (not in current catalog)`,
                      value: task.worker,
                    }
                  }
                  onChange={({ detail }) => {
                    const worker = detail.selectedOption.value ?? task.worker;
                    const valid = gatewayToolsFor(worker);
                    updateTask(index, {
                      worker,
                      // Keep only tools the new worker actually has.
                      allowedTools: task.allowedTools.filter((tool) =>
                        valid.includes(tool),
                      ),
                    });
                  }}
                  options={workerOptions}
                />
              </FormField>
            )}
            <FormField
              label="Allowed tools"
              description="Narrows this worker's gateway-tool grant for this step (validated on save). Browser/code-interpreter are worker-level capabilities and always available to workers that have them."
              stretch
            >
              <Multiselect
                selectedOptions={task.allowedTools.map((tool) => ({
                  label: tool,
                  value: tool,
                }))}
                onChange={({ detail }) =>
                  updateTask(index, {
                    allowedTools: detail.selectedOptions
                      .map((option) => option.value)
                      .filter((value): value is string => Boolean(value)),
                  })
                }
                options={[
                  ...gatewayToolsFor(task.worker).map((tool) => ({
                    label: tool,
                    value: tool,
                  })),
                  // Preserve selections the current catalog no longer offers
                  // (visible + removable, rejected server-side on save).
                  ...task.allowedTools
                    .filter((tool) => !gatewayToolsFor(task.worker).includes(tool))
                    .map((tool) => ({
                      label: `${tool} (not offered by ${task.worker})`,
                      value: tool,
                    })),
                ]}
                placeholder="No tool narrowing — worker uses its full grant"
              />
            </FormField>
            {modelCatalog.length > 0 && (
              <FormField
                label="Model"
                description="Which Bedrock model runs this task. Pick a stronger model for deep synthesis, a lighter one for simple lookups."
              >
                <Select
                  selectedOption={
                    modelOptions(task.modelOverride).find(
                      (option) => option.value === (task.modelOverride ?? WORKER_DEFAULT),
                    ) ?? null
                  }
                  onChange={({ detail }) =>
                    updateTask(index, {
                      modelOverride: detail.selectedOption.value || undefined,
                    })
                  }
                  options={modelOptions(task.modelOverride)}
                />
              </FormField>
            )}
          </SpaceBetween>
        </ExpandableSection>
      ))}
      <ExpandableSection headerText="Report" headerDescription={`worker: ${plan.report.worker}`}>
        <SpaceBetween size="m">
          {workerOptions.length > 0 && (
            <FormField
              label="Report worker"
              description="Which agent assembles the final deliverable from all task outputs."
            >
              <Select
                selectedOption={
                  workerOptions.find((option) => option.value === plan.report.worker) ?? {
                    label: `${plan.report.worker} (not in current catalog)`,
                    value: plan.report.worker,
                  }
                }
                onChange={({ detail }) =>
                  setPlan((current) => ({
                    ...current,
                    report: {
                      ...current.report,
                      worker: detail.selectedOption.value ?? current.report.worker,
                    },
                  }))
                }
                options={workerOptions}
              />
            </FormField>
          )}
          <FormField label="Report instructions" stretch>
            <Textarea
              rows={5}
              value={plan.report.instructions}
              onChange={({ detail }) =>
                setPlan((current) => ({
                  ...current,
                  report: { ...current.report, instructions: detail.value },
                }))
              }
            />
          </FormField>
        </SpaceBetween>
      </ExpandableSection>
      {issues.length > 0 && (
        <Alert type="error" header="The plan failed validation">
          {issues.map((issue) => (
            <div key={issue}>{issue}</div>
          ))}
        </Alert>
      )}
      <SpaceBetween direction="horizontal" size="xs">
        <Button variant="primary" onClick={() => void save()} loading={busy}>
          Save plan
        </Button>
        {onCancel && (
          <Button onClick={onCancel} disabled={busy}>
            Discard
          </Button>
        )}
      </SpaceBetween>
    </SpaceBetween>
  );
}
