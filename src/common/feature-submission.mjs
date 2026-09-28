/** Read the submission currently owned by a Feature, never an earlier retry. */
export const currentFeatureSubmission = (state, feature, { status = null } = {}) => {
  if (!feature) return null;
  const submission = feature.submissionId
    ? state.submissions.find(item => item.submissionId === feature.submissionId)
    : [...state.submissions].reverse().find(item => item.featureId === feature.id && !item.supersededAt);
  return submission?.featureId === feature.id && !submission.supersededAt && (!status || submission.result?.status === status)
    ? submission : null;
};
