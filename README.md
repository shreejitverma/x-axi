# x-axi

An [AXI](https://axi.md) CLI for reading X data and managing your X account from an agent session.
It signs in to X itself with OAuth 2.0 Authorization Code and PKCE as a public client, and keeps the login in your operating system's keystore.
There is no client secret, no plain-text token file, and no dependency on another CLI.

## Install

```sh
cd ~/github/x-axi && pnpm install --frozen-lockfile && pnpm run build && npm link
```

Node 20 or newer.
To update, run `git pull && pnpm install --frozen-lockfile && pnpm run build` in the checkout.
`x-axi update` only prints this, because the `x-axi` name on npm does not belong to this project.

## Connect your account

`x-axi setup` prints these steps with your current state.

1. At <https://console.x.com> create a project and an app on Pay-per-use and Production.
   Add credits and set a spend limit; the limit is the only hard cap on what the API can bill.
2. In the app's User authentication settings turn on OAuth 2.0.
   Set App permissions to "Read and write and Direct message" and Type of App to "Native App", which is a public client.
3. Set the Callback URI to exactly `http://127.0.0.1:8711/callback`, add any https website URL you own, and save.
   X matches the callback character for character, so a different port or `localhost` in place of `127.0.0.1` fails the login.
4. On the Keys and tokens page copy the OAuth 2.0 Client ID.
   If the portal also shows a Client Secret, the type is not Native App; x-axi never uses a secret.
5. In your own terminal, not through an agent, run `x-axi login --client-id YOUR_CLIENT_ID`.
   A browser opens on X's authorize page; approve it, and the tab says you can close it.
6. Verify with `x-axi auth status`, then `x-axi me`.

The client ID is not a secret.
`login` saves it to `~/.config/x-axi/config.json` (or `$XDG_CONFIG_HOME/x-axi/config.json`, or `$X_AXI_CONFIG_DIR/config.json`), so later runs need no flag.
`X_AXI_CLIENT_ID` in the environment also works.
The same file may hold `redirect_uri` if port 8711 is taken; it must stay a loopback `http://127.0.0.1` URL, and the value registered with X must match it exactly.

x-axi requests only the scopes its commands use: `tweet.read tweet.write tweet.moderate.write users.read follows.read follows.write dm.read dm.write offline.access`.
The raw `x-axi api` command can reach only endpoints those scopes cover.

### Upgrading from a version that used xurl

Earlier versions called the `xurl` CLI, which keeps a token and a client secret in plain text at `~/.xurl/auth.yml`.
x-axi no longer reads or writes that directory.
Run `x-axi login` once, then delete `~/.xurl` if nothing else on the machine uses xurl.
The spend ledger, cached account, and follow log in `~/.local/state/x-axi` keep working unchanged.

## Commands

| Group | Commands |
|---|---|
| Read | `me`, `timeline`, `mentions`, `replies`, `view`, `search`, `user`, `dm list`, `dm read`, `api`, `spend` |
| Write, approval required | `post`, `reply`, `delete`, `hide`, `unhide`, `follow`, `unfollow`, `follow-file`, `dm send` |
| Account | `setup`, `login`, `logout`, `auth status` |

Reads use the account cached by `login`, the last `me`, or the last write, and timeline, mentions, and search output name it in `account`.
`auth status` shows the account, scopes, access token expiry, and the storage backend without an API call, and never a token.
`logout` revokes the access and refresh tokens at `https://api.x.com/2/oauth2/revoke`, then deletes the stored login and the cached account.
If revocation fails the deletion still happens and the output says which revocation failed.

## Where the login lives

The access token, refresh token, expiry, scopes, and client ID are stored as one record in the OS keystore, behind a small interface with no plain-file implementation.

- macOS: the login keychain, through `/usr/bin/security` at its absolute path.
  The record is written through `security -i`, which reads the command from stdin, so it never appears in `ps` or shell history.
- Linux: the Secret Service (GNOME Keyring, KeePassXC, and others) through `secret-tool`, which reads the secret from stdin.
  Without `secret-tool` or a running Secret Service, every command that needs a token fails with `KEYSTORE_UNAVAILABLE` and the install steps; nothing falls back to a file.
- Windows: not supported; the error says so.

Access tokens last two hours.
Before each API call x-axi reads the record and, within two minutes of expiry, refreshes it at `https://api.x.com/2/oauth2/token` with `client_id` in the form body.
A file lock in the state directory (`auth.lock`, carrying a random owner token and touched every five seconds while held) serialises refreshes, logins, and logouts across x-axi processes, so a single-use refresh token is spent once and a logout cannot be undone by a refresh that was already in flight.
A lock untouched for a minute is treated as left by a crashed process and claimed atomically.
The new record is written to the keystore before the new token is used; if that write fails after X has already rotated the token, the command says so and asks for a new login rather than hiding it.
If X rejects the refresh token, the command fails with `AUTH_REQUIRED` and the stored login is left in place for you to inspect with `auth status` or remove with `logout`; nothing is cleared silently and nothing is retried.
A rate limit or an unusable answer from the token endpoint is reported as `X_UNAVAILABLE` and changes nothing.
Error messages have every known token removed before they are printed.

### Threat model

The keystore protects the tokens at rest.
On macOS they are encrypted in the keychain database rather than sitting in a readable file, so a copied home directory, a backup, a stray `cat`, or a tool that uploads dotfiles does not expose them.
Items added by `security` are not marked synchronizable, so they are not sent to iCloud Keychain.

The keystore does not protect the tokens from other code running as you.
x-axi stores the item with the keychain's default access control, which trusts the creating application, `/usr/bin/security`.
In an isolated test keychain created under a temporary directory, a different process (`python3` spawning `security find-generic-password -w`) read the item with no prompt.
Any same-user process can do the same, because the trusted application is a general-purpose system tool.
The alternative, an item with no trusted application (`-T ""`), would make macOS ask for confirmation on every read, including x-axi's own, which agent runs cannot answer and which trains the user to click Allow; that behaviour is taken from the `security` manual and was not exercised, because exercising it would have opened a dialog.
Direct reads through the Security framework from a binary that is not `/usr/bin/security` should prompt under the default access control according to Apple's documentation; this was not verified for the same reason.
The item is also only as locked as the login keychain, which is unlocked while you are logged in.

On Linux the same holds: any process in your session that can talk to the Secret Service can read the item.

The approval dialog on writes is therefore the gate, and it is not a sandbox.
A process that can run `security` or `secret-tool` as you can act as you on X with these scopes.
Keep spend limits set in the console.

## Safety model

Every write opens a native macOS dialog showing the account, parent post, and estimated cost.
Outgoing text appears in full under a tool-written header with its exact character and line counts, so all of those lines are sent, whatever they say about themselves.
Invisible characters are refused except where a language or emoji needs them: zero-width joiners in emoji and Indic script text, zero-width non-joiners in Arabic and Indic script text, tag characters in subdivision flags, and direction marks in right-to-left text.
Bidi embeddings, overrides, and isolates are always refused.
The gate lives in the tool, so it applies under every harness and permission mode, including unattended runs.
It fails closed: Cancel, a 120-second timeout, or a missing dialog sends nothing.
Writes are never retried, because a retry after a lost response could publish twice.
A failed response that might have been applied returns `OUTCOME_UNKNOWN`.

## X platform limits

Checked against the [changelog](https://docs.x.com/changelog) and [pricing](https://docs.x.com/x-api/getting-started/pricing) on 2026-10-31, and the [OAuth 2.0 documentation](https://docs.x.com/fundamentals/authentication/oauth-2-0/authorization-code) on 2026-11-01.

- API replies work only on your own posts, or when the post's author mentioned or quoted you.
  Otherwise `reply` returns `REPLY_NOT_SUMMONED` with a browser link holding your text.
- The changelog says liking, following, and quote-posting were removed from self-serve plans.
  A live follow on a Pay-per-use app still succeeded on 2026-10-31, so following may stop working without notice; liking and quote-posting are untested.
- [Following](https://help.x.com/en/using-x/x-follow-limit) is limited to 400 per day and 50 per 15 minutes, and X may lock accounts for aggressive following.
  `follow-file` asks once per batch, follows every 20 seconds, caps itself at 400 in 24 hours, and stops at the first error.
  Unfollowing does not give back room under that cap, and a follow with an unknown outcome uses room because X may have applied it.
- `follow-file` treats an account as already followed only if the logged-in account followed it through x-axi, and it does not read X's following list, because each listed account is billed.
  Filter a queue against your real following list when you build it, or those accounts are followed and billed again.
  The approval dialog shows usernames from the file, which are not verified with X; the follow goes to each entry's `id`.
- `replies` and `search` use recent search, which covers 7 days.
- `dm` uses the legacy DM endpoints and does not cover encrypted XChat conversations.
- Media upload is not implemented yet.
- The OAuth documentation does not say whether refresh tokens rotate, so x-axi treats each as single-use and stores whatever X returns.

## Cost

Each priced result shows `est_cost`, and `x-axi spend` totals them locally.
A write's `est_cost` is the write alone; the lookups before its dialog appear only in `spend`.
These are upper bounds, because X does not re-bill a resource within a UTC day and may change its rates.
The `hide`, `unhide`, and `api` calls have no estimate, so they add nothing to these totals and `spend` counts them in `unpriced_calls_30d`.
A write with an unknown outcome is counted, because it may have been billed.
`login` ends with one account read, about $0.01, so the approval dialogs can name the account the token belongs to.
The console is the billing truth, and its spend limit is the only hard cap.

## Test

```sh
pnpm run build && pnpm test
X_AXI_TEST_KEYCHAIN=1 pnpm test   # macOS: also round-trips a record through a temporary keychain under a temp directory, never the login keychain
X_AXI_TEST_DIALOG=1 pnpm test     # also opens a real dialog for one second and lets it expire
```

The suite runs the login flow against a local fake of X's OAuth endpoints with an injected in-memory keystore, checks PKCE against the RFC 7636 appendix B vector, and asserts that the real backends' commands carry the secret on stdin and never on argv.
Under `X_AXI_API_BASE`, which may only point at loopback, the keystore is never read and a fixed test token is sent.
