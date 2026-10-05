// For the editor's TS server; vue-tsc reads the SFCs themselves.
declare module "*.vue" {
  const component: import("vue").DefineComponent<Record<string, never>, Record<string, never>, unknown>;
  export default component;
}
