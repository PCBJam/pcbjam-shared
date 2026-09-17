import { inflateRawSync } from 'node:zlib';
import { createHash } from 'node:crypto';

export const LIMITS = { archive: 8 * 1024 * 1024, total: 12 * 1024 * 1024, file: 4 * 1024 * 1024, files: 32 };
export { default as PERMISSIONS } from './api-permissions.json' with { type: 'json' };
import PERMISSIONS from './api-permissions.json' with { type: 'json' };
import {validateEndpoints,backendPermissions} from './backend-contract.mjs';
const fail = message => { throw new Error(message); };
const metadataPath = name => name.split('/').some(part => part === '__MACOSX') || name.split('/').at(-1) === '.DS_Store' || name.split('/').at(-1).startsWith('._');
function validPath(name) {
  if (typeof name !== 'string' || name.length > 180 || !/^[A-Za-z0-9_./-]+$/.test(name) || name.startsWith('/') || name.split('/').some(p => !p || p === '.' || p === '..')) fail('Unsafe package path');
  return name;
}
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const b of bytes) { crc ^= b; for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)); }
  return (crc ^ 0xffffffff) >>> 0;
}

/** Bounded, single-disk ZIP reader. Never extracts paths onto the filesystem. */
export function readZip(bytes) {
  if (bytes.length > LIMITS.archive || bytes.length < 22) fail('ZIP must be smaller than 8 MiB');
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (bytes.readUInt32LE(i) === 0x06054b50 && i + 22 + bytes.readUInt16LE(i + 20) === bytes.length) { end = i; break; }
  }
  if (end < 0 || bytes.readUInt16LE(end + 4) || bytes.readUInt16LE(end + 6)) fail('Invalid or multi-disk ZIP');
  const count = bytes.readUInt16LE(end + 10), size = bytes.readUInt32LE(end + 12), start = bytes.readUInt32LE(end + 16);
  if (!count || count > LIMITS.files || bytes.readUInt16LE(end + 8) !== count || start + size !== end) fail('Invalid ZIP directory or too many files');
  const files = [], names = new Set(), ranges = [];
  let cursor = start, total = 0;
  for (let index = 0; index < count; index++) {
    if (cursor + 46 > end || bytes.readUInt32LE(cursor) !== 0x02014b50) fail('Invalid ZIP entry');
    const flags = bytes.readUInt16LE(cursor + 8), method = bytes.readUInt16LE(cursor + 10), crc = bytes.readUInt32LE(cursor + 16);
    const compressed = bytes.readUInt32LE(cursor + 20), expanded = bytes.readUInt32LE(cursor + 24);
    const n = bytes.readUInt16LE(cursor + 28), extra = bytes.readUInt16LE(cursor + 30), comment = bytes.readUInt16LE(cursor + 32);
    const mode = bytes.readUInt32LE(cursor + 38) >>> 16, local = bytes.readUInt32LE(cursor + 42);
    if (cursor + 46 + n + extra + comment > end || flags & ~0x808 || ![0, 8].includes(method) || bytes.readUInt16LE(cursor + 34)) fail('Unsupported ZIP entry');
    if ((mode & 0xf000) && ![0x8000, 0x4000].includes(mode & 0xf000)) fail('ZIP links and special files are forbidden');
    const rawName = bytes.subarray(cursor + 46, cursor + 46 + n);
    const name = new TextDecoder('utf-8', { fatal: true }).decode(rawName);
    cursor += 46 + n + extra + comment;
    const directory = name.endsWith('/');
    validPath(directory ? name.slice(0, -1) : name);
    if (names.has(name.toLowerCase())) fail('Duplicate ZIP path');
    names.add(name.toLowerCase());
    total += expanded;
    if (expanded > LIMITS.file || total > LIMITS.total || compressed > LIMITS.archive) fail('Expanded ZIP exceeds package limits');
    if (local + 30 > start || bytes.readUInt32LE(local) !== 0x04034b50) fail('Invalid ZIP local header');
    const ln = bytes.readUInt16LE(local + 26), le = bytes.readUInt16LE(local + 28), bodyStart = local + 30 + ln + le;
    if (bodyStart + compressed > start || bytes.readUInt16LE(local + 6) !== flags || bytes.readUInt16LE(local + 8) !== method || !bytes.subarray(local + 30, local + 30 + ln).equals(rawName)) fail('ZIP header mismatch');
    if (!(flags & 8) && (bytes.readUInt32LE(local + 14) !== crc || bytes.readUInt32LE(local + 18) !== compressed || bytes.readUInt32LE(local + 22) !== expanded)) fail('ZIP size mismatch');
    if (ranges.some(([a, b]) => local < b && bodyStart + compressed > a)) fail('Overlapping ZIP entries');
    ranges.push([local, bodyStart + compressed]);
    const packed = bytes.subarray(bodyStart, bodyStart + compressed);
    const body = method === 0 ? packed : inflateRawSync(packed, { maxOutputLength: Math.max(1, expanded) });
    if (body.length !== expanded || crc32(body) !== crc) fail('ZIP content mismatch');
    if (directory) { if (body.length) fail('Directory contains data'); continue; }
    if (metadataPath(name)) continue; // Finder metadata is bounded/validated, never executable content.
    files.push({ path: name, text: new TextDecoder('utf-8', { fatal: true }).decode(body) });
  }
  if (cursor !== end) fail('ZIP directory mismatch');
  return files;
}

