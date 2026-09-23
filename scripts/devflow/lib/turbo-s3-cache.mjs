// A turbo remote cache backed directly by S3, served in-process on loopback
// for the duration of one `verify`. No hosted cache service: turbo talks to
// 127.0.0.1, this proxy talks to S3 with the caller's own AWS credentials.
// Implements the subset of the turbo v8 artifacts API turbo 2 uses.
import { createHash, createHmac } from "node:crypto";
import { createServer } from "node:http";
import { request } from "node:https";
import { trySh } from "./util.mjs";

function loadCredentials(profile) {
  if (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) {
    return {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      sessionToken: process.env.AWS_SESSION_TOKEN || undefined,
    };
  }
  const args = ["configure", "export-credentials", "--format", "process"];
  if (profile) args.push("--profile", profile);
  const out = trySh("aws", args, { timeout: 15_000 });
  if (!out) return null;
  const parsed = JSON.parse(out);
  return { accessKeyId: parsed.AccessKeyId, secretAccessKey: parsed.SecretAccessKey, sessionToken: parsed.SessionToken };
}

const hmac = (key, data) => createHmac("sha256", key).update(data).digest();
const sha256hex = (data) => createHash("sha256").update(data).digest("hex");

function signedS3Request({ method, bucket, region, key, creds, body }) {
  const host = `${bucket}.s3.${region}.amazonaws.com`;
  const path = `/${key.split("/").map(encodeURIComponent).join("/")}`;
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const date = amzDate.slice(0, 8);
  const payloadHash = body ? sha256hex(body) : "UNSIGNED-PAYLOAD";
  const headers = { host, "x-amz-content-sha256": payloadHash, "x-amz-date": amzDate };
  if (creds.sessionToken) headers["x-amz-security-token"] = creds.sessionToken;
  if (body) headers["content-length"] = String(body.length);
  const signedNames = Object.keys(headers).sort();
  const canonicalHeaders = signedNames.map((n) => `${n}:${headers[n]}\n`).join("");
  const canonical = `${method}\n${path}\n\n${canonicalHeaders}\n${signedNames.join(";")}\n${payloadHash}`;
  const scope = `${date}/${region}/s3/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256hex(canonical)].join("\n");
  let k = hmac(`AWS4${creds.secretAccessKey}`, date);
  k = hmac(k, region);
  k = hmac(k, "s3");
  k = hmac(k, "aws4_request");
  const signature = createHmac("sha256", k).update(toSign).digest("hex");
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${creds.accessKeyId}/${scope}, SignedHeaders=${signedNames.join(";")}, Signature=${signature}`;
  return { host, path, headers };
}

function s3(method, opts) {
  const { host, path, headers } = signedS3Request({ method, ...opts });
  return new Promise((resolve, reject) => {
    const req = request({ host, path, method, headers, timeout: 60_000 }, (res) => resolve(res));
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("s3 timeout")));
    req.end(opts.body);
  });
}

const readBody = (stream) =>
  new Promise((resolve, reject) => {
    const chunks = [];
    stream.on("data", (c) => chunks.push(c));
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });

/**
 * Starts the proxy. Resolves { url, token, team, close, stats } or null when no
 * AWS credentials are available (verify then runs with the local cache only).
 */
export async function startTurboS3Cache({ bucket, region, prefix = "turbo/", profile, readOnly = false }) {
  const creds = loadCredentials(profile);
  if (!creds?.accessKeyId) return null;
  const stats = { hits: 0, misses: 0, puts: 0, errors: 0 };
  const keyFor = (hash) => `${prefix}${hash}`;
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://localhost");
      const match = url.pathname.match(/^\/v8\/artifacts\/([0-9a-zA-Z._-]+)$/);
      if (url.pathname === "/v8/artifacts/status") {
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ status: "enabled" }));
      } else if (url.pathname === "/v8/artifacts/events") {
        await readBody(req);
        res.writeHead(200).end("{}");
      } else if (match && (req.method === "GET" || req.method === "HEAD")) {
        const upstream = await s3(req.method, { bucket, region, key: keyFor(match[1]), creds });
        if (upstream.statusCode === 200) {
          if (req.method === "GET") stats.hits += 1;
          res.writeHead(200, {
            "content-type": "application/octet-stream",
            ...(upstream.headers["content-length"] ? { "content-length": upstream.headers["content-length"] } : {}),
            ...(upstream.headers["x-amz-meta-duration"] ? { "x-artifact-duration": upstream.headers["x-amz-meta-duration"] } : {}),
          });
          upstream.pipe(res);
        } else {
          upstream.resume();
          if (req.method === "GET") stats.misses += 1;
          res.writeHead(404).end();
        }
      } else if (match && req.method === "PUT") {
        const body = await readBody(req);
        if (readOnly) {
          res.writeHead(202, { "content-type": "application/json" }).end("{}");
          return;
        }
        const upstream = await s3("PUT", { bucket, region, key: keyFor(match[1]), creds, body });
        upstream.resume();
        if (upstream.statusCode === 200) stats.puts += 1;
        else stats.errors += 1;
        res.writeHead(upstream.statusCode === 200 ? 202 : 500, { "content-type": "application/json" }).end("{}");
      } else {
        await readBody(req);
        res.writeHead(404).end();
      }
    } catch {
      stats.errors += 1;
      if (!res.headersSent) res.writeHead(404);
      res.end();
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    token: "devflow-local",
    team: "devflow",
    stats,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
