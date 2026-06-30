// background.js - Network sniffer and downloader helper

const capturedVideos = {}; // tabId -> array of video objects: {url, type, initiator, timestamp, thumbnail}
const capturedSubtitles = {}; // tabId -> array of subtitle objects: {url, type, filename, initiator, timestamp, language}

// Helper to extract language/track information from the URL and construct a descriptive filename
function getSubtitleInfoFromUrl(url, extension) {
  try {
    const parsed = new URL(url);
    const params = parsed.searchParams;
    
    // Check common language/track/type query parameter names
    const langKeys = ["lang", "language", "locale", "srclang", "label", "name", "track", "type"];
    let trackInfo = "";
    
    for (const key of langKeys) {
      if (params.has(key)) {
        const val = params.get(key);
        if (val && val.length < 15) { // reasonable length for a label or lang code
          trackInfo = val;
          break;
        }
      }
    }

    // Try to get filename from path
    const cleanUrl = url.split("?")[0];
    const urlParts = cleanUrl.split("/");
    const lastPart = urlParts[urlParts.length - 1];
    
    let baseName = "Subtitles";
    if (lastPart && lastPart.includes(".")) {
      const dotIdx = lastPart.lastIndexOf(".");
      baseName = decodeURIComponent(lastPart.substring(0, dotIdx));
    } else if (lastPart) {
      baseName = decodeURIComponent(lastPart);
    }
    
    // Combine baseName and trackInfo
    let filename = baseName;
    if (trackInfo) {
      filename = `${baseName} (${trackInfo})`;
    }
    
    return {
      filename: filename + extension,
      trackInfo: trackInfo,
      cleanPath: cleanUrl
    };
  } catch (e) {
    return {
      filename: "Subtitle File" + extension,
      trackInfo: "",
      cleanPath: url.split("?")[0]
    };
  }
}

// Helper to detect sequence pattern and return a template URL (excluding query parameters)
function getCleanSequenceTemplate(url) {
  const cleanUrl = url.split("?")[0];
  const lastSlashIdx = cleanUrl.lastIndexOf("/");
  if (lastSlashIdx === -1) return cleanUrl;
  
  const path = cleanUrl.substring(0, lastSlashIdx + 1);
  const filename = cleanUrl.substring(lastSlashIdx + 1);
  
  const dotIdx = filename.lastIndexOf(".");
  const nameWithoutExt = dotIdx !== -1 ? filename.substring(0, dotIdx) : filename;
  const ext = dotIdx !== -1 ? filename.substring(dotIdx) : "";
  
  const match = nameWithoutExt.match(/(\d+)(?!.*\d)/);
  if (!match) {
    return cleanUrl;
  }
  
  const numStr = match[1];
  const matchIndex = match.index;
  
  const templateName = nameWithoutExt.substring(0, matchIndex) + "{SEQ}" + nameWithoutExt.substring(matchIndex + numStr.length);
  return path + templateName + ext;
}

// Extracts real video URL if embedded in tracking query parameters (like ping.gif?mu=...)
function extractRealVideoUrl(inputUrl) {
  try {
    const parsed = new URL(inputUrl);
    
    // Check if the main path is directly a video
    const pathLower = parsed.pathname.toLowerCase();
    const isDirectVideo = pathLower.includes(".m3u8") || 
                          pathLower.includes(".mp4") || 
                          pathLower.includes(".webm") || 
                          pathLower.includes(".mkv") || 
                          pathLower.includes(".mpd");
                          
    if (isDirectVideo) {
      return inputUrl;
    }
    
    // Scan query params for embedded media links
    for (const [key, value] of parsed.searchParams.entries()) {
      const valLower = value.toLowerCase();
      if (valLower.includes(".m3u8") || 
          valLower.includes(".mp4") || 
          valLower.includes(".webm") || 
          valLower.includes(".mkv") || 
          valLower.includes(".mpd")) {
        if (value.startsWith("http://") || value.startsWith("https://")) {
          return value;
        }
      }
    }
  } catch (e) {
    console.error("URL extraction error:", e);
  }
  return inputUrl;
}

