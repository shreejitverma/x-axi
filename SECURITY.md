# Security policy

## Reporting a vulnerability

Report it privately through GitHub's private vulnerability reporting: <https://github.com/shreejitverma/x-axi/security/advisories/new>.
Do not open a public issue for a vulnerability.
Never paste an access token, refresh token, client secret, keychain or Secret Service output, or the contents of `~/.xurl` into an issue, an advisory, or a pull request.
If a token was exposed, run `x-axi logout` first, which revokes it at X, and say in the report that you did.

Expect a first answer within 7 days.
Fixes ship in a new npm release of `@shreejitverma/x-axi`, and the advisory is published once that release is out.

## Scope

In scope:

- Token handling: any path that writes a token to disk, argv, the environment, logs, error messages, or output, or sends it anywhere but X's API and OAuth endpoints.
- The keystore: reading or writing the login record outside the macOS keychain or the Secret Service, or a fallback to a plain file.
- Approval gate bypass: any way to make a write reach X without the native dialog being approved, including through flags, environment variables, `PATH`, `--dry-run`, retries, or the `api` command.
- Dialog spoofing: text from X or from the user that makes the dialog show something other than what is sent, such as invisible or bidirectional characters, hidden lines, or text posing as the tool-written header.

Out of scope:

- Other code running as the same user, which the README's threat model already covers: it can read the keystore item and click in an X11 dialog.
- X's own API behavior, pricing, and limits.
- Findings that need a modified x-axi binary or a compromised Node installation.

## Supported versions

Only the latest release on npm gets security fixes.
