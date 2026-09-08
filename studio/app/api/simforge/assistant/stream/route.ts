import { NextRequest, NextResponse } from "next/server";
import { requireRouteSession } from "@/app/lib/auth/route-session";
import { MapAccessError } from "@/app/lib/cloud/access";
import { getAppContext } from "@/app/lib/db/app-context";
import { getNativeMapBundle, NativeMapBundleError } from "@/app/lib/editor-map/native-map-bundle";
import {
  streamEditorAssistant,
  type AssistantMessageParam,
  type EditorAssistantContext,
} from "@/app/lib/llm/editor-assistant";
import { assistantAvailability, AssistantUnavailableError } from "@/app/lib/llm/langchain-support";

export const maxDuration = 180;

const SSE_HEADERS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache",
  Connection: "keep-alive",
};

/**
 * Editor assistant turn as server-sent events.
 *
 * Events: `thinking` {text}, `delta` {text}, `tool_start` {name,input},
 * `tool_end` {name,result,uiActions}, `error` {message}, `done` {}.
 * A request that cannot start at all (no configured model, bad context, a
 * map this installation cannot read) is a JSON error status, never a stream
 * that pretends to answer.
 */
export async function POST(req: NextRequest) {
  const auth = await requireRouteSession(req);
  if (!auth.ok) return auth.response;

  const body = (await req.json().catch(() => null)) as {
    messages?: AssistantMessageParam[];
    editorContext?: EditorAssistantContext;
  } | null;
  if (!body || !Array.isArray(body.messages)) {
    return NextResponse.json({ error: "invalid_assistant_request" }, { status: 400 });
  }
  if (!body.editorContext?.mapAssetId || !body.editorContext.mapVersionId) {
    return NextResponse.json(
      {
        error: "assistant_context_missing_map",
        message: "Assistant context is missing the map asset and published map version.",
      },
      { status: 400 },
    );
  }

  const availability = await assistantAvailability();
  if (!availability.available) {
    return NextResponse.json(
      { error: "assistant_unavailable", message: availability.reason },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }

  const messages = body.messages;
  const editorContext: EditorAssistantContext = {
    ...body.editorContext,
    appContext: getAppContext(auth.session),
  };

  let bundle;
  try {
    bundle = await getNativeMapBundle({
      mapAssetId: editorContext.mapAssetId,
      mapVersionId: editorContext.mapVersionId,
    });
  } catch (error) {
    if (error instanceof NativeMapBundleError) {
      const status = error.code === "map_member_invalid" ? 502 : 404;
      return NextResponse.json({ error: error.code, message: error.message }, { status });
    }
    if (error instanceof MapAccessError) {
      const status = error.name === "NotAuthorized" ? 403 : error.name === "NotFound" ? 404 : 502;
      return NextResponse.json({ error: error.code, message: error.message }, { status });
    }
    throw error;
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const enqueue = (eventName: string, payload: unknown) => {
        controller.enqueue(
          encoder.encode(`event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`),
        );
      };

      try {
        enqueue("thinking", { text: "Running assistant..." });
        await streamEditorAssistant(messages, editorContext, {
          onTextDelta: (text) => enqueue("delta", { text }),
          onToolStart: (trace) => {
            enqueue("thinking", { text: `\nCalling ${trace.name}...` });
            enqueue("tool_start", { name: trace.name, input: trace.input });
          },
          onToolEnd: (trace) => {
            enqueue("thinking", { text: `\nFinished ${trace.name}.` });
            enqueue("tool_end", {
              name: trace.name,
              result: trace.result,
              uiActions: trace.uiActions ?? [],
            });
          },
        }, { bundle });
      } catch (error) {
        console.error("scenario assistant stream error:", error);
        enqueue("error", {
          message:
            error instanceof AssistantUnavailableError
              ? error.message
              : error instanceof Error
                ? `The assistant request failed: ${error.message}`
                : "The assistant request failed.",
        });
      } finally {
        enqueue("done", {});
        controller.close();
      }
    },
  });

  return new Response(stream, { headers: SSE_HEADERS });
}
