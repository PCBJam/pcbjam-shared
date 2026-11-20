export interface BackendEndpoint {
  origin: string;
  paths: string[];
  methods: ("GET" | "POST")[];
  auth: "none" | "pcbjam-user";
  /**
   * Paths that take one ZIP (exports.bundle) as multipart/form-data. `query`: the
   * query parameters an upload URL may carry (a signed upload URL the endpoint issued).
   */
  upload?: { paths: string[]; field: string; maxBytes: number; query?: string[] };
}
export interface UploadRequest {
  endpointId: string;
  path: string;
  bundleId: string;
  fields?: Record<string, string>;
  query?: Record<string, string>;
}
export interface BackendRequest {
  endpointId: string;
  method: "GET" | "POST";
  path: string;
  json?: unknown;
}
export interface BackendResponse {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}
export const BACKEND_LIMITS: Readonly<{
  requestBytes: number;
  responseBytes: number;
  resultBytes: number;
  deadlineMs: number;
  hostDeadlineMs: number;
  uploadBytes: number;
  uploadFields: number;
  uploadFieldChars: number;
}>;
export function exact(value: unknown, keys: string[]): void;
export function backendOrigin(value: unknown): string;
export function backendPath(value: unknown): string;
/** A policy path: exact, or ending in one placeholder segment ("/jobs/{id}"). */
export function backendPathPattern(value: unknown): string;
/** Whether a request path is one the policy's paths allow. */
export function pathAllowed(paths: string[], path: string): boolean;
/** "" or "?a=1&b=2" from validated upload query names and values, in name order. */
export function uploadQueryString(query?: Record<string, string>): string;
export function validateEndpoints(
  value: unknown
): Record<string, BackendEndpoint> | undefined;
export function backendPolicyText(value: BackendEndpoint): string;
export function backendPermissions(
  value?: Record<string, BackendEndpoint>
): Record<string, string>;
export function validateBackendRequest(
  value: unknown,
  policy?: BackendEndpoint
): BackendRequest;
export function validateUploadRequest(
  value: unknown,
  policy?: BackendEndpoint
): UploadRequest;
