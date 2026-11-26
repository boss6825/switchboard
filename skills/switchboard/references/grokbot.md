# Grok Bot

## How the round trip works

1. `sb grokbot send` makes a request id (`gb_` + 16 hex), records it in
   `~/.switchboard/grokbot/requests/`, and POSTs JSON to the Grok Bot routine's webhook:
   `request_id`, `task`, `context`, `reply_command`. The routine key goes in a header
   (`Authorization: Bearer <key>` by default).
2. Grok Bot runs the routine on its cloud computer and does the task.
3. The routine runs `reply_command` on the user's Mac with its answer on stdin. That is
   `sb grokbot reply --request-id <id> --status done|error`, which writes
   `~/.switchboard/grokbot/replies/<id>.json`. Replies for ids this machine did not send are
   refused.
4. `send` (or `wait`) sees the file and prints `{request_id, status, result, received_at,
   seconds_after_send}`.

A webhook answer of 200/202 only means the run started, not that it finished.

## When the reply does not arrive

- `pending` after 540 s: run `sb grokbot wait --request-id <id>` once or twice more. Long
  research can take several minutes.
- Still nothing: the likely causes, for the user to check in the Grok Bot app:
  - the Bot is waiting for approval to run the reply command on the Mac ("Execution on
    this computer" is set to Ask every time);
  - local execution is off for this Mac;
  - the routine instruction does not include the text from `sb grokbot instructions`;
  - the run failed (the routine's run history says why, e.g. the hourly routine limit).
  The answer may also be sitting in the Bot's chat. Do not resend the task; tell the user.
- HTTP errors from `send` come with a one-line cause (401: key rotated or routine paused;
  404: wrong URL or routine deleted; 429: hourly routine limit).

## Setup (the user does this once per Mac)

Walk the user through these four steps (see SKILL.md). Only the user can do 2 and 3.

1. `sb grokbot instructions` copies a message for their Bot. They paste it into a chat with
   their Grok Bot (desktop app). The Bot creates a routine named "Switchboard" with a webhook
   trigger and replies with the URL.
2. `sb grokbot setup` in their terminal: paste the URL (or the Bot's whole reply), then the
   key (hidden). Where the key is, in the Grok Bot desktop app: in the right-hand panel,
   under "Routines", click the routine's **name** (not its on/off switch). A panel opens with a
   Webhook section: **POST to**, **key**, **header**, each with a copy icon (an eye icon shows
   the hidden value). Copy the key; the header field works too (it is `Authorization: Bearer
   <key>`, and setup strips the prefix). The key is one string, never text from the chat.
3. Grok Bot settings: turn on "Execution on this computer" for this Mac. With the default
   "Ask every time" they approve each reply once.
4. `sb grokbot test`: sends a ping, waits for `pong`.

`sb grokbot status` shows what is set without printing values. Keychain entries are
`GROKBOT_WEBHOOK_URL`, `GROKBOT_WEBHOOK_SECRET`, `GROKBOT_WEBHOOK_HEADER` (account
`switchboard`); environment variables with those names override them (Linux, CI). Without a
terminal: `sb grokbot setup --url <url> --key-stdin < keyfile`.

Never read the Keychain entries, print the key, or put it in a task.
