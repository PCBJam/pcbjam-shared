import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PROVIDER_LIMITS, RPC_VERSION, WELL_KNOWN_PATH, assetAllowed, checkPanelHeaders, metadataUrl,
  providerPermissions, providerPolicyText, urlOrigin, validateEnvelope, validateInlineBundle,
  validatePlaceManifest, validateProviderMetadata,
} from '../remote-provider-contract.mjs';

const ORIGIN = 'https://kicad.acme-parts.example';
const metadata = patch => ({
  provider_name: 'Acme Parts', provider_version: '1.0.0', api_base_url: ORIGIN + '/api', panel_url: ORIGIN + '/panel',
  auth: { type: 'none' }, capabilities: { web_ui_v1: true, parts_v1: true, direct_downloads_v1: true, inline_payloads_v1: true },
  max_download_bytes: 1048576, supported_asset_types: ['symbol', 'footprint'], parts: { endpoint_template: '/v1/parts/{part_id}' },
  ...patch,
});
const asset = patch => ({
  asset_type: 'symbol', name: 'r.kicad_sym', target_library: 'Device', target_name: 'R', content_type: 'application/x-kicad-symbol',
  size_bytes: 120, sha256: 'A'.repeat(64), download_url: ORIGIN + '/downloads/r.kicad_sym', required: true, ...patch,
});
const manifest = patch => ({ part_id: 'acme-r', display_name: 'R 10k', mode: 'PLACE', assets: [asset({})], ...patch });

test('metadata: the well-known document validates and yields the pinned origin set', () => {
  const meta = validateProviderMetadata(metadata({ api_base_url: 'https://api.acme-parts.example/v1/' }));
  assert.equal(meta.providerName, 'Acme Parts');
  assert.equal(meta.authType, 'none');
  assert.deepEqual(meta.originSet, ['https://api.acme-parts.example', ORIGIN]);
  assert.deepEqual(meta.capabilities, { webUi: true, parts: true, directDownloads: true, inlinePayloads: true });
  assert.equal(metadataUrl(ORIGIN), ORIGIN + WELL_KNOWN_PATH);
  assert.equal(validateProviderMetadata(metadata({ api_base_url: ORIGIN + '/api' })).originSet.length, 1);
});

test('metadata: schema violations and unsupported auth are refused with a named reason', () => {
  const cases = [
    [metadata({ extra: 1 }), /Invalid plugin backend policy/],
    [metadata({ provider_name: '' }), /provider_name/],
    [metadata({ auth: { type: 'oauth2', metadata_url: ORIGIN + '/o', client_id: 'x' }, session_bootstrap_url: ORIGIN + '/s' }), /oauth2 are not supported/],
    [metadata({ auth: { type: 'oauth2' } }), /auth\.metadata_url/],
    [metadata({ auth: { type: 'basic' } }), /auth\.type/],
    [metadata({ capabilities: { web_ui_v1: false } }), /web_ui_v1/],
    [metadata({ max_download_bytes: 0 }), /max_download_bytes/],
    [metadata({ supported_asset_types: [] }), /supported_asset_types/],
    [metadata({ supported_asset_types: ['symbol', 'symbol'] }), /supported_asset_types/],
    [metadata({ supported_asset_types: ['gerber'] }), /supported_asset_types/],
    [metadata({ panel_url: 'http://kicad.acme-parts.example/panel' }), /must use https/],
    [metadata({ panel_url: 'https://kicad.acme-parts.example:8443/panel' }), /default https port/],
    [metadata({ panel_url: 'https://user:pw@kicad.acme-parts.example/panel' }), /credentials/],
    [metadata({ panel_url: '/panel' }), /not absolute/],
    [metadata({ api_base_url: 'https://localhost/api' }), /Invalid plugin backend policy/],
    [metadata({ parts: { endpoint_template: 'v1/parts' } }), /endpoint_template/],
    [{ ...metadata({}), auth: undefined }, /missing auth/],
  ];
  for (const [doc, pattern] of cases) assert.throws(() => validateProviderMetadata(doc), pattern, JSON.stringify(doc));
  // oauth2 documents are schema-valid; only the phase-1 allowlist rejects them.
  const oauth = metadata({ auth: { type: 'oauth2', metadata_url: ORIGIN + '/o', client_id: 'x', scopes: ['parts.read'] }, session_bootstrap_url: ORIGIN + '/s' });
  assert.equal(validateProviderMetadata(oauth, { allowedAuthTypes: ['none', 'oauth2'] }).authType, 'oauth2');
});

