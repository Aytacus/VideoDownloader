# VideoDownloader

VideoDownloader is a Chromium-based browser extension (Manifest V3) designed to detect, download, and merge video, audio, and subtitle streams from web pages. It features an advanced stream downloader interface and integrates FFmpeg both in-browser (via WebAssembly) and as a local command fallback to handle complex stream merging.

## Key Features

* Automated Media Sniffing: Intercepts network requests to identify video links (such as direct .mp4, .webm, or .mkv streams) and HLS playlist configurations (.m3u8).
* Subtitle Extraction: Automatically captures subtitle files (including .vtt and .srt formats) loaded by web media players.
* Clean Stream Filtering: Includes built-in heuristics to exclude promotional advertisements, ad-networks, trackers, and gambling-related video sources.
* User Interface: Provides a structured popup with dedicated tabs for Videos and Subtitles, listing detected items per tab.
* Dual Audio & Track Selection: For HLS streams, users can choose specific video qualities, select multiple audio tracks, and pick subtitle languages before initiating the download.
* Live Progress Statistics: Displays real-time details such as chunk progress, downloading speed, and Estimated Time of Arrival (ETA).
* AES-128 HLS Decryption: Automatically fetches encryption keys and decrypts segments in-memory when downloading protected HLS streams.

## How FFmpeg Integration Works

This extension relies heavily on FFmpeg to process and combine separate video, audio, and subtitle files. Since browser environments download video and audio tracks separately for adaptive streaming (like HLS), merging is necessary to produce a single playable media file.

### In-Browser Auto-Merging (FFmpeg WebAssembly)

The extension loads WebAssembly-based FFmpeg components (`ffmpeg-core.js` and `ffmpeg-core.wasm`) directly in the browser's sandbox context.
* Mechanism: When a multi-track download completes, the downloaded streams are written to the virtual FFmpeg filesystem (FS).
* Execution: An in-browser FFmpeg process executes CLI arguments (e.g. mapping tracks, setting codecs, compiling metadata) and compiles them into a unified `.mkv` or `.mp4` file.
* Advantage: The user does not need to install external software or use command-line interfaces.

### Local FFmpeg Fallback (Large Files & CSP Restrictions)

WebAssembly in browser tabs operates with strict memory allocation limits (typically under 2GB) and can be blocked by certain website Content Security Policies (CSP). If the automatic WASM merge fails or is bypassed:
1. Separate Files: The extension downloads the raw video, audio, and subtitle files directly to the local download folder.
2. Shell Command Generator: It generates and displays the precise native command required to merge the downloaded assets. Users can copy the command with a single click.
3. Windows Batch Integration: Users can click the "Download Batch Script" button to generate a `merge.bat` script. Placing this script alongside the downloaded files and running it automatically merges them using a locally installed FFmpeg binary.

## Project Structure

* `manifest.json`: Extension configuration including Manifest V3 schemas, background worker registration, and security headers (Cross-Origin-Opener-Policy / Cross-Origin-Embedder-Policy) required for FFmpeg SharedArrayBuffer support.
* `background.js`: The service worker managing network request redirection, filtering ads, and tracking sniffed stream resources for active tabs.
* `downloader.html` & `downloader.js`: The primary download controller dashboard where playlist parsing, decryption, segment fetching, and FFmpeg.WASM execution occur.
* `popup.html` & `popup.js`: The popup interface displaying detected streams and launching the downloader.

## Installation

Since this extension is distributed as developer source code, install it using the following steps:

1. Open a Chromium-based browser (Chrome, Edge, Brave, Opera, etc.).
2. Navigate to the Extensions management page (e.g. `chrome://extensions`).
3. Enable "Developer mode" in the top-right corner.
4. Click "Load unpacked" in the top-left corner.
5. Select the root directory containing these extension files.

## Required Permissions

* `webRequest` & `declarativeNetRequest`: Essential for monitoring browser network traffic to detect media stream patterns and manifest files.
* `downloads`: Required to save downloaded segments, files, and batch scripts to the local system storage.
* `activeTab` & `webNavigation`: Used to detect active tab changes and refresh the media lists for the active browsing session.
* `storage`: Used to save user options and downloader preferences.

## Usage Disclaimer

This tool is designed to assist in downloading video and audio tracks for personal archiving and offline viewing. Users are responsible for complying with the terms of service of the websites they visit and ensuring they have the rights or permission to download the media content.
