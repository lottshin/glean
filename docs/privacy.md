# Glean Capture Privacy Policy

Effective date: September 15, 2026

Glean Capture is a Chrome extension that syncs English captions selected by the user from YouTube or Bilibili to the Glean plugin running in the user's local Obsidian app.

## Data We Handle

The extension handles the current video's title, URL, channel or author name, caption language, and English captions selected by the user. For Bilibili videos, it also handles temporary media URLs and related media metadata so Glean can open the corresponding learning material in Obsidian.

## Local Storage

The extension stores the user-configured Obsidian receiver port and token in Chrome Sync storage. Caption segmentation results are cached in Chrome local storage. Users can remove this data through Chrome's extension data controls or by uninstalling the extension.

## Data Transfer And Sharing

When the user explicitly starts a sync, the extension sends the selected captions and necessary video information only to the Obsidian receiver configured by the user at `127.0.0.1` or `localhost`.

Glean does not operate remote collection, analytics, or advertising servers. We do not sell user data or share it with third parties.

## Permission Use

- `storage` stores receiver settings and caption cache data.
- `scripting` restores the content script in an already-open YouTube or Bilibili video page after the extension is installed or updated, so the user does not have to refresh the page manually.

## Third-Party Websites

The extension runs only on YouTube and Bilibili video pages. Those websites are governed by their own terms and privacy policies.

## Contact

For privacy questions, contact the developer through the project's GitHub support page.
