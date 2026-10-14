// Run before `npm install` (the "preinstall" script): stops at once, with a plain message, on a Node
// version Premise does not run on, instead of failing later with an error that does not say why.
// Supported: Node 24 or later (the same as "engines" in package.json).
const major = Number(process.versions.node.split(".")[0]);
if (major < 24) {
	console.error(`
  Premise needs Node.js 24. This is Node ${process.versions.node}.

  With nvm or fnm, run "nvm use" (or "fnm use") in this folder: the .nvmrc file asks for Node 24.
  Or install Node 24 from https://nodejs.org/ and run npm install again.
`);
	process.exit(1);
}
