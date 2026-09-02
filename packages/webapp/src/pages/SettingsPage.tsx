/**
 * Settings. Profile and Appearance work today; Cost & usage and Worker
 * catalog are previews — they need aggregation/catalog APIs the platform
 * doesn't expose yet.
 */
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import Alert from '@cloudscape-design/components/alert';
import Badge from '@cloudscape-design/components/badge';
import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import Container from '@cloudscape-design/components/container';
import ContentLayout from '@cloudscape-design/components/content-layout';
import ExpandableSection from '@cloudscape-design/components/expandable-section';
import FormField from '@cloudscape-design/components/form-field';
import Grid from '@cloudscape-design/components/grid';
import Header from '@cloudscape-design/components/header';
import Input from '@cloudscape-design/components/input';
import KeyValuePairs from '@cloudscape-design/components/key-value-pairs';
import Select from '@cloudscape-design/components/select';
import SpaceBetween from '@cloudscape-design/components/space-between';
import StatusIndicator from '@cloudscape-design/components/status-indicator';
import Textarea from '@cloudscape-design/components/textarea';
import Toggle from '@cloudscape-design/components/toggle';
import {
  isCompactDensity,
  isDarkMode,
  setCompactDensity,
  setDarkMode,
} from '../appearance';
import { signOut, tokenClaims } from '../auth';
import {
  api,
  ApiError,
  type CatalogModelEntry,
  type SettingsResponse,
} from '../api';
import { useShell } from '../shell/AppShell';

export default function SettingsPage() {
  const navigate = useNavigate();
  const { setBreadcrumbs } = useShell();
  const [dark, setDark] = useState(isDarkMode);
  const [compact, setCompact] = useState(isCompactDensity);
  const claims = tokenClaims();

  useEffect(() => {
    setBreadcrumbs([{ text: 'Settings', href: '/settings' }]);
  }, [setBreadcrumbs]);

  return (
    <ContentLayout
      header={
        <Header variant="h1" description="Your profile, appearance preferences, and workspace configuration.">
          Settings
        </Header>
      }
    >
      <SpaceBetween size="l">
        <Container
          header={
            <Header
              variant="h2"
              actions={
                <Button
                  onClick={() => {
                    signOut();
                    navigate('/login');
                  }}
                >
                  Sign out
                </Button>
              }
            >
              Profile
            </Header>
          }
        >
          <KeyValuePairs
            columns={3}
            items={[
              {
                label: 'Username',
                value: (claims?.['cognito:username'] as string) ?? '—',
              },
              { label: 'Email', value: (claims?.email as string) ?? '—' },
              {
                label: 'Session expires',
                value: claims?.exp ? new Date(claims.exp * 1000).toLocaleString() : '—',
              },
            ]}
          />
        </Container>

        <Container
          header={
            <Header variant="h2" description="Applied immediately and remembered on this browser.">
              Appearance
            </Header>
          }
        >
          <SpaceBetween size="m">
            <Toggle
              checked={dark}
              onChange={({ detail }) => {
                setDarkMode(detail.checked);
                setDark(detail.checked);
              }}
              description="Switch the whole app between light and dark visual modes."
            >
              Dark mode
            </Toggle>
            <Toggle
              checked={compact}
              onChange={({ detail }) => {
                setCompactDensity(detail.checked);
                setCompact(detail.checked);
              }}
              description="Reduce paddings across the app to fit more on screen."
            >
              Compact density
            </Toggle>
          </SpaceBetween>
        </Container>

        {/* Preview: needs a token/cost aggregation API (per-run token
            totals exist today; account-level charts do not). */}
        <Container
          header={
            <Header
              variant="h2"
              actions={<Badge color="blue">Coming soon</Badge>}
              description="Token usage and spend across workflows over time."
            >
              Cost &amp; usage
            </Header>
          }
        >
          <Box color="text-body-secondary">
            Needs a cross-workflow usage aggregation API. Today, per-run token totals are shown on
            each run&rsquo;s detail page.
          </Box>
        </Container>

        <OrganizationConfiguration />
      </SpaceBetween>
    </ContentLayout>
  );
}

/**
 * Organization configuration (D-19): agent prompts and the model catalog,
 * runtime-editable. Everyone can read; editing requires the Cognito 'admin'
 * group (also enforced server-side). Changes apply from the next invocation —
 * no redeploy.
 */