// Check if a captured video URL is likely a promotional ad or tracker
function isPotentialAd(url) {
  const urlLower = url.toLowerCase();
  const adKeywords = [
    "doubleclick.net",
    "googleads",
    "adnxs",
    "adsystem",
    "adserver",
    "ad_video",
    "vast",
    "vpaid",
    "pre-roll",
    "advertisement",
    "adskeeper",
    "popunder",
    "traffic",
    "telemetry",
    "ping.gif",
    "ad.mp4",
    "/ads/",
    "adsterra",
    "exoclick",
    "adsco.re",
    "popads",
    "propellerads",
    "adcash",
    "mgid",
    "exdynsrv",
    "reklam",
    "1xbet",
    "bettilt",
    "megapari",
    "melbet",
    "mostbet",
    "jojobet",
    "paribahis",
    "casino",
    "creative",
    "admail"
  ];
  return adKeywords.some(keyword => urlLower.includes(keyword));
}

// Helper to add captured video and notify content script/badge
function addCapturedVideo(tabId, url, type, initiator) {
  if (tabId < 0) return;

  if (!capturedVideos[tabId]) {
    capturedVideos[tabId] = [];
  }

  const cleanUrl = url.split("?")[0];
  // Check if we already captured this exact URL
  const exists = capturedVideos[tabId].some(
    (v) => v.url === url || v.url.split("?")[0] === cleanUrl
  );

  if (!exists) {
    let filename = "Video File";
    try {
      const urlParts = cleanUrl.split("/");
      const lastPart = urlParts[urlParts.length - 1];
      if (lastPart && lastPart.includes(".")) {
        filename = decodeURIComponent(lastPart);
      }
    } catch (e) {}

    const videoObject = {
      url: url,
      type: type,
      filename: filename,
      initiator: initiator || "Unknown page",
      timestamp: Date.now(),
      thumbnail: "" // Initially empty, will be updated by content script if available
    };

    capturedVideos[tabId].push(videoObject);
    if (capturedVideos[tabId].length > 10) {
      capturedVideos[tabId].shift();
    }

    // Update badge
    updateBadge(tabId);

    // Trigger visual toast notification in the page content (only if not a potential ad!)
    if (!isPotentialAd(url)) {
      setTimeout(() => {
        chrome.tabs.sendMessage(tabId, {
          action: "showDetectionToast",
          video: videoObject
        }, () => {
          // Suppress errors for tabs without content script (e.g. chrome:// settings)
          if (chrome.runtime.lastError) {
            // Ignored
          }
        });
      }, 500);
    }
  }
}

