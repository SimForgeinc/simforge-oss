import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { requireScenarioContext } from "@/app/lib/scenario/http";
import { resolveRunDirectory, runEvidenceFile } from "@/app/lib/evaluation/run-directory";

export async function GET(request: Request) {
  const auth = await requireScenarioContext();
  if (auth.response) return auth.response;
  try {
    const query = new URL(request.url).searchParams;
    const root = await resolveRunDirectory(auth.context, query.get("ref") ?? "");
    const path = await runEvidenceFile(root, query.get("file") ?? "");
    const { size } = await stat(path);
    const range = request.headers.get("range");
    let start = 0, end = size - 1;
    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (!match || (!match[1] && !match[2])) return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
      start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
      end = match[1] && match[2] ? Math.min(size - 1, Number(match[2])) : size - 1;
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
    }
    const headers: Record<string, string> = {
      "Content-Type": path.endsWith(".mp4") ? "video/mp4" : path.endsWith(".json") ? "application/json" : "text/plain; charset=utf-8",
      "Content-Length": String(Math.max(0, end - start + 1)), "Accept-Ranges": "bytes", "Cache-Control": "private, no-store",
    };
    if (range) headers["Content-Range"] = `bytes ${start}-${end}/${size}`;
    if (!size) return new Response(null, { headers });
    const stream = createReadStream(path, { start, end });
    return new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array>, { status: range ? 206 : 200, headers });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}
