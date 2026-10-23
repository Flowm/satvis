/** Make `env` (and the vitest plugin's `ProvidedEnv`) carry the Worker's bindings. */
declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}
