import { resolve } from 'node:path';
import { digestJson } from '../canonical.mjs';
import { inventoryTree, readJsonIfValid } from './inventory.mjs';

export class CardWorldLegacyImporter {
  constructor() { this.id = 'cardworld-t1-t2-importer'; this.version = '1.0.0'; }

  async inventory({ legacyRoot }) {
    const inventory = await inventoryTree(legacyRoot);
    const facts = [];
    for (const file of inventory.files.filter(item => item.path.endsWith('.json'))) {
      const value = await readJsonIfValid(resolve(inventory.root, file.path));
      if (!value) { facts.push({ id: file.path, disposition: 'invalid', reason: 'invalid-json', sourceSha256: file.sha256 }); continue; }
      const protocol = value.protocol ?? value.protocolVersion ?? null;
      const leases = value.leases ?? value.dispatches ?? [];
      if (Array.isArray(leases) && leases.length) facts.push({ id: `${file.path}#leases`, disposition: 'invalid', reason: 'legacy-transport-cannot-cross-epoch', count: leases.length, sourceSha256: file.sha256 });
      if (value.attempts) facts.push({ id: `${file.path}#attempts`, disposition: 'log-only', reason: 'preserve-stable-budget-input', count: Object.keys(value.attempts).length, sourceSha256: file.sha256 });
      if (value.status || value.completedStages) facts.push({ id: `${file.path}#state`, disposition: 'stale-revalidate', reason: 'legacy-completion-requires-current-evidence', status: value.status ?? null, protocol, sourceSha256: file.sha256 });
    }
    const report = { protocolVersion: '1.0', importer: { id: this.id, version: this.version }, kind: 'cardworld-t1-t2', legacyRoot: inventory.root, sourceDigest: inventory.sourceDigest, fileCount: inventory.files.length, facts, allowedDispositions: ['verified-current', 'stale-revalidate', 'log-only', 'invalid', 'superseded'] };
    return { ...report, assessmentDigest: digestJson(report) };
  }
}