function OrganizationConfiguration() {
  const { notify } = useShell();
  const [settings, setSettings] = useState<SettingsResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  /** Per-agent model override drafts; '' = deployed default. */
  const [modelDrafts, setModelDrafts] = useState<Record<string, string>>({});
  /** Per-agent thinking effort drafts; '' = deployed default, 'off' = off. */
  const [thinkingDrafts, setThinkingDrafts] = useState<Record<string, string>>({});
  const [catalogRows, setCatalogRows] = useState<CatalogModelEntry[]>([]);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await api.getSettings();
      setSettings(response);
      const seeded: Record<string, string> = {};
      const seededModels: Record<string, string> = {};
      const seededThinking: Record<string, string> = {};
      for (const agent of response.agents) {
        seeded[agent.name] = agent.instructionsOverride ?? agent.defaultInstructions;
        seededModels[agent.name] = agent.modelOverride ?? '';
        seededThinking[agent.name] = agent.thinkingEffortOverride ?? '';
      }
      setDrafts(seeded);
      setModelDrafts(seededModels);
      setThinkingDrafts(seededThinking);
      setCatalogRows(
        response.org.modelCatalog ?? response.deployedModelCatalog ?? [],
      );
      setLoadError(null);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const failure = (error: unknown) => {
    notify({
      type: 'error',
      content:
        error instanceof ApiError && error.status === 403
          ? 'Not permitted: org configuration editing requires the admin group.'
          : error instanceof Error
            ? error.message
            : String(error),
    });
  };

  const saveAgent = async (name: string, override: string | null) => {
    setBusy(`agent-${name}`);
    try {
      await api.putAgentConfig(name, { instructionsOverride: override });
      notify({
        type: 'success',
        content:
          override === null
            ? `${name}: restored the deployed default prompt.`
            : `${name}: prompt override saved — applies from the next run.`,
      });
      await load();
    } catch (error) {
      failure(error);
    } finally {
      setBusy(null);
    }
  };

  const saveAgentModel = async (name: string) => {
    setBusy(`model-${name}`);
    try {
      const model = (modelDrafts[name] ?? '').trim();
      const thinking = (thinkingDrafts[name] ?? '').trim();
      await api.putAgentConfig(name, {
        modelOverride: model === '' ? null : model,
        thinkingEffortOverride:
          thinking === ''
            ? null
            : (thinking as 'off' | 'low' | 'medium' | 'high'),
      });
      notify({
        type: 'success',
        content: `${name}: model settings saved — applies from the next invocation.`,
      });
      await load();
    } catch (error) {
      failure(error);
    } finally {
      setBusy(null);
    }
  };

  const saveCatalog = async (rows: CatalogModelEntry[] | null) => {
    setBusy('catalog');
    try {
      const cleaned = rows
        ?.map((row) => ({
          modelId: row.modelId.trim(),
          ...(row.description?.trim() ? { description: row.description.trim() } : {}),
        }))
        .filter((row) => row.modelId);
      await api.putOrgSettings(cleaned && cleaned.length > 0 ? cleaned : null);
      notify({
        type: 'success',
        content:
          rows === null
            ? 'Model catalog restored to the deployed default.'
            : 'Model catalog saved — the planner sees it on the next draft or run.',
      });
      await load();
    } catch (error) {
      failure(error);
    } finally {
      setBusy(null);
    }
  };

  if (loadError) {
    return (
      <Container header={<Header variant="h2">Organization configuration</Header>}>
        <Alert type="error">{loadError}</Alert>
      </Container>
    );
  }
  if (!settings) {
    return (
      <Container header={<Header variant="h2">Organization configuration</Header>}>
        <StatusIndicator type="loading">Loading configuration…</StatusIndicator>
      </Container>
    );
  }

  const admin = settings.isAdmin;

  // Extended thinking is applied on the planner invocation path (the plan
  // interpreter does not pass thinking params to workers), so only surface
  // the control where it takes effect.
  const supportsThinking = (agentName: string) => {
    const agent = settings.agents.find((entry) => entry.name === agentName);
    return agentName === 'planner' || agent?.defaultThinkingEffort !== undefined;
  };

  const thinkingOptions = (agentName: string) => {
    const agent = settings.agents.find((entry) => entry.name === agentName);
    return [
      {
        label: `Deployed default (${agent?.defaultThinkingEffort ?? 'off'})`,
        value: '',
      },
      { label: 'Off', value: 'off' },
      { label: 'Low', value: 'low' },
      { label: 'Medium', value: 'medium' },
      { label: 'High', value: 'high' },
    ];
  };

  /** Deployed default + effective model catalog + any off-catalog override. */
  const modelOptions = (agentName: string) => {
    const agent = settings.agents.find((entry) => entry.name === agentName);
    const catalog = settings.org.modelCatalog ?? settings.deployedModelCatalog ?? [];
    const options: Array<{ label: string; value: string; description?: string }> = [
      {
        label: `Deployed default (${agent?.defaultModelId ?? 'unknown'})`,
        value: '',
      },
      ...catalog.map((entry) => ({
        label: entry.modelId,
        value: entry.modelId,
        ...(entry.description ? { description: entry.description } : {}),
      })),
    ];
    const current = agent?.modelOverride;
    if (current && !options.some((option) => option.value === current)) {
      options.push({ label: current, value: current });
    }
    return options;
  };

  return (
    <SpaceBetween size="l">
      <Container
        header={
          <Header
            variant="h2"
            description="Each agent's system prompt. Overrides apply per invocation from the next run — the deployment itself is untouched, and 'Restore default' returns to the deployed prompt."
            actions={
              !admin ? <Badge color="grey">Read-only (admin group required)</Badge> : undefined
            }
          >
            Agent prompts
          </Header>
        }
      >
        <SpaceBetween size="m">
          {settings.agents.map((agent) => {
            const draft = drafts[agent.name] ?? '';
            const overridden = agent.instructionsOverride !== undefined;
            const effective = agent.instructionsOverride ?? agent.defaultInstructions;
            return (
              <ExpandableSection
                key={agent.name}
                headerText={agent.name}
                headerDescription={agent.description}
                headerActions={
                  overridden ? <Badge color="blue">Customized</Badge> : undefined
                }
              >
                <SpaceBetween size="s">
                  <SpaceBetween direction="horizontal" size="xs">
                    {(agent.defaultTools ?? []).map((tool) => (
                      <Badge
                        key={tool}
                        color={
                          tool === 'browser' || tool === 'code_interpreter'
                            ? 'green'
                            : 'grey'
                        }
                      >
                        {tool}
                      </Badge>
                    ))}
                    {(agent.defaultTools ?? []).length === 0 && (
                      <Badge color="grey">no tools — knowledge/synthesis only</Badge>
                    )}
                  </SpaceBetween>
                  <FormField
                    label="System prompt"
                    description={`Default model: ${agent.defaultModelId}${
                      agent.updatedBy ? ` · Last edited by ${agent.updatedBy}` : ''
                    }`}
                    stretch
                  >
                    <Textarea
                      value={draft}
                      onChange={({ detail }) =>
                        setDrafts((current) => ({ ...current, [agent.name]: detail.value }))
                      }
                      rows={12}
                      readOnly={!admin}
                      spellcheck={false}
                    />
                  </FormField>
                  {admin && (
                    <SpaceBetween direction="horizontal" size="xs">
                      <Button
                        variant="primary"
                        loading={busy === `agent-${agent.name}`}
                        disabled={!draft.trim() || draft === effective}
                        onClick={() => void saveAgent(agent.name, draft)}
                      >
                        Save override
                      </Button>
                      <Button
                        disabled={!overridden}
                        loading={busy === `agent-${agent.name}`}
                        onClick={() => void saveAgent(agent.name, null)}
                      >
                        Restore default
                      </Button>
                    </SpaceBetween>
                  )}
                  <Grid
                    gridDefinition={[
                      { colspan: { default: 12, s: supportsThinking(agent.name) ? 5 : 8 } },
                      ...(supportsThinking(agent.name)
                        ? [{ colspan: { default: 12, s: 4 } }]
                        : []),
                      { colspan: { default: 12, s: 3 } },
                    ]}
                  >
                    <FormField
                      label="Model"
                      description={`Deployed default: ${agent.defaultModelId}. Overrides apply from the next invocation.`}
                      stretch
                    >
                      <Select
                        selectedOption={
                          modelOptions(agent.name).find(
                            (option) => option.value === (modelDrafts[agent.name] ?? ''),
                          ) ?? modelOptions(agent.name)[0]!
                        }
                        options={modelOptions(agent.name)}
                        disabled={!admin}
                        onChange={({ detail }) =>
                          setModelDrafts((current) => ({
                            ...current,
                            [agent.name]: detail.selectedOption.value ?? '',
                          }))
                        }
                      />
                    </FormField>
                    {supportsThinking(agent.name) && (
                      <FormField
                        label="Thinking effort"
                        description={`Adaptive reasoning depth per invocation. Deployed default: ${
                          agent.defaultThinkingEffort ?? 'off'
                        }.`}
                        stretch
                      >
                        <Select
                          selectedOption={
                            thinkingOptions(agent.name).find(
                              (option) =>
                                option.value === (thinkingDrafts[agent.name] ?? ''),
                            ) ?? thinkingOptions(agent.name)[0]!
                          }
                          options={thinkingOptions(agent.name)}
                          disabled={!admin}
                          onChange={({ detail }) =>
                            setThinkingDrafts((current) => ({
                              ...current,
                              [agent.name]: detail.selectedOption.value ?? '',
                            }))
                          }
                        />
                      </FormField>
                    )}
                    {admin ? (
                      <Box padding={{ top: 'xl' }}>
                        <Button
                          loading={busy === `model-${agent.name}`}
                          onClick={() => void saveAgentModel(agent.name)}
                        >
                          Save model settings
                        </Button>
                      </Box>
                    ) : (
                      <Box />
                    )}
                  </Grid>
                </SpaceBetween>
              </ExpandableSection>
            );
          })}
          {settings.agents.length === 0 && (
            <Box color="text-body-secondary">
              No agent configs found — they are seeded at deploy time.
            </Box>
          )}
        </SpaceBetween>
      </Container>

      <Container
        header={
          <Header
            variant="h2"
            description="Models the planner may assign to tasks by complexity. Include guidance in each description; the planner reads it verbatim."
            actions={
              settings.org.modelCatalog ? <Badge color="blue">Customized</Badge> : undefined
            }
          >
            Model catalog
          </Header>
        }
      >
        <SpaceBetween size="s">
          {catalogRows.map((row, index) => (
            <Grid
              key={index}
              gridDefinition={[
                { colspan: { default: 12, s: 4 } },
                { colspan: { default: 12, s: 6 } },
                { colspan: { default: 12, s: 2 } },
              ]}
            >
              <FormField label={index === 0 ? 'Model id' : undefined} stretch>
                <Input
                  value={row.modelId}
                  placeholder="inference profile or model id"
                  readOnly={!admin}
                  onChange={({ detail }) =>
                    setCatalogRows((rows) =>
                      rows.map((r, i) => (i === index ? { ...r, modelId: detail.value } : r)),
                    )
                  }
                />
              </FormField>
              <FormField
                label={index === 0 ? 'Complexity guidance' : undefined}
                stretch
              >
                <Input
                  value={row.description ?? ''}
                  placeholder="e.g. fast/low-cost — simple extraction"
                  readOnly={!admin}
                  onChange={({ detail }) =>
                    setCatalogRows((rows) =>
                      rows.map((r, i) =>
                        i === index ? { ...r, description: detail.value } : r,
                      ),
                    )
                  }
                />
              </FormField>
              {admin ? (
                <Box padding={{ top: index === 0 ? 'xl' : 'n' }}>
                  <Button
                    iconName="remove"
                    variant="icon"
                    ariaLabel={`Remove ${row.modelId || 'row'}`}
                    onClick={() =>
                      setCatalogRows((rows) => rows.filter((_, i) => i !== index))
                    }
                  />
                </Box>
              ) : (
                <Box />
              )}
            </Grid>
          ))}
          {catalogRows.length === 0 && (
            <Box color="text-body-secondary">
              No models configured — the planner will not assign per-task models.
            </Box>
          )}
          {admin && (
            <SpaceBetween direction="horizontal" size="xs">
              <Button
                iconName="add-plus"
                onClick={() =>
                  setCatalogRows((rows) => [...rows, { modelId: '', description: '' }])
                }
              >
                Add model
              </Button>
              <Button
                variant="primary"
                loading={busy === 'catalog'}
                onClick={() => void saveCatalog(catalogRows)}
              >
                Save catalog
              </Button>
              <Button
                disabled={!settings.org.modelCatalog}
                loading={busy === 'catalog'}
                onClick={() => void saveCatalog(null)}
              >
                Restore deployed default
              </Button>
            </SpaceBetween>
          )}
        </SpaceBetween>
      </Container>
    </SpaceBetween>
  );
}
