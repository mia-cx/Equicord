# MessageArchive

Saves every message the Discord client loads while you use it, and can scroll
back through older history on its own while Discord is in the background.
Without backfill or attachment downloads, it makes no requests of its own: it
only records what Discord already fetched.

## What gets saved

- Channel history as you scroll
- New messages and edits that arrive live
- Search results and the recent-mentions inbox
- Older history fetched by backfill, when it is on

Each channel gets one file, `<channel_id>.jsonl`, with one raw Discord API
message per line. Repeated loads of the same message are skipped. An edit adds a
new line with a new `edited_timestamp`, so the last line for an `id` is its
latest version.

## Settings

- **Archive folder**: where the files go. Defaults to `EquicordData/MessageArchive`.
- **Direct messages** and **Servers**: which kinds of channel to archive and
  backfill.
- **Save media** and **Save files**: download images and videos, or every other
  attachment, to `attachments/<channel_id>/<attachment_id>-<filename>`. Each file
  is fetched from Discord's CDN once.
- **Max file size**: attachments larger than this are skipped.
- **Auto backfill** and the schedule: see below.

## Backfill

Backfill pages back through history in sessions: DMs first, then every
server channel you can read. Each channel resumes from the oldest message
already in the archive, so history you scrolled through yourself is never
fetched again. A channel is finished once Discord returns its first message.

Turn on **Auto backfill** to run sessions on a schedule while Discord is not
focused. Each session picks a random value from each range:

| Setting | Default |
| --- | --- |
| Start between | 1 and 5 o'clock (AM) |
| Run for | 1 to 3 hours |
| Wait per page | 6 to 30 seconds |
| Jitter | 75% either way |

The page wait is picked once per session, so some sessions run faster than
others. Every individual wait then varies by the jitter. A rate limit ends the
session early.

Run `/backfill` to start a session right away, or to stop the one you started.
A session started this way keeps running while Discord is focused.

These requests are the same ones Discord makes when you scroll up, but an
unattended client paging through history for hours is a pattern Discord can
see.

Desktop only, because the files are written by the native side.
