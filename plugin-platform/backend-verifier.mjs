import { createRemoteJWKSet, jwtVerify } from "jose";

export const REQUEST_TOKEN_TYPE = "pcbjam-plugin-request+jwt";
export async function bodyDigest(bytes) {
  return Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
    (b) => b.toString(16).padStart(2, "0")
  ).join("");
}

/** Configure issuer/audience/pluginId from PCBJam's approval, never from a token.
 * consumeReplay must atomically insert (issuer,audience,jti) in shared durable storage.
 * Returning false means already used. Storage errors must propagate (fail closed).
 */
export function createBackendVerifier({
  issuer,
  audience,
  pluginId,
  consumeReplay,
  jwks,
}) {
  const origin = new URL(issuer);
  if (
    origin.origin !== issuer ||
    !(
      origin.protocol === "https:" ||
      (origin.protocol === "http:" &&
        ["localhost", "127.0.0.1"].includes(origin.hostname))
    )
  )
    throw new Error("Invalid configured issuer");
  if (!audience || !pluginId || typeof consumeReplay !== "function")
    throw new Error("Configure audience, pluginId and durable replay storage");
  const key =
    jwks ??
    createRemoteJWKSet(
      new URL("/.well-known/pcbjam-plugin-jwks.json", issuer),
      { timeoutDuration: 5000, cooldownDuration: 30000, cacheMaxAge: 60000 }
    );
  return async function verifyRequest({ authorization, method, url, body }) {
    if (
      typeof authorization !== "string" ||
      authorization.length > 8192 ||
      !/^Bearer [A-Za-z0-9_.-]+$/.test(authorization)
    )
      throw new Error("Invalid plugin identity");
    if (
      !(body instanceof Uint8Array) ||
      body.byteLength > 128 * 1024 ||
      !["GET", "POST"].includes(method)
    )
      throw new Error("Invalid signed request");
    const { payload, protectedHeader } = await jwtVerify(
      authorization.slice(7),
      key,
      {
        algorithms: ["ES256"],
        issuer,
        audience,
        typ: REQUEST_TOKEN_TYPE,
        clockTolerance: 5,
        maxTokenAge: 65,
        requiredClaims: [
          "iss",
          "aud",
          "sub",
          "iat",
          "nbf",
          "exp",
          "jti",
          "plugin_id",
          "htm",
          "htu",
          "body_sha256",
        ],
      }
    );
    const now = Math.floor(Date.now() / 1000);
    if (
      typeof protectedHeader.kid !== "string" ||
      !protectedHeader.kid ||
      protectedHeader.jku ||
      protectedHeader.jwk ||
      protectedHeader.x5u ||
      payload.aud !== audience ||
      payload.plugin_id !== pluginId ||
      typeof payload.sub !== "string" ||
      !/^ps_[a-f0-9]{48}$/.test(payload.sub) ||
      typeof payload.jti !== "string" ||
      !/^[a-f0-9]{48}$/.test(payload.jti) ||
      !Number.isInteger(payload.iat) ||
      !Number.isInteger(payload.nbf) ||
      !Number.isInteger(payload.exp) ||
      payload.nbf !== payload.iat ||
      payload.iat > now + 5 ||
      payload.exp - payload.iat !== 60 ||
      payload.htm !== method ||
      payload.htu !== url ||
      payload.body_sha256 !== (await bodyDigest(body)) ||
      (method === "GET" && body.byteLength !== 0)
    )
      throw new Error("Signed request does not match");
    // Consume only after all signature, identity and request checks, before any side effect.
    if (
      (await consumeReplay({
        issuer,
        audience,
        jti: payload.jti,
        expiresAt: new Date((payload.exp + 5) * 1000),
      })) !== true
    )
      throw new Error("Plugin request already used");
    return Object.freeze({
      subject: payload.sub,
      pluginId,
      audience,
      expiresAt: new Date(payload.exp * 1000),
    });
  };
}

export const IDENTITY_TOKEN_TYPE = "pcbjam-plugin-identity+jwt";
export const IDENTITY_TOKEN_SECONDS = 300;

/**
 * A plugin's own site checks the identity token its page sent (plugins 0025 §5.5). Configure
 * issuer, audience (the hosted UI's origin, exactly as approved) and pluginId from PCBJam's
 * approval, never from a token. Unlike a signed request, the token is a short bearer credential
 * (5 minutes): the page may send it on a WebSocket's first frame and again on a reconnect, so it
 * is not consumed. Resolves with the claims the person granted; absent claims stay undefined.
 */
export function createIdentityVerifier({ issuer, audience, pluginId, jwks }) {
  const origin = new URL(issuer);
  if (
    origin.origin !== issuer ||
    !(
      origin.protocol === "https:" ||
      (origin.protocol === "http:" &&
        ["localhost", "127.0.0.1"].includes(origin.hostname))
    )
  )
    throw new Error("Invalid configured issuer");
  if (!audience || new URL(audience).origin !== audience || !pluginId)
    throw new Error("Configure audience (the plugin site's origin) and pluginId");
  const key =
    jwks ??
    createRemoteJWKSet(
      new URL("/.well-known/pcbjam-plugin-jwks.json", issuer),
      { timeoutDuration: 5000, cooldownDuration: 30000, cacheMaxAge: 60000 }
    );
  return async function verifyIdentity(token) {
    if (typeof token !== "string" || token.length > 8192 || !/^[A-Za-z0-9_.-]+$/.test(token))
      throw new Error("Invalid plugin identity");
    const { payload, protectedHeader } = await jwtVerify(token, key, {
      algorithms: ["ES256"],
      issuer,
      audience,
      typ: IDENTITY_TOKEN_TYPE,
      clockTolerance: 5,
      maxTokenAge: IDENTITY_TOKEN_SECONDS + 5,
      requiredClaims: ["iss", "aud", "iat", "nbf", "exp", "jti", "plugin_id", "enabled"],
    });
    const now = Math.floor(Date.now() / 1000);
    if (
      typeof protectedHeader.kid !== "string" ||
      !protectedHeader.kid ||
      protectedHeader.jku ||
      protectedHeader.jwk ||
      protectedHeader.x5u ||
      payload.aud !== audience ||
      payload.plugin_id !== pluginId ||
      payload.enabled !== true ||
      typeof payload.jti !== "string" ||
      !/^[a-f0-9]{48}$/.test(payload.jti) ||
      !Number.isInteger(payload.iat) ||
      payload.nbf !== payload.iat ||
      payload.iat > now + 5 ||
      payload.exp - payload.iat !== IDENTITY_TOKEN_SECONDS ||
      (payload.sub !== undefined && !/^ps_[a-f0-9]{48}$/.test(String(payload.sub))) ||
      (payload.uid !== undefined && (typeof payload.uid !== "string" || !payload.uid || payload.uid.length > 128)) ||
      (payload.role !== undefined && !["admin", "user"].includes(payload.role)) ||
      (payload.pro !== undefined && typeof payload.pro !== "boolean") ||
      (payload.limits !== undefined && (typeof payload.limits !== "object" || payload.limits === null || Array.isArray(payload.limits)))
    )
      throw new Error("Plugin identity does not match");
    return Object.freeze({
      pluginId,
      enabled: true,
      subject: payload.sub,
      userId: payload.uid,
      role: payload.role,
      pro: payload.pro,
      limits: payload.limits,
      expiresAt: new Date(payload.exp * 1000),
    });
  };
}
