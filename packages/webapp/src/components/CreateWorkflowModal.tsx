/**
 * Create-workflow modal (Cloudscape modal). Client-side limits mirror the
 * API's validation (name ≤128, goal ≤4000).
 */
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import Alert from '@cloudscape-design/components/alert';
import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import FormField from '@cloudscape-design/components/form-field';
import Input from '@cloudscape-design/components/input';
import Modal from '@cloudscape-design/components/modal';
import RadioGroup from '@cloudscape-design/components/radio-group';
import SpaceBetween from '@cloudscape-design/components/space-between';
import Textarea from '@cloudscape-design/components/textarea';
import { api } from '../api';
import { useShell } from '../shell/AppShell';

type PlanMode = 'static' | 'replan-each-run';

interface CreateWorkflowModalProps {
  visible: boolean;
  onDismiss: () => void;
}

export default function CreateWorkflowModal({ visible, onDismiss }: CreateWorkflowModalProps) {
  const navigate = useNavigate();
  const { notify } = useShell();
  const [name, setName] = useState('');
  const [goal, setGoal] = useState('');
  const [planMode, setPlanMode] = useState<PlanMode>('static');
  const [nameError, setNameError] = useState<string | null>(null);
  const [goalError, setGoalError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (visible) {
      setName('');
      setGoal('');
      setPlanMode('static');
      setNameError(null);
      setGoalError(null);
      setError(null);
      setBusy(false);
    }
  }, [visible]);

  async function create() {
    const trimmedName = name.trim();
    const trimmedGoal = goal.trim();
    const nameIssue = !trimmedName
      ? 'Name is required.'
      : trimmedName.length > 128
        ? 'Name must be 128 characters or fewer.'
        : null;
    const goalIssue = !trimmedGoal
      ? 'Goal is required.'
      : trimmedGoal.length > 4000
        ? 'Goal must be 4,000 characters or fewer.'
        : null;
    setNameError(nameIssue);
    setGoalError(goalIssue);
    if (nameIssue || goalIssue) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const { workflowId } = await api.createWorkflow({
        name: trimmedName,
        goal: trimmedGoal,
        planMode,
      });
      notify({ type: 'success', content: `Workflow "${trimmedName}" created.` });
      navigate(`/workflows/${workflowId}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'create failed');
      setBusy(false);
    }
  }

  return (
    <Modal
      visible={visible}
      onDismiss={onDismiss}
      header="Create workflow"
      footer={
        <Box float="right">
          <SpaceBetween direction="horizontal" size="xs">
            <Button variant="link" onClick={onDismiss} disabled={busy}>
              Cancel
            </Button>
            <Button variant="primary" onClick={() => void create()} loading={busy}>
              Create
            </Button>
          </SpaceBetween>
        </Box>
      }
    >
      <SpaceBetween size="l">
        {error && <Alert type="error">{error}</Alert>}
        <FormField label="Name" constraintText="Up to 128 characters." errorText={nameError ?? undefined}>
          <Input
            value={name}
            onChange={({ detail }) => setName(detail.value)}
            placeholder="EV market scan"
            autoFocus
          />
        </FormField>
        <FormField
          label="Goal"
          description="State the research goal in plain language — the planner drafts the agent workflow for your review."
          constraintText="Up to 4,000 characters."
          errorText={goalError ?? undefined}
          stretch
        >
          <Textarea
            rows={4}
            value={goal}
            onChange={({ detail }) => setGoal(detail.value)}
            placeholder="Research current electric vehicle market trends in Europe: consumer sentiment, competitor moves, pricing, and recent coverage. Produce a concise brief."
          />
        </FormField>
        <FormField label="Plan mode">
          <RadioGroup
            value={planMode}
            onChange={({ detail }) => setPlanMode(detail.value as PlanMode)}
            items={[
              {
                value: 'static',
                label: 'Static',
                description: 'Every run executes the reviewed plan (recommended).',
              },
              {
                value: 'replan-each-run',
                label: 'Replan each run',
                description: 'The planner re-plans at every execution.',
              },
            ]}
          />
        </FormField>
      </SpaceBetween>
    </Modal>
  );
}
