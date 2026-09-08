"use client";

import {
  defaultDrivingSpeedKph,
  deterministicActorCatalog,
  editorMapVersionId,
  editorSourceMapId,
  type EditorController,
  type EditorDocument,
} from "@simforge-oss/editor";
import { Bot, CornerDownLeft, Plus, Wrench, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "../../../../lib/utils";

/**
 * HOST SLOT — assistant / copilot. Manifest section 11.
 *
 * The assistant runs server-side against the local map bundle and streams
 * `/api/simforge/assistant/stream`. Its edits land through `controller` and
 * `document` — the same mutation path a human click takes — so they are
 * undoable, lane-snapped and validated like any other placement.
 *
 * Road selection and the located place are assistant conversation state
 * (they have no editor-level counterpart) and round-trip to the server with
 * every turn. Nothing is written when no AI model is configured: the server
 * refuses with the reason and this panel shows it.
 */

const STREAM_URL = "/api/simforge/assistant/stream";
const SETTINGS_URL = "/dashboard/settings/ai-providers";

type ToolTrace = {
  name: string;
  input?: unknown;
  result?: unknown;
  applied?: string[];
};

type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  tools?: ToolTrace[];
};

/** The subset of the server's `EditorToolUiAction` this editor can act on. */
type UiAction =
  | {
      type: "add_actor";
      label: string;
      input: { actorToolId: "car"; wantsSensors?: boolean; roadId: string; fraction: number };
      scenePose: { x: number; y: number; z: number; headingRad: number } | null;
      autoApply?: boolean;
    }
  | { type: "remove_actor"; label: string; actorId: string; autoApply?: boolean }
  | { type: "update_actor_spawn_fraction"; label: string; actorId: string; fraction: number; autoApply?: boolean }
  | { type: "set_selected_roads"; label: string; roadIds: string[]; autoApply?: boolean }
  | { type: "select_location"; label: string; location: unknown; autoApply?: boolean }
  | { type: "inspect_selected_roads"; label: string; autoApply?: boolean }
  | { type: "manage_scenario"; label: string; autoApply?: boolean };

type StreamingState = { active: boolean; thinking: string; text: string; tools: ToolTrace[] };
const IDLE: StreamingState = { active: false, thinking: "", text: "", tools: [] };

type AssistantSelection = { selectedRoadIds: string[]; selectedLocation: unknown | null };

function parseSseFrame(frame: string): { event: string; data: unknown } | null {
  let event = "";
  let data = "";
  for (const line of frame.split("\n")) {
    if (line.startsWith("event: ")) event = line.slice(7).trim();
    else if (line.startsWith("data: ")) data = line.slice(6).trim();
  }
  if (!event || !data) return null;
  try {
    return { event, data: JSON.parse(data) };
  } catch {
    return null;
  }
}

/**
 * Apply one server action to the editor. Returns a one-line record of what
 * happened for the tool trace; the editor's undo stack owns the rest.
 */
