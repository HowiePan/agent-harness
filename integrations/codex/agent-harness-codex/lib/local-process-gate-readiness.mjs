import { spawnSync } from 'node:child_process';

export const assertLocalProcessGateHost = ({ recipes, executable = process.execPath, spawn = spawnSync } = {}) => {
  if (!Array.isArray(recipes) || !recipes.some(recipe => recipe.executionClass === 'deterministic-process' && !recipe.executorPluginId)) return;
  const result = spawn(executable, ['-e', ''], { windowsHide: true, timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.error || result.status !== 0) throw Object.assign(new Error('Current Codex process permissions cannot launch a captured child process required by Project Gates.'), {
    code: 'LOCAL_PROCESS_GATE_HOST_UNAVAILABLE',
    details: { processCode: result.error?.code ?? null, exitCode: result.status ?? null },
  });
};
