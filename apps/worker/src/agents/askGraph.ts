import {
  Annotation, END, INTERRUPT, START, StateGraph, interrupt, type BaseCheckpointSaver, type LangGraphRunnableConfig, type StateSnapshot,
} from "@langchain/langgraph";
import type { AskToolCallRecord, ToolApprovalCall, ToolApprovalResolution } from "@digestor/core";
import { createToolApproval, getAskMessage, getToolApproval } from "@digestor/core/server";
import type { ToolCallRequest, ToolMessage } from "../llm/tools.js";
import {
  AskRunError, DECLINED, EDITED, MAX_ASK_STEPS, MAX_CALLS_PER_STEP, MUTATING_TOOLS, NOT_IN_DATA, OUT_OF_STEPS, TOOL_SPECS, loadAskRun, record, runTool,
  type AskDeps, type AskRun, type ToolResult,
} from "./ask.js";

/** The decision the approve node passes on to `tools`, with the calls it covers (the ones on the card). */
export type Approval = ToolApprovalResolution & { ids: string[] };

const keep = <T>(_old: T, next: T): T => next;

/**
 * Serialisable state only, checkpointed per answer (thread id = the assistant message id). The DB, the LLM and the
 * search come from the closures of `buildAskGraph`; the session, transcript and prompt are reloaded per graph run.
 */
export const AskState = Annotation.Root({
  /** The conversation the model sees: history, then its turns and the tool results. */
  messages: Annotation<ToolMessage[]>({ reducer: keep, default: () => [] }),
  /** One chip per tool call (stored on the answer). */
  records: Annotation<AskToolCallRecord[]>({ reducer: keep, default: () => [] }),
  final: Annotation<string | null>({ reducer: keep, default: () => null }),
  /** Model turns so far (at most MAX_ASK_STEPS). */
  steps: Annotation<number>({ reducer: keep, default: () => 0 }),
  /** Changes applied without the bulk confirmation in this answer (R31: at most 3). */
  directChanges: Annotation<number>({ reducer: keep, default: () => 0 }),
  /** Something was written: a failure from here on fails the answer instead of retrying it. */
  wrote: Annotation<boolean>({ reducer: keep, default: () => false }),
  /** The journalist's decision on the current turn's changes, from `approve` to `tools` (null: nothing was asked). */
  approval: Annotation<Approval | null>({ reducer: keep, default: () => null }),
});
export type AskStateValue = typeof AskState.State;

export const threadConfig = (messageId: string) => ({ configurable: { thread_id: messageId }, recursionLimit: 4 * MAX_ASK_STEPS + 4 });

/** The action id an answer is paused on (a graph result or a state snapshot), or null when it isn't paused. */
export function interruptedBy(x: unknown): string | null {
  const interrupts =
    typeof x === "object" && x !== null && "tasks" in x
      ? (x as StateSnapshot).tasks.flatMap((t) => t.interrupts)
      : ((x as Record<string, unknown> | null)?.[INTERRUPT] as { value?: unknown }[] | undefined) ?? [];
  for (const i of interrupts) {
    const id = (i.value as { actionId?: unknown } | undefined)?.actionId;
    if (typeof id === "string") return id;
  }
  return null;
}

type AssistantTurn = Extract<ToolMessage, { role: "assistant" }>;

function lastTurn(state: AskStateValue): AssistantTurn {
  const turn = state.messages.at(-1);
  if (turn?.role !== "assistant") throw new Error("The graph expected the model's turn last");
  return turn;
}

/** The calls of a turn that would change something (calls past the per-turn limit never run). */
const mutatingCalls = (turn: AssistantTurn): ToolCallRequest[] =>
  (turn.toolCalls ?? []).slice(0, MAX_CALLS_PER_STEP).filter((c) => MUTATING_TOOLS.has(c.name));

/** Edited arguments replace the model's, key by key (the card edits times, title or moments, never ids or status). */
function withEdits(call: ToolCallRequest, edits: Map<string, unknown>): ToolCallRequest {
  const edit = edits.get(call.id);
  if (edit === undefined) return call;
  const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
  return { ...call, args: isObject(call.args) && isObject(edit) ? { ...call.args, ...edit } : edit };
}

const threadOf = (config: LangGraphRunnableConfig): string => {
  const id = config.configurable?.thread_id;
  if (typeof id !== "string") throw new Error("Ask graph run without a thread id");
  return id;
};

/**
 * The Ask agent as a LangGraph graph: `START → agent → route`. `route` ends on a final answer, sends a turn with any
 * call in MUTATING_TOOLS to `approve`, and any other turn to `tools`. `approve` validates the changes without
 * writing (plan mode), stores one `tool_approval` action per answer and turn, sets the answer `waiting` and pauses
 * with `interrupt({ actionId })`; resumed with the journalist's decision it goes on to `tools`. `tools` runs every
 * call through `runTool` (validation, `evidence()`, the R31 cap) and returns to `agent`.
 */
