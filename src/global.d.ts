/**
 * Ambient module declaration for Bun's `import x from './file.ext' with {
 * type: 'file' }` syntax, used to embed non-JS assets (e.g. `.proto` files)
 * into `bun build --compile` binaries. TypeScript doesn't know this import
 * form resolves to a `string` (an on-disk path) without this declaration.
 */
declare module '*.proto' {
  const path: string;
  export default path;
}
