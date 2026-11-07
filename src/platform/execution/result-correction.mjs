// Only a trusted validator can classify an error as result-local. A worker's
// error code or JSON field cannot authorize result correction.
const correctable=new WeakSet();
export const markResultCorrection=error=>{correctable.add(error);return error;};
export const isResultCorrection=error=>Boolean(error&&correctable.has(error));
