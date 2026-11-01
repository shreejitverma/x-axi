# x-axi

An [AXI](https://axi.md) CLI for reading X data and managing your X account from an agent session.
It signs in to X itself with OAuth 2.0 Authorization Code and PKCE as a public client, and keeps the login in your operating system's keystore.
There is no client secret, no plain-text token file, and no dependency on another CLI.

## Install

```sh
cd ~/github/x-axi && pnpm install --frozen-lockfile && pnpm run build && npm link
```

Node 20 or newer.
The install uses pnpm 11, which itself needs Node 22.13 or newer; on an older Node, install pnpm's standalone `@pnpm/exe` build, which brings its own Node.
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
`login` saves it to `~/.config/x-axi/config.json` (or `$XDG_CONFIG_HOME/x-axi/config.json`), so later runs need no flag.
If port 8711 is taken, set `redirect_uri` in the same file to another `http://127.0.0.1` URL with a port from 1024 to 65535.
Register that exact URI as the Callback URI in the X portal as well, because X refuses a login whose callback differs; `x-axi setup` prints the URI in use.

x-axi requests these scopes: `tweet.read tweet.write tweet.moderate.write users.read follows.read follows.write media.write dm.read dm.write offline.access`.
The commands use all of them, and the raw `x-axi api` command can reach only endpoints they cover.
`media.write` is new: a login made before it was added works for everything except `--media`, which stops with `MISSING_SCOPE` before any spend or dialog until you run `x-axi login` again.

### Upgrading from a version that used xurl

Earlier versions called the `xurl` CLI, which keeps a token and a client secret in plain text at `~/.xurl/auth.yml`.
x-axi no longer reads or writes that directory.
Those versions registered a Web App (confidential client) with the callback `http://localhost:8080/callback`, and x-axi cannot sign in through that app as it stands.

1. In the app's User authentication settings change Type of App to "Native App", and set the Callback URI to the one `x-axi setup` prints.
2. Copy the OAuth 2.0 Client ID from the Keys and tokens page, and run `x-axi login --client-id YOUR_CLIENT_ID` in your own terminal.
3. Delete `~/.xurl` if nothing else on the machine uses xurl.

The spend ledger, cached account, and follow log in `~/.local/state/x-axi` keep working unchanged.

## Commands

| Group | Commands |
|---|---|
| Read | `me`, `timeline`, `mentions`, `replies`, `view`, `search`, `user`, `following`, `followers`, `dm list`, `dm read`, `api`, `spend` |
| Write, approval required, each takes `--dry-run` | `post`, `reply`, `thread`, `delete`, `hide`, `unhide`, `repost`, `unrepost`, `follow`, `unfollow`, `follow-file`, `dm send` |
| Plan, reads X and writes a local file | `follow-plan` |
| Account | `setup`, `login`, `logout`, `auth status` |

Reads use the account cached by `login`, the last `me`, or the last write, and timeline, mentions, and search output name it in `account`.
`auth status` shows the account, scopes, access token expiry, and the storage backend without an API call, and never a token.
`logout` revokes the access and refresh tokens at `https://api.x.com/2/oauth2/revoke`, then deletes the stored login and the cached account.
If revocation fails the deletion still happens and the output says which revocation failed.

### Reading following and followers

`x-axi following [handle]` and `x-axi followers [handle]` show the list's total and one page, `--limit` from 1 to 1000, continued with `--next`.
Without a handle they read your own list.
`--all --out file.json` exports every page to a JSON array of `{id, username, name, protected}`.
The export is unfiltered, so it can hold accounts you already follow; build a follow queue with `follow-plan`, not from an export.
A read estimated above $1 refuses before reading any page, and names the total and the cost, unless `--max-spend <usd>` covers it.
`--all` with `--next` cannot be priced in advance, so it does not refuse up front; it stops at the cap, keeps what it read, and prints the command to continue.
Every read sizes its page to what the cap still allows, so a wrong total from X cannot spend past it, and a page cut short this way still gives a `next_token`.
If the cap, a rate limit, or an error stops an export after its first page, the file holds what was paid for and the output gives the `next_token` to continue into a new file.
The export reports `complete: true` only if the read did not stop and X reported no partial errors.
`--out` never overwrites a file, and it creates exports and queues readable only by you, because they can hold lists X shows only to approved viewers.

### Building a follow queue

`x-axi follow-plan <handle> --out queue.json` builds a queue for `follow-file`, and it is how "do nothing if I already follow the account" is met.
It reads that account's following and your own following once, removes accounts you already follow and yourself, and writes the rest in the format `follow-file` reads.
It sends nothing to X and asks for no approval, because it only reads.

- The two lookups that give the totals cost about $0.02, and the output and any refusal state the cost.
- Above $1 it refuses without a `--max-spend <usd>` that covers the estimate, before reading either list.
- Protected accounts go to `queue.protected.json` rather than the queue, unless you pass `--include-protected`.
- A partial read of your own list writes no queue, because such a queue could hold accounts you already follow.
- If X lists fewer of your follows than its own count, the output carries a warning.

The queue is correct when it is built.
Follows you make elsewhere afterwards are not in it, and `follow-file` skips only accounts this login followed through x-axi.

### Threads

`x-axi thread "first" "second" ...` posts each part as a reply to the part before it, after one approval dialog that shows every part and the total cost.
Each part is priced on its own, so a part with a URL costs $0.20.
The whole thread must fit the same review limits as one text, 4000 characters and 40 lines of dialog, which is about 19 short parts.
The Linux dialog has less room, about 8 short parts, because it may not scroll.
If a part fails, nothing further is sent and nothing is retried.
The output lists the posted IDs, the failed part, and whether it was `not posted` or `unknown`.
Do not rerun a stopped thread, because the posted parts are public.

### Media

`post --media <file>` and `reply <id> <text> --media <file>` attach one file; the text may be left out.

| Type | Detected from the file's bytes | Limit checked locally |
|---|---|---|
| Image | JPEG, PNG, WebP | 5 MiB |
| Animated GIF | GIF | 15 MiB |
| Video | MP4, MOV, WebM | 16 GiB |

A file's extension must agree with its bytes.
MP4 means a plain MP4 brand and WebM means the WebM DocType, so HEIC, AVIF, M4A, 3GP, and other Matroska files are refused.
These checks run before any API call, and the dialog shows the file's path, type, and size, eliding the middle of a path over 120 characters.
The upload runs only after approval, through `POST /2/media/upload/initialize`, then `POST /2/media/upload/{id}/append` in multipart chunks of at most 5,000,000 bytes indexed from 0, then `POST /2/media/upload/{id}/finalize`, then `GET /2/media/upload` while X reports processing, for at most 10 minutes.
A failed chunk stops the upload and is not retried, and the error says nothing was posted.
A file that changes after approval is refused.
x-axi does not know a video's duration or the account's Premium status, so X judges those: 8 GB and 20 minutes by default, 16 GB and 125 minutes with Premium or verification.
X checks limits again when media is attached, so a finished upload can still be refused at the post, as the error then says.

### Dry runs

`--dry-run` on any write runs the validation and prints the exact requests and the write's estimated cost, with no approval and no write.
If the text would not fit the Linux dialog, on any platform the output carries `dry_run.linux_dialog`, because the real run on Linux refuses that text with `APPROVAL_TEXT_TOO_LONG`.
Reads needed to validate it still happen and are billed, such as the account read, and the parent post on a reply, and they appear as `est_cost`.
Media is inspected locally and no byte is uploaded.

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
The new record is written to the keystore before the new token is used; if that write fails after X has already rotated the token, the command says so and asks for a new login rather than hiding it, and makes one attempt to revoke the tokens it could not keep.
When `login` replaces a stored login for a different account, it revokes the old tokens after saving the new ones and reports whether that worked.
When it replaces a login for the same account, or the old account is not known because no account is cached or the new one could not be read, it leaves the old tokens live and says so, because whether revoking them would also end the new grant is unverified.
After a suspected leak, run `x-axi logout` before `x-axi login`, which revokes the tokens while x-axi still holds them; once they are replaced, only revoking the app at <https://x.com/settings/connected_apps> ends them.
`login` reads the keystore before it opens the browser, so a missing or locked keystore stops it before any consent, and if the final save still fails it makes the same attempt to revoke and reports the result.
If X rejects the refresh token, the command fails with `AUTH_REQUIRED` and the stored login is left in place for you to inspect with `auth status` or remove with `logout`; nothing is cleared silently and nothing is retried.
A network failure, a rate limit, or an unusable answer from the token endpoint is reported as `X_UNAVAILABLE` and changes nothing.
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

Every write opens a native dialog showing the account, parent post, and estimated cost.
Outgoing text appears in full under a tool-written header with its exact character and line counts, so all of those lines are sent, whatever they say about themselves.
Invisible characters are refused except where a language or emoji needs them: zero-width joiners in emoji and Indic script text, zero-width non-joiners in Arabic and Indic script text, tag characters in subdivision flags, and direction marks in right-to-left text.
Bidi embeddings, overrides, and isolates are always refused.
The gate lives in the tool, so it applies under every harness and permission mode, including unattended runs.
It fails closed: Cancel, a 120-second timeout, a crash, or a missing dialog sends nothing.
There is no terminal prompt, flag, or environment override, because an agent could answer or set those.
Writes are never retried, because a retry after a lost response could publish twice.
A failed response that might have been applied returns `OUTCOME_UNKNOWN`.

## X platform limits

Checked against the [changelog](https://docs.x.com/changelog), [pricing](https://docs.x.com/x-api/getting-started/pricing), [OAuth 2.0 documentation](https://docs.x.com/fundamentals/authentication/oauth-2-0/authorization-code), and [create post reference](https://docs.x.com/x-api/posts/create-post) on 2026-11-01.

- API replies work only on your own posts, or when the post's author mentioned or quoted you.
  Otherwise `reply` returns `REPLY_NOT_SUMMONED` with a browser link holding your text.
- The April 16, 2026 changelog entry says following, likes, and quote-posts were removed from all self-serve tiers.
  A live follow on a Pay-per-use app still succeeded on 2026-10-31, so following may stop working without notice.
- x-axi has no `like` or `unlike`, because of that entry.
- `post --quote` exists, but the create post reference says `quote_tweet_id` requires an Enterprise plan, so expect `FORBIDDEN` on self-serve; it is untested live.
- `repost` and `unrepost` use documented endpoints that the removal entry does not name, and the [API overview](https://docs.x.com/x-api/overview) says its endpoints are on pay-per-use, though it also lists likes.
  No page names reposts on pay-per-use specifically and the pricing page has no line for them, so they are untested and unpriced.
- [Following](https://help.x.com/en/using-x/x-follow-limit) is limited to 400 per day and 50 per 15 minutes, and X may lock accounts for aggressive following.
  `follow-file` asks once per batch, follows every 20 seconds, caps itself at 400 in 24 hours, and stops at the first error.
  Unfollowing does not give back room under that cap, and a follow with an unknown outcome uses room because X may have applied it.
- `follow-file` treats an account as already followed only if the logged-in account followed it through x-axi, and it does not read X's following list, because each listed account is billed.
  Build the queue with `x-axi follow-plan`, which removes accounts you already follow, or those accounts are followed and billed again.
  The approval dialog shows usernames from the file, which are not verified with X; the follow goes to each entry's `id`.
- `replies` and `search` use recent search, which covers 7 days.
- `dm` uses the legacy DM endpoints and does not cover encrypted XChat conversations.
- The OAuth documentation does not say whether refresh tokens rotate, so x-axi treats each as single-use and stores whatever X returns.

## Platform support for writes

| Platform | Approval dialog | Default button |
|---|---|---|
| macOS | `/usr/bin/osascript` | Cancel |
| Linux desktop | `zenity`, or `kdialog` if `zenity` is missing | Cancel on `zenity`; not Cancel on `kdialog` |
| Linux without a graphical session, such as plain SSH or CI | None, so writes return `APPROVAL_UNAVAILABLE` naming what to install | |
| Windows and other systems | None, so writes return `APPROVAL_UNSUPPORTED_PLATFORM` | |

On Linux:

- A graphical session means `DISPLAY` or `WAYLAND_DISPLAY` is set, so SSH with X forwarding counts and shows the dialog on the forwarded display.
- The tools are found only in `/usr/bin`, `/bin`, and `/usr/local/bin`, never through `PATH`, so copies from Nix, Flatpak, or Snap are not used.
- The tool gets a short list of display and locale variables and nothing else, because variables such as `ZENITY_CANCEL=0` or `LD_PRELOAD` could turn a Cancel into an approval.
- `kdialog` has no flag for the default button, so pressing Enter may approve; install `zenity` if you can.
- `kdialog` has no plain text mode, so x-axi sends it escaped rich text, and it has no timeout flag, so x-axi kills it at the timeout.
- The dialog holds about 25 lines of 50 columns.
  That is a conservative estimate rather than a measurement of the window, and macOS does not apply it.
- A word or URL wider than a line is split in the dialog with a `↵` mark at each break, and the dialog counts the breaks; the text sent to X is unchanged.
- Text you did not write for this action, such as a parent post, a post you are deleting or hiding, or a file path, is cut to fit with a marker giving its full character count, and never blocks the write.
- Text to send must be shown in full to be approved, so text too long to fit once wrapped returns `APPROVAL_TEXT_TOO_LONG` instead of a dialog.
  The text itself has room for about 19 rows, or about 950 characters of plain text, because the rest of the dialog is held for its other lines and any context.
  The rows of a split URL count toward that limit.
- A `zenity` that cannot open its display exits with the same code as Cancel, so x-axi reads its error output and returns `APPROVAL_UNAVAILABLE` rather than reporting a cancel nobody made.
- The gate is weaker than on macOS.
  Any process running as you can click in an X11 dialog, or set `DISPLAY` to an X server it controls and click there.

CI runs the suite on Ubuntu and macOS on Node 20 and 24.
It tests the Linux dialogs with fake executables that record their arguments and exit with a chosen code, so no real click reaches `zenity` or `kdialog` in CI.
The flags were checked against the help output of `zenity` 4.0.1 and `kdialog` 23.08 and against their upstream source on 2026-11-01.
Neither real Linux dialog has been opened by the test suite, so how they look on your desktop is unverified.
CI installs the standalone pnpm build described under [Install](#install).

## Cost

Each priced result shows `est_cost`, and `x-axi spend` totals them locally.
A write's `est_cost` is the write alone; the lookups before its dialog appear only in `spend`.
These are upper bounds, because X does not re-bill a resource within a UTC day and may change its rates.
The `hide`, `unhide`, `repost`, `unrepost`, media upload, and `api` calls have no estimate, so they add nothing to these totals and `spend` counts them in `unpriced_calls_30d`.
The [pricing page](https://docs.x.com/x-api/getting-started/pricing) lists no price for media upload or reposting, so a post with media shows the price of the post alone.
Following and followers lists cost $0.01 per account.
Your own list uses the $0.001 Owned Read rate, which X gives only when the login also owns the app, so under another app's login the estimate is low.
A write with an unknown outcome is counted, because it may have been billed.
`login` ends with one account read, about $0.01, so the approval dialogs can name the account the token belongs to.
The console is the billing truth, and its spend limit is the only hard cap.

## Test

```sh
pnpm run build && pnpm test
X_AXI_TEST_KEYCHAIN=1 pnpm test   # macOS: also round-trips a record through a temporary keychain under a temp directory, never the login keychain
X_AXI_TEST_DIALOG=1 pnpm test     # macOS: also opens a real dialog for one second and lets it expire
```

The suite runs the login flow against a local fake of X's OAuth endpoints with an injected in-memory keystore, checks PKCE against the RFC 7636 appendix B vector, and asserts that the real backends' commands carry the secret on stdin and never on argv.
Under `X_AXI_API_BASE`, which may only point at loopback, the keystore is never read and a fixed test token is sent.
