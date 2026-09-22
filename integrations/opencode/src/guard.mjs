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
    if (!scope?.managed) return;
    assert(Array.isArray(scope.allowedPaths), 'WRITE_SCOPE_REQUIRED', 'A Harness-managed OpenCode write requires an authoritative allowedPaths scope.');

    const args = output?.args ?? {};
    const targetPath = args.filePath ?? args.file ?? args.path;
    assert(targetPath, 'WRITE_TARGET_REQUIRED', 'A Harness-managed OpenCode write requires an explicit target path.');

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
