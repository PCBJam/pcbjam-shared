import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LOGIN_CALLBACK_PREFIX, OAUTH_SERVER_WELL_KNOWN_PATH, PROVIDER_LIMITS, RPC_VERSION, WELL_KNOWN_PATH, assetAllowed, checkPanelFraming, checkPanelHeaders,
  loginCallbackPath, loginRedirectUri, metadataUrl, oauthClientId, providerAuthSnapshot, providerPermissions, providerPolicyText,
  sameProviderAuth, urlOrigin, validateEnvelope, validateInlineBundle, validateOAuthServerMetadata, validatePlaceManifest,
  validateProviderMetadata,
} from '../remote-provider-contract.mjs';

const ORIGIN = 'https://kicad.acme-parts.example';
const metadata = patch => ({
  provider_name: 'Acme Parts', provider_version: '1.0.0', api_base_url: ORIGIN + '/api', panel_url: ORIGIN + '/panel',
  auth: { type: 'none' }, capabilities: { web_ui_v1: true, parts_v1: true, direct_downloads_v1: true, inline_payloads_v1: true },
  max_download_bytes: 1048576, supported_asset_types: ['symbol', 'footprint'], parts: { endpoint_template: '/v1/parts/{part_id}' },
  ...patch,
});
// A provider with sign-in: its sign-in server is a sibling host on its registered domain.
const ISSUER = 'https://auth.acme-parts.example';
const WITH_SIGN_IN = { allowedAuthTypes: ['none', 'oauth2'] };
const signIn = (patch, auth = {}) => metadata({
  session_bootstrap_url: ORIGIN + '/api/kicad/session',
  auth: { type: 'oauth2', metadata_url: ISSUER + OAUTH_SERVER_WELL_KNOWN_PATH, client_id: 'kicad-remote-symbols', scopes: ['parts.read', 'offline_access'], ...auth },
  ...patch,
});
const server = patch => ({
  issuer: ISSUER, authorization_endpoint: ISSUER + '/oauth/authorize', token_endpoint: ISSUER + '/oauth/token',
  response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'], code_challenge_methods_supported: ['S256'],
  token_endpoint_auth_methods_supported: ['none'], authorization_response_iss_parameter_supported: true, ...patch,
});
// Stands in for the public suffix list: the last two labels (reserved .example names follow its default rule).
const lastTwo = host => host.split('.').slice(-2).join('.');
const FOR_ACME = { metadataUrl: ISSUER + OAUTH_SERVER_WELL_KNOWN_PATH, origin: ORIGIN, registeredDomain: lastTwo };
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
    [metadata({ auth: { type: 'oauth2', metadata_url: ISSUER + OAUTH_SERVER_WELL_KNOWN_PATH, client_id: 'x' }, session_bootstrap_url: ORIGIN + '/s' }), /oauth2 are not supported/],
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
  // oauth2 documents are schema-valid; a caller that does not allow sign-in rejects them.
  assert.equal(validateProviderMetadata(signIn({}), WITH_SIGN_IN).authType, 'oauth2');
});