function applyUiAction(
  action: UiAction,
  controller: EditorController,
  document: EditorDocument,
  selection: AssistantSelection,
): string {
  switch (action.type) {
    case "add_actor": {
      if (!action.scenePose) {
        return `Could not place on road ${action.input.roadId}: the map bundle has no lane centerline there.`;
      }
      // Same recipe as controller placement: allocate an id for the vehicle
      // kind, then derive the stable appearance from that id.
      const placeholderId = document.allocateActorId(
        deterministicActorCatalog("vehicle", document.routeSeed, "assistant"),
      );
      const catalogId = deterministicActorCatalog("vehicle", document.routeSeed, placeholderId);
      const pose = action.scenePose;
      const drop = controller.resolveDrop(catalogId, pose.x, pose.z, {
        headingRad: pose.headingRad,
        fallbackY: pose.y,
      });
      if (drop.outcome !== "snapped" || !drop.laneRef) {
        return `Road ${action.input.roadId} at ${action.input.fraction.toFixed(2)} is not on a usable driving lane; nothing placed.`;
      }
      const speedKph = defaultDrivingSpeedKph(catalogId);
      const [id] = document.add([
        {
          id: placeholderId,
          catalogId,
          x: drop.x,
          y: drop.y,
          z: drop.z,
          headingRad: drop.headingRad,
          laneRef: drop.laneRef,
          ...(speedKph === null ? {} : { initialSpeedKph: speedKph }),
        },
      ]);
      controller.setSelection(id ? [id] : []);
      return `Placed ${action.input.wantsSensors ? "a sensor car" : "a car"} (${id}) on road ${action.input.roadId}.`;
    }
    case "remove_actor": {
      if (!document.actor(action.actorId)) return `Actor ${action.actorId} is not in this scenario.`;
      document.remove([action.actorId]);
      return `Removed ${action.actorId}.`;
    }
    case "update_actor_spawn_fraction":
      return `Moving ${action.actorId} along its road is not supported here; drag it on the map instead.`;
    case "set_selected_roads":
      selection.selectedRoadIds = action.roadIds;
      return `Selected ${action.roadIds.length} road${action.roadIds.length === 1 ? "" : "s"} for the assistant.`;
    case "select_location":
      selection.selectedLocation = action.location;
      return `Using ${action.label} as the current location.`;
    case "inspect_selected_roads":
      return "Inspected the selected roads.";
    case "manage_scenario":
      return "Scenario management from the assistant is not available in this editor; use the scenario rail.";
  }
}

