// content.js - In-page video detection, frame capturing, and notification toasts

// Listen to messages from background service worker
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "showDetectionToast") {
    const { url, filename, type } = request.video;
    
    // Capture thumbnail from the page
    const thumbnail = captureThumbnail();
    
    // Send thumbnail back to background to update stored video info
    chrome.runtime.sendMessage({
      action: "updateThumbnail",
      url: url,
      thumbnail: thumbnail
    });

    // Display the sliding toast notification
    // showToast(url, filename, type, thumbnail);
    sendResponse({ success: true });
  }
});

// Captures a frame from a playing video or falls back to page metadata
function captureThumbnail(videoElement) {
  const video = videoElement || document.querySelector("video");
  if (!video) return getPageMetadataImage();

  // 1. Try to grab the poster attribute
  if (video.poster) {
    return resolveUrl(video.poster);
  }

  // 2. Try to capture a canvas screenshot (only works if cross-origin permissions allow)
  try {
    const canvas = document.createElement("canvas");
    canvas.width = 160;
    canvas.height = 90;
    const ctx = canvas.getContext("2d");
    // Draw current frame
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL("image/jpeg", 0.6);
    // Ensure we didn't get a blank transparent canvas
    if (dataUrl && dataUrl.length > 1000) {
      return dataUrl;
    }
  } catch (e) {
    // Canvas thumbnail extraction blocked by CORS
  }

  // 3. Fallback to page metadata image
  return getPageMetadataImage();
}

function getPageMetadataImage() {
  // Look for og:image (OpenGraph)
  const ogImage = document.querySelector("meta[property='og:image']");
  if (ogImage && ogImage.content) {
    return resolveUrl(ogImage.content);
  }

  // Look for twitter:image
  const twitterImage = document.querySelector("meta[name='twitter:image']");
  if (twitterImage && twitterImage.content) {
    return resolveUrl(twitterImage.content);
  }

  // Look for largest image on the page as a last resort
  try {
    const imgs = Array.from(document.querySelectorAll("img"));
    if (imgs.length > 0) {
      const largestImg = imgs.reduce((prev, current) => {
        const prevArea = prev.width * prev.height;
        const currArea = current.width * current.height;
        return (currArea > prevArea) ? current : prev;
      });
      if (largestImg && largestImg.src && largestImg.width > 50) {
        return resolveUrl(largestImg.src);
      }
    }
  } catch (e) {}

  return ""; // No thumbnail found
}

function resolveUrl(url) {
  try {
    return new URL(url, window.location.href).href;
  } catch (e) {
    return url;
  }
}

// Injects and slides in a beautiful floating toast
function showToast(videoUrl, filename, type, thumbnail) {
  // Remove existing toast container if present to avoid piling up
  const existing = document.getElementById("vdh-toast-container");
  if (existing) existing.remove();

  const container = document.createElement("div");
  container.id = "vdh-toast-container";

  const isHls = type.includes("HLS");
  const cleanName = filename.replace(/\.[^/.]+$/, ""); // strip extension for cleaner look

  // Construct thumbnail markup
  const thumbHtml = thumbnail
    ? `<img src="${thumbnail}" class="vdh-toast-thumb" alt="Preview"/>`
    : `<div class="vdh-toast-thumb vdh-toast-thumb-fallback">
         <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
           <polygon points="23 7 16 12 23 17 23 7"></polygon>
           <rect x="1" y="5" width="15" height="14" rx="2" ry="2"></rect>
         </svg>
       </div>`;

  container.innerHTML = `
    <div class="vdh-toast-card">
      <div class="vdh-toast-header">
        <span class="vdh-toast-badge ${isHls ? 'vdh-badge-hls' : 'vdh-badge-mp4'}">${isHls ? 'HLS Stream' : 'MP4 Video'}</span>
        <button class="vdh-toast-close" title="Dismiss">&times;</button>
      </div>
      <div class="vdh-toast-body">
        ${thumbHtml}
        <div class="vdh-toast-details">
          <div class="vdh-toast-filename" title="${filename}">${cleanName}</div>
          <div class="vdh-toast-domain">${window.location.hostname}</div>
        </div>
      </div>
      <button class="vdh-toast-btn">
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
          <polyline points="7 10 12 15 17 10"></polyline>
          <line x1="12" y1="15" x2="12" y2="3"></line>
        </svg>
        Download Now
      </button>
    </div>
  `;

  document.body.appendChild(container);

  // Trigger animation frame for transition
  requestAnimationFrame(() => {
    setTimeout(() => {
      container.classList.add("visible");
    }, 50);
  });

  // Auto dismiss after 8 seconds
  const dismissTimer = setTimeout(() => {
    dismissToast(container);
  }, 8000);

  // Event handlers
  container.querySelector(".vdh-toast-close").addEventListener("click", (e) => {
    e.stopPropagation();
    clearTimeout(dismissTimer);
    dismissToast(container);
  });

  container.querySelector(".vdh-toast-btn").addEventListener("click", () => {
    clearTimeout(dismissTimer);
    dismissToast(container);
    
    // Send message to trigger download via background/popup router
    chrome.runtime.sendMessage({
      action: "downloadFromToast",
      url: videoUrl,
      filename: filename,
      type: type,
      referrer: window.location.href
    });
  });
}

function dismissToast(container) {
  container.classList.remove("visible");
  setTimeout(() => {
    container.remove();
  }, 450); // matches CSS transitions
}

// ==========================================
// NEW: Global Hover Download Button & Scanner
// ==========================================

