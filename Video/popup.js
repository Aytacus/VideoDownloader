// popup.js - Interactive script for extension popup UI

document.addEventListener("DOMContentLoaded", async () => {
  const clearBtn = document.getElementById("clear-btn");
  const noVideosEl = document.getElementById("no-videos");
  const videoListEl = document.getElementById("video-list");
  const subtitleListEl = document.getElementById("subtitle-list");
  const activeDomainEl = document.getElementById("active-domain");

  const tabVideos = document.getElementById("tab-videos");
  const tabSubtitles = document.getElementById("tab-subtitles");
  const videoBadge = document.getElementById("video-count-badge");
  const subBadge = document.getElementById("subtitle-count-badge");
  let activeTabName = "videos"; // "videos" or "subtitles"

  // Get current active tab
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!activeTab) return;

  const tabId = activeTab.id;

  // Set website host in footer
  try {
    const urlObj = new URL(activeTab.url);
    activeDomainEl.textContent = urlObj.hostname;
  } catch (e) {
    activeDomainEl.textContent = "Unknown Web Page";
  }

  // Load and display media
  loadMedia();

  // Clear list action
  clearBtn.addEventListener("click", () => {
    chrome.runtime.sendMessage({ action: "clearVideos", tabId: tabId }, (response) => {
      if (response && response.success) {
        loadMedia();
      }
    });
  });

  // Tab switching
  tabVideos.addEventListener("click", () => {
    activeTabName = "videos";
    tabVideos.classList.add("active");
    tabSubtitles.classList.remove("active");
    showActiveList();
  });

  tabSubtitles.addEventListener("click", () => {
    activeTabName = "subtitles";
    tabSubtitles.classList.add("active");
    tabVideos.classList.remove("active");
    showActiveList();
  });

  function loadMedia() {
    chrome.runtime.sendMessage({ action: "getVideos", tabId: tabId }, (response) => {
      const videos = response ? response.videos : [];
      chrome.runtime.sendMessage({ action: "getSubtitles", tabId: tabId }, (subResponse) => {
        const subtitles = subResponse ? subResponse.subtitles : [];
        renderMedia(videos, subtitles);
      });
    });
  }

  function renderMedia(videos, subtitles) {
    // 1. Render videos
    videoListEl.innerHTML = "";
    if (videos && videos.length > 0) {
      const sortedVideos = [...videos].sort((a, b) => {
        const aIsHls = a.type.includes("HLS") || a.type.includes("DASH");
        const bIsHls = b.type.includes("HLS") || b.type.includes("DASH");
        if (aIsHls && !bIsHls) return -1;
        if (!aIsHls && bIsHls) return 1;
        return b.timestamp - a.timestamp;
      });

      sortedVideos.forEach((video) => {
        const card = createVideoCard(video);
        videoListEl.appendChild(card);
      });
    }

    // 2. Render subtitles
    subtitleListEl.innerHTML = "";
    if (subtitles && subtitles.length > 0) {
      const sortedSubtitles = [...subtitles].sort((a, b) => b.timestamp - a.timestamp);
      sortedSubtitles.forEach((subtitle) => {
        const card = createSubtitleCard(subtitle);
        subtitleListEl.appendChild(card);
      });
    }

    // 3. Update badges
    if (videos && videos.length > 0) {
      videoBadge.textContent = videos.length;
      videoBadge.classList.remove("hidden");
    } else {
      videoBadge.classList.add("hidden");
    }

    if (subtitles && subtitles.length > 0) {
      subBadge.textContent = subtitles.length;
      subBadge.classList.remove("hidden");
    } else {
      subBadge.classList.add("hidden");
    }

    // 4. Update clear button state
    const totalCount = (videos ? videos.length : 0) + (subtitles ? subtitles.length : 0);
    if (totalCount === 0) {
      clearBtn.style.opacity = "0.5";
      clearBtn.style.pointerEvents = "none";
    } else {
      clearBtn.style.opacity = "1";
      clearBtn.style.pointerEvents = "auto";
    }

    showActiveList();
  }

  function showActiveList() {
    videoListEl.classList.add("hidden");
    subtitleListEl.classList.add("hidden");
    noVideosEl.classList.add("hidden");

    if (activeTabName === "videos") {
      if (videoListEl.children.length === 0) {
        noVideosEl.classList.remove("hidden");
        noVideosEl.querySelector("h3").textContent = "No videos detected";
        noVideosEl.querySelector("p").textContent = "Start playing a video on the page, and we will capture it automatically.";
      } else {
        videoListEl.classList.remove("hidden");
      }
    } else {
      if (subtitleListEl.children.length === 0) {
        noVideosEl.classList.remove("hidden");
        noVideosEl.querySelector("h3").textContent = "No subtitles detected";
        noVideosEl.querySelector("p").textContent = "Play a video with captions, and we will capture them automatically.";
      } else {
        subtitleListEl.classList.remove("hidden");
      }
    }
  }

  function createVideoCard(video) {
    const card = document.createElement("div");
    card.className = "video-card";

    // Format display and class selection
    let isHls = video.type.includes("HLS");
    let badgeClass = "badge-generic";
    let badgeText = "Video";

    if (video.type.includes("HLS")) {
      badgeClass = "badge-m3u8";
      badgeText = "HLS Stream";
    } else if (video.type.includes("MP4")) {
      badgeClass = "badge-mp4";
      badgeText = "MP4";
    } else if (video.type.includes("WebM")) {
      badgeClass = "badge-mp4";
      badgeText = "WebM";
    } else if (video.type.includes("MKV")) {
      badgeClass = "badge-mp4";
      badgeText = "MKV";
    } else if (video.type.includes("DASH")) {
      badgeClass = "badge-m3u8";
      badgeText = "DASH";
    }

    // Try to get initiator domain
    let domain = "Unknown Source";
    try {
      if (video.initiator) {
        domain = new URL(video.initiator).hostname;
      } else {
        domain = new URL(video.url).hostname;
      }
    } catch (e) {}

    // Thumbnail markup
    const thumbHtml = video.thumbnail
      ? `<img src="${video.thumbnail}" alt="Preview" />`
      : `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
           <polygon points="23 7 16 12 23 17 23 7"></polygon>
           <rect x="1" y="5" width="15" height="14" rx="2" ry="2"></rect>
         </svg>`;

    card.innerHTML = `
      <div class="card-main-row">
        <div class="thumbnail-wrapper">
          ${thumbHtml}
        </div>
        <div class="video-info-wrapper">
          <div class="video-meta-row">
            <span class="format-badge ${badgeClass}">${badgeText}</span>
            <span class="video-source" title="${escapeHtml(domain)}">${escapeHtml(domain)}</span>
          </div>
          <input type="text" class="video-title-input" value="${escapeHtml(video.filename)}" title="Click to edit filename" />
        </div>
      </div>
      <div class="card-actions">
        <button class="btn-primary ${isHls ? 'btn-hls' : ''} download-action-btn">
          ${isHls ? `
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path>
              <polyline points="15 3 21 3 21 9"></polyline>
              <line x1="10" y1="14" x2="21" y2="3"></line>
            </svg>
            Download Stream
          ` : `
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
              <polyline points="7 10 12 15 17 10"></polyline>
              <line x1="12" y1="15" x2="12" y2="3"></line>
            </svg>
            Download Video
          `}
        </button>
        <button class="btn-secondary copy-action-btn" title="Copy video link">
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"></path>
            <rect x="8" y="2" width="8" height="4" rx="1" ry="1"></rect>
          </svg>
        </button>
      </div>
    `;

    // Download action
    const downloadBtn = card.querySelector(".download-action-btn");
    downloadBtn.addEventListener("click", () => {
      const editedTitle = card.querySelector(".video-title-input").value.trim() || video.filename;
      if (isHls) {
        // Open downloader tab for HLS stream
        const downloaderUrl = chrome.runtime.getURL("downloader.html") + 
          `?url=${encodeURIComponent(video.url)}&title=${encodeURIComponent(editedTitle)}&referrer=${encodeURIComponent(activeTab.url)}&tabId=${tabId}`;
        chrome.tabs.create({ url: downloaderUrl });
      } else {
        // Trigger standard downloads
        chrome.downloads.download({
          url: video.url,
          filename: sanitizeFilename(editedTitle),
          saveAs: true
        });
      }
    });

    // Copy action
    const copyBtn = card.querySelector(".copy-action-btn");
    copyBtn.addEventListener("click", () => {
      navigator.clipboard.writeText(video.url).then(() => {
        const svg = copyBtn.querySelector("svg");
        copyBtn.style.color = "var(--success)";
        copyBtn.style.borderColor = "var(--success)";
        
        copyBtn.innerHTML = `
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="20 6 9 17 4 12"></polyline>
          </svg>
        `;

        setTimeout(() => {
          copyBtn.style.color = "";
          copyBtn.style.borderColor = "";
          copyBtn.innerHTML = "";
          copyBtn.appendChild(svg);
        }, 1500);
      });
    });

    return card;
  }

  function createSubtitleCard(subtitle) {
    const card = document.createElement("div");
    card.className = "video-card";

    let badgeClass = "badge-m3u8";
    let badgeText = subtitle.type || "Subtitle";

    // Try to get initiator domain
    let domain = "Unknown Source";
    try {
      if (subtitle.initiator) {
        domain = new URL(subtitle.initiator).hostname;
      } else {
        domain = new URL(subtitle.url).hostname;
      }
    } catch (e) {}

    // Subtitle icon markup
    const thumbHtml = `
      <div class="thumbnail-wrapper" style="background: rgba(6, 182, 212, 0.05); border-color: rgba(6, 182, 212, 0.2);">
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#06b6d4" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="width: 24px; height: 24px;">
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
          <path d="M8 7h8"></path>
          <path d="M8 11h8"></path>
        </svg>
      </div>
    `;

    card.innerHTML = `
      <div class="card-main-row">
        ${thumbHtml}
        <div class="video-info-wrapper">
          <div class="video-meta-row">
            <span class="format-badge ${badgeClass}" style="background-color: rgba(6, 182, 212, 0.15); color: var(--accent-secondary); border-color: rgba(6, 182, 212, 0.3);">${badgeText}</span>
            <span class="video-source" title="${escapeHtml(domain)}">${escapeHtml(domain)}</span>
          </div>
          <input type="text" class="video-title-input" value="${escapeHtml(subtitle.filename)}" title="Click to edit filename" />
        </div>
      </div>
      <div class="card-actions">
        <button class="btn-primary btn-hls download-action-btn">
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
            <polyline points="7 10 12 15 17 10"></polyline>
            <line x1="12" y1="15" x2="12" y2="3"></line>
          </svg>
          Download Subtitle
        </button>
        <button class="btn-secondary copy-action-btn" title="Copy subtitle link">
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"></path>
            <rect x="8" y="2" width="8" height="4" rx="1" ry="1"></rect>
          </svg>
        </button>
      </div>
    `;

    // Download action
    const downloadBtn = card.querySelector(".download-action-btn");
    downloadBtn.addEventListener("click", () => {
      const editedTitle = card.querySelector(".video-title-input").value.trim() || subtitle.filename;
      const downloaderUrl = chrome.runtime.getURL("downloader.html") + 
        `?url=${encodeURIComponent(subtitle.url)}&title=${encodeURIComponent(editedTitle)}&referrer=${encodeURIComponent(activeTab.url)}&tabId=${tabId}&mode=subtitle`;
      chrome.tabs.create({ url: downloaderUrl });
    });

    // Copy action
    const copyBtn = card.querySelector(".copy-action-btn");
    copyBtn.addEventListener("click", () => {
      navigator.clipboard.writeText(subtitle.url).then(() => {
        const svg = copyBtn.querySelector("svg");
        copyBtn.style.color = "var(--success)";
        copyBtn.style.borderColor = "var(--success)";
        
        copyBtn.innerHTML = `
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="20 6 9 17 4 12"></polyline>
          </svg>
        `;

        setTimeout(() => {
          copyBtn.style.color = "";
          copyBtn.style.borderColor = "";
          copyBtn.innerHTML = "";
          copyBtn.appendChild(svg);
        }, 1500);
      });
    });

    return card;
  }

  function escapeHtml(text) {
    const div = document.createElement("div");
    div.textContent = text;
    return div.innerHTML;
  }

  function sanitizeFilename(name) {
    return name.replace(/[\\/:*?"<>|]/g, "_");
  }
});
