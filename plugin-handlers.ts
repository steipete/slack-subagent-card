import { WebClient } from "@slack/web-api";
import type {
  OpenClawConfig,
  SlackAccountConfig,
} from "openclaw/plugin-sdk/config-contracts";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import type { resolveConfiguredSecretInputWithFallback } from "openclaw/plugin-sdk/secret-input-runtime";
import {
  DEFAULT_ACCOUNT_ID,
  listCombinedAccountIds,
  normalizeAccountId,
  resolveListedDefaultAccountId,
  resolveMergedAccountConfig,
} from "openclaw/plugin-sdk/account-resolution";

import {
  BLOCK_TEXT_MAX_CHARS,
  buildRunningContent,
  buildTerminalContent,
  hasTerminalTaskSignal,
  type Mode,
  type Outcome,
  type SlackTaskStatus,
  type TaskRunDetail,
} from "./task-card.js";

type OpenClawPluginConfig = {
  toolTasks?: {
    enabled?: unknown;
  };
};

type SlackWebClient = {
  chat: {
    postMessage: (params: Record<string, unknown>) => Promise<unknown>;
    update: (params: Record<string, unknown>) => Promise<unknown>;
  };
  conversations: {
    open: (params: Record<string, unknown>) => Promise<unknown>;
  };
};

export type Logger = OpenClawPluginApi["logger"];

type SlackRequester = {
  channel?: string;
  accountId?: string;
  to?: string;
  threadId?: string | number;
  channelId?: string | number;
  messageId?: string | number;
};

type InternalHookContext = {
  requesterSessionKey?: string;
  childSessionKey?: string;
  runId?: string;
};

type InternalSubagentSpawnedInput = {
  runId?: string;
  childSessionKey?: string;
  agentId?: string;
  label?: string;
  requester?: SlackRequester;
  threadRequested?: boolean;
  mode?: Mode;
};

type InternalSubagentEndedInput = {
  runId?: string;
  endedAt?: number;
  outcome?: Outcome;
  targetSessionKey?: string;
  targetKind?: string;
  accountId?: string;
};

type InternalSubagentProgressInput = {
  phase?: "started" | "ended";
  runId?: string;
  childSessionKey?: string;
  outcome?: "ok" | "error" | "timeout" | "killed" | "unknown";
  requester?: SlackRequester;
};

type InternalAfterToolCallInput = {
  toolName?: string;
  runId?: string;
  failed: boolean;
  durationMs?: number;
};

export type PluginApi = OpenClawPluginApi & {
  createSlackWebClient?: (token: string) => SlackWebClient;
  fallbackSlackWebClientFactory?: (token: string) => SlackWebClient;
  resolveConfiguredSecretInputWithFallback?: typeof resolveConfiguredSecretInputWithFallback;
};

type TrackedRun = {
  messageTs?: string;
  channelId?: string;
  threadTs?: string;
  accountId?: string;
  startedAt: number;
  endedAt?: number;
  agentId?: string;
  childSessionKey?: string;
  label: string;
  spawnLabel?: string;
  mode?: Mode;
  requester?: SlackRequester;
  requesterSessionKey?: string;
  terminalUpdateQueued?: boolean;
  updateChain?: Promise<void>;
  initializing?: Promise<void>;
  toolCalls: TrackedToolCall[];
  nextToolTaskSequence: number;
};

type TrackedToolCall = {
  id: string;
  name: string;
  detail?: string;
  durationMs?: number;
  status: "complete" | "error";
};

export type SharedState = {
  runs: Map<string, TrackedRun>;
  registeredApis: WeakSet<object>;
  webClients: Map<string, SlackWebClient>;
  stateVersion: number;
};

type SlackThreadTarget = {
  channelId: string;
  threadTs: string;
};

type SlackTaskCardContent = {
  detail: string;
  outputText?: string;
  taskId: string;
  slackTaskStatus: SlackTaskStatus;
};

type SlackTaskCardPayloadParams = {
  elapsedText?: string;
  fallbackStatusText?: string;
  label: string;
  statusText: string;
  content: SlackTaskCardContent;
  toolCalls?: readonly TrackedToolCall[];
};

const SHARED_STATE_KEY = "__slackSubagentCardSharedState";
const STALE_RUN_TTL_MS = 60 * 60 * 1000;
const TASK_LOOKUP_RETRY_MS = 250;
const CARD_TEXT_PREFIX = "Sub-agent ";
const SHARED_STATE_VERSION = 3;
const MAX_TOOL_TASKS = 10;
const TOOL_TASK_TITLE_MAX_CHARS = 96;
const SLACK_WEB_CLIENT_TIMEOUT_MS = 10_000;
const SLACK_THREAD_RE = /^agent:[^:]+:slack:(?:channel|room|direct):([^:]+):thread:(.+)$/;
const SLACK_TOPIC_RE = /^agent:[^:]+:slack:(?:channel|room|direct):([^-]+)-topic-(.+)$/;

