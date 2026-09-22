import { relative, resolve } from 'node:path';
import { assert } from '../../../src/common/errors.mjs';

/**
 * Creates a write boundary guard hook for OpenCode tool execution.
 * Intercepts tool execution to prevent unauthorized edits outside allowedPaths.
 */
export const createWriteGuard = ({ getCurrentScope = null } = {}) => {
  return async (input, output) => {
    const toolName = input?.tool ?? input?.name;
    if (!['edit', 'write'].includes(toolName)) return;
    const scope = typeof getCurrentScope === 'function' ? await getCurrentScope() : null;
    if (!scope || !Array.isArray(scope.allowedPaths)) return;

    const targetPath = input.args?.filePath ?? input.args?.file ?? input.args?.path;
    if (!targetPath) return;

    const workspaceRoot = resolve(scope.workspaceRoot ?? process.cwd());
    const resolvedTarget = resolve(workspaceRoot, targetPath);
    const rel = relative(workspaceRoot, resolvedTarget).replaceAll('\\', '/');

    const isAllowed = scope.allowedPaths.some(allowed => {
      const cleanAllowed = allowed.replace(/\/$/, '');
      return rel === cleanAllowed || rel.startsWith(`${cleanAllowed}/`);
    });

    assert(
      isAllowed,
      'WRITE_BOUNDARY_VIOLATION',
      `OpenCode agent is not authorized to modify ${rel}. Authorized paths: [${scope.allowedPaths.join(', ')}]`,
      { targetPath: rel, allowedPaths: scope.allowedPaths }
    );
  };
};
