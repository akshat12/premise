// The one place the app imports the TypeScript compiler from. Import `ts` from here, never from
// "typescript" directly: the order of these three imports is what makes the compiler load safely
// inside a Worker (see ./before.ts). ES modules are evaluated in import order, and bundlers keep it.
import "./before";
import ts from "typescript";
import "./after";

export default ts;
