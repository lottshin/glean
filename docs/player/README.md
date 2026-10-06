# Glean YouTube player page

This is the small HTTPS page used by Glean on iPad and other mobile Obsidian
WebViews. It loads the official YouTube IFrame Player API and relays only
player commands and playback time through `postMessage`.

The page does not download, proxy, store, or upload video, captions, or Vault
files. YouTube video bytes go directly from YouTube to the device.

Publish the repository's `docs/` directory with GitHub Pages, then set the
resulting `/player/` URL in `src/media/youtube.ts` as
`YOUTUBE_PLAYER_BRIDGE_URL`.
