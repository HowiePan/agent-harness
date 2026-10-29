// Recognize explicit local implementation gaps without rewriting native results
// or their charged budget keys. Protected/capacity blockers need separate proof.
export const isIncompleteImplementationResult = result => ['blocked', 'failed'].includes(result?.status)
  && ['implementation-incomplete', 'implementation-gap'].includes(result.failureClass)
  && ['implementation', 'implementation-gap'].includes(result.blocker?.kind);
