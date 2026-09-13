export class HarnessError extends Error {
  constructor(code, message, details = undefined, options = undefined) {
    super(message, options);
    this.name = 'HarnessError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

export const fail = (code, message, details) => {
  throw new HarnessError(code, message, details);
};

export const assert = (condition, code, message, details) => {
  if (!condition) fail(code, message, details);
};
