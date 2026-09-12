import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  createBoundedSlackWebClient,
  createSharedState,
  handleAfterToolCall,
  handleEnded,
  handleProgress,
  handleSpawned,
  registerSlackSubagentCardHandlers,
} from "./dist/plugin-handlers.js";

const THREAD_SESSION_KEY = "agent:test:slack:channel:C123:thread:1700000000.000100";
const DM_SESSION_KEY = "agent:test:slack:direct:U123:thread:1700000000.000100";
const CHILD_SESSION_KEY = "agent:test:subagent:child";
const TOKEN = "xoxb-test-token";

function createTaskRunDetail(overrides = {}) {
  const runId = overrides.runId ?? "run-1234567890";
  const createdAt = overrides.createdAt ?? 1_700_000_000_000;
  return {
    id: `task-${runId}`,
    runtime: "subagent",
    sessionKey: THREAD_SESSION_KEY,
    ownerKey: THREAD_SESSION_KEY,
    scope: "session",
    childSessionKey: CHILD_SESSION_KEY,
    agentId: "research-agent",
    runId,
    title: "Gather context",
    status: "running",
    deliveryStatus: "pending",
    notifyPolicy: "done_only",
    createdAt,
    startedAt: createdAt + 10,
    lastEventAt: createdAt + 20,
    ...overrides,
  };
}

function createRequester(overrides = {}) {
  return {
    channel: "slack",
    to: "channel:C123",
    threadId: "1700000000.000100",
    channelId: "C123",
    messageId: "1700000000.000100",
    ...overrides,
  };
}

function createHookContext(runId, overrides = {}) {
  return {
    runId,
    childSessionKey: CHILD_SESSION_KEY,
    requesterSessionKey: THREAD_SESSION_KEY,
    ...overrides,
  };
}

function createSpawnedEvent(runId, overrides = {}) {
  return {
    runId,
    childSessionKey: CHILD_SESSION_KEY,
    agentId: "research-agent",
    label: "Gather context",
    mode: "run",
    requester: createRequester(),
    threadRequested: true,
    ...overrides,
  };
}

function createProgressEvent(phase, runId, overrides = {}) {
  return {
    phase,
    runId,
    childSessionKey: CHILD_SESSION_KEY,
    requester: createRequester(),
    ...(phase === "ended" ? { outcome: "ok" } : {}),
    ...overrides,
  };
}