export function registerSlackSubagentCardHandlers(api: PluginApi, shared: SharedState = getSharedState()): void {
  const log = api.logger;

  if (shared.registeredApis.has(api)) return;
  shared.registeredApis.add(api);

  api.on("subagent_spawned", (event, ctx) => {
    const spawned: InternalSubagentSpawnedInput = event;
    const runId = asNonEmptyString(spawned.runId ?? ctx.runId) ?? "unknown";
    log.info(
      `slack-subagent-card: subagent_spawned fired — runId=${runId} requesterSessionKey=${asNonEmptyString(ctx.requesterSessionKey) ?? "none"} threadRequested=${String(spawned.threadRequested ?? false)} requester=${summarizeRequester(spawned.requester)}`,
    );
    runDetached(log, "subagent_spawned", handleSpawned(api, shared, spawned, ctx));
  });

  api.on("subagent_progress", (event, ctx) => {
    const progress: InternalSubagentProgressInput = event;
    const runId = asNonEmptyString(progress.runId ?? ctx.runId) ?? "unknown";
    log.info(
      `slack-subagent-card: subagent_progress fired — runId=${runId} phase=${progress.phase ?? "unknown"} outcome=${progress.phase === "ended" ? progress.outcome ?? "unknown" : "pending"}`,
    );
    runDetached(log, "subagent_progress", handleProgress(api, shared, progress, ctx));
  });

  api.on("subagent_ended", (event, ctx) => {
    const ended: InternalSubagentEndedInput = event;
    const runId = asNonEmptyString(ended.runId ?? ctx.runId) ?? "unknown";
    log.info(
      `slack-subagent-card: subagent_ended fired — runId=${runId} outcome=${normalizeOutcome(ended.outcome)} accountId=${asNonEmptyString(ended.accountId) ?? "default"} requesterSessionKey=${asNonEmptyString(ctx.requesterSessionKey) ?? "none"}`,
    );
    runDetached(log, "subagent_ended", handleEnded(api, shared, ended, ctx));
  });

  api.on("after_tool_call", (event, ctx) => {
    if (!areToolTasksEnabled(api)) return;
    const tool: InternalAfterToolCallInput = {
      toolName: normalizeToolName(event.toolName),
      runId: asNonEmptyString(event.runId ?? ctx.runId),
      failed: Boolean(event.error),
      durationMs: normalizeToolDurationMs(event.durationMs),
    };
    const runId = tool.runId ?? "unknown";
    log.info(
      `slack-subagent-card: after_tool_call fired — runId=${runId} toolName=${tool.toolName ?? "unknown"} status=${tool.failed ? "error" : "complete"}`,
    );
    runDetached(log, "after_tool_call", handleAfterToolCall(api, shared, tool));
  });

  log.info("slack-subagent-card plugin registered");
}

export async function handleSpawned(
  api: PluginApi,
  shared: SharedState,
  event: InternalSubagentSpawnedInput,
  ctx: InternalHookContext,
): Promise<void> {
  const runId = asNonEmptyString(event.runId ?? ctx.runId);
  if (!runId) {
    api.logger.debug?.("slack-subagent-card: handleSpawned skipped because runId is missing");
    return;
  }

  const requesterSessionKey = asNonEmptyString(ctx.requesterSessionKey);
  if (!requesterSessionKey) {
    api.logger.debug?.(`slack-subagent-card: handleSpawned skipped because requesterSessionKey is missing for runId=${runId}`);
    return;
  }

  if (!hasSlackThreadTargetHint(requesterSessionKey, event.requester)) {
    api.logger.debug?.(
      `slack-subagent-card: handleSpawned skipped because no Slack thread target hint was found for runId=${runId} requesterSessionKey=${requesterSessionKey} requester=${summarizeRequester(event.requester)}`,
    );
    return;
  }

  cleanupStaleRuns(shared, api.logger);

  const enrichedLabel =
    asNonEmptyString(event.label) ??
    asNonEmptyString(event.agentId);

  const existing = shared.runs.get(runId);
  if (existing) {
    if (existing.terminalUpdateQueued) return;
    let shouldRefresh = mergeTrackedRunMetadata(existing, event, enrichedLabel);
    const task = await resolveTaskRun(api, requesterSessionKey, runId);
    if (shared.runs.get(runId) !== existing || existing.terminalUpdateQueued) return;
    shouldRefresh = mergeTrackedRunMetadata(
      existing,
      {},
      asNonEmptyString(task?.label) ?? existing.spawnLabel ?? asNonEmptyString(task?.title),
    ) || shouldRefresh;
    if (shouldRefresh) {
      await refreshRunningCardAfterMetadataMerge(api, shared, runId, existing);
    }
    return;
  }

  const cardTitle = truncate(enrichedLabel ?? runId, 80);

  const tracked = createTrackedRun({
    accountId: asNonEmptyString(event.requester?.accountId),
    agentId: asNonEmptyString(event.agentId),
    childSessionKey: asNonEmptyString(event.childSessionKey ?? ctx.childSessionKey),
    label: cardTitle,
    spawnLabel: enrichedLabel,
    mode: event.mode,
    requester: event.requester,
    requesterSessionKey,
  });
  if (!reserveTrackedRun(shared, runId, tracked)) return;
  tracked.initializing = initializeSpawnedRun({
    api,
    shared,
    requesterSessionKey,
    runId,
    tracked,
  })
    .catch((error) => {
      cleanupTrackedRun(shared, runId, tracked);
      throw error;
    })
    .finally(() => {
      delete tracked.initializing;
    });
  await tracked.initializing;
}

async function initializeSpawnedRun(params: {
  api: PluginApi;
  shared: SharedState;
  requesterSessionKey: string;
  runId: string;
  tracked: TrackedRun;
}): Promise<void> {
  const resolved = await resolveSlackWebClient(
    params.api,
    params.shared,
    params.tracked.accountId,
  );
  if (!resolved) {
    cleanupTrackedRun(params.shared, params.runId, params.tracked);
    return;
  }
  params.tracked.accountId = resolved.accountId;

  const target = await resolveSlackThreadTarget(
    params.requesterSessionKey,
    params.tracked.requester,
    resolved.web,
    params.api.logger,
  );
  if (!target) {
    params.api.logger.debug?.(
      `slack-subagent-card: no Slack thread target for runId=${params.runId} requesterSessionKey=${params.requesterSessionKey}`,
    );
    cleanupTrackedRun(params.shared, params.runId, params.tracked);
    return;
  }

  const task = await resolveTaskRun(params.api, params.requesterSessionKey, params.runId);
  if (params.shared.runs.get(params.runId) !== params.tracked) return;
  const taskLabel = asNonEmptyString(task?.label) ??
    params.tracked.spawnLabel ?? asNonEmptyString(task?.title);
  if (taskLabel) params.tracked.label = truncate(taskLabel, 80);
  const runningContent = buildRunningContent({
    task,
    runId: params.runId,
    mode: params.tracked.mode,
  });

  const trackedPosted = await initializeSlackTaskCard({
    web: resolved.web,
    logger: params.api.logger,
    target,
    tracked: params.tracked,
    label: params.tracked.label,
    statusText: runningContent.statusText,
    fallbackStatusText: "SubAgent Running",
    content: runningContent,
  });
  if (!trackedPosted) {
    cleanupTrackedRun(params.shared, params.runId, params.tracked);
    return;
  }
  params.api.logger.debug?.(
    `slack-subagent-card: initialized Block Kit card for runId=${params.runId} channel=${target.channelId} thread=${target.threadTs}`,
  );
}

