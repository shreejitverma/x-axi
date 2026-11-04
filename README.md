# x-axi

An [AXI](https://axi.md) CLI for reading X data and managing your X account from an agent session.
It reads posts, mentions, bookmarks, likes, Lists, mutes, blocks, trends, and DMs, and it posts, replies, threads, bookmarks, mutes, and manages Lists, each write only after you approve it in a native dialog.
It signs in to X itself with OAuth 2.0 Authorization Code and PKCE as a public client, and keeps the login in your operating system's keystore.
There is no client secret, no plain-text token file, and no dependency on another CLI.
Output is [TOON](https://github.com/toon-format/toon), errors carry a code and an exit status, and every priced result shows its estimated cost.

## Quickstart

```sh
npm install -g @shreejitverma/x-axi
x-axi setup                                  # prints the X developer portal steps and your current state
x-axi login --client-id YOUR_CLIENT_ID       # in your own terminal; opens X's authorize page
x-axi auth status                            # the account, scopes, and expiry, with no API call
x-axi mentions --limit 5                     # $0.001 per post plus $0.01 per author, at most $0.055
x-axi post "hello from x-axi" --dry-run      # the exact request and cost, with no dialog and no write
```

The client ID comes from an app you create once at <https://console.x.com>, as [Connect your account](#connect-your-account) describes.
Pay-per-use API calls are billed to that app, so set a spend limit there first.

## Commands

| Group | Commands |
|---|---|
| Read | `me`, `timeline`, `mentions`, `replies`, `view`, `search`, `user`, `following`, `followers`, `likes`, `bookmarks`, `lists`, `list view`, `list members`, `mutes`, `blocks`, `trends`, `dm list`, `dm read`, `api`, `spend` |
| Write, approval required, each takes `--dry-run` | `post` (with `--media`, `--poll`, or `--quote`), `reply`, `thread`, `delete`, `hide`, `unhide`, `repost`, `unrepost`, `follow`, `unfollow`, `follow-file`, `bookmark`, `unbookmark`, `list create`, `list delete`, `list add`, `list remove`, `mute`, `unmute`, `dm send` |
| Plan, reads X and writes a local file | `follow-plan` |
| Account | `setup`, `login`, `logout`, `auth status`, `update` |

`x-axi` with no arguments shows the cached account and local spend without an API call.
`x-axi --help` lists the commands, and `x-axi <command> --help` shows its usage and cost.

## Output format

Output is TOON per the current specification, encoded by `@toon-format/toon` 4.
Read it with a current TOON decoder.
For what changed from 0.3, see the [v0.4.0 release notes](https://github.com/shreejitverma/x-axi/releases/tag/v0.4.0).

## Install

```sh
npm install -g @shreejitverma/x-axi
```

Node 22.12 or newer.
The package installs one command, `x-axi`.
`x-axi update` prints the installed version and the update command for npm and for a git checkout; it installs nothing itself.

From source:

```sh
git clone https://github.com/shreejitverma/x-axi.git
cd x-axi && pnpm install --frozen-lockfile && pnpm run build && npm link
```

Building from source uses pnpm 11, which itself needs Node 22.13 or newer; on an older Node, install pnpm's standalone `@pnpm/exe` build, which brings its own Node.
To update a checkout, run `git pull && pnpm install --frozen-lockfile && pnpm run build`.

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

### Scopes

x-axi requests these scopes: `tweet.read tweet.write tweet.moderate.write users.read follows.read follows.write media.write dm.read dm.write bookmark.read bookmark.write like.read list.read list.write mute.read mute.write block.read offline.access`.
The commands use all of them, and the raw `x-axi api` command can reach only endpoints they cover.

| Scope | Used by |
|---|---|
| `tweet.read`, `users.read` | every command that reads or writes |
| `tweet.write` | `post`, `reply`, `thread`, `delete`, `repost`, `unrepost` |
| `tweet.moderate.write` | `hide`, `unhide` |
| `follows.read`, `follows.write` | `following`, `followers`, `follow-plan`; `follow`, `unfollow`, `follow-file` |
| `media.write` | `post --media`, `reply --media` |
| `dm.read`, `dm.write` | `dm list`, `dm read`; `dm send` |
| `bookmark.read`, `bookmark.write` | `bookmarks`; `bookmark`, `unbookmark` |
| `like.read` | `likes` |
| `list.read`, `list.write` | `lists`, `list view`, `list members`; `list create`, `list delete`, `list add`, `list remove` |
| `mute.read`, `mute.write` | `mutes`; `mute`, `unmute` |
| `block.read` | `blocks` |
| `offline.access` | the refresh token |

A login made before a scope was added keeps working for everything else.
A command that needs a scope the login lacks stops with `MISSING_SCOPE` before any API call, spend, or dialog, and says to run `x-axi login` again in your own terminal.
This applies to `media.write` and to the bookmark, like, List, mute, and block scopes, which version 0.3.0 added.

### Upgrading from a version that used xurl

Earlier versions called the `xurl` CLI, which keeps a token and a client secret in plain text at `~/.xurl/auth.yml`.
x-axi no longer reads or writes that directory.
Those versions registered a Web App (confidential client) with the callback `http://localhost:8080/callback`, and x-axi cannot sign in through that app as it stands.

1. In the app's User authentication settings change Type of App to "Native App", and set the Callback URI to the one `x-axi setup` prints.
2. Copy the OAuth 2.0 Client ID from the Keys and tokens page, and run `x-axi login --client-id YOUR_CLIENT_ID` in your own terminal.
3. Delete `~/.xurl` if nothing else on the machine uses xurl.

The spend ledger, cached account, and follow log in `~/.local/state/x-axi` keep working unchanged.

## Using the commands

Reads use the account cached by `login`, the last `me`, or the last write, and timeline, mentions, search, bookmarks, mutes, and blocks output name it in `account`.
`auth status` shows the account, scopes, access token expiry, and the storage backend without an API call, and never a token.
`logout` revokes the access and refresh tokens at `https://api.x.com/2/oauth2/revoke`, then deletes the stored login and the cached account.
If revocation fails the deletion still happens and the output says which revocation failed.

List results show a few fields per item and a `count`, an empty result says so in words, such as `0 bookmarks found`, and a page with more after it gives a `next_token` and the command to continue.
Long post and DM text is truncated with its full length; `--full` shows all of it.

### Posts and metrics

`x-axi view <post>` shows the post with its public metrics: replies, likes, and reposts, and quotes, bookmarks, and impressions when X returns them.
They come with the post read itself, at no extra cost and with no extra scope.
`timeline`, `mentions`, `search`, `replies`, `bookmarks`, `likes`, and `list view` show replies and likes per post.

### Bookmarks and likes

`x-axi bookmarks` shows your bookmarked posts, `--limit` from 1 to 100.
`x-axi bookmark <post>` and `x-axi unbookmark <post>` add and remove one, each after a dialog that shows the post.
`x-axi likes [handle]` shows posts an account liked, yours without a handle, `--limit` from 5 to 100.
x-axi cannot like or unlike, as [X platform limits](#x-platform-limits) explains.

### Lists

`x-axi lists [handle]` shows the Lists an account owns, yours without a handle, with each List's ID, name, member count, and whether it is private.
`x-axi list view <list>` shows a List's posts and `x-axi list members <list>` its members, `--limit` from 1 to 100.
A `<list>` is a List ID or a URL such as `https://x.com/i/lists/123`.

- `x-axi list create <name> [--description TEXT] [--private]` creates a List; the name is 1 to 25 characters and the description at most 100, each on one line.
  Without `--private` the List is public, and the request says `private: false`.
- `x-axi list delete <list>` deletes one of your Lists; a List that is already gone is a no-op.
- `x-axi list add <list> <handle>` and `x-axi list remove <list> <handle>` change its members.

Delete, add, and remove first read the List so the dialog can show its name, visibility, and member count, and add and remove look up the handle so the dialog names the member.

### Mutes and blocks

`x-axi mutes` and `x-axi blocks` show the accounts you muted and blocked, `--limit` from 1 to 1000.
`x-axi mute <handle>` and `x-axi unmute <handle>` change a mute after approval.
There is no `block` or `unblock`, because X offers them only on Enterprise.

### Trends

`x-axi trends` shows trends personalized for you, with each trend's name, category, post count, and when it started trending.
`x-axi trends --woeid N [--limit 1-50]` shows trends for a place by its Yahoo WOEID, such as `1` for worldwide or `23424977` for the United States, with each trend's name and post count.
X bills each request the same, however many trends come back.

### Polls

`x-axi post <text> --poll "Tea|Coffee|Water" [--poll-minutes 5-10080]` attaches a poll of 2 to 4 options, each 1 to 25 characters, open for `--poll-minutes`, default 1440, which is one day.
Options are separated by `|`, the spaces around each are trimmed, and an option cannot itself contain `|`.
A poll needs text and cannot be combined with `--media` or `--quote`.
The dialog's first line shows every option, quoted, and the duration, and a dry run shows them under `dry_run.poll`.

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
- A read of either list that stops early writes no queue, and neither do partial errors on your own list, because such a queue could hold accounts you already follow.
- If X lists fewer of your follows than its own count, or reports partial errors on the other account's list, the queue is still written and the output carries a warning.

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
On Linux, if the text would not fit the Linux dialog, the output carries `dry_run.linux_dialog`, because the real run refuses that text with `APPROVAL_TEXT_TOO_LONG`.
macOS and other systems never show that dialog, so their dry runs leave it out.
Reads needed to validate it still happen and are billed, such as the account read, the parent post on a reply, the post on a bookmark, and the List and member lookups on a List write, and they appear as `est_cost`.
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
Report a vulnerability as [SECURITY.md](SECURITY.md) describes.

## Safety model

Every write opens a native dialog showing the account, the target, and estimated cost: the parent post on a reply, the post on a bookmark or repost, the List and member on a List write, and the account on a follow or mute.
Outgoing text appears in full under a tool-written header with its exact character and line counts, so all of those lines are sent, whatever they say about themselves.
Invisible characters are refused except where a language or emoji needs them: zero-width joiners in emoji and Indic script text, zero-width non-joiners in Arabic and Indic script text, tag characters in subdivision flags, and direction marks in right-to-left text.
Bidi embeddings, overrides, and isolates are always refused, in posts, DMs, poll options, and List names and descriptions alike.
The gate lives in the tool, so it applies under every harness and permission mode, including unattended runs.
It fails closed: Cancel, a 120-second timeout, a crash, or a missing dialog sends nothing.
There is no terminal prompt, flag, or environment override, because an agent could answer or set those.
Writes are never retried, because a retry after a lost response could publish twice.
A failed response that might have been applied returns `OUTCOME_UNKNOWN`, and so does a success that does not confirm the change, such as a bookmark answer without `bookmarked: true`.

## X platform limits

Checked on 2026-11-03 against the [changelog](https://docs.x.com/changelog), [pricing](https://docs.x.com/x-api/getting-started/pricing), [OAuth 2.0 documentation](https://docs.x.com/fundamentals/authentication/oauth-2-0/authorization-code), and the API reference page of each endpoint x-axi calls, such as [create post](https://docs.x.com/x-api/posts/create-post).

- API replies work only on your own posts, or when the post's author mentioned or quoted you.
  Otherwise `reply` returns `REPLY_NOT_SUMMONED` with a browser link holding your text.
- The April 16, 2026 changelog entry says following, likes, and quote-posts were removed from all self-serve tiers.
  A live follow on a Pay-per-use app still succeeded on 2026-10-31, so following may stop working without notice.
- x-axi has no `like` or `unlike`, because of that entry.
  Reading liked posts with `likes` is still documented and priced (Like: Read, and Owned Reads for your own), so it stays, though X may refuse it on self-serve.
- `post --quote` exists, but the create post reference says `quote_tweet_id` requires an Enterprise plan, so expect `FORBIDDEN` on self-serve; it is untested live.
- `repost` and `unrepost` use documented endpoints that the removal entry does not name, and the [API overview](https://docs.x.com/x-api/overview) says its endpoints are on pay-per-use, though it also lists likes.
  No page names reposts on pay-per-use specifically and the pricing page has no line for them, so they are untested and unpriced.
- x-axi has no `block` or `unblock`.
  The [Blocks introduction](https://docs.x.com/x-api/users/blocks/introduction) lists `GET /2/users/:id/blocking` as Pay-per-use and Enterprise, and `POST /2/users/:id/blocking` and `DELETE /2/users/:source_user_id/blocking/:target_user_id` as Enterprise only; the [Block User reference](https://docs.x.com/x-api/users/block-user) says the same in the [API index](https://docs.x.com/x-api/llms.txt).
- The [Personalized Trends introduction](https://docs.x.com/x-api/trends/personalized-trends/introduction) lists a Premium user subscription as a requirement, so `trends` without `--woeid` may return `FORBIDDEN` on an account without X Premium.
- The [Trends by WOEID reference](https://docs.x.com/x-api/trends/get-trends-by-woeid) lists OAuth 2.0 user context and an app Bearer Token, while its [introduction](https://docs.x.com/x-api/trends/trends-by-woeid/introduction) shows only the app token; x-axi sends the user token, which is untested live.
- Bookmarks, liked posts, Lists, mutes, blocks, trends, `post --poll`, and the quote, bookmark, and impression counts in `view` were added on 2026-11-03 from their API references, and none of them has been run against live X.
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

Reads work on every platform that has a keystore, so on Linux they need the Secret Service but no dialog.

On Linux:

- A graphical session means `DISPLAY` or `WAYLAND_DISPLAY` is set, so SSH with X forwarding counts and shows the dialog on the forwarded display.
- The tools are found only in `/usr/bin`, `/bin`, and `/usr/local/bin`, never through `PATH`, so copies from Nix, Flatpak, or Snap are not used.
- The tool gets a short list of display and locale variables and nothing else, because variables such as `ZENITY_CANCEL=0` or `LD_PRELOAD` could turn a Cancel into an approval.
- `kdialog` has no flag for the default button, so pressing Enter may approve; install `zenity` if you can.
- `kdialog` has no plain text mode, so x-axi sends it escaped rich text, and it has no timeout flag, so x-axi kills it at the timeout.
- The dialog holds about 25 lines of 50 columns.
  That is a conservative estimate rather than a measurement of the window, and macOS does not apply it.
- A word or URL wider than a line is split in the dialog with a `↵` mark at each break, and the dialog counts the breaks; the text sent to X is unchanged.
- Text you did not write for this action, such as a parent post, a post you are deleting, hiding, or bookmarking, or the path of a `follow-file` queue, is cut to fit with a marker giving its full character count, and never blocks the write.
- Text to send must be shown in full to be approved, so text too long to fit once wrapped returns `APPROVAL_TEXT_TOO_LONG` instead of a dialog.
  The text itself has room for about 19 rows, or about 950 characters of plain text, because the rest of the dialog is held for its other lines and any context.
  The rows of a split URL count toward that limit.
  A `--media` path is shown in the dialog's first lines, so it takes from that room: about 17 rows are left with a short path, and about 13 with a 120-character path.
  A poll's options are shown in those first lines too, and take from that room the same way.
- A `zenity` that cannot open its display exits with the same code as Cancel, so x-axi reads its error output and returns `APPROVAL_UNAVAILABLE` rather than reporting a cancel nobody made.
- The gate is weaker than on macOS.
  Any process running as you can click in an X11 dialog, or set `DISPLAY` to an X server it controls and click there.

CI runs the suite on Ubuntu and macOS on Node 22, 24, and 26.
It tests the Linux dialogs with fake executables that record their arguments and exit with a chosen code, so no real click reaches `zenity` or `kdialog` in CI.
The flags were checked against the help output of `zenity` 4.0.1 and `kdialog` 23.08 and against their upstream source on 2026-11-01.
Neither real Linux dialog has been opened by the test suite, so how they look on your desktop is unverified.
CI installs the standalone pnpm build described under [Install](#install).

## Cost

Each priced result shows `est_cost`, and `x-axi spend` totals them locally.
A write's `est_cost` is the write alone; the lookups before its dialog appear only in `spend`.
These are upper bounds, because X does not re-bill a resource within a UTC day and may change its rates.

| What | Rate used |
|---|---|
| A post read (`view`, `search`, `replies`, `list view`, and the post shown on a write) | $0.005 per post |
| A user read (`me`, `user`, a handle lookup, each author X includes, `list members`) | $0.010 per account |
| Following and followers lists | $0.010 per account |
| Another account's liked posts | $0.001 per post (Like: Read) |
| Another account's Lists, and the List read before a List write | $0.005 per List |
| Mutes and blocks | $0.001 per account |
| Your own timeline, mentions, bookmarks, liked posts, Lists, and following and followers | $0.001 per item (Owned Reads) |
| `trends` | $0.010 per request |
| `post`, `reply`, each `thread` part | $0.015, $0.20 with a URL, $0.010 for a summoned reply |
| `follow`, `mute` | $0.015 |
| `delete`, `unfollow` | $0.010 |
| `bookmark`, `unbookmark` | $0.005 |
| `list create` | $0.010 |
| `list delete`, `list add`, `list remove` | $0.005 (List: Manage) |
| `unmute` | $0.005 (Mute: Delete) |
| `dm send`; DM reads | $0.015; $0.010 per message |

The `hide`, `unhide`, `repost`, `unrepost`, media upload, and `api` calls have no estimate, so they add nothing to these totals and `spend` counts them in `unpriced_calls_30d`.
The [pricing page](https://docs.x.com/x-api/getting-started/pricing) lists no price for media upload or reposting, so a post with media shows the price of the post alone.
X gives the Owned Read rate only when `{id}` is the logged-in account and that account also owns the app, so under another app's login those estimates are low.
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
Commands run against fakes of X that answer with the shapes in each endpoint's API reference, and no test calls live X.
Under `X_AXI_API_BASE`, which may only point at loopback, the keystore is never read, a fixed test token is sent, and the login's scopes are unknown, so `MISSING_SCOPE` checks let commands through.
[CONTRIBUTING.md](CONTRIBUTING.md) has the rules for tests, commits, and releases.

## License

[MIT](LICENSE)