test('sign-in: the provider document declares one checked configuration', () => {
  const meta = validateProviderMetadata(signIn({}), WITH_SIGN_IN);
  assert.deepEqual(meta.auth, { type: 'oauth2', metadataUrl: ISSUER + OAUTH_SERVER_WELL_KNOWN_PATH, clientId: 'kicad-remote-symbols', scopes: ['parts.read', 'offline_access'] });
  assert.equal(meta.sessionBootstrapUrl, ORIGIN + '/api/kicad/session');
  assert.equal('auth' in validateProviderMetadata(metadata({})), false, 'a document without sign-in reads as before');
  assert.deepEqual(validateProviderMetadata(signIn({}, { scopes: undefined }), WITH_SIGN_IN).auth.scopes, []);
  const cases = [
    [signIn({}, { metadata_url: ISSUER + OAUTH_SERVER_WELL_KNOWN_PATH + '?tenant=a' }), /auth\.metadata_url must be a plain URL/],
    [signIn({}, { metadata_url: 'https://AUTH.acme-parts.example' + OAUTH_SERVER_WELL_KNOWN_PATH }), /auth\.metadata_url must be a plain URL/],
    [signIn({}, { metadata_url: ISSUER + '/.well-known/o auth' }), /path PCBJam cannot call/],
    [signIn({}, { metadata_url: 'http://auth.acme-parts.example' + OAUTH_SERVER_WELL_KNOWN_PATH }), /must use https/],
    [signIn({}, { metadata_url: 'https://auth.acme-parts.example:8443' + OAUTH_SERVER_WELL_KNOWN_PATH }), /default https port/],
    [signIn({}, { client_id: 'kicad\nremote' }), /auth\.client_id/],
    [signIn({}, { client_id: 'x'.repeat(201) }), /auth\.client_id/],
    [signIn({}, { client_id: 'kic\u00e4d' }), /auth\.client_id/],
    [signIn({}, { scopes: ['parts read'] }), /auth\.scopes/],
    [signIn({}, { scopes: ['a', 'a'] }), /auth\.scopes/],
    [signIn({}, { scopes: ['say"hi'] }), /auth\.scopes/],
    [signIn({}, { scopes: Array.from({ length: 33 }, (_, i) => 's' + i) }), /auth\.scopes/],
    [signIn({ session_bootstrap_url: 'https://api.acme-parts.example/session' }), /origin of panel_url/],
    [signIn({ session_bootstrap_url: ORIGIN + '/api/kicad/session?next=1' }), /session_bootstrap_url must be a plain URL/],
    [signIn({ session_bootstrap_url: undefined }), /session_bootstrap_url/],
  ];
  for (const [doc, pattern] of cases) assert.throws(() => validateProviderMetadata(doc, WITH_SIGN_IN), pattern, JSON.stringify(doc));
  assert.equal(oauthClientId('pcbjam editor'), 'pcbjam editor');
  for (const bad of ['', 'x'.repeat(201), 'tab\there', 7, undefined]) assert.throws(() => oauthClientId(bad), /printable/);
});

test('sign-in server: its document is tied to the provider and able to do what PCBJam needs', () => {
  assert.deepEqual(validateOAuthServerMetadata(server({}), FOR_ACME), {
    issuer: ISSUER, authorizationEndpoint: ISSUER + '/oauth/authorize', tokenEndpoint: ISSUER + '/oauth/token',
  });
  // Unknown keys are fine (such a document has many), and the provider's own host may be the issuer.
  validateOAuthServerMetadata(server({ registration_endpoint: ISSUER + '/register', jwks_uri: 'https://elsewhere.example/keys' }), FOR_ACME);
  validateOAuthServerMetadata(server({ issuer: ORIGIN, authorization_endpoint: ORIGIN + '/authorize', token_endpoint: ORIGIN + '/token' }),
    { ...FOR_ACME, metadataUrl: ORIGIN + OAUTH_SERVER_WELL_KNOWN_PATH });
  validateOAuthServerMetadata(server({ grant_types_supported: undefined }), FOR_ACME);
  const cases = [
    [server({ issuer: undefined }), /issuer must be an https origin/],
    [server({ issuer: ISSUER + '/' }), /bare origin/],
    [server({ issuer: ISSUER + '/tenant' }), /bare origin/],
    [server({ issuer: 'http://auth.acme-parts.example' }), /issuer must be an https origin/],
    [server({ issuer: 'https://auth.acme-parts.example:8443' }), /issuer must be an https origin/],
    [server({ issuer: 'https://203.0.113.7' }), /issuer must be an https origin/],
    // The document says another issuer than the address it was read from (RFC 8414 3.3).
    [server({ issuer: 'https://login.acme-parts.example' }), /auth\.metadata_url must be the issuer/],
    [server({ authorization_endpoint: 'https://other.acme-parts.example/oauth/authorize' }), /authorization_endpoint must be on the issuer/],
    [server({ token_endpoint: 'https://evil.example/oauth/token' }), /token_endpoint must be on the issuer/],
    [server({ token_endpoint: ISSUER + '/oauth/token?x=1' }), /token_endpoint must be a plain URL/],
    [server({ token_endpoint: undefined }), /missing token_endpoint/],
    [server({ authorization_endpoint: 7 }), /missing authorization_endpoint/],
    [server({ response_types_supported: ['token'] }), /code in response_types_supported/],
    [server({ response_types_supported: undefined }), /code in response_types_supported/],
    [server({ grant_types_supported: ['client_credentials'] }), /authorization_code in grant_types_supported/],
    [server({ code_challenge_methods_supported: ['plain'] }), /S256 in code_challenge_methods_supported/],
    [server({ code_challenge_methods_supported: undefined }), /S256/],
    [server({ token_endpoint_auth_methods_supported: ['client_secret_basic'] }), /none in token_endpoint_auth_methods_supported/],
    [server({ token_endpoint_auth_methods_supported: undefined }), /none in token_endpoint_auth_methods_supported/],
    [server({ authorization_response_iss_parameter_supported: undefined }), /RFC 9207/],
    [server({ authorization_response_iss_parameter_supported: 'true' }), /RFC 9207/],
    [[], /JSON object/],
    [null, /JSON object/],
  ];
  for (const [doc, pattern] of cases) assert.throws(() => validateOAuthServerMetadata(doc, FOR_ACME), pattern, JSON.stringify(doc));
  assert.throws(() => validateOAuthServerMetadata(server({}), { ...FOR_ACME, registeredDomain: undefined }), /needs registeredDomain/);
});

