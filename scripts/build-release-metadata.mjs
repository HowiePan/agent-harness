import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { digestJson, sha256 } from '../src/canonical.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const included = ['bin', 'src', 'schemas', 'profiles', 'plugins', 'integrations', 'docs', 'examples', 'scripts/check-context-budget.mjs', 'package.json', 'README.md', 'CONTRIBUTING.md', 'SECURITY.md', 'LICENSE'];
const files = [];
const visit = async file => {
  const info = await stat(file);
  if (info.isDirectory()) for (const name of await readdir(file)) await visit(resolve(file, name));
  else {
    const bytes = await readFile(file);
    files.push({ path: relative(root, file).replaceAll('\\', '/'), sha256: sha256(bytes), size: bytes.length });
  }
};
for (const name of included) try { await visit(resolve(root, name)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
files.sort((a, b) => a.path.localeCompare(b.path));
const packageJson = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
const manifest = { protocolVersion: '1.0', name: packageJson.name, version: packageJson.version, node: packageJson.engines.node, license: packageJson.license, files, packageDigest: digestJson(files), metadataFiles: ['release-manifest.json', 'sbom.spdx.json'], generatedAt: new Date().toISOString() };
await writeFile(resolve(root, 'release-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
const sbom = { spdxVersion: 'SPDX-2.3', dataLicense: 'CC0-1.0', SPDXID: 'SPDXRef-DOCUMENT', name: `${packageJson.name}-${packageJson.version}`, documentNamespace: `https://agent-harness.local/spdx/${manifest.packageDigest}`, creationInfo: { created: manifest.generatedAt, creators: ['Tool: agent-harness-build-release-metadata-1.0.0'] }, packages: [{ name: packageJson.name, SPDXID: 'SPDXRef-Package', versionInfo: packageJson.version, downloadLocation: 'NOASSERTION', filesAnalyzed: true, licenseConcluded: 'NOASSERTION', licenseDeclared: packageJson.license, checksums: [{ algorithm: 'SHA256', checksumValue: manifest.packageDigest }] }], relationships: [{ spdxElementId: 'SPDXRef-DOCUMENT', relationshipType: 'DESCRIBES', relatedSpdxElement: 'SPDXRef-Package' }] };
await writeFile(resolve(root, 'sbom.spdx.json'), `${JSON.stringify(sbom, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({ ok: true, packageDigest: manifest.packageDigest, fileCount: files.length, manifest: 'release-manifest.json', sbom: 'sbom.spdx.json' }, null, 2));
