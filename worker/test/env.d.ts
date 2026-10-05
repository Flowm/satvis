/** Make `env` (and the pool-workers `ProvidedEnv`) carry the Worker's bindings. */
declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}