function mergeTrackedRunMetadata(
  tracked: TrackedRun,
  event: InternalSubagentSpawnedInput,
  enrichedLabel: string | undefined,
): boolean {
  let presentationChanged = false;
  const label = enrichedLabel ? truncate(enrichedLabel, 80) : undefined;
  if (label && label !== tracked.label) {
    tracked.label = label;
    presentationChanged = true;
  }
  if (event.mode && event.mode !== tracked.mode) {
    tracked.mode = event.mode;
    presentationChanged = true;
  }

  tracked.agentId = asNonEmptyString(event.agentId) ?? tracked.agentId;
  tracked.spawnLabel = asNonEmptyString(event.label) ?? asNonEmptyString(event.agentId) ?? tracked.spawnLabel;
  tracked.childSessionKey = asNonEmptyString(event.childSessionKey) ?? tracked.childSessionKey;
  tracked.accountId = asNonEmptyString(event.requester?.accountId) ?? tracked.accountId;
  if (event.requester) {
    tracked.requester = { ...tracked.requester, ...event.requester };
  }
  return presentationChanged;
}

async function refreshRunningCardAfterMetadataMerge(
  api: PluginApi,
  shared: SharedState,
  runId: string,
  tracked: TrackedRun,
): Promise<void> {
  await tracked.initializing?.catch(() => undefined);
  if (
    shared.runs.get(runId) !== tracked ||
    tracked.terminalUpdateQueued ||
    !isPostedTrackedRun(tracked)
  ) {
    return;
  }

  await enqueueRunUpdate(tracked, async () => {
    if (shared.runs.get(runId) !== tracked || tracked.terminalUpdateQueued) return;
    const resolved = await resolveSlackWebClient(api, shared, tracked.accountId);
    if (!resolved || shared.runs.get(runId) !== tracked || tracked.terminalUpdateQueued) return;
    const task = await resolveTaskRun(api, tracked.requesterSessionKey, runId);
    if (shared.runs.get(runId) !== tracked || tracked.terminalUpdateQueued) return;
    const taskLabel = asNonEmptyString(task?.label);
    if (taskLabel) tracked.label = truncate(taskLabel, 80);
    await renderTrackedRunUpdate({
      web: resolved.web,
      logger: api.logger,
      tracked,
      content: buildRunningContent({ task, runId, mode: tracked.mode }),
    });
  });
}

export async function handleProgress(
  api: PluginApi,
  shared: SharedState,
  event: InternalSubagentProgressInput,
  ctx: InternalHookContext,
): Promise<void> {
  if (event.phase === "started") {
    await handleSpawned(
      api,
      shared,
      {
        runId: event.runId,
        childSessionKey: event.childSessionKey,
        requester: event.requester,
      },
      ctx,
    );
    return;
  }
  if (event.phase !== "ended") return;
  const outcome = event.outcome === "unknown" || !event.outcome ? "error" : event.outcome;
  await handleEnded(
    api,
    shared,
    {
      runId: event.runId,
      outcome,
      accountId: event.requester?.accountId,
    },
    ctx,
  );
}

export async function handleAfterToolCall(
  api: PluginApi,
  shared: SharedState,
  event: InternalAfterToolCallInput,
): Promise<void> {
  if (!areToolTasksEnabled(api)) {
    api.logger.debug?.("slack-subagent-card: handleAfterToolCall skipped because tool task rendering is disabled");
    return;
  }

  const runId = asNonEmptyString(event.runId);
  if (!runId) {
    api.logger.debug?.("slack-subagent-card: handleAfterToolCall skipped because runId is missing");
    return;
  }
  const tracked = shared.runs.get(runId);
  if (!tracked) {
    api.logger.debug?.(`slack-subagent-card: handleAfterToolCall missing tracked runId=${runId}`);
    return;
  }

  await tracked.initializing?.catch(() => undefined);
  if (!isPostedTrackedRun(tracked)) return;

  const toolName = normalizeToolName(event.toolName);
  if (!toolName) {
    api.logger.debug?.(`slack-subagent-card: handleAfterToolCall skipped because toolName is missing for runId=${runId}`);
    return;
  }

  try {
    await enqueueRunUpdate(tracked, async () => {
      if (shared.runs.get(runId) !== tracked) return;
      const resolved = await resolveSlackWebClient(api, shared, tracked.accountId);
      if (!resolved || shared.runs.get(runId) !== tracked) return;

      upsertTrackedToolCall(tracked, {
        id: buildToolCallTaskId(tracked),
        name: toolName,
        detail: buildToolCallDetail(toolName),
        durationMs: normalizeToolDurationMs(event.durationMs),
        status: event.failed ? "error" : "complete",
      });

      const task = await resolveTaskRun(api, tracked.requesterSessionKey, runId);
      if (shared.runs.get(runId) !== tracked || tracked.terminalUpdateQueued) return;
      const runningContent = buildRunningContent({
        task,
        runId,
        mode: tracked.mode,
      });

      await renderTrackedRunUpdate({
        web: resolved.web,
        logger: api.logger,
        tracked,
        content: runningContent,
        elapsedText: tracked.endedAt ? formatElapsed(Math.max(0, tracked.endedAt - tracked.startedAt)) : undefined,
      });
    });
  } catch (error) {
    api.logger.warn(`slack-subagent-card: tool call card update failed for runId=${runId}: ${stringifyError(error)}`);
  }
}

