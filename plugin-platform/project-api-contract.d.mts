export const PROJECT_API_PERMISSION: string;
export const BACKEND_CREDENTIAL_TYPE: string;
export const BACKEND_CREDENTIAL_SECONDS: number;
export const PROJECT_KEY_DAYS: number;
export interface ProjectApi {
  access: "read" | "write";
  paths?: string[];
  credentialKey: { kty: "EC"; crv: "P-256"; x: string; y: string };
}
export function validPaths(paths: unknown): paths is string[];
export function pathsWithin(inner: string[], outer: string[]): boolean;
export function validateProjectApi(api: unknown): ProjectApi | undefined;
export function narrowProjectAccess(
  declared: ProjectApi,
  requested?: { access?: "read" | "write"; paths?: string[] },
): { access: "read" | "write"; paths?: string[] };
export function projectApiPolicyText(api: ProjectApi): string;
