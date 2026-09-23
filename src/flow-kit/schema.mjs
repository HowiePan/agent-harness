export const stringSchema = Object.freeze({ type: 'string', minLength: 1 });
export const stringsSchema = Object.freeze({ type: 'array', items: stringSchema });
