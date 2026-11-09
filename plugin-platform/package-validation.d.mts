import type {BackendEndpoint} from './backend-contract.mjs';
import type {Contributes, HostedUi} from './hosted-ui-contract.mjs';
export interface PluginManifest {
  apiVersion: 1; kind?: 'plugin'; id: string; name: string; version: string; description: string;
  main: 'main.js';
  /** The packaged ui.html, or a page on the plugin's own origin (plugins 0025 §5.1). */
  ui: 'ui.html' | HostedUi; surfaces: string[]; permissions: string[]; endpoints?:Record<string,BackendEndpoint>;
  /** HTTPS sites the Worker may call directly (plugins 0022 M3); each needs its `direct:<hostname>` permission. */
  network?: string[];
  uiSize?: {width: number; height: number};
  /** Where its hosted pages show up in the web app (plugins 0025 §5.2); needs a hosted ui. */
  contributes?: Contributes;
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
/** A tutorial's project in the package: KiCad text files under template/ (overlay-system 0005). */
export const TEMPLATE_LIMITS: {files: number; bytes: number};
export function isTemplatePath(path: string): boolean;
/** The template file a started tutorial opens (paths relative to template/); null when there is none. */
export function templateEntry(paths: string[]): string | null;
export const PERMISSIONS: Record<string, string>;
export const PACKAGE_KINDS: readonly ['plugin', 'remote-provider'];
export const PROVIDER_PERMISSIONS: readonly ['provider:embed', 'provider:download', 'editor:place-items'];
export function readZip(bytes: Buffer): {path: string; text: string}[];
export function validatePackage(input: unknown, options?: {legacyDigest?: boolean; allowLocalHostedUi?: boolean}): ValidatedPackage;
