import type {BackendEndpoint} from './backend-contract.mjs';
export interface PluginManifest {
  apiVersion: 1; kind?: 'plugin'; id: string; name: string; version: string; description: string;
  main: 'main.js'; ui: 'ui.html'; surfaces: string[]; permissions: string[]; endpoints?:Record<string,BackendEndpoint>;
  uiSize?: {width: number; height: number};
}
/** Manifest-only package whose UI is the provider's own KiCad 10 remote-symbol panel page. */
export interface RemoteProviderManifest {
  apiVersion: 1; kind: 'remote-provider'; id: string; name: string; version: string; description: string;
  surfaces: ['editor:eeschema']; permissions: string[]; provider: {origin: string};
}
export type Manifest = PluginManifest | RemoteProviderManifest;
export interface ValidatedPackage {
  digest: string; manifest: Manifest; files: {path: string; text: string}[];
  fileMetadata: Record<string, {sha256: string; bytes: number}>;
  policyDigest: string; validationVersion: number;
}
export const LIMITS: {archive: number; total: number; file: number; files: number};
export const PERMISSIONS: Record<string, string>;
export const PACKAGE_KINDS: readonly ['plugin', 'remote-provider'];
export const PROVIDER_PERMISSIONS: readonly ['provider:embed', 'provider:download', 'editor:place-items'];
export function readZip(bytes: Buffer): {path: string; text: string}[];
export function validatePackage(input: unknown, options?: {legacyDigest?: boolean}): ValidatedPackage;
