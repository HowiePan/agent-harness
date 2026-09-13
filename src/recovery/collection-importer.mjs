import { resolve } from 'node:path';
import { digestJson } from '../canonical.mjs';
import { inventoryTree, readJsonIfValid } from './inventory.mjs';

export class CollectionLegacyImporter {
  constructor() { this.id = 'collection-m2-b1-importer'; this.version = '1.0.0'; }

  async inventory({ legacyRoot }) {
    const inventory = await inventoryTree(legacyRoot);
    const facts = [];
    for (const file of inventory.files.filter(item => /(^|\/)(round|stage-report)\.json$/.test(item.path))) {
      const value = await readJsonIfValid(resolve(inventory.root, file.path));
      if (!value) { facts.push({ id: file.path, disposition: 'invalid', reason: 'invalid-json', sourceSha256: file.sha256 }); continue; }
      facts.push({ id: `${file.path}#schema`, disposition: ['0.2', '0.4'].includes(String(value.version)) ? 'legacy-only' : 'invalid', reason: 'round-is-profile-projection-not-authority', version: value.version ?? null, sourceSha256: file.sha256 });
      if (Array.isArray(value.leases) && value.leases.length) facts.push({ id: `${file.path}#leases`, disposition: 'invalid', reason: 'legacy-agent-identity-cannot-cross-epoch', count: value.leases.length, sourceSha256: file.sha256 });
      const items = value.items ?? [];
      const completed = items.filter(item => item.status === 'completed');
      const blocked = items.filter(item => ['blocked', 'failed-budget'].includes(item.status));
      if (completed.length) facts.push({ id: `${file.path}#completed`, disposition: 'stale-revalidate', reason: 'path-evidence-is-not-current-evidence', count: completed.length, sourceSha256: file.sha256 });
      if (blocked.length) facts.push({ id: `${file.path}#blocked`, disposition: 'log-only', reason: 'blockers-require-current-artifact-assessment', count: blocked.length, sourceSha256: file.sha256 });
    }
    const report = { protocolVersion: '1.0', importer: { id: this.id, version: this.version }, kind: 'collection-m2-b1', legacyRoot: inventory.root, sourceDigest: inventory.sourceDigest, fileCount: inventory.files.length, facts, allowedDispositions: ['verified-current', 'stale-revalidate', 'log-only', 'invalid', 'superseded'] };
    return { ...report, assessmentDigest: digestJson(report) };
  }
}
