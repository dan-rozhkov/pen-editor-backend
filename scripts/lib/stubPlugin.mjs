// esbuild plugin for scripts/build-local.mjs: replaces packages the local
// routes never reach (but that sit in the static import graph) with a stub
// whose every use throws, so a code path that does reach one fails loudly
// with a clear message instead of silently needing node_modules.

export const STUBBED = [
  "sharp",
  "pg",
  "pg-native",
  "pg-cloudflare",
  "playwright",
  "playwright-core",
  "chromium-bidi",
  "electron",
  "@aws-sdk/client-s3",
  "posthog-node",
  "resend",
  "better-auth",
  "@electric-sql/pglite",
];
const isStubbed = (path) => STUBBED.some((name) => path === name || path.startsWith(`${name}/`));

// A CJS module whose exports are a Proxy. esbuild reads named imports as
// `import_x.Name` on __toESM(module.exports), which builds its target with
// Object.create(getPrototypeOf(mod)) and copies own keys: the names are not
// known up front, so `__esModule` is true (no default wrapper) and the
// prototype is the stub itself, which makes every name (and `default`) resolve
// to the throwing stub through the prototype chain.
const stubSource = (message) => `
  const fail = () => { throw new Error(${JSON.stringify(message)}); };
  const stub = new Proxy(function () {}, {
    get: (_t, key) => (key === "__esModule" ? true : key === "then" ? undefined : stub),
    getPrototypeOf: () => stub,
    has: () => true,
    ownKeys: (t) => Reflect.ownKeys(t),
    getOwnPropertyDescriptor: (t, key) => Reflect.getOwnPropertyDescriptor(t, key),
    apply: fail,
    construct: fail,
  });
  module.exports = stub;
`;

export const stubPlugin = {
  name: "stub-unreachable",
  setup(b) {
    b.onResolve({ filter: /.*/ }, (args) => {
      if (args.kind === "entry-point" || args.path.startsWith(".") || args.path.startsWith("/")) return undefined;
      if (!isStubbed(args.path)) return undefined;
      return { path: args.path, namespace: "stub" };
    });
    b.onLoad({ filter: /.*/, namespace: "stub" }, (args) => ({
      loader: "js",
      contents: stubSource(`"${args.path}" is not available in the local bundle`),
    }));
  },
};
