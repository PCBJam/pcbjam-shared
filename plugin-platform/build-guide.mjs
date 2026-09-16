import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { exportStarter } from './export-starter.mjs';
import path from 'node:path';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkRehype from 'remark-rehype';
import rehypeStringify from 'rehype-stringify';

const ROOT=path.dirname(fileURLToPath(import.meta.url));
const PAGES = [
  ['0008-local-plugin-development.md', 'guide.html', ''],
  ['0009-plugin-api-and-permissions.md', 'guide-api.html', '/api'],
  ['0010-plugin-security-and-testing.md', 'guide-security.html', '/security'],
];
const escape = text => String(text).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const textOf = node => node.value ?? (node.children ?? []).map(textOf).join('');
const element = (tagName, properties, children) => ({type:'element',tagName,properties,children});
const text = value => ({type:'text',value});

/** Render repository-owned Markdown at build time. Never render uploaded plugins. */
export async function buildGuide(output, {base='/plugin-guide',sourceDir=path.join(ROOT,'docs'),legacy=false}={}) {
  const BASE=base;
  const pages=legacy?[...PAGES,['0004-plugin-platform-quickjs.md','guide-plan.html','/plan'],['writing-a-plugin.md','guide-legacy.html','/legacy']]:PAGES;
  await mkdir(output,{recursive:true});
  const outputDirectory=output;
  for (const [source, output, route] of pages) {
    const markdown = await readFile(path.join(sourceDir, source), 'utf8');
    const sections = [], ids = new Map();
    let title = '';
    function prepare() {
      return tree => {
        function walk(node) {
          if (node.type === 'heading') {
            const label = textOf(node);
            const base = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
            const count = ids.get(base) ?? 0; ids.set(base, count + 1);
            const id = base + (count ? '-' + count : '');
            node.data = {hProperties:{id}};
            if (node.depth === 1 && !title) title = label;
            if (node.depth === 2) sections.push({id,label});
          }
          if (node.type === 'link') {
            const url = node.url;
            const related = pages.find(([file]) => url.split('#')[0] === file);
            if (related) node.url = BASE + related[2] + (url.includes('#') ? '#' + url.split('#')[1] : '');
            else if (url.endsWith('/examples/external-symbol-import')) node.url = BASE + '#example-package';
            else if (url.endsWith('/examples/external-symbol-import/sdk.d.ts')) node.url = BASE + '/download/sdk.d.ts';
            else if (/^https?:\/\//i.test(url)) node.data = {hProperties:{target:'_blank',rel:'noopener noreferrer'}};
            else if (!url.startsWith('#') && !url.startsWith(BASE + '/download/')) {
              // Other repository-only references have no app route. Keep the
              // readable label instead of sending the reader to a broken URL.
              node.type = 'emphasis'; delete node.url;
            }
          }
          for (const child of node.children ?? []) walk(child);
        }
        walk(tree);
        tree.children = tree.children.filter(node => !(node.type === 'heading' && node.depth === 1));
      };
    }
    function polish() {
      return tree => {
        function walk(node) {
          for (let i = 0; i < (node.children?.length ?? 0); i++) {
            const child = node.children[i];
            if (child.tagName === 'table') {
              node.children[i] = element('div', {className:['table-wrap']}, [child]);
            } else if (child.tagName === 'pre') {
              const code = child.children.find(c => c.tagName === 'code');
              const language = code?.properties?.className?.find(c => c.startsWith('language-'))?.slice(9);
              child.properties = {...child.properties, 'data-language': language ?? 'Files'};
              if (!route && language === 'mermaid') {
                node.children[i] = element('figure', {className:['architecture']}, [
                  element('figcaption', {}, [text('One request, four steps')]),
                  element('ol', {}, ['Plugin UI','QuickJS in Worker','PCBJam checks + your confirmation','Native editor placement'].map(label => element('li', {}, [text(label)]))),
                  element('p', {}, [text('The user’s canvas click commits the item through the editor’s normal Undo and collaboration flow.')]),
                ]);
              }
            } else walk(child);
          }
        }
        walk(tree);
      };
    }
    const html = String(await unified().use(remarkParse).use(remarkGfm).use(prepare)
      .use(remarkRehype).use(polish).use(rehypeStringify).process(markdown));
    const toc = sections.map(s => `<li><a href="#${escape(s.id)}">${escape(s.label)}</a></li>`).join('');
    const example = route ? '' : `<section class="downloads" id="example-package" aria-label="Example plugin downloads">
      <div><span class="eyebrow">TYPESCRIPT + REACT STARTER</span><h2>External Symbol Import</h2><p>Edit readable TypeScript and React source, or install the built example to try it.</p></div>
      <div class="download-links"><a class="primary" href="${BASE}/download/external-symbol-import-source.zip" download>Download TypeScript + React source <span aria-hidden="true">↓</span></a>
      <a href="${BASE}/download/external-symbol-import.zip" download>Download installable plugin ZIP <span aria-hidden="true">↓</span></a>
      <a href="${BASE}/download/sample-symbols.kicad_sym" download>Sample symbol library <span aria-hidden="true">↓</span></a>
      <a href="${BASE}/download/sdk.d.ts" download>SDK type declarations <span aria-hidden="true">↓</span></a></div>
    </section>`;
    await writeFile(path.join(outputDirectory, output), `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${route ? escape(title) : 'Plugin developer guide'} · PCBJam</title><link rel="stylesheet" href="${BASE}/guide.css"></head>
<body><a class="skip-link" href="#content">Skip to guide</a>
<header class="site-header"><a class="brand" href="${BASE}" aria-label="PCBJam plugin developer guide"><span class="brand-mark" aria-hidden="true">P</span>PCBJam <span class="divider">/</span><span class="header-label">Developers</span></a><span class="badge">Preview SDK</span></header>
<div class="layout"><aside class="contents"><details open><summary>On this page</summary><nav aria-label="Guide sections"><ul>${toc}</ul></nav></details>
<nav aria-label="Developer references"><a class="related" href="${BASE}">Developer guide</a><a class="related" href="${BASE}/api">API and permissions catalog</a><a class="related" href="${BASE}/security">Security and tests</a>${legacy?`<a class="related" href="${BASE}/plan">Platform implementation plan</a>`:''}</nav></aside>
<main id="content"><div class="intro"><p class="eyebrow">${route ? 'REFERENCE' : 'PLUGIN DEVELOPMENT'}</p><h1>${route ? escape(title) : 'Build a plugin for PCBJam'}</h1><p class="lead">${route ? 'Companion documentation for the plugin platform.' : 'Your logic. Your interface. A small API that connects them to the editor.'}</p></div>
${example}<article>${html}</article><footer>PCBJam developer documentation · Generated from the repository guide.<a href="#content">Back to top ↑</a></footer></main></div></body></html>`);
  }
  await copyFile(path.join(ROOT,'guide.css'),path.join(output,'guide.css'));
  // Export the same validated example used for manual testing, not an installed
  // publisher release. Only the named downloads are served by guide.mjs.
  await exportStarter(path.join(output,'guide-downloads'));
  if(!legacy){
    const {rename,rm}=await import('node:fs/promises');
    await rename(path.join(output,'guide.html'),path.join(output,'index.html'));
    for(const name of ['api','security']){await mkdir(path.join(output,name),{recursive:true});await rename(path.join(output,`guide-${name}.html`),path.join(output,name,'index.html'));}
    await rm(path.join(output,'download'),{recursive:true,force:true});
    await rename(path.join(output,'guide-downloads'),path.join(output,'download'));
    await copyFile(path.join(output,'download/external-symbol-import/sdk.d.ts'),path.join(output,'download/sdk.d.ts'));
  }
}
