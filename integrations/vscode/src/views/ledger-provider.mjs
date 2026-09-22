/**
 * Tree data provider for VS Code Activity Bar: Quality Finding Ledger.
 */
export class LedgerTreeProvider {
  constructor({ getHarness, onDidChange = null }) {
    this.getHarness = getHarness;
    this.onDidChange = onDidChange;
  }

  async getChildren(element = null) {
    const harness = typeof this.getHarness === 'function' ? await this.getHarness() : null;
    if (!harness) return [{ id: 'not-ready', label: 'Agent Harness Initializing...' }];

    if (!element) {
      return [
        { id: 'open-findings', label: 'Open Findings (Blocking Closure)', collapsible: true },
        { id: 'resolved-findings', label: 'Resolved Findings', collapsible: true },
      ];
    }

    if (element.id === 'open-findings') {
      return [
        { id: 'finding-empty', label: 'No unresolved findings (Clean Ledger)', contextValue: 'clean' },
      ];
    }

    return [];
  }

  getTreeItem(element) {
    return {
      id: element.id,
      label: element.label,
      collapsibleState: element.collapsible ? 1 : 0,
      contextValue: element.contextValue ?? 'finding',
    };
  }
}
