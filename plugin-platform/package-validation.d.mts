import type {BackendEndpoint} from './backend-contract.mjs';
export interface Manifest {
  apiVersion: 1; id: string; name: string; version: string; description: string;
  main: 'main.js'; ui: 'ui.html'; surfaces: string[]; permissions: string[]; endpoints?:Record<string,BackendEndpoint>;
}
export interface ValidatedPackage {
  digest: string; manifest: Manifest; files: {path: string; text: string}[];
  fileMetadata: Record<string, {sha256: string; bytes: number}>;
  policyDigest: string; validationVersion: number;
}
export const LIMITS: {archive: number; total: number; file: number; files: number};
export const PERMISSIONS: Record<string, string>;
export function readZip(bytes: Buffer): {path: string; text: string}[];
export function validatePackage(input: unknown, options?: {legacyDigest?: boolean}): ValidatedPackage;
