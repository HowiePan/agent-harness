/**
 * Tree data provider for VS Code Activity Bar: Active Runs & Work Graph.
 */
export class RunTreeProvider {
  constructor({ getHarness, onDidChange = null }) {
    this.getHarness = getHarness;
    this.onDidChange = onDidChange;
  }

  async getChildren(element = null) {
    const harness = typeof this.getHarness === 'function' ? await this.getHarness() : null;
    if (!harness) return [{ id: 'not-ready', label: 'Agent Harness Initializing...' }];

    if (!element) {
      return [
        { id: 'runs', label: 'Active Lifecycle Runs', collapsible: true },
        { id: 'work-graph', label: 'Feature DAG Nodes', collapsible: true },
      ];
    }

    if (element.id === 'runs') {
      return [
        { id: 'run-1', label: 'Run: Active (Epoch 1, Gen 1)', contextValue: 'run' },
      ];
    }

    if (element.id === 'work-graph') {
      return [
        { id: 'feat-intake', label: 'intake: completed', contextValue: 'feature' },
        { id: 'feat-plan', label: 'plan: completed', contextValue: 'feature' },
        { id: 'feat-implement', label: 'implement: ready', contextValue: 'feature' },
      ];
    }

    return [];
  }

  getTreeItem(element) {
    return {
      id: element.id,
      label: element.label,
      collapsibleState: element.collapsible ? 1 : 0, // 1: Collapsed, 0: None
      contextValue: element.contextValue ?? 'item',
    };
  }
}