export async function handleEnded(
  api: PluginApi,
  shared: SharedState,
  event: InternalSubagentEndedInput,
  ctx: InternalHookContext,
): Promise<void> {
  const runId = asNonEmptyString(event.runId ?? ctx.runId);
  if (!runId) {
    api.logger.debug?.("slack-subagent-card: handleEnded skipped because runId is missing");
    return;
  }

  const tracked = shared.runs.get(runId);
  if (!tracked) {
    api.logger.debug?.(`slack-subagent-card: handleEnded missing tracked runId=${runId}`);
    return;
  }

  await tracked.initializing?.catch(() => undefined);
  if (!isPostedTrackedRun(tracked)) {
    cleanupTrackedRun(shared, runId, tracked);
    return;
  }

  // Portable progress and compatibility ended hooks can describe the same terminal run.
  // Claim before any further await so exactly one path owns the Slack update.
  if (tracked.terminalUpdateQueued) return;
  tracked.terminalUpdateQueued = true;

  try {
    const resolved = await resolveSlackWebClient(
      api,
      shared,
      asNonEmptyString(event.accountId) ?? tracked.accountId,
    );
    if (!resolved) return;

    const outcome = normalizeOutcome(event.outcome);
    tracked.endedAt = asFiniteNumber(event.endedAt) ?? Date.now();

    const elapsedText = formatElapsed(Math.max(0, tracked.endedAt - tracked.startedAt));
    const requesterSessionKey =
      validateTrackedRequesterSessionKey(api.logger, tracked, undefined, ctx.requesterSessionKey) ??
      tracked.requesterSessionKey;
    const task = await resolveTaskRunWithRetry(api, requesterSessionKey, runId);
    if (shared.runs.get(runId) !== tracked) return;
    const terminalContent = buildTerminalContent({
      task,
      runId,
      outcome,
      elapsedText,
      mode: tracked.mode,
    });

    await enqueueRunUpdate(tracked, async () => {
      if (shared.runs.get(runId) !== tracked) return;
      await renderTrackedRunUpdate({
        web: resolved.web,
        logger: api.logger,
        tracked,
        content: terminalContent,
        elapsedText,
      });
    });
  } catch (error) {
    api.logger.warn(
      `slack-subagent-card: terminal card finalization failed for runId=${runId}: ${stringifyError(error)}`,
    );
  } finally {
    cleanupTrackedRun(shared, runId, tracked);
  }
}

function buildBlocks(params: {
  label: string;
  statusText: string;
  elapsedText?: string;
  detail?: string;
  outputText?: string;
  taskId: string;
  slackTaskStatus: SlackTaskStatus;
  toolCalls?: readonly TrackedToolCall[];
}): Array<Record<string, unknown>> {
  const titleParts = [params.label];
  if (params.elapsedText) titleParts.push(`(${params.elapsedText})`);

  const task: Record<string, unknown> = {
    type: "task_card",
    task_id: params.taskId,
    title: titleParts.join(" "),
    status: params.slackTaskStatus,
  };

  if (params.detail) {
    task.details = toRichText(truncate(params.detail, BLOCK_TEXT_MAX_CHARS));
  }

  if (params.outputText) {
    task.output = toRichText(truncate(params.outputText, BLOCK_TEXT_MAX_CHARS));
  }

  const toolTasks = buildToolTaskCards(params.toolCalls ?? []);
  const tasks = params.slackTaskStatus === "in_progress" ? [task, ...toolTasks] : [...toolTasks, task];

  return [
    {
      type: "plan",
      title: params.statusText,
      tasks,
    },
  ];
}

async function postSlackTaskCard(params: {
  web: SlackWebClient;
  logger: Logger;
  target: SlackThreadTarget;
  label: string;
  statusText: string;
  fallbackStatusText?: string;
  content: SlackTaskCardContent;
}): Promise<string | undefined> {
  params.logger.debug?.(
    `slack-subagent-card: posting card channel=${params.target.channelId} thread=${params.target.threadTs} taskId=${params.content.taskId} status=${params.content.slackTaskStatus} detailLen=${params.content.detail.length} outputLen=${params.content.outputText?.length ?? 0}`,
  );
  const sent = await params.web.chat.postMessage({
    channel: params.target.channelId,
    thread_ts: params.target.threadTs,
    ...buildSlackTaskCardPayload({
      label: params.label,
      statusText: params.statusText,
      fallbackStatusText: params.fallbackStatusText,
      content: params.content,
    }),
  });

  return asNonEmptyString((sent as any)?.ts) ?? asNonEmptyString((sent as any)?.message?.ts);
}

async function initializeSlackTaskCard(params: {
  web: SlackWebClient;
  logger: Logger;
  target: SlackThreadTarget;
  tracked: TrackedRun;
  label: string;
  statusText: string;
  fallbackStatusText?: string;
  content: SlackTaskCardContent;
}): Promise<boolean> {
  const messageTs = await postSlackTaskCard({
    web: params.web,
    logger: params.logger,
    target: params.target,
    label: params.label,
    statusText: params.statusText,
    fallbackStatusText: params.fallbackStatusText,
    content: params.content,
  });

  if (!messageTs) {
    params.logger.warn("slack-subagent-card: postMessage returned no ts; skipping tracking");
    return false;
  }

  params.tracked.messageTs = messageTs;
  params.tracked.channelId = params.target.channelId;
  params.tracked.threadTs = params.target.threadTs;
  return true;
}

async function updateSlackTaskCard(params: {
  web: SlackWebClient;
  logger: Logger;
  tracked: TrackedRun & { messageTs: string; channelId: string };
  content: SlackTaskCardContent & { statusText: string };
  elapsedText?: string;
}): Promise<void> {
  params.logger.debug?.(
    `slack-subagent-card: updating card channel=${params.tracked.channelId} ts=${params.tracked.messageTs} taskId=${params.content.taskId} status=${params.content.slackTaskStatus} detailLen=${params.content.detail.length} outputLen=${params.content.outputText?.length ?? 0}`,
  );
  await params.web.chat.update({
    channel: params.tracked.channelId,
    ts: params.tracked.messageTs,
    ...buildSlackTaskCardPayload({
      label: params.tracked.label,
      statusText: params.content.statusText,
      elapsedText: params.elapsedText,
      content: params.content,
      toolCalls: params.tracked.toolCalls,
    }),
  });
}

function buildSlackTaskCardPayload(params: SlackTaskCardPayloadParams): Record<string, unknown> {
  return {
    text: buildFallbackText(params.label, params.fallbackStatusText ?? params.statusText),
    parse: "none",
    blocks: buildBlocks({
      label: params.label,
      statusText: params.statusText,
      elapsedText: params.elapsedText,
      detail: params.content.detail,
      outputText: params.content.outputText,
      taskId: params.content.taskId,
      slackTaskStatus: params.content.slackTaskStatus,
      toolCalls: params.toolCalls ?? [],
    }) as any,
  };
}

