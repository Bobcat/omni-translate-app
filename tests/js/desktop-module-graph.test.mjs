import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const desktopDocumentUrl = new URL('https://example.test/static/desktop/index.html');

function readRepoUrl(url) {
  return readFileSync(`${repoRoot}${url.pathname}`, 'utf8');
}

function relativeImports(source) {
  const specifiers = [];
  for (const pattern of [
    /\bfrom\s*['"]([^'"]+)['"]/g,
    /\bimport\s*['"]([^'"]+)['"]/g,
  ]) {
    for (const match of source.matchAll(pattern)) {
      if (match[1].startsWith('.')) specifiers.push(match[1]);
    }
  }
  return specifiers;
}

function collectModuleGraph(entryUrl) {
  const pending = [entryUrl];
  const visited = new Set();
  const searchesByPath = new Map();
  while (pending.length) {
    const url = pending.pop();
    if (visited.has(url.href)) continue;
    visited.add(url.href);
    const searches = searchesByPath.get(url.pathname) || new Set();
    searches.add(url.search);
    searchesByPath.set(url.pathname, searches);
    for (const specifier of relativeImports(readRepoUrl(url))) {
      pending.push(new URL(specifier, url));
    }
  }
  return searchesByPath;
}

test('desktop module graph uses one URL per source module', () => {
  const html = readRepoUrl(desktopDocumentUrl);
  const entryMatch = html.match(/<script\s+type="module"\s+src="([^"]+)"/);
  assert.ok(entryMatch, 'desktop module entry is present');

  const graph = collectModuleGraph(new URL(entryMatch[1], desktopDocumentUrl));
  const duplicateUrls = [...graph]
    .filter(([, searches]) => searches.size > 1)
    .map(([pathname, searches]) => `${pathname}: ${[...searches].join(', ')}`);
  assert.deepEqual(duplicateUrls, []);

  const preloadHrefs = [...html.matchAll(/<link\s+rel="modulepreload"\s+href="([^"]+)"/g)]
    .map((match) => match[1]);
  for (const href of preloadHrefs) {
    const preloadUrl = new URL(href, desktopDocumentUrl);
    const graphSearches = graph.get(preloadUrl.pathname);
    if (!graphSearches) continue;
    assert.ok(
      graphSearches.has(preloadUrl.search),
      `${preloadUrl.pathname} is preloaded with a different cache version`,
    );
  }
});
