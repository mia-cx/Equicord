# MessageArchive

Saves every message the Discord client loads while you use it, and can scroll
back through older history on its own while Discord is in the background. It
never calls Discord's API itself: it only records what the client loaded.
Attachment downloads, off by default, are the one exception.

## What gets saved

- Channel history as you scroll
- New messages and edits that arrive live
- Search results and the recent-mentions inbox
- Older history fetched by backfill, when it is on

Each conversation gets one file with one raw Discord API message per line:

```
servers/<guild_id>/<channel_id>.jsonl
dms/<user_id>.jsonl
groups/<channel_id>.jsonl
unsorted/<channel_id>.jsonl   channels Discord hadn't loaded yet
```

Repeated loads of the same message are skipped. An edit adds a new line with a
new `edited_timestamp`, so the last line for an `id` is its latest version.

## Settings

- **Archive folder**: where the files go. Defaults to `EquicordData/MessageArchive`.
- **Direct messages** and **Servers**: which kinds of channel to archive and
  backfill. **Servers** lists every server you're in with its own switch,
  under an **All servers** switch that sets them all at once. Running
  `/archive-server` in a server flips that one too.
- **Save media** and **Save files**: download images and videos, or every other
  attachment, into a folder beside the conversation's file, such as
  `servers/<guild_id>/<channel_id>/<attachment_id>-<filename>`. Each file
  is fetched from Discord's CDN once.
- **Max file size**: attachments larger than this are skipped.
- **Auto backfill** and the schedule: see below.

## Backfill

Backfill scrolls the client back through history in sessions: DMs first, then
every server channel you can read. It opens each channel at the oldest message
already in the archive, the way a message link does. Then, once per page wait,
it focuses the message list and presses Home to reach the top of what's
loaded, then Page Up, so Discord loads older messages as it would for you. The
keys are real input sent to Discord's window. The archive saves what arrives. A
channel is finished once Discord has loaded its first message.

### Data package

Choose **Import data package** in the plugin settings and pick the zip Discord
sends when you request your data. Backfill then visits your own messages from
it before anything else. It finishes one channel, DM or group at a time,
starting with the one you last wrote in, newest message first. For each message
the archive doesn't have yet, it opens the message's link, waits for Discord to
finish scrolling to it, presses Page Down and then Page Up twice, which gets
back above the message, so Discord loads the conversation on both sides, then
waits a page wait with jitter. Messages
already covered by an earlier visit are skipped. Channels you can no longer
open are passed over until Discord reloads. A channel that opens but loads
slowly is tried again after the next wait. Once every package message it can reach is archived,
backfill moves on to scrolling back through the rest of your history. Only the
message and channel files are read from the zip.

Once imported, the settings show how many of your messages the package holds
and the next three backfill will open. **Replace data package** imports a newer
one and starts over, and **Remove** forgets it.

Turn on **Auto backfill** to run sessions on a schedule while Discord is not
focused. Each session picks a random value from each range:

| Setting | Default |
| --- | --- |
| Start between | 1 and 5 o'clock (AM) |
| Run for | 1 to 3 hours |
| Wait per page | 6 to 30 seconds |
| Jitter | 75% either way |

The page wait is picked once per session, so some sessions run faster than
others. Every individual wait then varies by the jitter.

Run `/backfill start` in a channel or DM to back it up to its first message
right away. With a data package imported, the session works through the package
first, starting with your messages in that channel. The session stops when that
channel is finished, or carries on with your other channels when you pass
`all: True`. A session started this way keeps
running while Discord is focused, and pauses if you switch to another channel.
`/backfill pause` holds it until the next `/backfill start`, and
`/backfill stop` ends it. A toast shows when a session starts, pauses, resumes,
finishes, or runs out of time.

An unattended client scrolling through history for hours is still a pattern
Discord can see.

Desktop only, because the files are written by the native side.
