import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const gameIdPattern = /^[a-z0-9][a-z0-9-]*$/;
const sameIds = (left, right) => Array.isArray(left) && Array.isArray(right) && left.length === right.length
  && new Set(left).size === left.length && new Set(right).size === right.length
  && left.every(id => right.includes(id));

/** Cross-check an engine-only claim against the current Game Pack manifests. */
export const verifyCollectionScenarioInventories = async ({ workspaceRoot, state }) => {
  const mismatches = [];
  const games = [...new Set(state.features.filter(feature => feature.metadata?.stage === 'produce').map(feature => feature.metadata.gameId))];
  for (const gameId of games) {
    if (!gameIdPattern.test(gameId)) { mismatches.push({ gameId, reason: 'invalid-game-id' }); continue; }
    let manifest;
    try { manifest = JSON.parse(await readFile(resolve(workspaceRoot, 'games', 'presets', gameId, 'manifest.json'), 'utf8')); }
    catch { mismatches.push({ gameId, reason: 'manifest-unreadable' }); continue; }
    const latest = state.features.filter(feature => feature.metadata?.stage === 'produce' && feature.metadata.gameId === gameId).at(-1);
    const reported = state.submissions.findLast(item => item.featureId === latest.id)?.result?.outputs?.produce?.value;
    if (manifest.id !== gameId || !sameIds(manifest.requiredScenarios, reported?.requiredScenarios)
      || !sameIds(manifest.requiredScenarios, reported?.scenarioAudit?.map(item => item.id)))
      mismatches.push({ gameId, reason: 'required-scenario-audit-mismatch' });
  }
  return { ok: mismatches.length === 0, checkedGames: games, mismatches };
};
