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
  /** What the provider's document declares for sign-in; absent without sign-in. */
  auth?: DeclaredAuth;
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
/** Sign-in as the provider's own document declares it (auth.type "oauth2"). */
export interface DeclaredAuth {
  type: "oauth2";
  metadataUrl: string;
  clientId: string;
  scopes: string[];
}
/** The endpoints read once from the sign-in server's document (RFC 8414). */
export interface OAuthServer {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
}
/** The one sign-in configuration a release is pinned to at upload. */
export interface ProviderAuth extends OAuthServer {
  type: "oauth2";
  metadataUrl: string;
  /** The client PCBJam uses. */
  clientId: string;
  /** "metadata": the provider's document (desktop KiCad's client); "package": `provider.oauthClientId`. */
  clientIdFrom: "metadata" | "package";
  scopes: string[];
}
/** The stored snapshot of a provider: its metadata, plus the pinned sign-in when it has one. */
export type ProviderSnapshot = Omit<ProviderMetadata, "auth"> & { auth?: ProviderAuth };
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
export const OAUTH_SERVER_WELL_KNOWN_PATH: "/.well-known/oauth-authorization-server";
export const LOGIN_CALLBACK_PREFIX: "/remote-provider-callback/";
export const OAUTH_LIMITS: Readonly<{ clientIdChars: number; scopes: number; scopeChars: number }>;
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
export function oauthClientId(value: unknown): string;
/**
 * `registeredDomain(hostname)` answers the registrable domain from the public
 * suffix list with its private section, or null (an IP address, a suffix).
 */
export function validateOAuthServerMetadata(
  doc: unknown,
  options: UrlOptions & {
    metadataUrl: string;
    /** The package's `provider.origin`. */
    origin: string;
    registeredDomain?: (hostname: string) => string | null;
  }
): OAuthServer;
export function providerAuthSnapshot(
  metadata: ProviderMetadata,
  server: OAuthServer | undefined,
  packageClientId?: string
): ProviderAuth | undefined;
export function sameProviderAuth(snapshot: ProviderSnapshot, fresh: ProviderMetadata): boolean;
export function loginCallbackPath(issuer: string): string;
export function loginRedirectUri(editorOrigin: string, issuer: string): string;
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
export function withinMessageBudget(value: unknown, limit?: number): boolean;
export function validateEnvelope(raw: unknown): Envelope;
export function providerPolicyText(origin: string, auth?: Pick<ProviderAuth, "type" | "issuer" | "clientId" | "clientIdFrom">): string;
export function providerPermissions(origin: string): Record<string, string>;
export function checkPanelHeaders(
  headers: { get(name: string): string | null } | Record<string, string> | null | undefined
): HeaderCheck;
export const PANEL_FRAMING_HEADERS: readonly ["content-security-policy", "x-frame-options"];
/** Whether a browser shows the panel inside the editor; when not, the header that keeps it out. */
export function checkPanelFraming(
  headers: { get(name: string): string | null } | Record<string, string> | null | undefined,
  editorOrigin: string
): { ok: true } | { ok: false; header: "content-security-policy" | "x-frame-options"; actual: string };