let activeVideo = null;
let hoverBtn = null;
let hoverTimer = null;

function initHoverButton() {
  if (document.getElementById("vdh-hover-download-btn")) return;

  hoverBtn = document.createElement("button");
  hoverBtn.id = "vdh-hover-download-btn";
  hoverBtn.innerHTML = `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
      <polyline points="7 10 12 15 17 10"></polyline>
      <line x1="12" y1="15" x2="12" y2="3"></line>
    </svg>
    Download
  `;
  document.body.appendChild(hoverBtn);

  // Watch hover over video elements
  document.addEventListener("mouseover", (e) => {
    const video = e.target.closest("video");
    if (video) {
      clearTimeout(hoverTimer);
      activeVideo = video;
      positionButton(video);
    }
  }, true);

  document.addEventListener("mouseout", (e) => {
    const video = e.target.closest("video");
    if (video) {
      hoverTimer = setTimeout(() => {
        if (activeVideo === video) {
          hideButton();
        }
      }, 1000);
    }
  }, true);

  hoverBtn.addEventListener("mouseenter", () => {
    clearTimeout(hoverTimer);
  });

  hoverBtn.addEventListener("mouseleave", () => {
    hideButton();
  });

  hoverBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (!activeVideo) return;
    const url = activeVideo.currentSrc || activeVideo.src;
    if (!url) return;

    if (url.startsWith("blob:")) {
      // Query background sniffer for real HLS URL captured on this tab
      chrome.runtime.sendMessage({ action: "getVideosForContentScript" }, (response) => {
        const videos = response ? response.videos : [];
        if (videos && videos.length > 0) {
          // Prioritize HLS (.m3u8) or DASH (.mpd) streams (the main movie/series)
          let targetVideo = videos.find(v => v.type.includes("HLS") || v.type.includes("DASH"));
          
          if (!targetVideo) {
            // Filter out ad networks to grab the actual video
            const cleanMp4s = videos.filter(v => {
              const urlLower = v.url.toLowerCase();
              return !urlLower.includes("ads") && 
                     !urlLower.includes("adsystem") && 
                     !urlLower.includes("doubleclick") && 
                     !urlLower.includes("vast") &&
                     !urlLower.includes("pre-roll");
            });
            if (cleanMp4s.length > 0) {
              targetVideo = cleanMp4s[cleanMp4s.length - 1];
            }
          }
          
          // Fallback to the latest captured video if no filter matched
          if (!targetVideo) {
            targetVideo = videos[videos.length - 1];
          }

          chrome.runtime.sendMessage({
            action: "downloadFromToast",
            url: targetVideo.url,
            filename: targetVideo.filename,
            type: targetVideo.type,
            referrer: window.location.href
          });
        } else {
          alert("Could not detect the streaming source for this video yet. Please click play and wait a few seconds, or try clicking the extension icon in your browser toolbar.");
        }
      });
      hideButton();
      return;
    }

    let filename = document.title || "Video File";
    chrome.runtime.sendMessage({
      action: "downloadFromToast",
      url: url,
      filename: filename + ".mp4",
      type: "MP4 Video",
      referrer: window.location.href
    });
    hideButton();
  });
}

function positionButton(video) {
  if (!hoverBtn) return;
  const rect = video.getBoundingClientRect();
  
  // Ignore tiny thumbs or background video loops
  if (rect.width < 140 || rect.height < 100) return;

  const scrollTop = window.pageYOffset || document.documentElement.scrollTop;
  const scrollLeft = window.pageXOffset || document.documentElement.scrollLeft;

  // Align hover button at the top-right corner of the video
  hoverBtn.style.top = (rect.top + scrollTop + 10) + "px";
  hoverBtn.style.left = (rect.right + scrollLeft - hoverBtn.offsetWidth - 12) + "px";
  hoverBtn.classList.add("visible");
}

function hideButton() {
  if (hoverBtn) {
    hoverBtn.classList.remove("visible");
  }
  activeVideo = null;
}

// Periodic scanner to capture dynamic video changes and cached files
function startDynamicVideoScanner() {
  let currentUrl = window.location.href;

  setInterval(() => {
    // Check for SPA navigation (URL change without page reload) - ONLY in the main frame!
    if (window === window.top && window.location.href !== currentUrl) {
      currentUrl = window.location.href;
      chrome.runtime.sendMessage({ action: "clearVideos" });
    }

    const videos = Array.from(document.querySelectorAll("video"));
    videos.forEach((video) => {
      let url = video.currentSrc || video.src;
      
      // Fallback: Check if there are <source> child elements if main src is empty
      if (!url) {
        const source = video.querySelector("source");
        if (source && source.src) {
          url = source.src;
        }
      }

      if (url && !url.startsWith("blob:") && url.startsWith("http")) {
        const thumb = captureThumbnail(video);
        
        chrome.runtime.sendMessage({
          action: "addCapturedVideoDirectly",
          url: url,
          title: document.title,
          thumbnail: thumb
        });
      }

      // Scan for track tags inside this video
      const tracks = Array.from(video.querySelectorAll("track"));
      tracks.forEach((track) => {
        if (track.src && track.src.startsWith("http")) {
          chrome.runtime.sendMessage({
            action: "addCapturedSubtitleDirectly",
            url: track.src,
            label: track.label || track.srclang || "Subtitles",
            language: track.srclang || ""
          });
        }
      });
    });
  }, 2000);
}

// Initialize scripts
initHoverButton();
startDynamicVideoScanner();
