export interface BackendEndpoint {
  origin: string;
  paths: string[];
  methods: ("GET" | "POST")[];
  auth: "none" | "pcbjam-user";
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
}>;
export function exact(value: unknown, keys: string[]): void;
export function backendOrigin(value: unknown): string;
export function backendPath(value: unknown): string;
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
