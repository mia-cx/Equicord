# MessageArchive

Saves every message the Discord client loads while you use it normally. It makes
no requests of its own: it only records what Discord already fetched, so your
traffic looks the same with or without the plugin.

## What gets saved

- Channel history as you scroll
- New messages and edits that arrive live
- Search results and the recent-mentions inbox

Each channel gets one file, `<channel_id>.jsonl`, with one raw Discord API
message per line. Repeated loads of the same message are skipped. An edit adds a
new line with a new `edited_timestamp`, so the last line for an `id` is its
latest version.

## Where

The archive is stored at `EquicordData/MessageArchive`. Open
**Equicord Settings → Plugins → MessageArchive** and choose
**Open archive folder** to go straight there.

Desktop only, because the files are written by the native side.
