# Contributing

## Setup

x-axi needs Node 22.12 or newer, and pnpm 11 through the `packageManager` field in `package.json`.
pnpm 11 itself needs Node 22.13 or newer; on an older Node, install pnpm's standalone `@pnpm/exe` build.

```sh
git clone https://github.com/shreejitverma/x-axi.git
cd x-axi
pnpm install --frozen-lockfile
pnpm run build
npm link   # optional: puts this checkout's x-axi on PATH
```

`pnpm-workspace.yaml` refuses any package published less than 7 days ago, so a new dependency or bump resolves to a version at least that old.

## Tests

```sh
pnpm run build && pnpm test
X_AXI_TEST_KEYCHAIN=1 pnpm test   # macOS: also round-trips a record through a temporary keychain under a temp directory, never the login keychain
X_AXI_TEST_DIALOG=1 pnpm test     # macOS: also opens a real approval dialog for one second and lets it expire
```

`pnpm test` runs the end-to-end tests against `dist`, so build first.
`X_AXI_TEST_DIALOG` puts a dialog on your screen; leave it unset in CI and in agent runs.

Rules for tests:

- Tests never call the live X API, `x.com`, or `api.x.com`.
  Every live call is billed, and a write is public.
  Commands are tested through an injected `XClient` fake, and the built binary through a loopback server set by `X_AXI_API_BASE`, which may only point at `127.0.0.1` or `localhost` and never receives a real token.
- Tests never read the login keychain, the Secret Service, `~/.xurl`, or any real credential.
  Use the injected in-memory keystore, or `X_AXI_TEST_KEYCHAIN=1` for the temporary keychain.
- A fake response or an expected request follows the endpoint's API reference on docs.x.com, not the code under test.
  Assert observable behavior through the command interface: requests sent, output, exit codes, and the spend ledger.
- Every write needs tests for the approval being declined (nothing sent), `--dry-run` (no dialog, no write), and an unknown outcome (`OUTCOME_UNKNOWN`, never retried).
  A command that needs a new OAuth scope needs a test that a login without it stops with `MISSING_SCOPE` before any call, spend, or dialog.

## Adding a command

1. Read the endpoint's reference page on docs.x.com and confirm the method, path, body, response, and OAuth 2.0 user-context scopes.
   An endpoint that is app-only or Enterprise only does not ship; record it in the README under "X platform limits" with the date and the URL.
2. Add any new scope to `SCOPES` in `src/oauth.ts` and to the README, and check it with `requireScopes` before the first call.
3. Add its rate to `src/rates.ts` from the pricing page, or record it as unpriced with `null`.
4. Add usage and cost to `HELP` in `src/commands.ts`, the command to `TOP_HELP` in `src/cli.ts`, the README command table, and `skills/x-axi/SKILL.md`.
5. Keep list items to 3 or 4 fields, state an empty result definitively, and end with a help hint where a next step exists.

## Commits

Use [Conventional Commits](https://www.conventionalcommits.org): `feat(lists): add list create`, `fix(approve): ...`, `docs: ...`, `build(deps-dev): ...`.
Keep each commit to one change, and explain why in the body when it is not obvious.
Never commit a token, a client secret, or output that holds one.

## Releasing

Releases publish `@shreejitverma/x-axi` to npm from `.github/workflows/release.yml`, with npm trusted publishing and provenance, and create a GitHub Release with generated notes.
There is no changelog file; the GitHub Release notes are the changelog.
The workflow first ran for `v0.3.0` on 2026-11-03 and skipped its publish step, because that version was already on npm; 0.4.0 is the first version it publishes.
Version 0.3.0 was published by hand on 2026-11-03, without provenance, because the Trusted Publisher setting lives on an existing package's settings page.
The workflow skips `npm publish` when the tagged version is already on npm, and skips the GitHub Release when one exists for the tag, so tagging an already-published version such as `v0.3.0` only creates its Release.

One-time setup by the package owner on npmjs.com:

1. Done for 0.3.0: publish the first version from your own machine with `npm login`, then `pnpm install --frozen-lockfile && npm publish --access public --provenance=false`.
   Provenance is off here because it can only be generated in CI.
2. Done on 2026-11-03: on <https://www.npmjs.com/package/@shreejitverma/x-axi/access>, under Trusted Publisher, choose GitHub Actions and enter Organization or user `shreejitverma`, Repository `x-axi`, Workflow filename `release.yml`, and no environment.
   Under Allowed actions, allow `npm publish`.
   npm expires a new trusted publisher that has not published within 2 days, so tag the next release soon after.
3. Once a release has gone out through the workflow, set Publishing access to require two-factor authentication and disallow tokens, so only the workflow can publish.

Each release:

1. On a branch, bump `version` in `package.json` and `VERSION` in `src/version.ts` to the same value; `pnpm test` checks that the binary reports the `package.json` version.
2. Merge it to `main` through the usual pipeline.
3. Tag the merge commit on `main` and push the tag:

   ```sh
   git switch main && git pull
   git tag vX.Y.Z
   git push origin vX.Y.Z
   ```

The workflow refuses a tag that differs from `package.json`'s version or points at a commit not on `main`.
It then installs with the frozen lockfile, builds, tests, publishes with `npm publish --provenance --access public` unless the version is already on npm, and runs `gh release create` with `--generate-notes` unless the Release exists.
A failed npm lookup other than a 404 stops the run before publishing.
If the publish step fails, nothing reached npm and no Release exists: fix the cause, delete the tag on GitHub and locally, and tag again.
If the publish succeeded and only the Release step failed, rerun the workflow; it skips the publish, because npm never accepts the same version twice, and creates the Release.
