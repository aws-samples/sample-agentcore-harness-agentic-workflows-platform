/**
 * ReportWorkspace — the report viewer with version history and a Markdown
 * editor as page content, plus the "Ask the report" chat mounted in the
 * AppLayout tools drawer so it stays alongside the report while you scroll.
 *
 * Review model: the assistant proposes ALL its edits at once (one entry per
 * affected section). Review renders the WHOLE report with every proposed
 * section shown as an inline diff and its own Accept / Keep current toggle;
 * a sticky bar at the top offers Accept all / Keep all current and saves the
 * composed result ("Save 2 of 3 sections"). Unchanged sections render as
 * normal text, so each change is seen in context. Nothing is written until
 * the user saves.
 *
 * Saves create report.v<n>.md; the generated original is never overwritten.
 * `baseVersion` gives optimistic concurrency (409 → reload). Editing is
 * offered to the workflow owner or an org admin (the server enforces it).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Alert from '@cloudscape-design/components/alert';
import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import Container from '@cloudscape-design/components/container';
import ExpandableSection from '@cloudscape-design/components/expandable-section';
import FormField from '@cloudscape-design/components/form-field';
import Header from '@cloudscape-design/components/header';
import Input from '@cloudscape-design/components/input';
import PromptInput from '@cloudscape-design/components/prompt-input';
import SegmentedControl from '@cloudscape-design/components/segmented-control';
import Select, { type SelectProps } from '@cloudscape-design/components/select';
import SpaceBetween from '@cloudscape-design/components/space-between';
import StatusIndicator from '@cloudscape-design/components/status-indicator';
import Textarea from '@cloudscape-design/components/textarea';
import {
  applySectionEdits,
  editTarget,
  extractReportSection,
  findReportSection,
  listReportSections,
} from '@agentic-platform/plan-schema';
import {
  api,
  ApiError,
  chatAboutReportStream,
  type ChatMessage,
  type ProposedEdit,
  type ReportVersion,
} from '../api';
import { formatDateTime } from '../format';
import {
  describeDiff,
  diffMarkdown,
  groupHunks,
  joinBlocks,
  summarizeDiff,
  removesMostContent,
  wordDiffMarkdown,
  type Hunk,
} from '../reportDiff';
import { useShell } from '../shell/AppShell';
import Markdown from './Markdown';

export interface ReportWorkspaceProps {
  runId: string;
  /** Latest report key from the run record (v1 until an edit is saved). */
  reportArtifactKey: string;
  /** Edit history from the run record; absent for never-edited runs. */
  reportVersions?: ReportVersion[];
  /** Whether the signed-in user may save edits (owner or admin). */
  canEdit: boolean;
  /** Called after a successful save so the page can refresh run state. */
  onSaved?: () => void;
}

interface LoadedReport {
  version: number;
  key: string;
  text: string;
}

type ReviewView = 'diff' | 'proposed' | 'current';

/** A set of proposed section edits under review in the report pane. */
interface Review {
  edits: ProposedEdit[];
  /** Per-edit decision: true = accept proposed, false = keep current. */
  accepted: boolean[];
  /** Index of the chat message that carried the proposal (to mark saved). */
  messageIndex: number;
  view: ReviewView;
}

