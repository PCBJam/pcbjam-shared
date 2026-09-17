import type { JWTVerifyGetKey } from "jose";
export const REQUEST_TOKEN_TYPE: string;
export function bodyDigest(bytes: Uint8Array): Promise<string>;
export function createBackendVerifier(config: {
  issuer: string;
  audience: string;
  pluginId: string;
  consumeReplay: (value: {
    issuer: string;
    audience: string;
    jti: string;
    expiresAt: Date;
  }) => Promise<boolean>;
  jwks?: JWTVerifyGetKey;
}): (request: {
  authorization: string | null | undefined;
  method: string;
  url: string;
  body: Uint8Array;
}) => Promise<{
  subject: string;
  pluginId: string;
  audience: string;
  expiresAt: Date;
}>;