export function AssistantChatSlot({
  controller,
  document,
  documentId = null,
  datasetId = null,
}: {
  controller: EditorController | null;
  document: EditorDocument | null;
  documentId?: string | null;
  datasetId?: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [streaming, setStreaming] = useState<StreamingState>(IDLE);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; configuration: boolean } | null>(null);
  const selectionRef = useRef<AssistantSelection>({ selectedRoadIds: [], selectedLocation: null });
  const scrollRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => () => abortRef.current?.abort(), []);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, streaming.text, streaming.tools.length]);

  const resetThread = useCallback(() => {
    abortRef.current?.abort();
    setMessages([]);
    setStreaming(IDLE);
    setError(null);
    setBusy(false);
    selectionRef.current = { selectedRoadIds: [], selectedLocation: null };
  }, []);

  const submit = useCallback(async () => {
    const text = input.trim();
    if (!text || busy || !controller || !document) return;

    const userMessage: ChatMessage = { id: crypto.randomUUID(), role: "user", content: text };
    const history = [...messages, userMessage];
    setMessages(history);
    setInput("");
    setBusy(true);
    setError(null);
    setStreaming({ ...IDLE, active: true });

    const selection = selectionRef.current;
    const editorContext = {
      mapAssetId: editorSourceMapId(document.map),
      mapVersionId: editorMapVersionId(document.map),
      mapLabel: document.map.label,
      mapName: document.map.label,
      selectedRoadIds: selection.selectedRoadIds,
      selectedLocation: selection.selectedLocation,
      actors: document.actors.map((actor) => ({
        id: actor.id,
        label: actor.label ?? actor.catalogId,
        kind: actor.kind,
        role: "traffic",
        roadId: actor.laneRef ? String(actor.laneRef.roadId) : null,
        fraction: null,
      })),
      scenarioId: documentId,
      datasetId,
      durationSeconds: document.data.choreography.clipSeconds,
    };

    const abort = new AbortController();
    abortRef.current = abort;
    let accText = "";
    let accThinking = "";
    let accTools: ToolTrace[] = [];
    let streamError: string | null = null;

    try {
      const response = await fetch(STREAM_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          messages: history.map(({ role, content }) => ({ role, content })),
          editorContext,
        }),
        signal: abort.signal,
      });
      if (!response.ok || !response.body) {
        const body = (await response.json().catch(() => null)) as { message?: string; error?: string } | null;
        setError({
          message: body?.message ?? `The assistant request failed (${response.status}).`,
          configuration: response.status === 503,
        });
        setMessages((previous) => previous.filter((message) => message.id !== userMessage.id));
        setInput(text);
        return;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let finished = false;
      while (!finished) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const frames = buffer.split("\n\n");
        buffer = frames.pop() ?? "";
        for (const frame of frames) {
          const parsed = parseSseFrame(frame);
          if (!parsed) continue;
          const payload = parsed.data as Record<string, unknown>;
          switch (parsed.event) {
            case "delta":
              accText += typeof payload.text === "string" ? payload.text : "";
              setStreaming((state) => ({ ...state, text: accText }));
              break;
            case "thinking":
              accThinking += typeof payload.text === "string" ? payload.text : "";
              setStreaming((state) => ({ ...state, thinking: accThinking }));
              break;
            case "tool_start":
              accTools = [...accTools, { name: String(payload.name), input: payload.input }];
              setStreaming((state) => ({ ...state, tools: accTools }));
              break;
            case "tool_end": {
              const actions = Array.isArray(payload.uiActions) ? (payload.uiActions as UiAction[]) : [];
              const applied = actions
                .filter((action) => action.autoApply)
                .map((action) => applyUiAction(action, controller, document, selection));
              let pending = -1;
              for (let index = accTools.length - 1; index >= 0; index -= 1) {
                const tool = accTools[index];
                if (tool && tool.name === payload.name && tool.result === undefined) {
                  pending = index;
                  break;
                }
              }
              const trace: ToolTrace = { name: String(payload.name), result: payload.result, applied };
              accTools =
                pending >= 0
                  ? accTools.map((tool, index) => (index === pending ? { ...tool, ...trace } : tool))
                  : [...accTools, trace];
              setStreaming((state) => ({ ...state, tools: accTools }));
              break;
            }
            case "error":
              streamError = typeof payload.message === "string" ? payload.message : "The assistant failed.";
              break;
            case "done":
              finished = true;
              break;
          }
        }
      }

      if (accText || accTools.length > 0) {
        setMessages((previous) => [
          ...previous,
          {
            id: crypto.randomUUID(),
            role: "assistant",
            content: accText,
            tools: accTools.length > 0 ? accTools : undefined,
          },
        ]);
      }
      if (streamError) setError({ message: streamError, configuration: false });
    } catch (reason) {
      if (!(reason instanceof DOMException && reason.name === "AbortError")) {
        setError({
          message: reason instanceof Error ? reason.message : "The assistant request failed.",
          configuration: false,
        });
      }
    } finally {
      if (abortRef.current === abort) abortRef.current = null;
      setBusy(false);
      setStreaming(IDLE);
    }
  }, [busy, controller, datasetId, document, documentId, input, messages]);

  if (!controller || !document) return null;

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="fixed bottom-24 right-4 z-30 flex items-center gap-2 rounded-full border border-border/60 bg-background/90 px-3 py-2 text-xs font-medium text-foreground shadow-lg backdrop-blur transition-colors hover:bg-muted"
        aria-label="Open the scene assistant"
      >
        <Bot className="size-4" aria-hidden="true" />
        Assistant
      </button>
    );
  }

  return (
    <aside
      className="fixed bottom-4 right-4 top-16 z-30 flex w-[380px] max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-xl border border-border/60 bg-background/95 text-foreground shadow-2xl backdrop-blur"
      aria-label="Scene assistant"
    >
      <div className="flex shrink-0 items-center justify-between border-b border-border/40 px-4 py-2">
        <span className="flex items-center gap-2 text-xs font-medium">
          <Bot className="size-4" aria-hidden="true" />
          Scene assistant
        </span>
        <div className="flex items-center gap-1">
          <button
            type="button"
            className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40"
            disabled={busy}
            onClick={resetThread}
          >
            <Plus className="size-3" aria-hidden="true" />
            New
          </button>
          <button
            type="button"
            className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            onClick={() => setOpen(false)}
            aria-label="Close the scene assistant"
          >
            <X className="size-4" aria-hidden="true" />
          </button>
        </div>
      </div>

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
        {messages.length === 0 && !streaming.active ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
            <div className="flex size-10 items-center justify-center rounded-full bg-primary/10">
              <Bot className="size-5 text-primary" aria-hidden="true" />
            </div>
            <div>
              <p className="text-sm font-medium">Scene assistant</p>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                Find places on {document.map.label}, select roads and place cars. Every placement
                goes through the editor, so it snaps to lanes and can be undone.
              </p>
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-2 px-3 py-3">
            {messages.map((message) => (
              <MessageBubble key={message.id} message={message} />
            ))}
            {streaming.active ? (
              <div className="rounded-lg border border-border/40 bg-muted/30 px-3 py-2 text-sm">
                {streaming.thinking ? (
                  <p className="whitespace-pre-wrap text-[11px] text-muted-foreground">{streaming.thinking.trim()}</p>
                ) : null}
                {streaming.tools.length > 0 ? <ToolTraceList tools={streaming.tools} /> : null}
                {streaming.text ? <p className="mt-1 whitespace-pre-wrap">{streaming.text}</p> : null}
              </div>
            ) : null}
          </div>
        )}
        {error ? (
          <div
            role="alert"
            className={cn(
              "mx-3 mb-3 rounded-md border p-3 text-xs",
              error.configuration
                ? "border-amber-500/30 bg-amber-500/10 text-amber-200"
                : "border-red-500/30 bg-red-500/10 text-red-200",
            )}
          >
            {error.message}
            {error.configuration ? (
              <>
                {" "}
                <a href={SETTINGS_URL} className="underline underline-offset-2">
                  Open AI provider settings
                </a>
                .
              </>
            ) : null}
          </div>
        ) : null}
      </div>

      <form
        className="shrink-0 border-t border-border/40 p-3"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <div className="flex items-end gap-2 rounded-xl border border-border/60 bg-muted/20 px-3 py-2">
          <textarea
            className="max-h-[120px] min-h-[20px] flex-1 resize-none bg-transparent text-sm outline-none placeholder:text-muted-foreground/60"
            disabled={busy}
            value={input}
            rows={1}
            placeholder="Find an intersection, select it, add a car…"
            aria-label="Message the scene assistant"
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void submit();
              }
            }}
          />
          <button
            type="submit"
            className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground transition-opacity disabled:opacity-30"
            disabled={busy || !input.trim()}
            aria-label="Send"
          >
            <CornerDownLeft className="size-3.5" aria-hidden="true" />
          </button>
        </div>
        <p className="mt-1.5 text-center text-[10px] text-muted-foreground/50">
          Enter to send · Shift+Enter for a new line
        </p>
      </form>
    </aside>
  );
}