export function buildAskGraph(deps: AskDeps, checkpointer: BaseCheckpointSaver) {
  const { db, llm } = deps;
  // One load per answer and graph run: the nodes share it, and a resumed run reads the session as it is now.
  const runs = new Map<string, Promise<AskRun>>();
  const load = (config: LangGraphRunnableConfig): Promise<AskRun> => {
    const messageId = threadOf(config);
    let run = runs.get(messageId);
    if (!run) {
      run = (async () => {
        const msg = await getAskMessage(db, messageId);
        if (!msg) throw new Error(`Ask message not found: ${messageId}`);
        return loadAskRun(deps, msg);
      })();
      run.catch(() => runs.delete(messageId));
      runs.set(messageId, run);
    }
    return run;
  };

  async function agent(state: AskStateValue, config: LangGraphRunnableConfig): Promise<typeof AskState.Update> {
    const steps = state.steps + 1;
    try {
      const { system } = await load(config);
      const res = await llm.step({ system, messages: state.messages, tools: TOOL_SPECS });
      if (res.toolCalls.length === 0) return { steps, final: res.text.trim() || NOT_IN_DATA };
      if (steps >= MAX_ASK_STEPS) return { steps, final: OUT_OF_STEPS }; // the model could never read these results
      return { steps, messages: [...state.messages, { role: "assistant", text: res.text, toolCalls: res.toolCalls, raw: res.raw }] };
    } catch (err) {
      throw new AskRunError(err, state.records, state.wrote);
    }
  }

  function route(state: AskStateValue): typeof END | "approve" | "tools" {
    if (state.final !== null) return END;
    return mutatingCalls(lastTurn(state)).length > 0 ? "approve" : "tools";
  }

  async function approve(state: AskStateValue, config: LangGraphRunnableConfig): Promise<typeof AskState.Update> {
    const messageId = threadOf(config);
    let action = await getToolApproval(db, messageId, state.steps);
    if (!action) {
      // Validate each change as the tools would, in order and without writing, so the card shows what will happen
      // (snapped times) and asks nothing for a call that will only return an error (or wait for the bulk confirmation).
      const { ctx } = await load(config);
      const plan = { ...ctx, mode: "plan" as const, directChanges: state.directChanges, wrote: false, callWrote: false, approved: new Set<string>() };
      const calls: ToolApprovalCall[] = [];
      for (const call of mutatingCalls(lastTurn(state))) {
        plan.callId = call.id;
        const out: ToolResult & { ok: boolean } = await runTool(plan, call);
        if (!out.ok || !out.summary) continue;
        calls.push({
          id: call.id, name: call.name, args: call.args, summary: out.summary,
          ...(out.range ? { range: out.range } : {}),
          ...(out.moments ? { moments: out.moments } : {}),
        });
      }
      if (calls.length === 0) return { approval: null };
      action = await createToolApproval(db, messageId, { step: state.steps, calls });
    }
    // Paused here; on resume the node runs again from the top, finds the action and `interrupt` returns the decision.
    const decision = interrupt<{ actionId: string }, ToolApprovalResolution>({ actionId: action.id });
    const ids = ((action.payload as { calls?: { id: string }[] }).calls ?? []).map((c) => c.id);
    return { approval: { decision: decision.decision, ...(decision.edits ? { edits: decision.edits } : {}), ids } };
  }

  async function tools(state: AskStateValue, config: LangGraphRunnableConfig): Promise<typeof AskState.Update> {
    const records = [...state.records];
    const messages = [...state.messages];
    let wrote = state.wrote;
    try {
      const { ctx } = await load(config);
      const { approval } = state;
      const asked = new Set(approval?.ids ?? []);
      ctx.mode = "apply";
      ctx.directChanges = state.directChanges;
      ctx.wrote = state.wrote;
      ctx.approved = approval && approval.decision !== "reject" ? asked : new Set();
      const edits = new Map(approval?.decision === "edit" ? (approval.edits ?? []).map((e) => [e.id, e.args] as const) : []);
      for (const [i, asSent] of (lastTurn(state).toolCalls ?? []).entries()) {
        const call = withEdits(asSent, edits);
        ctx.callWrote = false;
        ctx.callId = call.id;
        let out: ToolResult & { ok: boolean };
        try {
          if (i >= MAX_CALLS_PER_STEP) out = { text: `Error: at most ${MAX_CALLS_PER_STEP} tool calls per turn.`, ok: false };
          else if (approval?.decision === "reject" && asked.has(call.id)) out = { text: DECLINED, ok: false };
          else {
            out = await runTool(ctx, call);
            if (out.ok && call !== asSent) out = { ...out, text: out.text + EDITED };
          }
        } catch (err) {
          // It may have changed something before failing: keep a chip so the user can check.
          if (ctx.callWrote) records.push(record(call, { text: "Failed partway; check your clips and selections.", ok: false }));
          throw err;
        } finally {
          wrote = ctx.wrote;
        }
        records.push(record(call, out));
        messages.push({ role: "tool", toolCallId: call.id, content: out.text });
      }
      return { messages, records, directChanges: ctx.directChanges, wrote, approval: null };
    } catch (err) {
      throw err instanceof AskRunError ? err : new AskRunError(err, records, wrote);
    }
  }

  return new StateGraph(AskState)
    .addNode("agent", agent)
    .addNode("approve", approve)
    .addNode("tools", tools)
    .addEdge(START, "agent")
    .addConditionalEdges("agent", route, { approve: "approve", tools: "tools", [END]: END })
    .addEdge("approve", "tools")
    .addEdge("tools", "agent")
    .compile({ checkpointer });
}

export type AskGraph = ReturnType<typeof buildAskGraph>;
/** A first run's state, a `Command({ resume })`, or null to continue from the last checkpoint. */
export type AskGraphInput = Parameters<AskGraph["invoke"]>[0];