function createEndedEvent(runId, overrides = {}) {
  return {
    targetSessionKey: CHILD_SESSION_KEY,
    targetKind: "subagent",
    reason: "subagent-complete",
    runId,
    endedAt: 1_700_000_010_000,
    outcome: "ok",
    ...overrides,
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function waitFor(predicate, message = "condition", timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${message}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function withEnv(changes, work) {
  const previous = new Map();
  for (const [key, value] of Object.entries(changes)) {
    previous.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await work();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function createFakeWeb(options = {}) {
  const posts = [];
  const updates = [];
  const opens = [];
  let streamCalls = 0;
  const web = {
    posts,
    updates,
    opens,
    get streamCalls() {
      return streamCalls;
    },
    chat: {
      async postMessage(params) {
        posts.push(params);
        if (options.onPost) return options.onPost(params, posts.length);
        return { ts: `1700000000.${String(200 + posts.length).padStart(6, "0")}` };
      },
      async update(params) {
        updates.push(params);
        if (options.onUpdate) return options.onUpdate(params, updates.length);
        return { ok: true };
      },
      async startStream() {
        streamCalls += 1;
        throw new Error("native Slack streams must not be used");
      },
      async appendStream() {
        streamCalls += 1;
        throw new Error("native Slack streams must not be used");
      },
      async stopStream() {
        streamCalls += 1;
        throw new Error("native Slack streams must not be used");
      },
    },
    conversations: {
      async open(params) {
        opens.push(params);
        if (options.onOpen) return options.onOpen(params, opens.length);
        return { channel: { id: "D123" } };
      },
    },
  };
  return web;
}

function createHarness(options = {}) {
  const shared = options.shared ?? createSharedState();
  const web = options.web ?? createFakeWeb();
  const tokens = [];
  const logs = { debug: [], info: [], warn: [] };
  let currentTask = options.task;
  const api = {
    config: options.config ?? { channels: { slack: { botToken: TOKEN } } },
    pluginConfig: options.toolTasks ? { toolTasks: { enabled: true } } : undefined,
    logger: {
      debug(message) { logs.debug.push(message); },
      info(message) { logs.info.push(message); },
      warn(message) { logs.warn.push(message); },
    },
    createSlackWebClient(token) {
      tokens.push(token);
      return options.clientForToken?.(token) ?? web;
    },
    runtime: {
      tasks: {
        async: {
          runs: {
            bindSession({ sessionKey }) {
              assert.equal(sessionKey, options.sessionKey ?? THREAD_SESSION_KEY);
              return { resolve: async () => options.onResolve ? options.onResolve() : currentTask };
            },
          },
        },
      },
    },
  };
  return {
    api,
    shared,
    web,
    tokens,
    logs,
    setTask(task) { currentTask = task; },
  };
}

async function spawn(harness, options = {}) {
  const runId = options.runId ?? "run-1234567890";
  const requesterSessionKey = options.sessionKey ?? THREAD_SESSION_KEY;
  const requester = options.requester
    ? createRequester(options.requester)
    : createRequester();
  await handleSpawned(
    harness.api,
    harness.shared,
    createSpawnedEvent(runId, {
      label: options.label ?? "Gather context",
      requester,
    }),
    createHookContext(runId, { requesterSessionKey }),
  );
  return runId;
}

function plan(payload) {
  return payload.blocks[0];
}

function mainTask(payload) {
  const tasks = plan(payload).tasks;
  return tasks.find((task) => !String(task.task_id).startsWith("tool-"));
}

function richTextValue(value) {
  return value?.elements?.flatMap((section) => section.elements ?? []).map((item) => item.text ?? "").join("") ?? "";
}

describe("portable lifecycle convergence", () => {
  it("posts a Block Kit card and never invokes Slack native stream methods", async () => {
    const harness = createHarness();
    await spawn(harness);

    assert.equal(harness.web.posts.length, 1);
    assert.equal(harness.web.streamCalls, 0);
    assert.equal(plan(harness.web.posts[0]).type, "plan");
    assert.equal(mainTask(harness.web.posts[0]).status, "in_progress");
    assert.equal(harness.shared.runs.size, 1);
  });

  for (const source of ["label", "agentId", "title"]) {
    it(`uses the ${source} source even when a spawn label equals the run ID`, async () => {
      const runId = "run-label-source";
      const harness = createHarness({ task: createTaskRunDetail({ label: undefined, title: "Task title" }) });
      await handleSpawned(
        harness.api,
        harness.shared,
        createSpawnedEvent(runId, { label: undefined, agentId: undefined, ...(source === "title" ? {} : { [source]: runId }) }),
        createHookContext(runId),
      );

      assert.equal(mainTask(harness.web.posts[0]).title, source === "title" ? "Task title" : runId);
    });
  }

  it("retains a duplicate spawn label received while the initial task lookup is pending", async () => {
    const runId = "run-pending-label";
    const gate = deferred();
    const task = createTaskRunDetail({ label: undefined, title: "Task title" });
    let lookups = 0;
    const harness = createHarness({ onResolve: () => ++lookups === 1 ? gate.promise : task });
    const initial = handleSpawned(
      harness.api,
      harness.shared,
      createSpawnedEvent(runId, { label: undefined, agentId: undefined }),
      createHookContext(runId),
    );
    await waitFor(() => lookups === 1, "initial task lookup");
    const duplicate = handleSpawned(
      harness.api,
      harness.shared,
      createSpawnedEvent(runId, { label: runId, agentId: undefined }),
      createHookContext(runId),
    );
    await waitFor(() => lookups === 2, "duplicate task lookup");
    gate.resolve(task);
    await Promise.all([initial, duplicate]);

    assert.equal(harness.web.posts.length, 1);
    assert.equal(mainTask(harness.web.posts[0]).title, runId);
  });

  it("retains a rich spawn label when a sparse started hook follows", async () => {
    const harness = createHarness({ task: createTaskRunDetail({ label: undefined, title: "Task title" }) });
    const runId = await spawn(harness, { label: "Explicit spawn label" });

    await handleProgress(harness.api, harness.shared, createProgressEvent("started", runId), createHookContext(runId));

    assert.equal(harness.web.posts.length, 1);
    assert.equal(harness.web.updates.length, 0);
    assert.equal(mainTask(harness.web.posts[0]).title, "Explicit spawn label");
  });

  it("applies duplicate spawn metadata before a pending lookup can be overtaken by termination", async () => {
    const gate = deferred();
    let lookups = 0;
    const task = createTaskRunDetail({ label: undefined, title: undefined, status: "succeeded" });
    const harness = createHarness({ onResolve: () => ++lookups === 2 ? gate.promise : task });
    const runId = await spawn(harness);
    const duplicate = handleSpawned(
      harness.api,
      harness.shared,
      createSpawnedEvent(runId, { label: "Updated before termination" }),
      createHookContext(runId),
    );
    await waitFor(() => lookups === 2, "duplicate task lookup");

    await handleEnded(harness.api, harness.shared, createEndedEvent(runId), createHookContext(runId));
    assert.equal(mainTask(harness.web.updates[0]).title, "Updated before termination");
    gate.resolve(task);
    await duplicate;
    assert.equal(harness.web.updates.length, 1);
  });

  it("finalizes a retained run from subagent_progress ended", async () => {
    const harness = createHarness();
    const runId = await spawn(harness);
    harness.setTask(createTaskRunDetail({
      id: "task-123",
      runId,
      status: "succeeded",
      deliveryStatus: "delivered",
      endedAt: 1_700_000_010_000,
      terminalOutcome: "succeeded",
    }));

    await handleProgress(
      harness.api,
      harness.shared,
      createProgressEvent("ended", runId),
      createHookContext(runId),
    );

    assert.equal(harness.web.updates.length, 1);
    assert.equal(mainTask(harness.web.updates[0]).status, "complete");
    assert.equal(harness.shared.runs.has(runId), false);
  });

  it("coalesces portable progress and compatibility ended signals in either order", async () => {
    for (const order of ["progress-first", "ended-first"]) {
      const harness = createHarness();
      const runId = await spawn(harness, { runId: `run-${order}` });
      const progress = () => handleProgress(
        harness.api,
        harness.shared,
        createProgressEvent("ended", runId),
        createHookContext(runId),
      );
      const ended = () => handleEnded(
        harness.api,
        harness.shared,
        createEndedEvent(runId),
        createHookContext(runId),
      );

      if (order === "progress-first") await Promise.all([progress(), ended()]);
      else await Promise.all([ended(), progress()]);

      assert.equal(harness.web.updates.length, 1, order);
      assert.equal(harness.shared.runs.has(runId), false, order);
    }
  });

  it("maps the official unknown portable outcome to failure instead of success", async () => {
    const harness = createHarness();
    const runId = await spawn(harness, { runId: "run-unknown" });
    await handleProgress(
      harness.api,
      harness.shared,
      createProgressEvent("ended", runId, { outcome: "unknown" }),
      createHookContext(runId),
    );
    assert.equal(mainTask(harness.web.updates[0]).status, "error");
    assert.match(richTextValue(mainTask(harness.web.updates[0]).details), /failed/i);
  });

  it("robustness: treats a malformed ended progress event with no outcome as failure", async () => {
    const harness = createHarness();
    const runId = await spawn(harness, { runId: "run-missing-outcome" });
    await handleProgress(
      harness.api,
      harness.shared,
      { phase: "ended", runId, childSessionKey: CHILD_SESSION_KEY, requester: createRequester() },
      createHookContext(runId),
    );
    assert.equal(mainTask(harness.web.updates[0]).status, "error");
    assert.match(richTextValue(mainTask(harness.web.updates[0]).details), /failed/i);
  });

  it("never renders raw task summaries or compatibility-hook error details", async () => {
    const harness = createHarness();
    const runId = await spawn(harness);
    const secrets = [
      "raw progress from a private workspace",
      "raw terminal copied user content",
      "raw task error xoxb-private-token",
      "compatibility hook error with private details",
      "compatibility hook reason with private details",
    ];
    harness.setTask(createTaskRunDetail({
      id: "task-private",
      runId,
      title: "Private task",
      status: "failed",
      deliveryStatus: "failed",
      endedAt: 1_700_000_010_000,
      progressSummary: secrets[0],
      terminalSummary: secrets[1],
      error: secrets[2],
    }));

    await handleEnded(
      harness.api,
      harness.shared,
      createEndedEvent(runId, { outcome: "error", error: secrets[3], reason: secrets[4] }),
      createHookContext(runId),
    );

    const rendered = JSON.stringify(harness.web.updates[0]);
    assert.equal(mainTask(harness.web.updates[0]).status, "error");
    assert.match(richTextValue(mainTask(harness.web.updates[0]).details), /failed/i);
    for (const secret of secrets) assert.equal(rendered.includes(secret), false);
  });

  it("merges richer spawned metadata into portable started without a duplicate post", async () => {
    const harness = createHarness();
    const runId = "run-portable-start";
    await handleProgress(
      harness.api,
      harness.shared,
      createProgressEvent("started", runId, { childSessionKey: "agent:test:subagent:portable" }),
      createHookContext(runId, { childSessionKey: "agent:test:subagent:portable" }),
    );
    await handleSpawned(
      harness.api,
      harness.shared,
      createSpawnedEvent(runId, {
        childSessionKey: "agent:test:subagent:portable",
        agentId: "research-agent",
        label: "Research worker",
        mode: "session",
      }),
      createHookContext(runId, { childSessionKey: "agent:test:subagent:portable" }),
    );

    assert.equal(harness.web.posts.length, 1);
    assert.equal(harness.web.updates.length, 1);
    assert.equal(mainTask(harness.web.updates[0]).title, "Research worker");
    assert.match(richTextValue(mainTask(harness.web.updates[0]).details), /persistent background worker session/i);
    assert.match(richTextValue(mainTask(harness.web.updates[0]).output), /worker session continues/i);
    assert.equal(harness.shared.runs.get(runId).mode, "session");
    assert.equal(harness.shared.runs.get(runId).agentId, "research-agent");
    assert.equal(harness.shared.runs.get(runId).childSessionKey, "agent:test:subagent:portable");
    assert.equal(harness.shared.runs.has(runId), true);
  });

  it("registers the portable and compatibility lifecycle hooks", () => {
    const registrations = [];
    const harness = createHarness();
    harness.api.on = (name, handler) => registrations.push({ name, handler });

    registerSlackSubagentCardHandlers(harness.api, harness.shared);

    assert.deepEqual(
      registrations.map(({ name }) => name),
      ["subagent_spawned", "subagent_progress", "subagent_ended", "after_tool_call"],
    );
  });

  it("refreshes the task label when an otherwise identical spawn event is repeated", async () => {
    const harness = createHarness();
    const runId = await spawn(harness);
    harness.setTask(createTaskRunDetail({ label: "Resolved task label" }));

    await spawn(harness, { runId });

    assert.equal(harness.web.posts.length, 1);
    assert.equal(harness.web.updates.length, 1);
    assert.equal(mainTask(harness.web.updates[0]).title, "Resolved task label");
  });

  it("reserves synchronously and returns from the hook while Slack is blocked", async () => {
    const gate = deferred();
    const web = createFakeWeb({ onPost: () => gate.promise });
    const harness = createHarness({ web });
    const registrations = new Map();
    harness.api.on = (name, handler) => registrations.set(name, handler);
    registerSlackSubagentCardHandlers(harness.api, harness.shared);

    const result = registrations.get("subagent_spawned")(
      createSpawnedEvent("run-blocked", { label: "Blocked post" }),
      createHookContext("run-blocked"),
    );

    assert.equal(result, undefined);
    assert.equal(harness.shared.runs.has("run-blocked"), true);
    await waitFor(() => web.posts.length === 1, "initial Slack post");
    gate.resolve({ ts: "1700000000.000200" });
    await waitFor(() => harness.shared.runs.get("run-blocked")?.messageTs, "completed initialization");
  });

  it("preserves a terminal signal that arrives during initialization", async () => {
    const gate = deferred();
    const web = createFakeWeb({ onPost: () => gate.promise });
    const harness = createHarness({ web });
    const registrations = new Map();
    harness.api.on = (name, handler) => registrations.set(name, handler);
    registerSlackSubagentCardHandlers(harness.api, harness.shared);

    registrations.get("subagent_spawned")(
      createSpawnedEvent("run-race", { label: "Race" }),
      createHookContext("run-race"),
    );
    registrations.get("subagent_progress")(
      createProgressEvent("ended", "run-race"),
      createHookContext("run-race"),
    );
    gate.resolve({ ts: "1700000000.000200" });

    await waitFor(() => web.updates.length === 1 && !harness.shared.runs.has("run-race"), "terminal update");
    assert.equal(web.updates.length, 1);
  });

  it("preserves a terminal signal while the initial task lookup is pending", async () => {
    const gate = deferred();
    let lookupStarted = false;
    const harness = createHarness({ onResolve: () => {
      lookupStarted = true;
      return gate.promise;
    } });
    const registrations = new Map();
    harness.api.on = (name, handler) => registrations.set(name, handler);
    registerSlackSubagentCardHandlers(harness.api, harness.shared);

    registrations.get("subagent_spawned")(
      createSpawnedEvent("run-lookup", { label: "Lookup" }),
      createHookContext("run-lookup"),
    );
    assert.equal(harness.shared.runs.has("run-lookup"), true);
    await waitFor(() => lookupStarted, "initial task lookup");
    registrations.get("subagent_progress")(
      createProgressEvent("ended", "run-lookup"),
      createHookContext("run-lookup"),
    );
    gate.resolve({ status: "succeeded", terminalSummary: "Finished" });

    await waitFor(() => harness.web.updates.length === 1 && !harness.shared.runs.has("run-lookup"), "terminal update after lookup");
    assert.equal(harness.web.posts.length, 1);
    assert.equal(mainTask(harness.web.updates[0]).status, "complete");
  });

  it("cleans up when secret resolution rejects after the terminal claim", async () => {
    const harness = createHarness({
      config: { channels: { slack: { botToken: "${SLACK_CARD_TOKEN}" } } },
    });
    let resolutions = 0;
    harness.api.resolveConfiguredSecretInputWithFallback = async () => {
      resolutions += 1;
      if (resolutions === 1) return { value: TOKEN, source: "secretRef" };
      throw new Error("secret backend unavailable");
    };
    const runId = await spawn(harness);

    await handleEnded(
      harness.api,
      harness.shared,
      createEndedEvent(runId),
      createHookContext(runId),
    );

    assert.equal(resolutions, 2);
    assert.equal(harness.shared.runs.has(runId), false);
    assert.equal(harness.web.updates.length, 0);
    assert.ok(harness.logs.warn.some((message) => message.includes("secret backend unavailable")));
  });
});

describe("tool updates and presentation safety", () => {
  it("serializes concurrent tool mutations and renders exact snapshots", async () => {
    const firstUpdate = deferred();
    const web = createFakeWeb({
      onUpdate(_params, number) {
        return number === 1 ? firstUpdate.promise : { ok: true };
      },
    });
    const harness = createHarness({ web, toolTasks: true });
    const runId = await spawn(harness);

    const a = handleAfterToolCall(harness.api, harness.shared, {
      runId, toolName: "exec", failed: false,
    });
    await waitFor(() => web.updates.length === 1, "first tool update");
    const b = handleAfterToolCall(harness.api, harness.shared, {
      runId, toolName: "read", failed: false,
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(web.updates.length, 1);

    firstUpdate.resolve({ ok: true });
    await Promise.all([a, b]);

    assert.deepEqual(plan(web.updates[0]).tasks.map((task) => task.task_id), [runId, "tool-1"]);
    assert.deepEqual(plan(web.updates[1]).tasks.map((task) => task.task_id), [runId, "tool-1", "tool-2"]);
  });

  it("robustness: direct handler ignores unexpected tool arguments and external call IDs", async () => {
    const harness = createHarness({ toolTasks: true });
    const runId = await spawn(harness);
    const secrets = [
      "xoxb-super-secret",
      "Bearer top-secret",
      "https://user:pass@example.test/path",
      "sk-live-secret",
      "AWS_SECRET_ACCESS_KEY=aws-secret",
      "postgres://admin:db-password@db.example.test/app",
      "-----BEGIN PRIVATE KEY-----private-material",
    ];
    const hostileEvents = [
      {
        toolName: "exec",
        toolCallId: `call-${secrets[0]}`,
        params: {
          cmd: `curl -H 'Authorization: ${secrets[1]}' ${secrets[2]} --token ${secrets[0]}`,
          env: { SECRET: secrets[4] },
        },
      },
      {
        toolName: "search",
        toolCallId: `call-${secrets[3]}`,
        params: { query: secrets.join(" "), headers: { authorization: secrets[1] } },
      },
      {
        toolName: "read",
        toolCallId: `call-${secrets[5]}`,
        params: { path: `/tmp/${secrets[0]}.txt`, url: secrets[5] },
      },
      {
        toolName: "custom",
        toolCallId: `call-${secrets[6]}`,
        params: { api_key: secrets[3], note: secrets[6], enabled: true, count: 42 },
      },
    ];

    for (const [index, event] of hostileEvents.entries()) {
      await handleAfterToolCall(
        harness.api,
        harness.shared,
        { runId, ...event, failed: false, durationMs: index === 0 ? 5_200 : undefined },
      );
    }

    const rendered = JSON.stringify(harness.web.updates.at(-1));
    for (const secret of [...secrets, "top-secret", "user:pass", "db-password", "private-material"]) {
      assert.equal(rendered.includes(secret), false, secret);
    }
    const toolRows = plan(harness.web.updates.at(-1)).tasks.filter((task) => String(task.task_id).startsWith("tool-"));
    assert.deepEqual(toolRows.map((task) => task.task_id), ["tool-1", "tool-2", "tool-3", "tool-4"]);
    assert.deepEqual(toolRows.map((task) => task.title), ["exec (5s)", "search", "read file", "custom"]);

    for (let index = 0; index < 20; index += 1) {
      await handleAfterToolCall(
        harness.api,
        harness.shared,
        {
          runId,
          toolName: "custom",
          failed: false,
          toolCallId: `external-${index}-${secrets[index % secrets.length]}`,
          params: { payload: secrets[index % secrets.length] },
        },
      );
    }

    const tracked = harness.shared.runs.get(runId);
    assert.equal(Object.hasOwn(tracked, "toolTaskIdsByCallId"), false);
    assert.equal(tracked.toolCalls.length, 10);
    assert.equal(tracked.nextToolTaskSequence, 24);
    const trackedState = JSON.stringify(tracked);
    for (const secret of [...secrets, "top-secret", "user:pass", "db-password", "private-material"]) {
      assert.equal(trackedState.includes(secret), false, `retained ${secret}`);
    }
  });

  it("bounds and single-lines hostile tool names before logging, retaining, or rendering", async () => {
    const harness = createHarness({ toolTasks: true });
    const runId = await spawn(harness, { runId: "run-hostile-tool-name" });
    const registrations = new Map();
    harness.api.on = (name, handler) => registrations.set(name, handler);
    registerSlackSubagentCardHandlers(harness.api, harness.shared);

    const hostileToolName = `hostile-tool\nFORGED level=error ${"x".repeat(10_000)}`;
    const unexpectedSecret = "unexpected-enumerable-private-value";
    let unexpectedGetterReads = 0;
    const hostEvent = {
      toolName: hostileToolName,
      params: { secret: unexpectedSecret },
      result: { secret: unexpectedSecret },
      toolCallId: unexpectedSecret,
      error: `raw failure ${unexpectedSecret}`,
      runId,
      durationMs: Number.MAX_VALUE,
    };
    Object.defineProperty(hostEvent, "unexpectedEnumerable", {
      enumerable: true,
      get() {
        unexpectedGetterReads += 1;
        throw new Error("unexpected enumerable field was captured");
      },
    });
    const result = registrations.get("after_tool_call")(
      hostEvent,
      { runId },
    );

    assert.equal(result, undefined);
    await waitFor(() => harness.web.updates.length === 1, "bounded hostile tool update");

    const logLine = harness.logs.info.find((message) => message.includes("after_tool_call fired"));
    assert.ok(logLine);
    assert.equal(unexpectedGetterReads, 0);
    assert.equal(logLine.includes("\n"), false);
    assert.equal(logLine.includes(unexpectedSecret), false);
    const loggedName = /toolName=(.*) status=error$/.exec(logLine)?.[1];
    assert.ok(loggedName);
    assert.ok(loggedName.length <= 96);

    const retained = harness.shared.runs.get(runId).toolCalls[0];
    assert.equal(retained.name, loggedName);
    assert.equal(retained.name.includes("\n"), false);
    assert.ok(retained.name.length <= 96);
    assert.equal(retained.status, "error");
    assert.equal(retained.durationMs, 60 * 60 * 1_000);
    assert.equal(JSON.stringify(retained).includes(hostileToolName), false);
    assert.equal(JSON.stringify(retained).includes(unexpectedSecret), false);
    assert.deepEqual(Object.keys(retained).sort(), ["detail", "durationMs", "id", "name", "status"]);

    const toolRow = plan(harness.web.updates[0]).tasks.find((task) => task.task_id === "tool-1");
    assert.equal(toolRow.title.includes("\n"), false);
    assert.ok(toolRow.title.length <= 96);
    assert.equal(toolRow.status, "error");
    assert.equal(JSON.stringify(harness.web.updates[0]).includes(hostileToolName), false);
    assert.equal(JSON.stringify(harness.web.updates[0]).includes(unexpectedSecret), false);
  });

  it("keeps tool rows opt-in and honors the host preview kill switch", async () => {
    for (const options of [
      {},
      {
        toolTasks: true,
        config: { channels: { slack: { botToken: TOKEN, streaming: { preview: { toolProgress: false } } } } },
      },
    ]) {
      const harness = createHarness(options);
      const runId = await spawn(harness);
      await handleAfterToolCall(harness.api, harness.shared, { runId, toolName: "read", failed: false });
      assert.equal(harness.web.updates.length, 0);
    }
  });

  it("does not retry failed Slack calls in plugin code", async () => {
    let attempts = 0;
    const web = createFakeWeb({
      onPost() {
        attempts += 1;
        throw Object.assign(new Error("rate_limited"), { code: "slack_webapi_rate_limited_error" });
      },
    });
    const harness = createHarness({ web });
    await assert.rejects(() => spawn(harness));
    assert.equal(attempts, 1);
    assert.equal(harness.shared.runs.size, 0);
  });

  it("drops a reservation when Slack returns no message timestamp", async () => {
    const harness = createHarness({ web: createFakeWeb({ onPost: () => ({ ok: true }) }) });
    const runId = await spawn(harness);
    assert.equal(harness.shared.runs.has(runId), false);
  });
});

describe("Slack account and client isolation", () => {
  it("uses configured defaultAccount when the event omits accountId", async () => {
    const harness = createHarness({
      config: {
        channels: {
          slack: {
            defaultAccount: "work",
            accounts: { work: { botToken: "xoxb-work" }, other: { botToken: "xoxb-other" } },
          },
        },
      },
    });
    await spawn(harness);
    assert.deepEqual(harness.tokens, ["xoxb-work"]);
  });

  it("does not fall through from a named account to default or env credentials", async () => {
    await withEnv({ SLACK_BOT_TOKEN: "xoxb-env" }, async () => {
      const harness = createHarness({
        config: {
          channels: {
            slack: {
              botToken: "xoxb-root",
              accounts: { default: { botToken: "xoxb-default" }, work: { botToken: undefined } },
            },
          },
        },
      });
      await spawn(harness, { requester: { accountId: "work" } });
      assert.deepEqual(harness.tokens, []);
      assert.equal(harness.web.posts.length, 0);
    });
  });

  it("allows a named account to inherit the channel-level bot token", async () => {
    const harness = createHarness({
      config: { channels: { slack: { botToken: "xoxb-root", accounts: { work: {} } } } },
    });
    await spawn(harness, { requester: { accountId: "work" } });
    assert.deepEqual(harness.tokens, ["xoxb-root"]);
  });

  it("uses SLACK_BOT_TOKEN only for the effective default account", async () => {
    await withEnv({ SLACK_BOT_TOKEN: "xoxb-env" }, async () => {
      const harness = createHarness({ config: {} });
      await spawn(harness);
      assert.deepEqual(harness.tokens, ["xoxb-env"]);
    });
  });

  it("does not read credentials from the legacy local-config escape hatch", async () => {
    const directory = await mkdtemp(join(tmpdir(), "slack-card-test-"));
    const configPath = join(directory, "openclaw.json");
    await writeFile(configPath, JSON.stringify({ channels: { slack: { botToken: "xoxb-disk" } } }));
    try {
      await withEnv({
        SLACK_BOT_TOKEN: undefined,
        OPENCLAW_SLACK_SUBAGENT_CARD_CONFIG_PATH: configPath,
      }, async () => {
        const harness = createHarness({ config: {} });
        await spawn(harness);
        assert.deepEqual(harness.tokens, []);
        assert.equal(harness.web.posts.length, 0);
      });
      assert.match(await readFile(configPath, "utf8"), /xoxb-disk/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("scopes DM-channel caching to each Slack client", async () => {
    const webA = createFakeWeb({ onOpen: () => ({ channel: { id: "DA" } }) });
    const webB = createFakeWeb({ onOpen: () => ({ channel: { id: "DB" } }) });
    const config = {
      channels: {
        slack: {
          accounts: {
            a: { botToken: "xoxb-a" },
            b: { botToken: "xoxb-b" },
          },
        },
      },
    };
    const harness = createHarness({
      config,
      sessionKey: DM_SESSION_KEY,
      clientForToken: (token) => token === "xoxb-a" ? webA : webB,
    });

    await spawn(harness, { runId: "run-a1", sessionKey: DM_SESSION_KEY, requester: { accountId: "a" } });
    await spawn(harness, { runId: "run-a2", sessionKey: DM_SESSION_KEY, requester: { accountId: "a" } });
    await spawn(harness, { runId: "run-b1", sessionKey: DM_SESSION_KEY, requester: { accountId: "b" } });

    assert.equal(webA.opens.length, 1);
    assert.equal(webB.opens.length, 1);
    assert.equal(webA.posts[0].channel, "DA");
    assert.equal(webB.posts[0].channel, "DB");
  });

  it("constructs Slack clients with zero SDK retries and finite timeouts", () => {
    const web = createBoundedSlackWebClient("xoxb-test");
    assert.equal(web.retryConfig.retries, 0);
    assert.equal(web.axios.defaults.timeout, 10_000);
    assert.equal(web.rejectRateLimitedCalls, true);
  });
});