async function renderTrackedRunUpdate(params: {
  web: SlackWebClient;
  logger: Logger;
  tracked: TrackedRun & { messageTs: string; channelId: string };
  content: SlackTaskCardContent & { statusText: string };
  elapsedText?: string;
}): Promise<void> {
  await updateSlackTaskCard(params);
}

function createTrackedRun(params: {
  accountId?: string;
  agentId?: string;
  childSessionKey?: string;
  endedAt?: number;
  label: string;
  spawnLabel?: string;
  mode?: Mode;
  requester?: SlackRequester;
  requesterSessionKey: string;
}): TrackedRun {
  return {
    accountId: params.accountId,
    agentId: params.agentId,
    childSessionKey: params.childSessionKey,
    startedAt: Date.now(),
    endedAt: params.endedAt,
    label: params.label,
    spawnLabel: params.spawnLabel,
    mode: params.mode,
    requester: params.requester,
    requesterSessionKey: params.requesterSessionKey,
    toolCalls: [],
    nextToolTaskSequence: 0,
  };
}

function buildToolTaskCards(toolCalls: readonly TrackedToolCall[]): Array<Record<string, unknown>> {
  return toolCalls.slice(-MAX_TOOL_TASKS).map((toolCall) => {
    return {
      type: "task_card",
      task_id: toolCall.id,
      title: truncate(formatToolTaskTitle(toolCall), TOOL_TASK_TITLE_MAX_CHARS),
      status: toolCall.status,
    };
  });
}

function areToolTasksEnabled(api: PluginApi): boolean {
  const config = api.config;
  if (config?.channels?.slack?.streaming?.preview?.toolProgress === false) {
    return false;
  }
  const pluginConfig = api.pluginConfig as OpenClawPluginConfig | undefined;
  return pluginConfig?.toolTasks?.enabled === true;
}

function formatToolTaskTitle(toolCall: TrackedToolCall): string {
  const parts = [toolCall.name];
  if (toolCall.detail) parts.push(toolCall.detail);
  const elapsed = toolCall.durationMs != null ? formatElapsed(Math.max(0, toolCall.durationMs)) : undefined;
  if (elapsed) parts.push(`(${elapsed})`);
  return normalizeSingleLine(parts.join(" "));
}

function normalizeSingleLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function buildToolCallDetail(toolName: string): string | undefined {
  const normalized = toolName.toLowerCase();
  if (normalized === "read" || normalized === "write" || normalized === "edit") {
    return "file";
  }
  return undefined;
}

function normalizeToolName(value: unknown): string | undefined {
  const toolName = asNonEmptyString(value);
  if (!toolName) return undefined;
  return truncate(normalizeSingleLine(toolName), TOOL_TASK_TITLE_MAX_CHARS);
}

function normalizeToolDurationMs(value: unknown): number | undefined {
  const durationMs = asFiniteNumber(value);
  if (durationMs === undefined) return undefined;
  return Math.min(Math.max(0, durationMs), STALE_RUN_TTL_MS);
}

function upsertTrackedToolCall(tracked: TrackedRun, toolCall: TrackedToolCall): void {
  const existingIndex = tracked.toolCalls.findIndex((candidate) => candidate.id === toolCall.id);
  if (existingIndex >= 0) {
    tracked.toolCalls[existingIndex] = toolCall;
  } else {
    tracked.toolCalls.push(toolCall);
  }
  if (tracked.toolCalls.length > MAX_TOOL_TASKS) {
    tracked.toolCalls.splice(0, tracked.toolCalls.length - MAX_TOOL_TASKS);
  }
}

function buildToolCallTaskId(tracked: TrackedRun): string {
  tracked.nextToolTaskSequence += 1;
  return `tool-${tracked.nextToolTaskSequence}`;
}

function isPostedTrackedRun(
  tracked: TrackedRun,
): tracked is TrackedRun & { messageTs: string; channelId: string; threadTs: string } {
  return Boolean(tracked.messageTs && tracked.channelId && tracked.threadTs);
}

function reserveTrackedRun(shared: SharedState, runId: string, tracked: TrackedRun): boolean {
  if (shared.runs.has(runId)) return false;
  shared.runs.set(runId, tracked);
  return true;
}

async function resolveTaskRun(api: PluginApi, requesterSessionKey: string | undefined, runId: string): Promise<TaskRunDetail | undefined> {
  if (!requesterSessionKey) return undefined;

  try {
    const tasks: PluginApi["runtime"]["tasks"] & {
      async?: {
        runs: {
          bindSession(params: { sessionKey: string }): {
            resolve(runId: string): Promise<TaskRunDetail | undefined>;
          };
        };
      };
    } = api.runtime.tasks;
    // Older supported hosts expose only the synchronous task-read namespace.
    const runs = tasks.async === undefined ? tasks.runs : tasks.async.runs;
    return await runs.bindSession({ sessionKey: requesterSessionKey }).resolve(runId);
  } catch (error) {
    api.logger.debug?.(`slack-subagent-card: task lookup failed for runId=${runId}: ${stringifyError(error)}`);
    return undefined;
  }
}

async function resolveTaskRunWithRetry(
  api: PluginApi,
  requesterSessionKey: string | undefined,
  runId: string,
): Promise<TaskRunDetail | undefined> {
  const initial = await resolveTaskRun(api, requesterSessionKey, runId);
  if (hasTerminalTaskSignal(initial) || !requesterSessionKey) return initial;

  await sleep(TASK_LOOKUP_RETRY_MS);
  return (await resolveTaskRun(api, requesterSessionKey, runId)) ?? initial;
}

function validateTrackedRequesterSessionKey(
  log: Logger,
  tracked: TrackedRun,
  ...candidates: Array<string | undefined>
): string | undefined {
  const trackedSessionKey = asNonEmptyString(tracked.requesterSessionKey);
  if (!trackedSessionKey) return undefined;

  for (const candidate of candidates) {
    const normalized = asNonEmptyString(candidate);
    if (normalized && normalized !== trackedSessionKey) {
      log.warn("slack-subagent-card: ignoring mismatched requester session key for tracked run");
    }
  }

  return trackedSessionKey;
}

async function enqueueRunUpdate(tracked: TrackedRun, update: () => Promise<void>): Promise<void> {
  const previous = tracked.updateChain ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(update);
  tracked.updateChain = next.catch(() => undefined);
  await next;
}

