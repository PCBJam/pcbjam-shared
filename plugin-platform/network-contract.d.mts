export const NET_LIMITS: Readonly<{
  sites: number;
  requestBytes: number;
  responseBytes: number;
  timeoutMs: number;
  inFlight: number;
  perMinute: number;
}>;
export const NET_METHODS: readonly ['GET', 'POST'];
export const NET_HEADERS: readonly ['accept', 'content-type', 'authorization'];
export function directOrigin(value: unknown): string;
export function canonicalSites(sites: readonly string[]): string[];
export function validateNetwork(value: unknown): string[] | undefined;
export function sitePermission(site: string): string;
export function directPermissions(network: readonly string[] | undefined): Record<string, string>;
export function sitesSegment(sites: readonly string[]): string;
export function sitesFromSegment(segment: unknown): string[] | null;
export function workerCsp(sites?: readonly string[]): string;
