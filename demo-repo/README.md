# acme-accounts

A small accounts and billing core for a made-up SaaS company, written in plain TypeScript: sessions and logins, users and roles, billing, invoices and currencies.

It is the shared codebase that the AI agents work on in the [Premise](https://github.com/akshat12/premise) demo. Each agent is given one task in this repo (for example "make `verifySession` return null for an expired session"), and Premise keeps track of what each agent's change relies on.

It has no runtime dependencies and uses no Node or browser APIs, so its tests run anywhere, including inside a sandbox with no file system.

## Run it

You need [Node.js](https://nodejs.org/) 22 or later.

```bash
git clone https://github.com/akshat12/acme-accounts.git
cd acme-accounts
npm install
npm test           # runs the tests
npm run typecheck  # checks the types
```

## What is in it

```
src/auth/      sessions, logins, passwords, tokens, permissions, rate limiting, audit log
src/users/     users, profiles, roles, invites
src/billing/   plans, subscriptions, tax, discounts, currencies, invoices
src/api/       request handlers, routes, responses, validation
src/store/     in-memory stores
src/util/      small shared helpers
tests/         the tests
premise/       the test runner, and checks the Premise demo uses
```

## Licence

[MIT](LICENSE).
