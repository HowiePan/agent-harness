import {digestJson} from './canonical.mjs';

// One observation is idempotent; a new source is a new observation, not a new budget.
export const diagnosticIdentity = ({root, submissionId, sourceDigest, correctionOf = null}) =>
  `diagnostic/${digestJson({version:3, root, submissionId, sourceDigest, ...(correctionOf ? {correctionOf} : {})})}`;
