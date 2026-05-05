// Module augmentation for Express request — `req.agent` is set by the
// authMiddleware (`src/middlewares/auth.ts`) once the x-api-key header
// has been verified. The same augmentation lived inside auth.ts but
// some tsc + @types/express configurations don't pick up `declare
// module` blocks that come from regular module-shaped files. A
// dedicated .d.ts with no imports is the canonical way to expose
// global type augmentations and is unambiguously picked up via the
// `include: ["src/**/*"]` glob in tsconfig.json.

// Augment the Express request via the canonical `Express` global
// namespace that `@types/express-serve-static-core` itself extends.
// Going through `declare module "express-serve-static-core"` does NOT
// work under pnpm's nested layout because the module name is not
// resolvable from this file (the package is installed transitively
// through @types/express). The `declare global` namespace path works
// regardless of the dependency hoisting strategy because both this
// file and @types/express target the same Express namespace.

export {}; // makes this a module file (required for declare global)

declare global {
  namespace Express {
    interface Request {
      agent?: {
        id: number;
        wallet: string;
        tier: "free" | "paid";
        keyId: number;
      };
    }
  }
}