// Sniff network requests for video formats and HLS playlists
chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    let { url, tabId, initiator } = details;
    if (tabId < 0) return; // Ignore requests not related to a specific tab

    url = extractRealVideoUrl(url);
    const urlLower = url.toLowerCase();

    // Check if it's a subtitle request
    let isSub = false;
    let subType = "";
    let extension = "";

    if (urlLower.includes(".vtt") || urlLower.includes("mime=text/vtt") || urlLower.includes("format=vtt")) {
      isSub = true;
      subType = "WebVTT Subtitle (.vtt)";
      extension = ".vtt";
    } else if (urlLower.includes(".srt") || urlLower.includes("mime=text/srt") || urlLower.includes("format=srt")) {
      isSub = true;
      subType = "SubRip Subtitle (.srt)";
      extension = ".srt";
    } else if (urlLower.includes(".ass") || urlLower.includes("format=ass")) {
      isSub = true;
      subType = "SubStation Alpha (.ass)";
      extension = ".ass";
    } else if (urlLower.includes(".ssa")) {
      isSub = true;
      subType = "SubStation Alpha (.ssa)";
      extension = ".ssa";
    } else if (urlLower.includes(".ttml") || urlLower.includes("format=ttml")) {
      isSub = true;
      subType = "TTML Subtitle (.ttml)";
      extension = ".ttml";
    } else if (
      urlLower.includes("subtitle") || 
      urlLower.includes("subtitles") || 
      urlLower.includes("/sub/") || 
      urlLower.includes("/subs/") ||
      urlLower.includes("/caption/") ||
      urlLower.includes("/captions/")
    ) {
      isSub = true;
      if (urlLower.includes(".json")) {
        subType = "JSON Subtitle (.json)";
        extension = ".json";
      } else if (urlLower.includes(".xml") || urlLower.includes(".ttml")) {
        subType = "XML Subtitle (.xml)";
        extension = ".xml";
      } else if (urlLower.includes(".srt")) {
        subType = "SubRip Subtitle (.srt)";
        extension = ".srt";
      } else if (urlLower.includes(".ass") || urlLower.includes(".ssa")) {
        subType = "SubStation Alpha";
        extension = ".ass";
      } else {
        subType = "WebVTT Subtitle (.vtt)";
        extension = ".vtt";
      }
    }

    if (isSub) {
      if (!capturedSubtitles[tabId]) {
        capturedSubtitles[tabId] = [];
      }
      
      const subInfo = getSubtitleInfoFromUrl(url, extension);
      const cleanTemplate = getCleanSequenceTemplate(url);
      
      const exists = capturedSubtitles[tabId].some((s) => {
        const sTemplate = getCleanSequenceTemplate(s.url);
        const sInfo = getSubtitleInfoFromUrl(s.url, extension);
        return sTemplate === cleanTemplate && sInfo.trackInfo === subInfo.trackInfo;
      });

      if (!exists) {
        capturedSubtitles[tabId].push({
          url: url,
          type: subType,
          filename: subInfo.filename,
          initiator: initiator || "Unknown page",
          timestamp: Date.now(),
          language: subInfo.trackInfo
        });

        if (capturedSubtitles[tabId].length > 20) {
          capturedSubtitles[tabId].shift();
        }
      }
      return; // Stop processing since it's a subtitle
    }

    let type = "";

    // Comprehensive video matching rules including dynamic queries
    if (urlLower.includes(".m3u8") || urlLower.includes("/hls/") || urlLower.includes("m3u8")) {
      type = "HLS Playlist (.m3u8)";
    } else if (
      urlLower.includes(".mp4") || 
      urlLower.includes("mime=video/mp4") || 
      urlLower.includes("mime=video%2fmp4") ||
      urlLower.includes("format=mp4") ||
      urlLower.includes("ext=mp4") ||
      urlLower.includes("type=mp4") ||
      urlLower.includes("/mp4/")
    ) {
      type = "MP4 Video";
    } else if (
      urlLower.includes(".webm") || 
      urlLower.includes("mime=video/webm") || 
      urlLower.includes("mime%2fwebm") ||
      urlLower.includes("type=webm")
    ) {
      type = "WebM Video";
    } else if (urlLower.includes(".mkv") || urlLower.includes("mime=video/x-matroska")) {
      type = "MKV Video";
    } else if (urlLower.includes(".mpd") || urlLower.includes("/dash/")) {
      type = "DASH Playlist (.mpd)";
    }

    // Skip potential ads only if they do not match any known video extensions/patterns
    if (type === "" && isPotentialAd(url)) return;

    if (type !== "") {
      addCapturedVideo(tabId, url, type, initiator);
    }
  },
  { urls: ["<all_urls>"] }
);

// Sniff response headers to detect videos by Content-Type (useful for obfuscated/extensionless URLs)
chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    const { url, tabId, responseHeaders, initiator } = details;
    if (tabId < 0) return;

    const contentTypeHeader = responseHeaders.find(
      (h) => h.name.toLowerCase() === "content-type"
    );
    if (!contentTypeHeader) return;

    const contentType = contentTypeHeader.value.toLowerCase();
    let type = "";

    if (contentType.includes("mpegurl") || contentType.includes("m3u8")) {
      type = "HLS Playlist (.m3u8)";
    } else if (contentType.includes("video/mp4")) {
      type = "MP4 Video";
    } else if (contentType.includes("video/webm")) {
      type = "WebM Video";
    } else if (contentType.includes("video/x-matroska")) {
      type = "MKV Video";
    } else if (contentType.includes("dash+xml")) {
      type = "DASH Playlist (.mpd)";
    }

    if (type !== "") {
      addCapturedVideo(tabId, url, type, initiator);
    }
  },
  { urls: ["<all_urls>"] },
  ["responseHeaders"]
);

