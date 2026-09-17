import { createServer } from "node:http";
import { Pool } from "pg";
import { createBackendVerifier } from "./backend-verifier.mjs";
const required = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error("Set " + name);
  return value;
};
// These are YOUR backend's trusted settings, supplied by PCBJam after approval.
// Never derive them from JWT claims, request headers, query strings or plugin input.
const issuer = required("PCBJAM_ISSUER"),
  audience = required("PCBJAM_AUDIENCE"),
  pluginId = required("PCBJAM_PLUGIN_ID");
const origin = required("PUBLIC_ORIGIN");
if (new URL(origin).origin !== origin || !origin.startsWith("https://"))
  throw new Error("PUBLIC_ORIGIN must be your approved HTTPS origin");
const db = new Pool({ connectionString: required("DATABASE_URL"), max: 5 });
const verify = createBackendVerifier({
  issuer,
  audience,
  pluginId,
  consumeReplay: async ({ issuer, audience, jti, expiresAt }) => {
    // Atomic across every backend replica. A DB error rejects the request.
    const result = await db.query(
      "INSERT INTO plugin_request_nonce (issuer,audience,jti,expires_at) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING jti",
      [issuer, audience, jti, expiresAt]
    );
    return result.rowCount === 1;
  },
});
const server = createServer(async (req, res) => {
  res.setHeader("content-type", "application/json");
  res.setHeader("cache-control", "no-store");
  if (
    req.url !== "/v1/preferences" ||
    !["GET", "POST"].includes(req.method ?? "")
  ) {
    res.writeHead(404).end("{}");
    return;
  }
  if (
    req.headers["content-encoding"] &&
    req.headers["content-encoding"] !== "identity"
  ) {
    res.writeHead(415).end("{}");
    return;
  }
  try {
    const chunks: Buffer[] = [];
    let length = 0;
    for await (const chunk of req) {
      length += chunk.length;
      if (length > 128 * 1024) {
        res.writeHead(413).end("{}");
        return;
      }
      chunks.push(chunk);
    }
    const body = Buffer.concat(chunks);
    let identity;
    try {
      identity = await verify({
        authorization: req.headers.authorization,
        method: req.method!,
        url: origin + req.url,
        body,
      });
    } catch {
      res
        .writeHead(401)
        .end('{"error":"Invalid or already used PCBJam request"}');
      return;
    }
    // Use the VERIFIED subject, never a body/query userId. Authentication does
    // not replace your own authorization, validation or business rules.
    if (req.method === "POST") {
      const input = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(body)
      );
      if (
        !input ||
        Object.keys(input).length !== 1 ||
        typeof input.library !== "string" ||
        input.library.length > 100
      ) {
        res.writeHead(400).end("{}");
        return;
      }
      await db.query(
        "INSERT INTO plugin_preference (issuer,subject,library) VALUES ($1,$2,$3) ON CONFLICT (issuer,subject) DO UPDATE SET library=EXCLUDED.library",
        [issuer, identity.subject, input.library]
      );
    }
    const data = await db.query(
      "SELECT library FROM plugin_preference WHERE issuer=$1 AND subject=$2",
      [issuer, identity.subject]
    );
    res.end(JSON.stringify({ library: data.rows[0]?.library ?? "" }));
  } catch {
    res.writeHead(503).end('{"error":"Request could not be completed"}');
  }
});
server.requestTimeout = 10000;
server.headersTimeout = 10000;
server.maxHeadersCount = 32;
server.listen(Number(process.env.PORT ?? 8080), "127.0.0.1");
