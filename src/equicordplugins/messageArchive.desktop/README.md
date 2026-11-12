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

Turn on **Backfill** to have the plugin page back through history whenever
Discord is not focused: DMs first, then every server channel you can read. It
fetches one page of 50 messages every 3 to 8 seconds, pauses for 3 minutes
after every 25 pages, and stops for the day after 1000 pages or the first rate
limit. It pauses as soon as you focus Discord and resumes where it left off,
even after a restart.

These requests are the same ones Discord makes when you scroll up, but an
unattended client paging through history for hours is a pattern Discord can
see.

## Where

The archive is stored at `EquicordData/MessageArchive`. Open
**Equicord Settings → Plugins → MessageArchive** and choose
**Open archive folder** to go straight there.

Desktop only, because the files are written by the native side.