// Clear videos and subtitles for a tab when it closes or reloads
chrome.tabs.onRemoved.addListener((tabId) => {
  delete capturedVideos[tabId];
  delete capturedSubtitles[tabId];
});

// Clear videos and subtitles for a tab when it starts navigating to a new page (main frame only)
chrome.webNavigation.onBeforeNavigate.addListener((details) => {
  if (details.frameId === 0) {
    const tabId = details.tabId;
    delete capturedVideos[tabId];
    delete capturedSubtitles[tabId];
    updateBadge(tabId);
  }
});

function updateBadge(tabId) {
  const count = capturedVideos[tabId] ? capturedVideos[tabId].length : 0;
  chrome.action.setBadgeText({
    tabId: tabId,
    text: count > 0 ? count.toString() : ""
  });
  chrome.action.setBadgeBackgroundColor({
    tabId: tabId,
    color: "#e11d48"
  });
}

// Communication handler
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "getVideos") {
    sendResponse({ videos: capturedVideos[request.tabId] || [] });
  } else if (request.action === "getSubtitles") {
    sendResponse({ subtitles: capturedSubtitles[request.tabId] || [] });
  } else if (request.action === "getVideosForContentScript") {
    const tabId = sender.tab ? sender.tab.id : null;
    sendResponse({ videos: capturedVideos[tabId] || [] });
  } else if (request.action === "clearVideos") {
    const tabId = request.tabId || (sender.tab ? sender.tab.id : null);
    if (tabId) {
      delete capturedVideos[tabId];
      delete capturedSubtitles[tabId];
      updateBadge(tabId);
    }
    sendResponse({ success: true });
  } else if (request.action === "addCapturedVideoDirectly") {
    const { url, title, thumbnail } = request;
    const urlLower = url.toLowerCase();
    const isMediaExtension = urlLower.includes(".m3u8") || 
                             urlLower.includes(".mp4") || 
                             urlLower.includes(".webm") || 
                             urlLower.includes(".mkv") || 
                             urlLower.includes(".mpd") || 
                             urlLower.includes("/hls/") || 
                             urlLower.includes("/dash/");
    if (isPotentialAd(url) && !isMediaExtension) {
      sendResponse({ success: false, error: "Skipped potential ad" });
      return;
    }
    const tabId = sender.tab ? sender.tab.id : null;
    if (!tabId) return;

    if (!capturedVideos[tabId]) {
      capturedVideos[tabId] = [];
    }

    const cleanUrl = url.split("?")[0];
    const exists = capturedVideos[tabId].some(
      (v) => v.url === url || v.url.split("?")[0] === cleanUrl
    );

    if (!exists) {
      let type = "MP4 Video";
      if (url.includes(".m3u8")) type = "HLS Playlist (.m3u8)";
      else if (url.includes(".webm")) type = "WebM Video";
      
      let filename = title || "Video File";
      // Try to clean name from URL if possible
      try {
        const lastPart = cleanUrl.split("/").pop();
        if (lastPart && lastPart.includes(".")) filename = decodeURIComponent(lastPart);
      } catch (e) {}

      capturedVideos[tabId].push({
        url: url,
        type: type,
        filename: filename,
        initiator: sender.tab.url,
        timestamp: Date.now(),
        thumbnail: thumbnail || ""
      });

      if (capturedVideos[tabId].length > 10) {
        capturedVideos[tabId].shift();
      }

      updateBadge(tabId);
    }
    sendResponse({ success: true });
  } else if (request.action === "addCapturedSubtitleDirectly") {
    const { url, label, language } = request;
    const tabId = sender.tab ? sender.tab.id : null;
    if (!tabId) return;

    if (!capturedSubtitles[tabId]) {
      capturedSubtitles[tabId] = [];
    }

    let extension = ".vtt";
    if (url.toLowerCase().includes(".srt")) {
      extension = ".srt";
    } else if (url.toLowerCase().includes(".ass") || url.toLowerCase().includes(".ssa")) {
      extension = url.toLowerCase().includes(".ssa") ? ".ssa" : ".ass";
    } else if (url.toLowerCase().includes(".ttml")) {
      extension = ".ttml";
    }

    const subInfo = getSubtitleInfoFromUrl(url, extension);
    const cleanTemplate = getCleanSequenceTemplate(url);
    
    const finalTrackInfo = language || subInfo.trackInfo;
    const finalLabel = label || subInfo.filename.slice(0, -extension.length);
    const finalFilename = finalTrackInfo ? `${finalLabel.split(" (")[0]} (${finalTrackInfo})${extension}` : `${finalLabel}${extension}`;

    const exists = capturedSubtitles[tabId].some((s) => {
      const sTemplate = getCleanSequenceTemplate(s.url);
      const sInfo = getSubtitleInfoFromUrl(s.url, extension);
      const sTrackInfo = s.language || sInfo.trackInfo;
      return sTemplate === cleanTemplate && sTrackInfo === finalTrackInfo;
    });

    if (!exists) {
      let type = "WebVTT Subtitle (.vtt)";
      if (extension === ".srt") type = "SubRip Subtitle (.srt)";
      else if (extension === ".ass" || extension === ".ssa") type = "SubStation Alpha";
      else if (extension === ".ttml") type = "TTML Subtitle (.ttml)";

      capturedSubtitles[tabId].push({
        url: url,
        type: type,
        filename: finalFilename,
        initiator: sender.tab.url,
        timestamp: Date.now(),
        language: finalTrackInfo
      });

      if (capturedSubtitles[tabId].length > 20) {
        capturedSubtitles[tabId].shift();
      }
    }
    sendResponse({ success: true });
  } else if (request.action === "updateThumbnail") {
    // Content script discovered thumbnail preview, save it in memory
    const { url, thumbnail } = request;
    for (const tabId in capturedVideos) {
      const video = capturedVideos[tabId].find((v) => v.url === url);
      if (video) {
        video.thumbnail = thumbnail;
        break;
      }
    }
    sendResponse({ success: true });
  } else if (request.action === "downloadFromToast") {
    // Handle download button clicked inside floating web page toast
    const { url, filename, type, referrer } = request;
    if (type.includes("HLS")) {
      const tabId = sender.tab ? sender.tab.id : "";
      const downloaderUrl = chrome.runtime.getURL("downloader.html") + 
        `?url=${encodeURIComponent(url)}&title=${encodeURIComponent(filename)}&referrer=${encodeURIComponent(referrer)}&tabId=${tabId}`;
      chrome.tabs.create({ url: downloaderUrl });
    } else {
      chrome.downloads.download({
        url: url,
        filename: filename.replace(/[\\/:*?"<>|]/g, "_"),
        saveAs: true
      });
    }
    sendResponse({ success: true });
  } else if (request.action === "setupRefererHeader") {
    const { targetDomain, refererUrl } = request;
    setupDeclarativeRules(targetDomain, refererUrl)
      .then(() => sendResponse({ success: true }))
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }
});

// Setup chrome.declarativeNetRequest rules to bypass CORS/hotlinking
async function setupDeclarativeRules(targetDomain, refererUrl) {
  if (!chrome.declarativeNetRequest) return;

  const ruleId = 1001;
  const rules = await chrome.declarativeNetRequest.getSessionRules();
  const ruleExists = rules.some(r => r.id === ruleId);

  // Set the rule to match ANY url requested from our extension page (initiatorDomains: [chrome.runtime.id])
  // This rewrites Referer, Origin, and Sec-Fetch-Site for all domains contacted by the downloader tab!
  const newRule = {
    id: ruleId,
    priority: 1,
    action: {
      type: "modifyHeaders",
      requestHeaders: [
        { header: "Referer", operation: "set", value: refererUrl },
        { header: "Origin", operation: "set", value: new URL(refererUrl).origin },
        { header: "Sec-Fetch-Site", operation: "set", value: "same-site" }
      ]
    },
    condition: {
      urlFilter: "*",
      initiatorDomains: [chrome.runtime.id],
      resourceTypes: ["xmlhttprequest"]
    }
  };

  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [ruleId],
    addRules: [newRule]
  });
}
