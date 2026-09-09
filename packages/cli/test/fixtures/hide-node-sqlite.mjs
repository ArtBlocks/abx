/**
 * A loader hook that makes `node:sqlite` unresolvable, reproducing Node 22.5's
 * ERR_UNKNOWN_BUILTIN_MODULE on a modern Node. Registered by hide-node-sqlite-register.mjs.
 */
export async function resolve(specifier, context, next) {
  if (specifier === 'node:sqlite') {
    const err = new Error('No such built-in module: node:sqlite');
    err.code = 'ERR_UNKNOWN_BUILTIN_MODULE';
    throw err;
  }
  return next(specifier, context);
}