function exact(object, keys) {
  if (!object || typeof object !== 'object' || Array.isArray(object) || Object.keys(object).some(k => !keys.includes(k))) fail('Unknown manifest field');
}
export function validatePackage(input, { legacyDigest = false } = {}) {
  if (!Array.isArray(input) || !input.length || input.length > LIMITS.files) fail('Package must contain 1–32 files');
  let files = input.map(file => {
    exact(file, ['path', 'text']); validPath(file.path);
    if (typeof file.text !== 'string' || Buffer.byteLength(file.text) > LIMITS.file || (!metadataPath(file.path) && file.text.includes('\0'))) fail('Invalid or oversized text file');
    return { path: file.path, text: file.text };
  });
  if (files.reduce((n, f) => n + Buffer.byteLength(f.text), 0) > LIMITS.total) fail('Package exceeds 12 MiB');
  files = files.filter(file => !metadataPath(file.path));
  if (!files.length) fail('Package has no plugin files');
  // A folder picker/ZIP may wrap the package in one top-level directory.
  if (!files.some(f => f.path === 'manifest.json')) {
    const prefix = files[0].path.split('/')[0] + '/';
    if (!files.every(f => f.path.startsWith(prefix))) fail('Put manifest.json at the package root');
    files = files.map(f => ({ ...f, path: f.path.slice(prefix.length) }));
  }
  const names = new Set();
  for (const file of files) {
    validPath(file.path);
    if (names.has(file.path.toLowerCase())) fail('Duplicate package path');
    names.add(file.path.toLowerCase());
    if (!['manifest.json', 'main.js', 'ui.html', 'README.md', 'LICENSE.txt', 'sdk.d.ts'].includes(file.path)) fail(`Unsupported package file: ${file.path}. Install bundled main.js and a self-contained ui.html. For the TypeScript/React starter, run npm run build locally and install dist/plugin or its generated ZIP.`);
  }
  const get = name => files.find(f => f.path === name)?.text;
  if (Buffer.byteLength(get('manifest.json') ?? '') > 16384) fail('Manifest exceeds 16 KiB');
  const manifest = JSON.parse(get('manifest.json') ?? fail('Missing manifest.json'));
  exact(manifest, ['apiVersion', 'id', 'name', 'version', 'description', 'main', 'ui', 'surfaces', 'permissions', 'endpoints']);
  const endpoints = validateEndpoints(manifest.endpoints);
  const requestedBackendPermissions=backendPermissions(endpoints);
  if (manifest.apiVersion !== 1 || typeof manifest.id !== 'string' || !/^[a-z][a-z0-9-]{2,63}$/.test(manifest.id) || typeof manifest.version !== 'string' || manifest.version.length > 32 || !/^\d+\.\d+\.\d+$/.test(manifest.version)) fail('Unsupported API version, plugin ID or version');
  if (typeof manifest.name !== 'string' || manifest.name.length < 1 || manifest.name.length > 80 || typeof manifest.description !== 'string' || manifest.description.length > 300) fail('Invalid plugin name or description');
  if (manifest.main !== 'main.js' || manifest.ui !== 'ui.html' || !get('main.js') || !get('ui.html')) fail('main.js and ui.html are required');
  if (Buffer.byteLength(get('main.js')) > 1024 * 1024 || Buffer.byteLength(get('ui.html')) > 512 * 1024) fail('Logic/UI entry exceeds its limit');
  for (const [key, allowed] of [['surfaces', ['editor:eeschema', 'editor:pcbnew']], ['permissions', [...Object.keys(PERMISSIONS), ...Object.keys(requestedBackendPermissions)]]]) {
    const values = manifest[key];
    if (!Array.isArray(values) || !values.length || values.length > allowed.length || new Set(values).size !== values.length || values.some(v => !allowed.includes(v))) fail(`Unsupported ${key}`);
  }
  if(Object.keys(requestedBackendPermissions).some(p=>!manifest.permissions.includes(p))) fail('Backend declarations require their network and identity permissions');
  if (!manifest.permissions.includes('ui:custom') || !manifest.permissions.includes('ui:project-data')) fail('Custom UI and data disclosure permissions are required');
  if (/<script\b[^>]*\bsrc\s*=|<link\b[^>]*\bhref\s*=/i.test(get('ui.html'))) fail('Bundle scripts and styles inline in ui.html; remote/module imports are not supported');
  files.sort((a, b) => legacyDigest ? a.path.localeCompare(b.path) : (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const digest = createHash('sha256').update(JSON.stringify(files)).digest('hex');
  const fileMetadata = Object.fromEntries(files.map(f => [f.path, {
    sha256: createHash('sha256').update(f.text).digest('hex'), bytes: Buffer.byteLength(f.text),
  }]));
  const policyDigest = createHash('sha256').update(JSON.stringify({ apiVersion: 1, permissions: [...manifest.permissions].sort(), ...(endpoints?{backendPolicyVersion:1,endpoints}: {}) })).digest('hex');
  return { digest, manifest, files, fileMetadata, policyDigest, validationVersion: endpoints ? 3 : 2 };
}
