# x-axi

An [AXI](https://axi.md) CLI for reading X data and managing your X account from an agent session.
It is built on the official [xurl](https://github.com/xdevplatform/xurl) CLI, which owns the OAuth 2.0 PKCE login and token refresh.

## Install

```sh
go install github.com/xdevplatform/xurl@v1.3.4
cd ~/github/x-axi && pnpm install --frozen-lockfile && pnpm run build && npm link
```

To update, run `git pull && pnpm install --frozen-lockfile && pnpm run build` in the checkout.
`x-axi update` only prints this, because the `x-axi` name on npm does not belong to this project.

## Connect your account

Run `x-axi setup` and follow the steps in your own terminal, not through an agent.
`xurl auth apps add` requires a client secret, so create a confidential client, and set a spend limit in the console.

## Commands

| Group | Commands |
|---|---|
| Read | `me`, `timeline`, `mentions`, `replies`, `view`, `search`, `user`, `dm list`, `dm read`, `api`, `spend` |
| Write, approval required | `post`, `reply`, `delete`, `hide`, `unhide`, `follow`, `unfollow`, `follow-file`, `dm send` |

Reads use the account cached by the last `me` or write, and timeline, mentions, and search output name it in `account`.
After switching logins with xurl, run `x-axi me` to refresh it.

## Safety model

Every write opens a native macOS dialog showing the account, parent post, and estimated cost.
Outgoing text appears in full under a tool-written header with its exact character and line counts, so all of those lines are sent, whatever they say about themselves.
The gate lives in the tool, so it applies under every harness and permission mode, including unattended runs.
It fails closed: Cancel, a 120-second timeout, or a missing dialog sends nothing.
Writes are never retried, because a retry after a lost response could publish twice.
A failed response that might have been applied returns `OUTCOME_UNKNOWN`.

The gate is not a sandbox.
xurl stores the token and client secret in plain text in `~/.xurl/auth.yml`, with broad scopes that xurl chooses.
A process that reads that file can act as you, so the Claude Code guard blocks agent access to it and to raw `xurl`.
Other harnesses do not have that guard.

## X platform limits

Checked against the [changelog](https://docs.x.com/changelog) and [pricing](https://docs.x.com/x-api/getting-started/pricing) on 2026-10-31.

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

## Cost

Each result shows `est_cost`, and `x-axi spend` totals them locally.
These are upper bounds, because X does not re-bill a resource within a UTC day and may change its rates.
A write with an unknown outcome is counted, because it may have been billed.
The console is the billing truth, and its spend limit is the only hard cap.

## Test

```sh
pnpm run build && pnpm test
X_AXI_TEST_DIALOG=1 pnpm test   # also opens a real dialog for one second and lets it expire
```