test('urls: loopback http is only accepted when a fixture opts in', () => {
  assert.throws(() => urlOrigin('http://127.0.0.1:4400/panel'), /must use https/);
  assert.equal(urlOrigin('http://127.0.0.1:4400/panel', { allowInsecureLocalhost: true }), 'http://127.0.0.1:4400');
  assert.throws(() => urlOrigin('http://10.0.0.5/panel', { allowInsecureLocalhost: true }), /must use https/);
  assert.equal(urlOrigin(ORIGIN + '/x?y=1'), ORIGIN);
  assert.throws(() => urlOrigin(ORIGIN + '/x#frag'), /fragment/);
});

test('assets: only the panel or API origin may serve downloads', () => {
  const set = [ORIGIN, 'https://api.acme-parts.example'];
  assert.equal(assetAllowed('https://api.acme-parts.example/dl/r.kicad_sym', set), 'https://api.acme-parts.example/dl/r.kicad_sym');
  assert.throws(() => assetAllowed('https://cdn.acme-parts.example/r.kicad_sym', set), /origin must match/);
  assert.throws(() => assetAllowed('https://kicad.acme-parts.example.evil.example/r', set), /origin must match/);
  assert.throws(() => assetAllowed('http://kicad.acme-parts.example/r', set), /must use https/);
});

test('manifest: PLACE_COMPONENT validates like the desktop client and normalises assets', () => {
  const out = validatePlaceManifest(manifest({ assets: [asset({}), asset({ asset_type: 'footprint', name: 'R_0603.kicad_mod', sha256: 'b'.repeat(64), required: false })] }),
    { supportedAssetTypes: ['symbol', 'footprint'], maxDownloadBytes: 1048576, originSet: [ORIGIN] });
  assert.equal(out.partId, 'acme-r');
  assert.equal(out.place, true);
  assert.equal(out.totalBytes, 240);
  assert.equal(out.assets[0].sha256, 'a'.repeat(64), 'digest is normalised to lowercase');
  assert.equal(out.assets[1].assetType, 'footprint');
  assert.equal(validatePlaceManifest(manifest({ mode: 'SAVE' })).place, false);
  assert.equal(validatePlaceManifest(manifest({ mode: undefined })).place, true, 'PLACE_COMPONENT without a mode places');
});

test('manifest: every desktop refusal is reproduced', () => {
  const cases = [
    [manifest({ assets: [] }), /non-empty assets/],
    [manifest({ assets: [asset({ sha256: undefined })] }), /missing 'sha256'/],
    // The error names the field a provider forgot, including `required`.
    [manifest({ assets: [asset({ required: undefined })] }), /missing 'required'/],
    [manifest({ assets: [asset({ sha256: 'zz' })] }), /sha256/],
    [manifest({ assets: [asset({ size_bytes: 0 })] }), /invalid size/],
    [manifest({ assets: [asset({ size_bytes: PROVIDER_LIMITS.assetBytes + 1 })] }), /asset size limit/],
    [manifest({ assets: [asset({ asset_type: 'gerber' })] }), /Unknown asset_type/],
    [manifest({ assets: [asset({ download_url: 'https://elsewhere.example/r' })] }), /origin must match/],
    [manifest({ assets: [asset({ download_url: 'http://kicad.acme-parts.example/r' })] }), /must use https/],
    [manifest({ assets: [asset({ required: 'yes' })] }), /required/],
    [manifest({ assets: [asset({ bonus: 1 })] }), /Invalid plugin backend policy/],
    [manifest({ mode: 'STREAM' }), /Unsupported transfer mode 'STREAM'/],
    [manifest({ part_id: '' }), /part_id and display_name/],
    [manifest({ assets: Array.from({ length: PROVIDER_LIMITS.manifestAssets + 1 }, () => asset({})) }), /too many assets/],
  ];
  for (const [params, pattern] of cases)
    assert.throws(() => validatePlaceManifest(params, { originSet: [ORIGIN] }), pattern, JSON.stringify(params).slice(0, 120));
  assert.throws(() => validatePlaceManifest(manifest({ assets: [asset({ asset_type: '3dmodel' })] }), { supportedAssetTypes: ['symbol'], originSet: [ORIGIN] }), /does not declare support for 3dmodel/);
  assert.throws(() => validatePlaceManifest(manifest({ assets: [asset({ size_bytes: 600 }), asset({ size_bytes: 500, sha256: 'b'.repeat(64) })] }), { maxDownloadBytes: 1000, originSet: [ORIGIN] }), /exceed the provider download limit/);
});