test('sign-in server: it has to be on the provider\'s own registered domain', () => {
  const at = (issuer, origin, registeredDomain) => validateOAuthServerMetadata(
    server({ issuer, authorization_endpoint: issuer + '/oauth/authorize', token_endpoint: issuer + '/oauth/token' }),
    { metadataUrl: issuer + OAUTH_SERVER_WELL_KNOWN_PATH, origin, registeredDomain });
  // Two customers of one shared suffix are two sites: the list's private section says so.
  const shared = host => (host.endsWith('.pages.example') ? host.split('.').slice(-3).join('.') : host === 'pages.example' ? null : lastTwo(host));
  at('https://auth.acme-parts.example', 'https://kicad.acme-parts.example', lastTwo);
  at('https://api.datasheets.example', 'https://datasheets.example', lastTwo);
  assert.throws(() => at('https://auth.other-parts.example', ORIGIN, lastTwo), /provider's own registered domain/);
  assert.throws(() => at('https://evil.pages.example', 'https://acme.pages.example', shared), /provider's own registered domain/);
  at('https://auth.acme.pages.example', 'https://kicad.acme.pages.example', shared);
  // A name that is itself a suffix, or an answer the list cannot give, is never "the same".
  assert.throws(() => at('https://auth.acme-parts.example', ORIGIN, () => null), /provider's own registered domain/);
  assert.throws(() => at('https://auth.acme-parts.example', ORIGIN, () => ''), /provider's own registered domain/);
  // Fixtures on loopback: the same host stands in, and only when the caller opts in.
  const local = issuer => ({ issuer, authorization_endpoint: issuer + '/authorize', token_endpoint: issuer + '/token' });
  const fixture = { metadataUrl: 'http://127.0.0.1:4500' + OAUTH_SERVER_WELL_KNOWN_PATH, origin: 'http://127.0.0.1:4400', allowInsecureLocalhost: true };
  assert.equal(validateOAuthServerMetadata(server(local('http://127.0.0.1:4500')), fixture).tokenEndpoint, 'http://127.0.0.1:4500/token');
  assert.throws(() => validateOAuthServerMetadata(server(local('http://127.0.0.1:4500')), { ...fixture, origin: 'http://localhost:4400' }), /provider's own registered domain/);
  assert.throws(() => validateOAuthServerMetadata(server(local('http://127.0.0.1:4500')), { ...fixture, allowInsecureLocalhost: false }), /issuer must be an https origin/);
});

test('sign-in: one pinned configuration, compared again at panel open', () => {
  const meta = validateProviderMetadata(signIn({}), WITH_SIGN_IN);
  const srv = validateOAuthServerMetadata(server({}), FOR_ACME);
  const pinned = providerAuthSnapshot(meta, srv);
  assert.deepEqual(pinned, {
    type: 'oauth2', metadataUrl: ISSUER + OAUTH_SERVER_WELL_KNOWN_PATH, issuer: ISSUER, clientId: 'kicad-remote-symbols', clientIdFrom: 'metadata',
    scopes: ['parts.read', 'offline_access'], authorizationEndpoint: ISSUER + '/oauth/authorize', tokenEndpoint: ISSUER + '/oauth/token',
  });
  const own = providerAuthSnapshot(meta, srv, 'pcbjam');
  assert.equal(own.clientId, 'pcbjam');
  assert.equal(own.clientIdFrom, 'package');
  assert.throws(() => providerAuthSnapshot(meta, srv, 'bad\nclient'), /printable/);
  // A provider without sign-in has no pinned configuration, and a package cannot name a client for it.
  const plain = validateProviderMetadata(metadata({}));
  assert.equal(providerAuthSnapshot(plain, undefined), undefined);
  assert.throws(() => providerAuthSnapshot(plain, undefined, 'pcbjam'), /needs a provider with sign-in/);

  const snapshot = { ...meta, auth: pinned };
  const fresh = patch => validateProviderMetadata(signIn(patch.doc ?? {}, patch.auth ?? {}), WITH_SIGN_IN);
  assert.equal(sameProviderAuth(snapshot, fresh({})), true);
  assert.equal(sameProviderAuth(snapshot, fresh({ auth: { scopes: ['offline_access', 'parts.read'] } })), true, 'scope order is irrelevant');
  assert.equal(sameProviderAuth(snapshot, fresh({ auth: { scopes: ['parts.read'] } })), false);
  assert.equal(sameProviderAuth(snapshot, fresh({ auth: { client_id: 'another' } })), false);
  assert.equal(sameProviderAuth(snapshot, fresh({ auth: { metadata_url: ORIGIN + OAUTH_SERVER_WELL_KNOWN_PATH } })), false);
  assert.equal(sameProviderAuth(snapshot, fresh({ doc: { session_bootstrap_url: ORIGIN + '/api/kicad/session2' } })), false);
  assert.equal(sameProviderAuth(snapshot, fresh({ doc: { panel_url: ORIGIN + '/panel2' } })), false, 'the bootstrap names the panel as next_url');
  assert.equal(sameProviderAuth(snapshot, validateProviderMetadata(metadata({}))), false, 'sign-in switched off is a change');
  // The package's own client: the document's client is desktop KiCad's and is not compared.
  assert.equal(sameProviderAuth({ ...meta, auth: own }, fresh({ auth: { client_id: 'another' } })), true);
  // A release without sign-in: only switching sign-in on is a change; the panel may move on its origin.
  assert.equal(sameProviderAuth(plain, validateProviderMetadata(metadata({ panel_url: ORIGIN + '/panel2' }))), true);
  assert.equal(sameProviderAuth(plain, fresh({})), false);
});

test('sign-in: the callback address names the sign-in server', () => {
  assert.equal(LOGIN_CALLBACK_PREFIX, '/remote-provider-callback/');
  assert.equal(loginCallbackPath(ISSUER), '/remote-provider-callback/auth.acme-parts.example');
  assert.equal(loginRedirectUri('https://editor.pcbjam.com', ISSUER), 'https://editor.pcbjam.com/remote-provider-callback/auth.acme-parts.example');
  assert.equal(loginRedirectUri('http://localhost:5173', 'http://127.0.0.1:4500'), 'http://localhost:5173/remote-provider-callback/127.0.0.1:4500');
  assert.throws(() => loginRedirectUri('https://editor.pcbjam.com/', ISSUER), /bare origin/);
  assert.throws(() => loginRedirectUri('https://editor.pcbjam.com/app', ISSUER), /bare origin/);
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
  // Sign-in is part of what an operator approves: each configuration has its own text, and so its own approval.
  const pinned = { type: 'oauth2', issuer: ISSUER, clientId: 'kicad-remote-symbols', clientIdFrom: 'metadata', scopes: ['parts.read'] };
  assert.equal(providerPolicyText(ORIGIN, undefined), providerPolicyText(ORIGIN), 'without sign-in the text is what it always was');
  assert.equal(providerPolicyText(ORIGIN, pinned), JSON.stringify({ version: 1, kind: 'remote-provider', origin: ORIGIN, auth: { type: 'oauth2', issuer: ISSUER } }));
  assert.equal(providerPolicyText(ORIGIN, { ...pinned, clientId: 'changed-by-the-provider' }), providerPolicyText(ORIGIN, pinned), 'the document\'s own client is on the approved origin');
  assert.equal(providerPolicyText(ORIGIN, { ...pinned, clientId: 'pcbjam', clientIdFrom: 'package' }),
    JSON.stringify({ version: 1, kind: 'remote-provider', origin: ORIGIN, auth: { type: 'oauth2', issuer: ISSUER, clientId: 'pcbjam' } }));
  assert.notEqual(providerPolicyText(ORIGIN, { ...pinned, issuer: 'https://login.acme-parts.example' }), providerPolicyText(ORIGIN, pinned));
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

test('panel framing: frame-ancestors must let the editor in; without one, X-Frame-Options decides', () => {
  const EDITOR = 'https://editor.pcbjam.example';
  const csp = (value) => checkPanelFraming({ 'content-security-policy': value }, EDITOR);
  const xfo = (value) => checkPanelFraming({ 'x-frame-options': value }, EDITOR);
  assert.deepEqual(checkPanelFraming({}, EDITOR), { ok: true });
  assert.deepEqual(checkPanelFraming(null, EDITOR), { ok: true });
  assert.deepEqual(checkPanelFraming(new Headers({ 'Content-Security-Policy': "default-src 'self'" }), EDITOR), { ok: true });
  // The sources a browser matches against the editor's origin.
  for (const allowed of ['frame-ancestors ' + EDITOR, 'FRAME-ANCESTORS ' + EDITOR.toUpperCase(), "default-src 'self'; frame-ancestors 'self' " + EDITOR, 'frame-ancestors *', 'frame-ancestors https:',
    'frame-ancestors https://*.pcbjam.example', 'frame-ancestors *.pcbjam.example', 'frame-ancestors editor.pcbjam.example', 'frame-ancestors https://editor.pcbjam.example:443',
    'frame-ancestors https://editor.pcbjam.example:*', 'frame-ancestors http://editor.pcbjam.example', 'frame-ancestors https://other.example ' + EDITOR + '/any/path'])
    assert.deepEqual(csp(allowed), { ok: true }, allowed);
  for (const closed of ["frame-ancestors 'none'", "frame-ancestors 'self'", 'frame-ancestors', 'frame-ancestors https://other.example', 'frame-ancestors https://pcbjam.example',
    'frame-ancestors https://*.editor.pcbjam.example', 'frame-ancestors http:// ' , 'frame-ancestors https://editor.pcbjam.example:8443', 'frame-ancestors wss:', 'frame-ancestors https://evil-editor.pcbjam.example.attacker.example'])
    assert.equal(csp(closed).ok, false, closed);
  assert.deepEqual(csp("script-src 'self'; frame-ancestors 'self' https://kicad.example"), { ok: false, header: 'content-security-policy', actual: "frame-ancestors 'self' https://kicad.example" });
  // Two policies: both have to let the editor in. The first frame-ancestors of a policy counts.
  assert.equal(csp('frame-ancestors ' + EDITOR + ", frame-ancestors 'none'").ok, false);
  assert.equal(csp('frame-ancestors ' + EDITOR + ", default-src 'self'").ok, true);
  assert.equal(csp("frame-ancestors 'none'; frame-ancestors " + EDITOR).ok, false);
  // A port in the editor's address (local development) has to be named.
  assert.equal(checkPanelFraming({ 'content-security-policy': 'frame-ancestors http://localhost' }, 'http://localhost:3048').ok, false);
  assert.equal(checkPanelFraming({ 'content-security-policy': 'frame-ancestors http://localhost:3048' }, 'http://localhost:3048').ok, true);
  assert.equal(checkPanelFraming({ 'content-security-policy': 'frame-ancestors https://localhost:3048' }, 'http://localhost:3048').ok, false);
  // X-Frame-Options, read as browsers do.
  assert.deepEqual(xfo('SAMEORIGIN'), { ok: false, header: 'x-frame-options', actual: 'SAMEORIGIN' });
  assert.equal(xfo('deny').ok, false);
  assert.equal(xfo('DENY, SAMEORIGIN').ok, false);
  assert.equal(xfo('sameorigin, sameorigin').ok, false);
  assert.equal(xfo('ALLOW-FROM https://kicad.example').ok, true, 'browsers ignore ALLOW-FROM');
  assert.equal(xfo('ALLOWALL').ok, true);
  assert.equal(xfo('nonsense, other').ok, true);
  assert.equal(xfo('allowall, nonsense').ok, false, 'two values with a known one: browsers block');
  // With frame-ancestors, X-Frame-Options is ignored either way.
  assert.deepEqual(checkPanelFraming({ 'content-security-policy': 'frame-ancestors ' + EDITOR, 'x-frame-options': 'DENY' }, EDITOR), { ok: true });
  assert.equal(checkPanelFraming({ 'content-security-policy': "frame-ancestors 'self'", 'x-frame-options': 'ALLOWALL' }, EDITOR).ok, false);
});