export default function ReportWorkspace(props: ReportWorkspaceProps) {
  const { runId, canEdit } = props;
  const shell = useShell();

  // Versions as the server sees them; synthesize v1 for legacy runs.
  const versions = useMemo<ReportVersion[]>(
    () =>
      props.reportVersions && props.reportVersions.length > 0
        ? props.reportVersions
        : [{ version: 1, artifactKey: props.reportArtifactKey, savedAt: '' }],
    [props.reportVersions, props.reportArtifactKey],
  );
  const latest = versions[versions.length - 1]!;

  const [selectedVersion, setSelectedVersion] = useState<number>(latest.version);
  const [loaded, setLoaded] = useState<LoadedReport | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Editor
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedVersion, setSavedVersion] = useState<number | null>(null);

  // Chat (state lives here so the drawer panel is pure props and survives
  // the drawer element being re-set on every render).
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  /** Prefill for the chat input (the panel owns the draft itself — see ChatPanel). */
  const [chatSeed, setChatSeed] = useState<{ text: string; nonce: number } | null>(null);
  const [chatBusy, setChatBusy] = useState(false);
  const [chatError, setChatError] = useState<string | null>(null);
  const [answeredVersion, setAnsweredVersion] = useState<number | null>(null);
  const [applied, setApplied] = useState<Set<number>>(new Set());
  const [streaming, setStreaming] = useState<string | null>(null);
  /** Sections drafted so far while an edit proposal streams; null = not drafting. */
  const [drafting, setDrafting] = useState<string[] | null>(null);

  // Proposal review (in the report pane)
  const [review, setReview] = useState<Review | null>(null);
  const reviewTopRef = useRef<HTMLDivElement>(null);

  // Follow the latest version when a save (ours or someone else's) lands.
  useEffect(() => {
    setSelectedVersion(latest.version);
  }, [latest.version]);

  // Load the selected version's text via a presigned URL.
  useEffect(() => {
    const target = versions.find((entry) => entry.version === selectedVersion) ?? latest;
    let cancelled = false;
    setLoaded(null);
    setLoadError(null);
    (async () => {
      try {
        const { url } = await api.getArtifactUrl(runId, target.artifactKey);
        const response = await fetch(url);
        if (!response.ok) {
          throw new Error(`report fetch failed: HTTP ${response.status}`);
        }
        const text = await response.text();
        if (!cancelled) {
          setLoaded({ version: target.version, key: target.artifactKey, text });
        }
      } catch (e) {
        if (!cancelled) {
          setLoadError(e instanceof Error ? e.message : 'report fetch failed');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [runId, selectedVersion, versions, latest]);

  const viewingLatest = selectedVersion === latest.version;

  function startEditing(initial?: string) {
    if (!loaded) return;
    setDraft(initial ?? loaded.text);
    setNote('');
    setSaveError(null);
    setSavedVersion(null);
    setReview(null);
    setEditing(true);
  }

  const save = useCallback(
    async (markdown: string, changeNote?: string) => {
      setSaving(true);
      setSaveError(null);
      try {
        const result = await api.putReport(runId, {
          markdown,
          baseVersion: latest.version,
          ...(changeNote?.trim() ? { note: changeNote.trim() } : {}),
        });
        setSavedVersion(result.version.version);
        setEditing(false);
        setReview(null);
        props.onSaved?.();
        return true;
      } catch (e) {
        if (e instanceof ApiError && e.status === 409) {
          setSaveError(
            `${e.message} Your text is still in the editor — reload the page to pick up the latest version, then reapply your change.`,
          );
        } else if (e instanceof ApiError && e.status === 403) {
          setSaveError('Only the workflow owner or an org admin can save report edits.');
        } else {
          setSaveError(e instanceof Error ? e.message : 'save failed');
        }
        return false;
      } finally {
        setSaving(false);
      }
    },
    [runId, latest.version, props],
  );

  /** The report with the ACCEPTED subset of a review's edits applied. */
  function composeReview(base: string, r: Review): string | null {
    const chosen = r.edits.filter((_, i) => r.accepted[i]);
    if (chosen.length === 0) return base;
    const result = applySectionEdits(base, chosen);
    if (!result.ok) {
      setSaveError(`Couldn't apply the proposal: ${result.error}`);
      return null;
    }
    return result.markdown;
  }

  function reviewNote(r: Review): string {
    const total = r.edits.length;
    const count = r.accepted.filter(Boolean).length;
    const names = r.edits
      .filter((_, i) => r.accepted[i])
      .map((e) => sectionTitle(e.heading))
      .join(', ');
    const scope = count === total ? `${total} section${total === 1 ? '' : 's'}` : `${count} of ${total} sections`;
    return `Revised ${scope}: ${names}`;
  }

  /** Save the review's accepted sections as a new version. */
  async function saveReview(r: Review) {
    if (!loaded) return false;
    const markdown = composeReview(loaded.text, r);
    if (markdown === null) return false;
    const ok = await save(markdown, reviewNote(r));
    if (ok) {
      setApplied((current) => new Set(current).add(r.messageIndex));
    }
    return ok;
  }

  /** Open the editor with the accepted sections applied, for hand tweaks. */
  function editReview(r: Review) {
    if (!loaded) return;
    const markdown = composeReview(loaded.text, r);
    if (markdown === null) return;
    setSelectedVersion(latest.version);
    startEditing(markdown);
    setNote(reviewNote(r));
  }

  /** Put a proposal set into review mode and scroll to the top of the report. */
  function reviewProposal(edits: ProposedEdit[], messageIndex: number) {
    setSelectedVersion(latest.version);
    setEditing(false);
    // Edits that would drop most of a section start as "Keep current": a big
    // cut must be chosen deliberately, never carried by Accept all / Save.
    const text = loaded?.text ?? '';
    const accepted = edits.map((edit) => {
      const section = findReportSection(text, edit.heading);
      if (!section) return true;
      const current = extractReportSection(text, editTarget(text, section, edit.newMarkdown));
      return !removesMostContent(current, edit.newMarkdown);
    });
    setReview({ edits, accepted, messageIndex, view: 'diff' });
    window.setTimeout(
      () => reviewTopRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }),
      50,
    );
  }

  /** "Ask about this section": seed the prompt and open the drawer. */
  function askAboutSection(heading: string) {
    setChatSeed((current) => ({
      text: `About "${sectionTitle(heading)}": `,
      nonce: (current?.nonce ?? 0) + 1,
    }));
    shell.openTools();
  }

  const sendChat = useCallback(async (question: string) => {
    if (!question || chatBusy) {
      return;
    }
    const history: ChatMessage[] = [...messages, { role: 'user', content: question }];
    setMessages(history);
    setChatError(null);
    setStreaming('');
    setDrafting(null);
    setChatBusy(true);
    try {
      const { message, reportVersion } = await chatAboutReportStream(runId, history, {
        onDelta: (text) => setStreaming((current) => (current ?? '') + text),
        onStatus: ({ phase, sections }) => {
          if (phase === 'drafting-edit') setDrafting(sections);
        },
      });
      setStreaming(null);
      setDrafting(null);
      setMessages((current) => [...current, message]);
      setAnsweredVersion(reportVersion);
      // Fresh proposals go straight into review so the user sees them in
      // context without an extra click; the drawer card keeps the summary.
      if (message.proposedEdits && message.proposedEdits.length > 0 && loaded) {
        reviewProposal(message.proposedEdits, history.length);
      }
    } catch (e) {
      setStreaming(null);
      setDrafting(null);
      if (e instanceof ApiError && e.status === 409) {
        setChatError('The report for this run isn’t available yet.');
      } else if (e instanceof ApiError && e.status === 503) {
        setChatError('Report chat isn’t enabled for this deployment.');
      } else {
        setChatError(e instanceof Error ? e.message : 'chat failed');
      }
    } finally {
      setChatBusy(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatBusy, messages, runId, loaded]);

  // Mount the chat in the tools drawer; clear it when this page goes away.
  useEffect(() => {
    shell.setTools(
      <ChatPanel
        canEdit={canEdit}
        messages={messages}
        seed={chatSeed}
        busy={chatBusy || saving}
        error={chatError}
        streaming={streaming}
        drafting={drafting}
        stale={answeredVersion !== null && answeredVersion !== latest.version}
        latestVersion={latest.version}
        currentText={loaded?.text ?? null}
        applied={applied}
        reviewing={review?.messageIndex ?? null}
        onSend={(question) => void sendChat(question)}
        onClear={() => {
          setMessages([]);
          setChatError(null);
          setApplied(new Set());
          setReview(null);
        }}
        onDismissError={() => setChatError(null)}
        onReview={reviewProposal}
      />,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    canEdit,
    messages,
    chatSeed,
    chatBusy,
    saving,
    chatError,
    streaming,
    drafting,
    answeredVersion,
    latest.version,
    loaded,
    applied,
    review,
    sendChat,
  ]);
  useEffect(() => () => shell.setTools(null), [shell]);

  const versionOptions: SelectProps.Option[] = [...versions]
    .reverse()
    .map((entry) => ({
      value: String(entry.version),
      label: `v${entry.version}${entry.version === latest.version ? ' (latest)' : ''}`,
      description:
        entry.version === 1
          ? 'Generated by the workflow'
          : `${entry.savedBy ?? 'unknown'} · ${formatDateTime(entry.savedAt)}${entry.note ? ` · ${entry.note}` : ''}`,
    }));

  return (
    <Container
      header={
        <Header
          variant="h2"
          description={
            viewingLatest
              ? undefined
              : `Viewing an older version. Edits always start from v${latest.version}.`
          }
          actions={
            <SpaceBetween direction="horizontal" size="xs">
              {versions.length > 1 && (
                <Select
                  selectedOption={
                    versionOptions.find((o) => o.value === String(selectedVersion)) ?? null
                  }
                  onChange={({ detail }) => setSelectedVersion(Number(detail.selectedOption.value))}
                  options={versionOptions}
                  disabled={editing}
                  ariaLabel="Report version"
                />
              )}
              <Button
                iconName="download"
                disabled={!loaded}
                onClick={() => loaded && downloadMarkdown(loaded)}
              >
                Download .md
              </Button>
              {canEdit && !editing && (
                <Button
                  iconName="edit"
                  disabled={!loaded || !viewingLatest}
                  disabledReason={
                    !viewingLatest ? 'Switch to the latest version to edit.' : undefined
                  }
                  onClick={() => startEditing()}
                >
                  Edit
                </Button>
              )}
              <Button iconName="contact" onClick={() => shell.openTools()}>
                Ask the report
              </Button>
            </SpaceBetween>
          }
        >
          Report
        </Header>
      }
    >
      <SpaceBetween size="m">
        {savedVersion !== null && (
          <Alert type="success" dismissible onDismiss={() => setSavedVersion(null)}>
            Saved as v{savedVersion}.
          </Alert>
        )}
        {saveError && (
          <Alert type="error" dismissible onDismiss={() => setSaveError(null)}>
            {saveError}
          </Alert>
        )}
        {loadError && <Alert type="error">{loadError}</Alert>}
        {!loaded && !loadError && (
          <StatusIndicator type="loading">Loading report…</StatusIndicator>
        )}

        {loaded && !editing && (
          <div ref={reviewTopRef}>
            <ReportBody
              text={loaded.text}
              review={viewingLatest ? review : null}
              canEdit={canEdit}
              saving={saving}
              onAsk={askAboutSection}
              onViewChange={(view) => setReview((r) => (r ? { ...r, view } : r))}
              onDecide={(index, value) =>
                setReview((r) =>
                  r ? { ...r, accepted: r.accepted.map((a, i) => (i === index ? value : a)) } : r,
                )
              }
              onDecideAll={(value) =>
                setReview((r) => (r ? { ...r, accepted: r.edits.map(() => value) } : r))
              }
              onSave={() => review && void saveReview(review)}
              onEdit={() => review && editReview(review)}
              onDismiss={() => setReview(null)}
            />
          </div>
        )}

        {loaded && editing && (
          <SpaceBetween size="m">
            <FormField
              label="Report markdown"
              description={`Editing from v${latest.version}. Saving creates v${latest.version + 1}; earlier versions are kept.`}
              stretch
            >
              <Textarea
                value={draft}
                onChange={({ detail }) => setDraft(detail.value)}
                rows={24}
                spellcheck
                disabled={saving}
              />
            </FormField>
            <FormField label="Change note" description="Optional, shown in the version history.">
              <Input
                value={note}
                onChange={({ detail }) => setNote(detail.value)}
                placeholder="e.g. Tightened the executive summary"
                disabled={saving}
              />
            </FormField>
            <ExpandableSection headerText="Preview">
              <Markdown text={draft} />
            </ExpandableSection>
            <SpaceBetween direction="horizontal" size="xs">
              <Button
                variant="primary"
                loading={saving}
                disabled={draft.trim().length === 0 || draft === loaded.text}
                onClick={() => void save(draft, note)}
              >
                Save as v{latest.version + 1}
              </Button>
              <Button disabled={saving} onClick={() => setEditing(false)}>
                Cancel
              </Button>
            </SpaceBetween>
          </SpaceBetween>
        )}
      </SpaceBetween>
    </Container>
  );
}

function sectionTitle(heading: string): string {
  return heading.replace(/^#+\s*/, '').trim();
}

function downloadMarkdown(report: LoadedReport) {
  const blob = new Blob([report.text], { type: 'text/markdown' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = report.version === 1 ? 'report.md' : `report.v${report.version}.md`;
  anchor.click();
  URL.revokeObjectURL(url);
}

// ── Report body: heading-chunked sections, hover "Ask", whole-report review ─

interface ReportBodyProps {
  text: string;
  review: Review | null;
  canEdit: boolean;
  saving: boolean;
  onAsk: (heading: string) => void;
  onViewChange: (view: ReviewView) => void;
  onDecide: (editIndex: number, accepted: boolean) => void;
  onDecideAll: (accepted: boolean) => void;
  onSave: () => void;
  onEdit: () => void;
  onDismiss: () => void;
}

/**
 * Renders the report as chunks split at every heading. In review mode the
 * chunks belonging to a proposed section are replaced by that section's
 * review block (diff + its own decision), every other chunk renders as
 * normal text, and a sticky summary bar sits above the report.
 */
function ReportBody(props: ReportBodyProps) {
  const { text, review } = props;
  const lines = useMemo(() => text.split('\n'), [text]);
  const sections = useMemo(() => listReportSections(text), [text]);

  // Resolve each proposed edit to a section range in the current text.
  const targets = useMemo(() => {
    if (!review) return [];
    return review.edits.map((edit, index) => {
      const section = findReportSection(text, edit.heading);
      // Diff against the lines the edit actually replaces (a parent's own
      // text when the replacement has no sub-headings), never the whole
      // nested range — see editTarget.
      return { index, edit, section: section && editTarget(text, section, edit.newMarkdown) };
    });
  }, [text, review]);
  const missing = targets.filter((t) => !t.section);

  const chunks = useMemo(() => {
    const starts = sections.map((s) => s.startLine);
    const out: Array<{ start: number; end: number; heading?: string }> = [];
    if (starts.length === 0 || starts[0]! > 0) {
      out.push({ start: 0, end: starts[0] ?? lines.length });
    }
    for (let i = 0; i < starts.length; i++) {
      out.push({ start: starts[i]!, end: starts[i + 1] ?? lines.length, heading: sections[i]!.heading });
    }
    return out;
  }, [sections, lines.length]);

  const rendered: React.ReactNode[] = [];
  const emitted = new Set<number>();
  for (const chunk of chunks) {
    const owner = targets.find(
      (t) => t.section && chunk.start >= t.section.startLine && chunk.start < t.section.endLine,
    );
    if (owner && owner.section) {
      if (!emitted.has(owner.index)) {
        emitted.add(owner.index);
        rendered.push(
          <SectionReview
            key={`review-${owner.section.startLine}`}
            ordinal={owner.index + 1}
            total={review!.edits.length}
            current={extractReportSection(text, owner.section)}
            proposed={owner.edit.newMarkdown}
            rationale={owner.edit.rationale}
            view={review!.view}
            accepted={review!.accepted[owner.index] ?? true}
            canEdit={props.canEdit}
            onDecide={(value) => props.onDecide(owner.index, value)}
          />,
        );
      }
      continue;
    }
    rendered.push(
      <SectionChunk
        key={`${chunk.start}`}
        text={lines.slice(chunk.start, chunk.end).join('\n')}
        heading={chunk.heading}
        onAsk={props.onAsk}
      />,
    );
  }

  return (
    <div className="report-body">
      {review && (
        <ReviewBar
          edits={review.edits}
          accepted={review.accepted}
          view={review.view}
          canEdit={props.canEdit}
          saving={props.saving}
          currentText={text}
          onViewChange={props.onViewChange}
          onDecideAll={props.onDecideAll}
          onSave={props.onSave}
          onEdit={props.onEdit}
          onDismiss={props.onDismiss}
        />
      )}
      {missing.length > 0 && (
        <Alert type="warning">
          {missing.length === 1
            ? `The proposed section “${sectionTitle(missing[0]!.edit.heading)}” isn’t in this version of the report and will be skipped.`
            : `${missing.length} proposed sections aren’t in this version of the report and will be skipped.`}
        </Alert>
      )}
      {rendered}
    </div>
  );
}

/** One heading-led chunk with a hover "Ask about this section" affordance. */
function SectionChunk(props: { text: string; heading?: string; onAsk: (heading: string) => void }) {
  return (
    <div className="report-section">
      {props.heading && (
        <div className="report-section-ask">
          <Button
            variant="inline-icon"
            iconName="contact"
            ariaLabel={`Ask about ${sectionTitle(props.heading)}`}
            onClick={() => props.onAsk(props.heading!)}
          />
        </div>
      )}
      <Markdown text={props.text} />
    </div>
  );
}

interface ReviewBarProps {
  edits: ProposedEdit[];
  accepted: boolean[];
  view: ReviewView;
  canEdit: boolean;
  saving: boolean;
  currentText: string;
  onViewChange: (view: ReviewView) => void;
  onDecideAll: (accepted: boolean) => void;
  onSave: () => void;
  onEdit: () => void;
  onDismiss: () => void;
}

/** Sticky summary bar above the report while a proposal set is under review. */
function ReviewBar(props: ReviewBarProps) {
  const total = props.edits.length;
  const count = props.accepted.filter(Boolean).length;
  const summary = useMemo(() => {
    let added = 0;
    let removed = 0;
    for (const edit of props.edits) {
      const section = findReportSection(props.currentText, edit.heading);
      if (!section) continue;
      const target = editTarget(props.currentText, section, edit.newMarkdown);
      const s = summarizeDiff(diffMarkdown(extractReportSection(props.currentText, target), edit.newMarkdown));
      added += s.wordsAdded;
      removed += s.wordsRemoved;
    }
    return `${total} section${total === 1 ? '' : 's'} · +${added} / −${removed} words`;
  }, [props.edits, props.currentText, total]);

  return (
    <div className="report-review-summary">
      <SpaceBetween direction="horizontal" size="s" alignItems="center">
        <Box variant="strong">Proposed changes</Box>
        <Box color="text-body-secondary" fontSize="body-s">
          {summary}
        </Box>
        <SegmentedControl
          selectedId={props.view}
          onChange={({ detail }) => props.onViewChange(detail.selectedId as ReviewView)}
          options={[
            { id: 'diff', text: 'Diff' },
            { id: 'proposed', text: 'Proposed' },
            { id: 'current', text: 'Current' },
          ]}
        />
        {props.canEdit && total > 1 && (
          <SpaceBetween direction="horizontal" size="xxs">
            <Button variant="inline-link" onClick={() => props.onDecideAll(true)}>
              Accept all
            </Button>
            <Box color="text-body-secondary">·</Box>
            <Button variant="inline-link" onClick={() => props.onDecideAll(false)}>
              Keep all current
            </Button>
          </SpaceBetween>
        )}
        <SpaceBetween direction="horizontal" size="xs">
          {props.canEdit && (
            <>
              <Button
                variant="primary"
                loading={props.saving}
                disabled={count === 0}
                disabledReason="No sections accepted — accept at least one, or dismiss."
                onClick={props.onSave}
              >
                {count === total
                  ? `Save ${total === 1 ? 'change' : 'all changes'}`
                  : `Save ${count} of ${total} sections`}
              </Button>
              <Button disabled={props.saving} onClick={props.onEdit}>
                Edit
              </Button>
            </>
          )}
          <Button disabled={props.saving} onClick={props.onDismiss}>
            Dismiss
          </Button>
        </SpaceBetween>
      </SpaceBetween>
      {!props.canEdit && (
        <Box color="text-body-secondary" fontSize="body-s" padding={{ top: 'xxs' }}>
          Only the workflow owner or an admin can save edits.
        </Box>
      )}
    </div>
  );
}

interface SectionReviewProps {
  ordinal: number;
  total: number;
  current: string;
  proposed: string;
  rationale?: string;
  view: ReviewView;
  accepted: boolean;
  canEdit: boolean;
  onDecide: (accepted: boolean) => void;
}

/**
 * One proposed section in the report: a header row with its decision toggle
 * and rationale, then the inline word-level diff (or the proposed/current
 * text, per the view). Rejected sections dim the proposal in place.
 */
function SectionReview(props: SectionReviewProps) {
  const hunks = useMemo(() => groupHunks(diffMarkdown(props.current, props.proposed)), [props.current, props.proposed]);
  const summary = useMemo(() => describeDiff(summarizeDiff(diffMarkdown(props.current, props.proposed))), [props.current, props.proposed]);
  const bigCut = removesMostContent(props.current, props.proposed);
  const title = sectionTitle(props.proposed.split('\n')[0] ?? '');
  return (
    <div className={`report-review report-review-${props.accepted ? 'accepted' : 'rejected'}`}>
      <div className="report-review-bar">
        <SpaceBetween direction="horizontal" size="s" alignItems="center">
          <Box variant="strong">
            Section {props.ordinal} of {props.total}: {title}
          </Box>
          <Box color="text-body-secondary" fontSize="body-s">
            {summary}
          </Box>
          {bigCut && (
            <StatusIndicator type="warning">Removes most of this section</StatusIndicator>
          )}
          {props.canEdit ? (
            <SegmentedControl
              selectedId={props.accepted ? 'accept' : 'keep'}
              onChange={({ detail }) => props.onDecide(detail.selectedId === 'accept')}
              options={[
                { id: 'accept', text: 'Accept', iconName: 'check' },
                { id: 'keep', text: 'Keep current', iconName: 'undo' },
              ]}
            />
          ) : null}
        </SpaceBetween>
        {props.rationale && (
          <Box color="text-body-secondary" fontSize="body-s" padding={{ top: 'xxs' }}>
            {props.rationale}
          </Box>
        )}
      </div>
      {props.view === 'diff' && <HunkDiff hunks={hunks} />}
      {props.view === 'proposed' && (
        <div className="report-review-pane">
          <Markdown text={props.accepted ? props.proposed : props.current} />
        </div>
      )}
      {props.view === 'current' && (
        <div className="report-review-pane">
          <Markdown text={props.current} />
        </div>
      )}
    </div>
  );
}

/**
 * Inline diff for one section. Removed/added blocks within a change are
 * paired positionally; a pair that reads as one edited paragraph renders
 * merged with <del>/<ins> word highlights, otherwise stacked. Every block is
 * still rendered Markdown.
 */
function HunkDiff({ hunks }: { hunks: Hunk[] }) {
  return (
    <div className="report-diff">
      {hunks.map((hunk, hunkIndex) => {
        if (hunk.kind === 'equal') {
          return (
            <div key={hunkIndex} className="report-diff-block report-diff-equal">
              <Markdown text={joinBlocks(hunk.blocks)} />
            </div>
          );
        }
        const pairs = Math.max(hunk.removed.length, hunk.added.length);
        const rows: React.ReactNode[] = [];
        for (let p = 0; p < pairs; p++) {
          const before = hunk.removed[p];
          const after = hunk.added[p];
          const merged = before && after ? wordDiffMarkdown(before, after) : null;
          if (merged !== null) {
            rows.push(
              <div key={`m${p}`} className="report-diff-block report-diff-merged">
                <Markdown text={merged} />
              </div>,
            );
            continue;
          }
          if (before) {
            rows.push(
              <div key={`r${p}`} className="report-diff-block report-diff-removed">
                <Markdown text={before} />
              </div>,
            );
          }
          if (after) {
            rows.push(
              <div key={`a${p}`} className="report-diff-block report-diff-added">
                <Markdown text={after} />
              </div>,
            );
          }
        }
        return (
          <div key={hunkIndex} className="report-diff-change">
            {rows}
          </div>
        );
      })}
    </div>
  );
}

// ── Drawer panel: the chat ───────────────────────────────────────────────

/**
 * Progress label while an edit proposal drafts. A multi-section proposal
 * can take over a minute, so name the section in flight ("Drafting section
 * 2: 8. Risks…") rather than showing one static spinner.
 */
export function draftingLabel(sections: string[]): string {
  const current = sections[sections.length - 1];
  if (!current) return 'Drafting section edits…';
  return `Drafting section ${sections.length}: ${current}…`;
}

interface ChatPanelProps {
  canEdit: boolean;
  messages: ChatMessage[];
  /** Prefill for the input; a new object (nonce) re-applies the same text. */
  seed: { text: string; nonce: number } | null;
  busy: boolean;
  error: string | null;
  /** In-flight assistant text ('' = waiting; null = idle). */
  streaming: string | null;
  /** Sections drafted so far during an edit proposal; null when not drafting. */
  drafting: string[] | null;
  stale: boolean;
  latestVersion: number;
  currentText: string | null;
  applied: Set<number>;
  reviewing: number | null;
  onSend: (question: string) => void;
  onClear: () => void;
  onDismissError: () => void;
  onReview: (edits: ProposedEdit[], messageIndex: number) => void;
}

function ChatPanel(props: ChatPanelProps) {
  const { messages, canEdit } = props;
  const bottomRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [messages.length, props.streaming]);

  // The draft lives HERE, not in the page. The panel is handed to the shell
  // through an effect, so a page-owned value would reach the input one
  // render after each keystroke — React resets the DOM to the stale value in
  // between, which throws the caret to the end and makes mid-text editing
  // impossible (live finding). The page only seeds it ("Ask about this
  // section") and receives the text on send.
  const [draft, setDraft] = useState('');
  useEffect(() => {
    if (props.seed) setDraft(props.seed.text);
  }, [props.seed]);
  const send = () => {
    const question = draft.trim();
    if (!question || props.busy) return;
    setDraft('');
    props.onSend(question);
  };

  return (
    <div className="chat-drawer">
      <div className="chat-drawer-header">
        <Header variant="h2">Ask the report</Header>
        <Box color="text-body-secondary" fontSize="body-s">
          {canEdit
            ? 'Answers are grounded in this report and its task outputs. Ask for changes and the assistant proposes section edits you review in the report — accept or keep each section.'
            : 'Answers are grounded in this report and its task outputs.'}
        </Box>
      </div>
      <div className="chat-drawer-body">
        <SpaceBetween size="m">
          {props.stale && (
            <Alert type="info">
              The report is now v{props.latestVersion}. New answers use the latest version.
            </Alert>
          )}
          {messages.length === 0 ? (
            <Box color="text-body-secondary">
              Try “Summarize the key findings”, “Where did the 12% figure come from?”
              {canEdit
                ? ', or “Tighten the executive summary and turn the risks into a table”.'
                : '.'}
              <Box padding={{ top: 's' }} fontSize="body-s">
                Tip: hover a section heading in the report and use the chat button to ask about it.
              </Box>
            </Box>
          ) : (
            <SpaceBetween size="s">
              {messages.map((message, index) => (
                <div key={index} className={`chat-turn chat-turn-${message.role}`}>
                  <Box fontSize="body-s" color="text-body-secondary">
                    {message.role === 'user' ? 'You' : 'Report assistant'}
                  </Box>
                  {message.role === 'assistant' ? (
                    <SpaceBetween size="xs">
                      {message.content && <Markdown text={message.content} />}
                      {message.proposalIssue && <Alert type="warning">{message.proposalIssue}</Alert>}
                      {message.proposedEdits && message.proposedEdits.length > 0 && (
                        <ProposalSummary
                          edits={message.proposedEdits}
                          currentText={props.currentText}
                          applied={props.applied.has(index)}
                          reviewing={props.reviewing === index}
                          onReview={() => props.onReview(message.proposedEdits!, index)}
                        />
                      )}
                    </SpaceBetween>
                  ) : (
                    <Box variant="p">{message.content}</Box>
                  )}
                </div>
              ))}
              {props.busy && props.streaming !== null && (
                <div className="chat-turn chat-turn-assistant">
                  <Box fontSize="body-s" color="text-body-secondary">
                    Report assistant
                  </Box>
                  {props.streaming ? (
                    <SpaceBetween size="xs">
                      <Markdown text={props.streaming} />
                      {props.drafting && (
                        <StatusIndicator type="loading">
                          {draftingLabel(props.drafting)}
                        </StatusIndicator>
                      )}
                    </SpaceBetween>
                  ) : (
                    <StatusIndicator type="loading">
                      {props.drafting ? draftingLabel(props.drafting) : 'Thinking…'}
                    </StatusIndicator>
                  )}
                </div>
              )}
              <div ref={bottomRef} />
              <Box textAlign="right">
                <Button variant="inline-link" disabled={props.busy} onClick={props.onClear}>
                  Clear conversation
                </Button>
              </Box>
            </SpaceBetween>
          )}
        </SpaceBetween>
      </div>
      {/* Composer pinned to the bottom of the drawer's scroll area. */}
      <div className="chat-drawer-composer">
        <SpaceBetween size="xs">
          {props.error && (
            <Alert type="error" dismissible onDismiss={props.onDismissError}>
              {props.error}
            </Alert>
          )}
          <PromptInput
            value={draft}
            onChange={({ detail }) => setDraft(detail.value)}
            onAction={send}
            disabled={props.busy}
            actionButtonAriaLabel="Send"
            actionButtonIconName="send"
            placeholder={
              canEdit ? 'Ask a question or request changes' : 'Ask a question about this report'
            }
            maxRows={5}
          />
        </SpaceBetween>
      </div>
    </div>
  );
}

interface ProposalSummaryProps {
  edits: ProposedEdit[];
  currentText: string | null;
  applied: boolean;
  reviewing: boolean;
  onReview: () => void;
}

/** Compact drawer card: which sections and how much; review happens in the report. */
function ProposalSummary(props: ProposalSummaryProps) {
  const { edits, currentText } = props;
  const rows = useMemo(
    () =>
      edits.map((edit) => {
        const section = currentText ? findReportSection(currentText, edit.heading) : undefined;
        const target = currentText && section ? editTarget(currentText, section, edit.newMarkdown) : undefined;
        const summary =
          currentText && target
            ? describeDiff(summarizeDiff(diffMarkdown(extractReportSection(currentText, target), edit.newMarkdown)))
            : currentText
              ? 'not in the current version'
              : null;
        return { title: sectionTitle(edit.heading), summary };
      }),
    [edits, currentText],
  );
  return (
    <div className={`chat-proposal${props.reviewing ? ' chat-proposal-active' : ''}`}>
      <SpaceBetween size="xs">
        <Box variant="strong">
          Proposed changes to {edits.length} section{edits.length === 1 ? '' : 's'}
        </Box>
        <ul className="chat-proposal-list">
          {rows.map((row, i) => (
            <li key={i}>
              <Box variant="span">{row.title}</Box>
              {row.summary && (
                <Box variant="span" color="text-body-secondary" fontSize="body-s">
                  {' '}
                  — {row.summary}
                </Box>
              )}
            </li>
          ))}
        </ul>
        <Button variant="primary" disabled={props.applied} onClick={props.onReview}>
          {props.applied ? 'Saved' : props.reviewing ? 'Reviewing in report…' : 'Review in report'}
        </Button>
      </SpaceBetween>
    </div>
  );
}
