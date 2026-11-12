# MessageArchive

Saves every message the Discord client loads while you use it, and can scroll
back through older history on its own while Discord is in the background.

## What gets saved

- Channel history as you scroll
- New messages and edits that arrive live
- Search results and the recent-mentions inbox
- Older history fetched by backfill, when it is on

Each channel gets one file, `<channel_id>.jsonl`, with one raw Discord API
message per line. Repeated loads of the same message are skipped. An edit adds a
new line with a new `edited_timestamp`, so the last line for an `id` is its
latest version.

## Backfill

Turn on **Backfill** to have the plugin page back through history while
Discord is not focused: DMs first, then every server channel you can read.

Each channel resumes from the oldest message already in the archive, so
history you scrolled through yourself is never fetched again. A channel is
finished once Discord returns its first message.

Backfill runs in sessions. Each session starts at a random time between
**Earliest start hour** and **Latest start hour** (1:00 to 5:00 by default),
lasts a random length between the minimum and maximum session hours (1 to 3),
and waits a random interval between pages (4 to 90 seconds). A rate limit ends
the session early. Focusing Discord pauses it.

These requests are the same ones Discord makes when you scroll up, but an
unattended client paging through history for hours is a pattern Discord can
see.

## Where

The archive is stored at `EquicordData/MessageArchive`. Open
**Equicord Settings → Plugins → MessageArchive** and choose
**Open archive folder** to go straight there.

Desktop only, because the files are written by the native side.