function buildFallbackText(label: string, statusText: string): string {
  return `${CARD_TEXT_PREFIX}${escapeSlackText(label)}: ${escapeSlackText(statusText)}`;
}

function escapeSlackText(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function toRichText(text: string): Record<string, unknown> {
  return {
    type: "rich_text",
    elements: [
      {
        type: "rich_text_section",
        elements: [{ type: "text", text }],
      },
    ],
  };
}

function normalizeOutcome(value: unknown): Outcome {
  return value === "error" ||
    value === "timeout" ||
    value === "killed" ||
    value === "reset" ||
    value === "deleted"
    ? value
    : "ok";
}

async function resolveSlackThreadTarget(
  requesterSessionKey: string,
  requester: SlackRequester | undefined,
  web: SlackWebClient,
  log: Logger,
): Promise<SlackThreadTarget | null> {
  const fromSession = parseSlackThreadSessionKey(requesterSessionKey);
  if (fromSession) {
    // For DM sessions the captured ID is a user ID (U...), not a DM channel (D...).
    // Slack's chat.postMessage needs the D-prefixed channel ID for thread replies.
    if (/^U/i.test(fromSession.channelId)) {
      const resolved = await resolveUserToDmChannel(web, fromSession.channelId, log);
      if (!resolved) return null;
      return {
        channelId: resolved,
        threadTs: fromSession.threadTs,
      };
    }
    return fromSession;
  }

  const rawTarget = asNonEmptyString(requester?.to);
  const threadTs = asNonEmptyIdString(requester?.threadId);
  if (!rawTarget || !threadTs) return null;

  let channelId = normalizeSlackChannelId(stripSlackTargetPrefix(rawTarget));
  if (/^U/i.test(channelId)) {
    const resolved = await resolveUserToDmChannel(web, channelId, log);
    if (!resolved) return null;
    channelId = resolved;
  }

  return { channelId, threadTs };
}

function parseSlackThreadSessionKey(sessionKey: string): SlackThreadTarget | null {
  const threadMatch = sessionKey.match(SLACK_THREAD_RE);
  if (threadMatch) {
    return {
      channelId: normalizeSlackChannelId(threadMatch[1]),
      threadTs: threadMatch[2],
    };
  }

  const topicMatch = sessionKey.match(SLACK_TOPIC_RE);
  if (topicMatch) {
    return {
      channelId: normalizeSlackChannelId(topicMatch[1]),
      threadTs: topicMatch[2],
    };
  }

  return null;
}

function stripSlackTargetPrefix(value: string): string {
  return value.replace(/^(channel:|room:|user:)/i, "");
}

function hasSlackThreadTargetHint(
  requesterSessionKey: string,
  requester: SlackRequester | undefined,
): boolean {
  if (parseSlackThreadSessionKey(requesterSessionKey)) return true;
  const requesterChannel = asNonEmptyString(requester?.channel)?.toLowerCase();
  if (requesterChannel && requesterChannel !== "slack") return false;
  return Boolean(asNonEmptyString(requester?.to) && asNonEmptyIdString(requester?.threadId));
}

type SlackTokenResolution = {
  accountId: string;
  token?: string;
  diagnostics: string[];
  unresolvedReasons: string[];
};

type SlackBotTokenCandidate = {
  path: string;
  value: unknown;
};

type SlackBotTokenCandidateResolution = {
  token?: string;
  source?: "config" | "secretRef" | "fallback";
  unresolvedReason?: string;
};

async function resolveSlackBotToken(
  api: PluginApi,
  accountId?: string,
): Promise<SlackTokenResolution> {
  const config = api.config;
  const resolvedAccountId = resolveEffectiveSlackAccountId(config, accountId);
  const diagnostics: string[] = [];
  const unresolvedReasons: string[] = [];
  const channelConfig = config?.channels?.slack;
  const merged = resolveMergedAccountConfig<SlackAccountConfig>({
    channelConfig,
    accounts: channelConfig?.accounts,
    accountId: resolvedAccountId,
  });
  const candidate = {
    path: `channels.slack.accounts.${resolvedAccountId}.botToken`,
    value: merged.botToken,
  } satisfies SlackBotTokenCandidate;
  const resolved = await resolveSlackBotTokenCandidate(api, config, candidate.value, candidate.path);
  diagnostics.push(formatTokenCandidateDiagnostic(candidate, resolved));
  if (resolved.token) {
    api.logger.info(
      `slack-subagent-card: resolved Slack bot token for accountId=${resolvedAccountId} via ${candidate.path} (${summarizeResolvedToken(resolved.token)} source=${resolved.source ?? "config"})`,
    );
    return { accountId: resolvedAccountId, token: resolved.token, diagnostics, unresolvedReasons };
  }
  if (resolved.unresolvedReason) unresolvedReasons.push(resolved.unresolvedReason);

  const envToken = resolvedAccountId === DEFAULT_ACCOUNT_ID
    ? asNonEmptyString(process.env.SLACK_BOT_TOKEN)
    : undefined;
  diagnostics.push(
    envToken
      ? `env.SLACK_BOT_TOKEN(input=present resolved=${summarizeResolvedToken(envToken)} source=env)`
      : resolvedAccountId === DEFAULT_ACCOUNT_ID
        ? "env.SLACK_BOT_TOKEN(input=missing resolved=missing)"
        : "env.SLACK_BOT_TOKEN(input=not-eligible-for-named-account resolved=missing)",
  );
  if (envToken) {
    api.logger.info(
      `slack-subagent-card: resolved Slack bot token for accountId=${resolvedAccountId} via env.SLACK_BOT_TOKEN (${summarizeResolvedToken(envToken)} source=env)`,
    );
    return { accountId: resolvedAccountId, token: envToken, diagnostics, unresolvedReasons };
  }

  return {
    accountId: resolvedAccountId,
    diagnostics,
    unresolvedReasons,
  };
}

function resolveEffectiveSlackAccountId(
  config: OpenClawConfig | undefined,
  requestedAccountId?: string,
): string {
  const requested = asNonEmptyString(requestedAccountId);
  if (requested) return normalizeAccountId(requested);

  const slack = config?.channels?.slack;
  const configuredIds = Object.keys(slack?.accounts ?? {}).filter(Boolean);
  const hasImplicitDefault = hasConfiguredValue(slack?.botToken) ||
    hasConfiguredValue(process.env.SLACK_BOT_TOKEN);
  const accountIds = listCombinedAccountIds({
    configuredAccountIds: configuredIds,
    implicitAccountId: hasImplicitDefault ? DEFAULT_ACCOUNT_ID : undefined,
    fallbackAccountIdWhenEmpty: DEFAULT_ACCOUNT_ID,
  });
  const configuredDefaultRaw = asNonEmptyString(slack?.defaultAccount);
  const configuredDefault = configuredDefaultRaw
    ? normalizeAccountId(configuredDefaultRaw)
    : undefined;
  return resolveListedDefaultAccountId({
    accountIds,
    configuredDefaultAccountId: configuredDefault,
  });
}

async function resolveSlackBotTokenCandidate(
  api: PluginApi,
  config: OpenClawConfig | undefined,
  value: unknown,
  path: string,
): Promise<SlackBotTokenCandidateResolution> {
  const directToken = asDirectPlaintextSecret(value);
  if (directToken) {
    return { token: directToken, source: "config" };
  }

  if (!config) {
    const token = asNonEmptyString(value);
    return { token, source: token ? "config" : undefined };
  }

  if (!api.resolveConfiguredSecretInputWithFallback) {
    const token = asNonEmptyString(value);
    return { token, source: token ? "config" : undefined };
  }

  const resolved = await api.resolveConfiguredSecretInputWithFallback({
    config,
    env: process.env,
    value,
    path,
  });

  return {
    token: asNonEmptyString(resolved?.value),
    source: resolved?.source,
    unresolvedReason: asNonEmptyString(resolved?.unresolvedRefReason),
  };
}

async function resolveSlackWebClient(
  api: PluginApi,
  shared: SharedState,
  accountId?: string,
): Promise<{ web: SlackWebClient; accountId: string } | undefined> {
  const { accountId: resolvedAccountId, token, diagnostics, unresolvedReasons } =
    await resolveSlackBotToken(api, accountId);
  if (!token) {
    const unresolvedSuffix =
      unresolvedReasons.length > 0 ? ` unresolvedRefs=${unresolvedReasons.join(" | ")}` : "";
    const diagnosticsSuffix =
      diagnostics.length > 0 ? ` diagnostics=${diagnostics.join(" ; ")}` : "";
    api.logger.warn(
      `slack-subagent-card: no Slack bot token found for accountId=${resolvedAccountId}; skipping configSurface=${summarizeConfigSurface(api.config)} hasResolver=${Boolean(api.resolveConfiguredSecretInputWithFallback)} hasClientFactory=${Boolean(api.createSlackWebClient)}${unresolvedSuffix}${diagnosticsSuffix}`,
    );
    return undefined;
  }
  const cached = shared.webClients.get(token);
  if (cached) return { web: cached, accountId: resolvedAccountId };
  const client =
    api.createSlackWebClient?.(token) ??
    api.fallbackSlackWebClientFactory?.(token) ??
    createNativeSlackWebClient(token, api.logger);
  if (!client) {
    api.logger.warn("slack-subagent-card: no Slack client factory available; skipping");
    return undefined;
  }
  shared.webClients.set(token, client);
  return { web: client, accountId: resolvedAccountId };
}

function formatElapsed(ms: number): string {
  if (ms < 1000) return "just now";
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remMinutes = minutes % 60;
  return remMinutes > 0 ? `${hours}h ${remMinutes}m` : `${hours}h`;
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function normalizeSlackChannelId(channelId: string): string {
  return /^[cgdu]/i.test(channelId) ? channelId.toUpperCase() : channelId;
}

/** Keep user-to-DM resolution isolated to the Slack client/account that produced it. */
const dmChannelCache = new WeakMap<SlackWebClient, Map<string, string>>();

async function resolveUserToDmChannel(
  web: SlackWebClient,
  userId: string,
  log: Logger,
): Promise<string | undefined> {
  const normalized = userId.toUpperCase();
  let clientCache = dmChannelCache.get(web);
  if (!clientCache) {
    clientCache = new Map();
    dmChannelCache.set(web, clientCache);
  }
  const cached = clientCache.get(normalized);
  if (cached) return cached;

  try {
    const result = await web.conversations.open({ users: normalized, return_im: true });
    const channelId = asNonEmptyString((result as any)?.channel?.id);
    if (channelId) {
      clientCache.set(normalized, channelId);
      log.info(`slack-subagent-card: resolved DM channel for ${normalized} → ${channelId}`);
      return channelId;
    }
    log.warn(`slack-subagent-card: conversations.open returned no channel for ${normalized}`);
    return undefined;
  } catch (error) {
    log.warn(`slack-subagent-card: failed to resolve DM channel for ${normalized}: ${stringifyError(error)}`);
    return undefined;
  }
}

function cleanupStaleRuns(shared: SharedState, log: Logger): void {
  const cutoff = Date.now() - STALE_RUN_TTL_MS;
  for (const [runId, tracked] of shared.runs.entries()) {
    if (tracked.startedAt >= cutoff) continue;
    shared.runs.delete(runId);
    log.debug?.(`slack-subagent-card: swept stale tracked runId=${runId}`);
  }
}

function cleanupTrackedRun(shared: SharedState, runId: string, tracked?: TrackedRun): void {
  if (!tracked || shared.runs.get(runId) === tracked) {
    shared.runs.delete(runId);
  }
}

export function createSharedState(): SharedState {
  return {
    runs: new Map(),
    registeredApis: new WeakSet(),
    webClients: new Map(),
    stateVersion: SHARED_STATE_VERSION,
  };
}

function getSharedState(): SharedState {
  const scope = globalThis as typeof globalThis & {
    [SHARED_STATE_KEY]?: SharedState;
  };

  if (!scope[SHARED_STATE_KEY]) {
    scope[SHARED_STATE_KEY] = createSharedState();
  }

  normalizeSharedState(scope[SHARED_STATE_KEY]!);
  return scope[SHARED_STATE_KEY]!;
}

function normalizeSharedState(shared: Partial<SharedState>): asserts shared is SharedState {
  if (!(shared.runs instanceof Map)) shared.runs = new Map();
  if (shared.stateVersion !== SHARED_STATE_VERSION || !(shared.registeredApis instanceof WeakSet)) {
    shared.registeredApis = new WeakSet();
  }
  if (!(shared.webClients instanceof Map)) shared.webClients = new Map();
  normalizeTrackedRuns(shared.runs);
  shared.stateVersion = SHARED_STATE_VERSION;
}

function normalizeTrackedRuns(runs: Map<string, TrackedRun>): void {
  for (const tracked of runs.values()) {
    tracked.toolCalls ??= [];
    tracked.nextToolTaskSequence ??= tracked.toolCalls.length;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asFiniteNumber(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function asNonEmptyIdString(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim() ? value : undefined;
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : undefined;
  return undefined;
}

function asDirectPlaintextSecret(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return /^\$\{.+\}$/.test(trimmed) ? undefined : trimmed;
}

function hasConfiguredValue(value: unknown): boolean {
  return value !== undefined && value !== null && (typeof value !== "string" || value.trim().length > 0);
}

export function createBoundedSlackWebClient(token: string): SlackWebClient {
  return new WebClient(token, {
    retryConfig: { retries: 0 },
    timeout: SLACK_WEB_CLIENT_TIMEOUT_MS,
    rejectRateLimitedCalls: true,
  }) as unknown as SlackWebClient;
}

function createNativeSlackWebClient(token: string, log: Logger): SlackWebClient | undefined {
  try {
    log.info("slack-subagent-card: using native Slack WebClient fallback");
    return createBoundedSlackWebClient(token);
  } catch (error) {
    log.warn(`slack-subagent-card: failed to construct native Slack WebClient: ${stringifyError(error)}`);
    return undefined;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatTokenCandidateDiagnostic(
  candidate: SlackBotTokenCandidate,
  resolved: SlackBotTokenCandidateResolution,
): string {
  const segments = [`${candidate.path}(input=${describeSecretInput(candidate.value)}`];
  if (resolved.source) segments.push(`source=${resolved.source}`);
  if (resolved.unresolvedReason) segments.push(`unresolved=${truncate(resolved.unresolvedReason, 120)}`);
  segments.push(`resolved=${resolved.token ? summarizeResolvedToken(resolved.token) : "missing"})`);
  return segments.join(" ");
}

function summarizeResolvedToken(token: string): string {
  return `${describeTokenFlavor(token)} len=${token.length}`;
}

function describeSecretInput(value: unknown): string {
  if (value === undefined || value === null) return "missing";
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return "empty-string";
    if (/^\$\{.+\}$/.test(trimmed)) return "secret-ref";
    return `string(${summarizeResolvedToken(trimmed)})`;
  }
  if (Array.isArray(value)) return `array(len=${value.length})`;
  if (typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>);
    return `object(keys=${truncate(keys.join(","), 80) || "none"})`;
  }
  return typeof value;
}

function describeTokenFlavor(token: string): string {
  if (/^xoxb-/i.test(token)) return "xoxb";
  if (/^xapp-/i.test(token)) return "xapp";
  if (/^xoxp-/i.test(token)) return "xoxp";
  return "opaque-token";
}

function summarizeConfigSurface(config: OpenClawConfig | undefined): string {
  if (!config) return "none";
  const topLevelKeys = Object.keys(config).sort();
  const rootSlack = config.channels?.slack;
  const rootAccountKeys = Object.keys(rootSlack?.accounts ?? {}).sort();
  return [
    `topLevelKeys=${topLevelKeys.length > 0 ? topLevelKeys.join(",") : "none"}`,
    `rootSlack=${rootSlack ? "present" : "missing"}`,
    `rootBotToken=${describeSecretInput(rootSlack?.botToken)}`,
    `defaultAccount=${asNonEmptyString(rootSlack?.defaultAccount) ?? "none"}`,
    `rootAccounts=${rootAccountKeys.length > 0 ? rootAccountKeys.join(",") : "none"}`,
  ].join(" ");
}

function summarizeRequester(requester: SlackRequester | undefined): string {
  if (!requester) return "none";
  return [
    `channel=${asNonEmptyString(requester.channel) ?? "unknown"}`,
    `accountId=${asNonEmptyString(requester.accountId) ?? "default"}`,
    `to=${asNonEmptyString(requester.to) ?? "none"}`,
    `threadId=${asNonEmptyIdString(requester.threadId) ?? "none"}`,
  ].join(",");
}

function runDetached(log: Logger, hookName: string, work: Promise<void>): void {
  void work.catch((error) => {
    log.warn(`slack-subagent-card: ${hookName} handler failed: ${stringifyError(error)}`);
  });
}

function stringifyError(error: unknown): string {
  const slackDetails = summarizeSlackError(error);
  if (error instanceof Error) {
    const base = error.stack || error.message;
    return slackDetails ? `${base} (${slackDetails})` : base;
  }
  if (typeof error === "string") return error;
  try {
    const serialized = JSON.stringify(error);
    return slackDetails ? `${serialized} (${slackDetails})` : serialized;
  } catch {
    const fallback = String(error);
    return slackDetails ? `${fallback} (${slackDetails})` : fallback;
  }
}

function summarizeSlackError(error: unknown): string | undefined {
  const record = asRecord(error);
  const data = asRecord(record?.data);
  const responseMetadata = asRecord(data?.response_metadata);
  const metadataMessages = Array.isArray(responseMetadata?.messages)
    ? responseMetadata.messages.filter(
        (value): value is string => typeof value === "string" && value.trim().length > 0,
      )
    : [];
  const parts = [
    asNonEmptyString(record?.code) ? `code=${asNonEmptyString(record?.code)}` : undefined,
    asNonEmptyString(data?.error) ? `slack_error=${asNonEmptyString(data?.error)}` : undefined,
    asFiniteNumber(data?.statusCode) ? `status=${asFiniteNumber(data?.statusCode)}` : undefined,
    metadataMessages.length > 0 ? `messages=${truncate(metadataMessages.join(" | "), 160)}` : undefined,
  ].filter((value): value is string => Boolean(value));
  return parts.length > 0 ? parts.join(" ") : undefined;
}

export { buildFallbackText };
