// Proposal IDs become suffixes of Feature IDs, so permit safe hierarchical
// identifiers while keeping each path-like component unambiguous.
const proposalIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/;

export const validProposalId = id => typeof id === 'string' && id.length <= 96 && proposalIdPattern.test(id);

export const uniqueProposalIds = proposals => proposals.every(item => validProposalId(item.id))
  && new Set(proposals.map(item => item.id)).size === proposals.length;
