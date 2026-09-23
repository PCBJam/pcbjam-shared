export type AssetType = "symbol" | "footprint" | "3dmodel" | "spice";
export type ProviderCommand =
  | "NEW_SESSION"
  | "GET_KICAD_VERSION"
  | "LIST_SUPPORTED_VERSIONS"
  | "CAPABILITIES"
  | "GET_SOURCE_INFO"
  | "REMOTE_LOGIN"
  | "DL_SYMBOL"
  | "DL_COMPONENT"
  | "DL_FOOTPRINT"
  | "DL_SPICE"
  | "DL_3DMODEL"
  | "PLACE_COMPONENT";

export interface ProviderMetadata {
  providerName: string;
  providerVersion: string;
  apiBaseUrl: string;
  panelUrl: string;
  sessionBootstrapUrl?: string;
  authType: "none" | "oauth2";
  capabilities: {
    webUi: true;
    parts: boolean;
    directDownloads: boolean;
    inlinePayloads: boolean;
  };
  maxDownloadBytes: number;
  supportedAssetTypes: AssetType[];
  documentationUrl?: string;
  termsUrl?: string;
  privacyUrl?: string;
  /** Sorted, de-duplicated origins of panel_url and api_base_url. */
  originSet: string[];
}
export interface ManifestAsset {
  assetType: AssetType;
  name: string;
  targetLibrary: string;
  targetName: string;
  contentType: string;
  sizeBytes: number;
  /** Lowercase hex. */
  sha256: string;
  downloadUrl: string;
  required: boolean;
}
export interface PlaceManifest {
  partId: string;
  displayName: string;
  summary: string;
  license: string;
  symbolName: string;
  libraryName: string;
  place: boolean;
  assets: ManifestAsset[];
  totalBytes: number;
}
export interface InlineEntry {
  type: AssetType;
  name: string;
  /** Base64 text, not yet decoded. */
  content: string;
  compression: string;
}
export interface Envelope {
  version: number;
  sessionId: string;
  messageId: number;
  responseTo?: number;
  command: string;
  status?: string;
  errorCode?: string;
  errorMessage?: string;
  parameters: Record<string, unknown>;
  data: string;
}
export interface UrlOptions {
  allowInsecureLocalhost?: boolean;
}
export interface HeaderCheck {
  ok: boolean;
  missing: { name: string; expected: string; actual: string }[];
}

export const RPC_VERSION: 1;
export const WELL_KNOWN_PATH: "/.well-known/kicad-remote-provider";
export const ASSET_TYPES: readonly AssetType[];
export const PROVIDER_COMMANDS: readonly ProviderCommand[];
export const PROVIDER_LIMITS: Readonly<{
  metadataBytes: number;
  assetBytes: number;
  partBytes: number;
  messageBytes: number;
  manifestAssets: number;
  handshakeAttempts: number;
  handshakeIntervalMs: number;
}>;
export const REQUIRED_PANEL_HEADERS: Readonly<Record<string, readonly string[]>>;

export function providerOrigin(value: unknown): string;
export function metadataUrl(origin: string): string;
export function urlOrigin(value: unknown, options?: UrlOptions): string;
export function validateProviderMetadata(
  doc: unknown,
  options?: UrlOptions & { allowedAuthTypes?: ("none" | "oauth2")[] }
): ProviderMetadata;
export function assetAllowed(url: unknown, originSet: string[], options?: UrlOptions): string;
export function validatePlaceManifest(
  params: unknown,
  options?: {
    supportedAssetTypes?: readonly AssetType[];
    maxDownloadBytes?: number;
    originSet?: string[];
    urlOptions?: UrlOptions;
  }
): PlaceManifest;
export function validateInlineBundle(entries: unknown): InlineEntry[];
export function validateEnvelope(raw: unknown): Envelope;
export function providerPolicyText(origin: string): string;
export function providerPermissions(origin: string): Record<string, string>;
export function checkPanelHeaders(
  headers: { get(name: string): string | null } | Record<string, string> | null | undefined
): HeaderCheck;
