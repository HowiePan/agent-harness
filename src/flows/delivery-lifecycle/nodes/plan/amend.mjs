import { deliveryNode, deliveryTask } from '../node.mjs';

const inputs = [
  { id: 'approved-base', source: 'intent', path: 'planRevision', required: true,
    description: 'Immutable approved plan, exact base digests and registered amendmentScope; inspection input, never permission to rewrite the base.' },
  { id: 'change-request', source: 'intent', path: 'changeRequest', required: true,
    description: 'The exact registered dependency/ownership amendment and its acceptance criteria.' },
];

export const amendNode = deliveryNode('plan', 'amend', 'version-planning', [], {
  portKey: 'amendment',
  task: deliveryTask({
    role: { id: 'plan-amender', description: 'Authors only a bounded delta against an approved immutable plan.' },
    objective: 'Resolve the registered local planning defect without regenerating unchanged plan content.',
    instructions: [
      'Inspect the approved base and current source consumers. Restrict every modification to amendmentScope and trace it to the registered change request.',
      'Author a delta file with version, basePlanDigest, changeRequestDigest, changes and documents. Each change has path, expectedDigest of its original JSON value and replacement value. In the final delivery-plan-amendment-v1 output return the materializer outputValue: version, basePlanDigest, changeRequestDigest and deltaRef {path,sha256}. Do not transcribe a large patch or provide a machine-derived plan.',
      'Keep proposal identities, final architecture, protected effects and unrelated acceptance unchanged. Respect actual producer dependencies, native signatures, source lifetimes, module/manifest/Schema/test wiring and acceptance owners. Never solve a dependency cycle by dropping an assertion or silently extending source lifetime.',
      'Write the draft delta only inside amendmentScope.artifactRoot. Use the official dev amendment-materialize command with the verified development manifest, this Run ID and --patch <draft.json>. It generates immutable content-addressed document copies, amendment.json, changes.md and plan.json, rebinds references, and returns compact outputValue with the exact delta reference. Application verifies that file, preserves the native result and records a digest-bound resolution Receipt.',
      'Do not edit any base plan/inventory or implementation source. A materializer scope, identity or graph rejection is not permission to weaken its checks. Return an exact protected blocker if this change requires broader Replan.',
      'After review rejection, produce a corrected delta against the same original base. New delta bytes use a new generated directory; retain prior review artifacts and findings.',
    ],
    inputs,
    steps: [
      { id: 'impact', instruction: 'Trace the registered defect through all live producers, references and consumers; record the precise affected boundaries.' },
      { id: 'patch', instruction: 'Author bounded replacements with original-value digests and evidence for each change.' },
      { id: 'materialize', instruction: 'Use deterministic materialization; inspect graph, references and unchanged content before returning the delta.' },
    ],
    constraints: ['No business implementation, base-file rewriting, feature identity changes, acceptance deletion or Authority edits.'],
    acceptance: ['Every delta entry has a registered bound, exact preimage and source-backed reason.',
      'Generated artifacts reproduce the delta and preserve unchanged plan content.',
      'Dependencies are acyclic and all referenced inputs exist; every affected retirement and consumer has an executable owner and check.'],
  }),
});

export const amendReviewNode = deliveryNode('plan-review', 'plan-review', 'plan-review', ['plan'], {
  readOnly: true,
  task: deliveryTask({
    role: { id: 'plan-amendment-reviewer', description: 'Independently reviews the bounded delta and its consumer/producer impact.' },
    objective: 'Approve only a coherent local amendment with unchanged unrelated contracts and complete affected acceptance.',
    instructions: [
      'Remain read-only. Inspect the typed amendment, immutable base, generated full plan and exact source evidence. Review the delta and affected consumer/producer boundaries; unchanged Features are checked by deterministic equality and whole-graph/reference validation, not regenerated.',
      'Check all registered change requirements, every affected native declaration/signature, source retirement deadline, dependency, module/manifest/Schema/test path and acceptance owner. Follow references into downstream consumers even when they are outside the write scope.',
      'Reject unregistered changes, missing producer capabilities, cycles, dangling or prematurely retired types, dropped assertions, historical binaries substituted for fresh-port acceptance, and unsupported API withdrawal. Report actionable findings; do not expand scope silently.',
      'Return plan-review with approved, findings, basePlanDigest, deltaDigest and reviewedFeatureIds. Bind basePlanDigest to the original approved base, deltaDigest to the exact typed amendment and reviewedFeatureIds to every registered affected Feature. An old review or user approval cannot approve this delta.',
    ],
    inputs,
    steps: [{ id: 'inspect', instruction: 'Inspect the delta, impact boundary, deterministic artifacts and all registered acceptance.' },
      { id: 'decide', instruction: 'Return a digest-bound independent review; preserve unresolved Finding identities.' }],
    constraints: ['No writes, implementation, inherited approval or implicit scope expansion.'],
    acceptance: ['The exact delta and affected Feature set are reviewed independently.',
      'No affected contract, producer, consumer or check is left without an executable owner.'],
  }),
});
