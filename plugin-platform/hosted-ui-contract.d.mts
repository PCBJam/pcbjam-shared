export interface HostedUi {
  kind: 'hosted';
  /** https origin of the plugin's own pages (http://localhost only in local development). */
  origin: string;
  /** The page the editor frames, absolute. */
  path: string;
  /** The panel follows the editor across files, tools and read-only changes instead of restarting. */
  persistent?: true;
}
export const HOSTED_UI_WELL_KNOWN: '/.well-known/pcbjam-plugin.json';
export const HOSTED_UI_HEADERS: Readonly<Record<string, readonly string[]>>;
export function hostedUi(value: unknown, options?: { allowLocalhost?: boolean }): HostedUi;
export function isHostedUi(ui: unknown): ui is HostedUi;
export function hostedUiPermission(origin: string): string;
export function hostedUiPermissions(origin: string): Record<string, string>;
export function hostedUiPolicyText(ui: HostedUi): string;
export function hostedUiUrl(ui: HostedUi): string;
export function wellKnownProves(body: string, challengeHash: string): boolean;
export function hostedFragment(hash: string, editors: readonly string[]): { nonce: string; parent: string } | null;
export type ContributionKind = 'adminNav' | 'adminUser' | 'adminProject' | 'userSettings' | 'projectSettings';
export interface LabeledContribution { label: string; path: string }
export interface SectionContribution { section: 'git'; path: string; height?: number }
export interface Contributes {
  adminNav?: LabeledContribution[];
  adminUser?: LabeledContribution[];
  adminProject?: LabeledContribution[];
  userSettings?: LabeledContribution[];
  projectSettings?: SectionContribution[];
}
export const CONTRIBUTION_KINDS: Readonly<Record<ContributionKind, { placeholders: string[]; sections?: string[] }>>;
export function validateContributes(input: unknown): Contributes | undefined;
export function contributionPath(path: string, values?: { userId?: string; projectId?: string }): string;