function MessageBubble({ message }: { message: ChatMessage }) {
  const user = message.role === "user";
  return (
    <div className={cn("flex", user ? "justify-end" : "justify-start")}>
      <div
        className={cn(
          "max-w-[92%] rounded-lg px-3 py-2 text-sm",
          user ? "bg-primary text-primary-foreground" : "border border-border/40 bg-muted/30",
        )}
      >
        {message.tools ? <ToolTraceList tools={message.tools} /> : null}
        {message.content ? <p className="whitespace-pre-wrap">{message.content}</p> : null}
      </div>
    </div>
  );
}

function ToolTraceList({ tools }: { tools: ToolTrace[] }) {
  return (
    <ul className="mb-1 space-y-1 text-[11px] text-muted-foreground">
      {tools.map((tool, index) => (
        <li key={`${tool.name}-${index}`}>
          <span className="inline-flex items-center gap-1">
            <Wrench className="size-3" aria-hidden="true" />
            <span className="font-mono">{tool.name}</span>
            {tool.result === undefined ? <span className="animate-pulse">…</span> : null}
          </span>
          {tool.applied?.map((line, lineIndex) => (
            <p key={lineIndex} className="pl-4 text-foreground/80">
              {line}
            </p>
          ))}
        </li>
      ))}
    </ul>
  );
}