test('inline bundle: DL_COMPONENT entries keep their base64 text and normalise type/compression', () => {
  const entries = validateInlineBundle([{ type: 'Symbol', name: 'R', content: 'aGVsbG8=', compression: 'none' }, { type: 'footprint', content: 'aGVsbG8=' }]);
  assert.deepEqual(entries[0], { type: 'symbol', name: 'R', content: 'aGVsbG8=', compression: 'NONE' });
  assert.deepEqual(entries[1], { type: 'footprint', name: '', content: 'aGVsbG8=', compression: 'NONE' });
  assert.throws(() => validateInlineBundle([]), /non-empty array/);
  assert.throws(() => validateInlineBundle([{ content: 'x' }]), /missing a type/);
  assert.throws(() => validateInlineBundle([{ type: 'gerber', content: 'x' }]), /Unsupported component type/);
  assert.throws(() => validateInlineBundle([{ type: 'symbol', content: '%%%' }]), /base64/);
});

test('envelope: strings and objects parse; shape violations are refused before dispatch', () => {
  const env = validateEnvelope(JSON.stringify({ version: RPC_VERSION, session_id: 's1', message_id: 3, command: 'CAPABILITIES' }));
  assert.deepEqual(env, { version: 1, sessionId: 's1', messageId: 3, responseTo: undefined, command: 'CAPABILITIES', status: undefined, errorCode: undefined, errorMessage: undefined, parameters: {}, data: '' });
  assert.equal(validateEnvelope({ version: 1, session_id: 's1', message_id: 0, command: 'NEW_SESSION', response_to: 1, status: 'OK' }).responseTo, 1);
  assert.equal(validateEnvelope({ message_id: 1, command: 'X' }).version, 0, 'a missing version reads as 0 so the host answers UNSUPPORTED_VERSION');
  for (const raw of ['not json', '[]', 'null', '{"command":"X"}', '{"message_id":1}', '{"message_id":"1","command":"X"}',
    '{"message_id":1,"command":"X","parameters":[]}', '{"message_id":1,"command":"X","data":5}', '{"message_id":1,"command":"X","extra":1}'])
    assert.throws(() => validateEnvelope(raw), Error, raw);
  assert.throws(() => validateEnvelope('x'.repeat(PROVIDER_LIMITS.messageBytes + 1)), /size limit/);
  // Already-parsed objects (structured clone) are held to the same limit, in data or nested parameters.
  const big = 'A'.repeat(PROVIDER_LIMITS.messageBytes + 1);
  assert.throws(() => validateEnvelope({ version: 1, session_id: 's1', message_id: 1, command: 'DL_SYMBOL', data: big }), /size limit/);
  assert.throws(() => validateEnvelope({ version: 1, session_id: 's1', message_id: 1, command: 'X', parameters: { a: [big.slice(0, 1 << 20), big] } }), /size limit/);
  const wide = Array.from({ length: PROVIDER_LIMITS.messageBytes }, () => 0);
  assert.throws(() => validateEnvelope({ version: 1, session_id: 's1', message_id: 1, command: 'X', parameters: { wide } }), /size limit/);
  assert.equal(validateEnvelope({ version: 1, session_id: 's1', message_id: 1, command: 'DL_SYMBOL', data: 'A'.repeat(1 << 20) }).data.length, 1 << 20);
});

test('policy and consent strings pin the provider origin', () => {
  assert.equal(providerPolicyText(ORIGIN), JSON.stringify({ version: 1, kind: 'remote-provider', origin: ORIGIN }));
  assert.deepEqual(providerPermissions(ORIGIN), {
    'provider:embed': 'Show ' + ORIGIN + ' inside PCBJam',
    'provider:download': 'Download parts you choose from ' + ORIGIN + ' into a team library',
  });
  assert.throws(() => providerPolicyText('http://kicad.acme-parts.example'));
});

test('panel headers: both isolation headers are required, case-insensitively', () => {
  assert.deepEqual(checkPanelHeaders(new Headers({ 'Cross-Origin-Embedder-Policy': 'Require-Corp', 'cross-origin-resource-policy': 'cross-origin' })), { ok: true, missing: [] });
  const check = checkPanelHeaders({ 'cross-origin-embedder-policy': 'credentialless' });
  assert.equal(check.ok, false);
  assert.deepEqual(check.missing, [
    { name: 'cross-origin-embedder-policy', expected: 'require-corp', actual: 'credentialless' },
    { name: 'cross-origin-resource-policy', expected: 'cross-origin', actual: '' },
  ]);
  assert.equal(checkPanelHeaders(null).missing.length, 2);
});
