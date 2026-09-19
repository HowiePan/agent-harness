export const requiredFinalGates = project => (project.gateRecipes ?? []).filter(gate => gate.scope === 'final' && gate.required !== false).map(gate => gate.id);
