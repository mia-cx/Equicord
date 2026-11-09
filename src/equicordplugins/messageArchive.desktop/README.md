# MessageArchive

Saves every message the Discord client loads while you use it normally. It makes
no requests of its own: it only records what Discord already fetched, so your
traffic looks the same with or without the plugin. Attachment downloads are the
one exception, and they are off by default.

## What gets saved

- Channel history as you scroll
- New messages and edits that arrive live
- Search results and the recent-mentions inbox

Each channel gets one file, `<channel_id>.jsonl`, with one raw Discord API
message per line. Repeated loads of the same message are skipped. An edit adds a
new line with a new `edited_timestamp`, so the last line for an `id` is its
latest version.

## Settings

- **Archive folder**: where the files go. Defaults to `EquicordData/MessageArchive`.
- **Direct messages** and **Servers**: which kinds of channel to archive.
- **Save media** and **Save files**: download images and videos, or every other
  attachment, to `attachments/<channel_id>/<attachment_id>-<filename>`. Each file
  is fetched from Discord's CDN once.
- **Max file size**: attachments larger than this are skipped.

Desktop only, because the files are written by the native side.
