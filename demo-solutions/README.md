# demo-solutions

Reference solutions for the 12 tasks in `demo-repo/premise/tasks.json`. They are the source for two generated things inside `demo-repo/`:

- `premise/reference/<id>.patch.ts`: each solution as a `FileChanges` object (path to new file content).
- `premise/hidden-tests/<task>.test.ts`: each task's acceptance tests, for the A/B harness.

Edit `solutions.ts` or `tests/`, then regenerate and re-check:

```
npm run demo:reference
npx tsx scripts/check-scenario.ts
```

The files in `tests/` are written as they will sit in `demo-repo/tests/`, so their imports only resolve there. They are typechecked by `check-scenario`, not in place.
