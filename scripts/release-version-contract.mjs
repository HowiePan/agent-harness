const strictSemverPattern = /^\d+\.\d+\.\d+$/;

export const validateReleaseVersionContract = ({ packageJson, codexPlugin }) => {
  const errors = [];
  const packageVersion = packageJson?.version;
  const pluginVersion = codexPlugin?.version;

  if (!strictSemverPattern.test(packageVersion ?? '')) {
    errors.push('package version must be a strict major.minor.patch version without a prerelease or build-metadata suffix');
  }
  if (pluginVersion !== packageVersion) {
    errors.push(`Codex integration plugin version must exactly equal package version ${packageVersion}; received ${pluginVersion ?? '<missing>'}`);
  }

  return errors;
};
