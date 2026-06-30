// downloader.js - Core logic for HLS (.m3u8) video downloader

document.addEventListener("DOMContentLoaded", async () => {
  // Elements
  const fileTitleEl = document.getElementById("file-title");
  const streamUrlEl = document.getElementById("stream-url");
  const filenameInputEl = document.getElementById("filename-input");
  const qualityPanelEl = document.getElementById("quality-panel");
  const qualityOptionsEl = document.getElementById("quality-options");
  const downloadPanelEl = document.getElementById("download-panel");
  const downloadStatusTxt = document.getElementById("download-status-txt");
  const downloadBadge = document.getElementById("download-badge");
  const progressBar = document.getElementById("progress-bar");
  
  const statSegments = document.getElementById("stat-segments");
  const statSpeed = document.getElementById("stat-speed");
  const statEta = document.getElementById("stat-eta");
  
  const errorPanel = document.getElementById("error-panel");
  const errorTitle = document.getElementById("error-title");
  const errorDesc = document.getElementById("error-desc");
  
  const cancelBtn = document.getElementById("cancel-btn");
  const restartBtn = document.getElementById("restart-btn");
  const saveBtn = document.getElementById("save-btn");

  // Dual audio DOM elements
  const audioSelectionWrapper = document.getElementById("audio-selection-wrapper");
  const audioOptionsEl = document.getElementById("audio-options");
  const subtitleSelectionWrapper = document.getElementById("subtitle-selection-wrapper");
  const subtitleOptionsEl = document.getElementById("subtitle-options");
  const startDownloadBtn = document.getElementById("start-download-btn");
  const mergeInstructionsPanel = document.getElementById("merge-instructions-panel");
  const ffmpegCommandBox = document.getElementById("ffmpeg-command-box");
  const copyFfmpegBtn = document.getElementById("copy-ffmpeg-btn");
  const autoMergeStatusPanel = document.getElementById("auto-merge-status-panel");
  const autoMergeStatusDesc = document.getElementById("auto-merge-status-desc");
  const downloadBatBtn = document.getElementById("download-bat-btn");

  // State
  let streamUrl = "";
  let baseTitle = "video";
  let referrerUrl = "";
  let isAborted = false;
  let activeQualityUrl = "";
  let activeAudioUrl = "";
  let activeAudioName = "";
  let isDualAudio = false;
  let activeSelectedSubs = [];
  const activeDownloads = {}; // downloadId -> { filename, complete: false }
  let pendingMerge = null; // { video, audio, subtitles, output }
  
  let segmentUrls = [];
  let encryptionKeyInfo = null;
  let decryptedSegments = [];
  let downloadedCount = 0;
  let totalSegments = 0;
  
  let finalBlobUrl = null;
  let finalFilename = "";
  
  // Speed metrics
  let downloadStartTime = 0;
  let downloadedBytesSinceStart = 0;
  let speedInterval = null;

  // Read query parameters
  const params = new URLSearchParams(window.location.search);
  streamUrl = params.get("url");
  baseTitle = params.get("title") || "video";
  referrerUrl = params.get("referrer") || "";
  const tabId = parseInt(params.get("tabId")) || null;
  const downloadMode = params.get("mode") || "video";

  if (baseTitle.toLowerCase().endsWith(".m3u8")) {
    baseTitle = baseTitle.slice(0, -5);
  }

  // Update UI headers
  fileTitleEl.textContent = baseTitle;
  streamUrlEl.textContent = streamUrl;

  if (filenameInputEl) {
    filenameInputEl.value = baseTitle;
    filenameInputEl.addEventListener("input", () => {
      baseTitle = filenameInputEl.value.trim() || "video";
      fileTitleEl.textContent = baseTitle;
      
      // Update finalFilename dynamically if it has already been generated
      if (finalFilename) {
        const cleanTitle = baseTitle.replace(/[\\/:*?"<>|]/g, "_");
        let ext = "";
        if (finalFilename.endsWith(".mkv")) ext = ".mkv";
        else if (finalFilename.endsWith(".ts")) ext = ".ts";
        else if (finalFilename.endsWith(".vtt")) ext = ".vtt";
        else if (finalFilename.endsWith(".srt")) ext = ".srt";
        else if (finalFilename.endsWith(".ass")) ext = ".ass";
        else if (finalFilename.endsWith(".ssa")) ext = ".ssa";
        else if (finalFilename.endsWith(".ttml")) ext = ".ttml";
        
        if (ext) {
          if (ext === ".mkv" && finalFilename.includes("_dual")) {
            finalFilename = `${cleanTitle}_dual.mkv`;
          } else {
            finalFilename = cleanTitle.toLowerCase().endsWith(ext) ? cleanTitle : `${cleanTitle}${ext}`;
          }
        } else {
          finalFilename = cleanTitle;
        }
      }
    });
  }

  if (!streamUrl) {
    showError("Missing Parameters", "No stream URL was passed to the downloader.");
    return;
  }

  // Download BAT helper script
  downloadBatBtn.addEventListener("click", () => {
    downloadMergeScript();
  });

  // Track chrome downloads changed to auto-merge when complete
  chrome.downloads.onChanged.addListener((delta) => {
    if (activeDownloads[delta.id]) {
      if (delta.state && delta.state.current === "complete") {
        activeDownloads[delta.id].complete = true;
        
        // Check if all active downloads are complete
        const allComplete = Object.values(activeDownloads).every(d => d.complete);
        if (allComplete) {
          // Set finalBlobUrl to dummy string to mark as finished so Cancel acts as Close
          if (!finalBlobUrl) {
            finalBlobUrl = "completed_separate";
          }
          
          // Change Cancel button to Close
          cancelBtn.innerHTML = `
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <line x1="18" y1="6" x2="6" y2="18"></line>
              <line x1="6" y1="6" x2="18" y2="18"></line>
            </svg>
            Close
          `;

          if (pendingMerge) {
            triggerAutoMerge(pendingMerge);
            pendingMerge = null;
          }
        }
      }
    }
  });

  // Cancel action
  cancelBtn.addEventListener("click", () => {
    // If download is completed (finalBlobUrl is set), Cancel acts as a Close button
    if (finalBlobUrl) {
      window.close();
      return;
    }

    isAborted = true;
    clearInterval(speedInterval);
    
    // Revoke any previous blob URL to free memory
    if (finalBlobUrl) {
      URL.revokeObjectURL(finalBlobUrl);
      finalBlobUrl = null;
    }
    saveBtn.classList.add("hidden");
    
    // Reset UI to quality/stream selection panel so they can download again
    downloadPanelEl.classList.add("hidden");
    qualityPanelEl.classList.remove("hidden");
    
    const settingsPanel = document.getElementById("settings-panel");
    if (settingsPanel) settingsPanel.classList.remove("hidden");
    
    // Reset progress UI components
    progressBar.style.width = "0%";
    downloadBadge.textContent = "0%";
    downloadBadge.className = "status-badge downloading";
    statSegments.textContent = "0 / 0";
    statSpeed.textContent = "0.0 MB/s";
    statEta.textContent = "--:--";
    downloadStatusTxt.textContent = "Downloading segments...";

    // Reset cancelBtn text just in case it was changed to Close
    cancelBtn.innerHTML = `
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <line x1="18" y1="6" x2="6" y2="18"></line>
        <line x1="6" y1="6" x2="18" y2="18"></line>
      </svg>
      Cancel
    `;
  });

  // Save action
  saveBtn.addEventListener("click", () => {
    if (finalBlobUrl) {
      chrome.downloads.download({
        url: finalBlobUrl,
        filename: finalFilename,
        saveAs: true
      });
    }
  });

  // Restart action
  restartBtn.addEventListener("click", () => {
    errorPanel.classList.add("hidden");
    restartBtn.classList.add("hidden");
    cancelBtn.classList.remove("hidden");
    saveBtn.classList.add("hidden");
    if (finalBlobUrl) {
      URL.revokeObjectURL(finalBlobUrl);
      finalBlobUrl = null;
    }
    isAborted = false;
    if (activeQualityUrl) {
      downloadPanelEl.classList.remove("hidden");
      startCustomDownload(activeQualityUrl, activeAudioUrl, activeAudioName, isDualAudio, activeSelectedSubs);
    } else {
      startProcess();
    }
  });

  // Initialize process
  startProcess();

  async function startProcess() {
    try {
      isAborted = false; // Reset abortion state
      saveBtn.classList.add("hidden");
      if (finalBlobUrl) {
        URL.revokeObjectURL(finalBlobUrl);
        finalBlobUrl = null;
      }
      // 1. Setup headers spoofing if referrer is provided
      if (referrerUrl) {
        try {
          const urlObj = new URL(streamUrl);
          await new Promise((resolve) => {
            chrome.runtime.sendMessage({
              action: "setupRefererHeader",
              targetDomain: urlObj.hostname,
              refererUrl: referrerUrl
            }, (res) => resolve(res));
          });
        } catch (e) {
          console.error("Failed to setup referer spoofing:", e);
        }
      }

      if (downloadMode === "subtitle") {
        downloadStatusTxt.textContent = "Analyzing subtitle track...";
        downloadPanelEl.classList.remove("hidden");
        
        let ext = ".vtt";
        const subUrlLower = streamUrl.toLowerCase();
        if (subUrlLower.includes(".srt")) ext = ".srt";
        else if (subUrlLower.includes(".ass")) ext = ".ass";
        else if (subUrlLower.includes(".ssa")) ext = ".ssa";
        else if (subUrlLower.includes(".ttml")) ext = ".ttml";

        const cleanTitle = baseTitle.replace(/[\\/:*?"<>|]/g, "_");
        const saveFilename = cleanTitle.toLowerCase().endsWith(ext) ? cleanTitle : `${cleanTitle}${ext}`;

        const mergedVtt = await downloadSubtitlePlaylist(streamUrl, baseTitle);
        if (mergedVtt) {
          const subBlob = new Blob([mergedVtt], { type: "text/plain" });
          finalBlobUrl = URL.createObjectURL(subBlob);
          finalFilename = saveFilename;
          saveBtn.classList.remove("hidden");
          
          chrome.downloads.download({
            url: finalBlobUrl,
            filename: saveFilename,
            saveAs: true
          }, () => {
            downloadStatusTxt.textContent = "Subtitle download initialized! Click 'Save File' to save again.";
            progressBar.style.width = "100%";
            downloadBadge.textContent = "100%";
            downloadBadge.className = "status-badge success";
            statEta.textContent = "Done";
            
            cancelBtn.innerHTML = `
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <line x1="18" y1="6" x2="6" y2="18"></line>
                <line x1="6" y1="6" x2="18" y2="18"></line>
              </svg>
              Close
            `;
          });
        } else {
          throw new Error("Failed to download or merge subtitle.");
        }
        return;
      }

      // 2. Fetch any page-sniffed subtitles for this tab
      let pageSubtitles = [];
      if (tabId) {
        try {
          const response = await new Promise((resolve) => {
            chrome.runtime.sendMessage({ action: "getSubtitles", tabId: tabId }, (res) => resolve(res));
          });
          pageSubtitles = response ? response.subtitles : [];
        } catch (e) {
          console.error("Failed to query page subtitles:", e);
        }
      }

      // 3. Fetch the m3u8 playlist
      downloadStatusTxt.textContent = "Fetching playlist details...";
      downloadPanelEl.classList.remove("hidden");
      
      const playlistText = await fetchText(streamUrl);
      
      if (!playlistText.includes("#EXTM3U")) {
        throw new Error("Invalid HLS playlist. Content does not start with #EXTM3U.");
      }

      // 4. Analyze if it's a Master Playlist or Media Playlist
      if (playlistText.includes("#EXT-X-STREAM-INF")) {
        // Master Playlist: Contains multiple resolutions
        parseMasterPlaylist(playlistText, streamUrl, pageSubtitles);
      } else {
        // Media Playlist: Direct video segment index
        showSingleStreamSelection(streamUrl, pageSubtitles);
      }
    } catch (err) {
      showError("Connection / Parsing Error", err.message || "Failed to load the media playlist.");
    }
  }

  // Parses Master playlists and lets user select quality, audio, and subtitles
  function parseMasterPlaylist(text, baseUrl, pageSubtitles = []) {
    downloadStatusTxt.textContent = "Multiple qualities detected. Select resolution.";
    downloadPanelEl.classList.add("hidden");
    qualityPanelEl.classList.remove("hidden");
    qualityOptionsEl.innerHTML = "";
    audioOptionsEl.innerHTML = "";
    audioSelectionWrapper.classList.add("hidden");
    subtitleOptionsEl.innerHTML = "";
    subtitleSelectionWrapper.classList.add("hidden");
    startDownloadBtn.style.display = "none";

    const lines = text.split("\n");
    const audioTracks = []; // { groupId, name, url, isDefault }
    const subtitleTracks = []; // { groupId, name, url, language, isDefault }

    // Scan for audio and subtitle tracks first
    lines.forEach((line) => {
      line = line.trim();
      if (line.startsWith("#EXT-X-MEDIA:")) {
        if (line.includes("TYPE=AUDIO")) {
          const groupIdMatch = line.match(/GROUP-ID="([^"]+)"/i);
          const nameMatch = line.match(/NAME="([^"]+)"/i);
          const uriMatch = line.match(/URI="([^"]+)"/i);
          const defaultMatch = line.match(/DEFAULT=(YES|NO)/i);

          if (groupIdMatch && nameMatch) {
            audioTracks.push({
              groupId: groupIdMatch[1],
              name: nameMatch[1],
              url: uriMatch ? resolveUrl(baseUrl, uriMatch[1]) : "",
              isDefault: defaultMatch ? defaultMatch[1].toUpperCase() === "YES" : false
            });
          }
        } else if (line.includes("TYPE=SUBTITLES")) {
          const groupIdMatch = line.match(/GROUP-ID="([^"]+)"/i);
          const nameMatch = line.match(/NAME="([^"]+)"/i);
          const uriMatch = line.match(/URI="([^"]+)"/i);
          const langMatch = line.match(/LANGUAGE="([^"]+)"/i);
          const defaultMatch = line.match(/DEFAULT=(YES|NO)/i);

          if (groupIdMatch && nameMatch) {
            subtitleTracks.push({
              groupId: groupIdMatch[1],
              name: nameMatch[1],
              language: langMatch ? langMatch[1] : "",
              url: uriMatch ? resolveUrl(baseUrl, uriMatch[1]) : "",
              isDefault: defaultMatch ? defaultMatch[1].toUpperCase() === "YES" : false
            });
          }
        }
      }
    });

    let streamInfo = null;
    const streams = [];

    lines.forEach((line) => {
      line = line.trim();
      if (line.startsWith("#EXT-X-STREAM-INF:")) {
        streamInfo = line;
      } else if (line && !line.startsWith("#") && streamInfo) {
        const resolvedUrl = resolveUrl(baseUrl, line);
        let resolution = "Unknown Resolution";
        let bandwidth = "";
        let audioGroup = "";
        let subtitleGroup = "";

        const resMatch = streamInfo.match(/RESOLUTION=([0-9]+x[0-9]+)/i);
        if (resMatch) resolution = resMatch[1];

        const bwMatch = streamInfo.match(/BANDWIDTH=([0-9]+)/i);
        if (bwMatch) {
          const bwBps = parseInt(bwMatch[1]);
          bandwidth = `${(bwBps / 1000000).toFixed(2)} Mbps`;
        }

        const audioMatch = streamInfo.match(/AUDIO="([^"]+)"/i);
        if (audioMatch) {
          audioGroup = audioMatch[1];
        }

        const subMatch = streamInfo.match(/SUBTITLES="([^"]+)"/i);
        if (subMatch) {
          subtitleGroup = subMatch[1];
        }

        streams.push({
          url: resolvedUrl,
          resolution: resolution,
          bandwidth: bandwidth,
          audioGroup: audioGroup,
          subtitleGroup: subtitleGroup
        });
        streamInfo = null;
      }
    });

    if (streams.length === 0) {
      showError("Parsing Error", "Failed to identify any quality tracks in the master playlist.");
      return;
    }

    // Render streams
    streams.forEach((stream, index) => {
      const optionCard = document.createElement("div");
      optionCard.className = "quality-option";
      optionCard.dataset.index = index;
      optionCard.innerHTML = `
        <div class="quality-info">
          <span class="quality-name">${stream.resolution}</span>
          <span class="quality-meta">${stream.bandwidth ? `Bandwidth: ${stream.bandwidth}` : ""}</span>
        </div>
        <button class="btn-select">Select</button>
      `;

      optionCard.addEventListener("click", () => {
        // Clear active classes from other options
        Array.from(qualityOptionsEl.children).forEach(child => child.classList.remove("active"));
        optionCard.classList.add("active");

        activeQualityUrl = stream.url;
        activeAudioUrl = "";
        activeAudioName = "";
        activeSelectedSubs = [];
        isDualAudio = false;

        // Check if there are audio and subtitle tracks for this stream (case-insensitive and trimmed comparison)
        const matchingAudioTracks = audioTracks.filter(track => 
          track.groupId && 
          stream.audioGroup && 
          track.groupId.trim().toLowerCase() === stream.audioGroup.trim().toLowerCase() && 
          track.url
        );
        const matchingSubTracks = subtitleTracks.filter(track => 
          track.groupId && 
          stream.subtitleGroup && 
          track.groupId.trim().toLowerCase() === stream.subtitleGroup.trim().toLowerCase() && 
          track.url
        );

        // Combine HLS-native and page-sniffed subtitles
        const allSubTracks = [...matchingSubTracks];
        pageSubtitles.forEach(pageSub => {
          if (!allSubTracks.some(t => t.url === pageSub.url)) {
            allSubTracks.push({
              name: pageSub.filename || "Page Subtitle",
              url: pageSub.url,
              language: pageSub.language || "",
              isDefault: false
            });
          }
        });

        if (matchingAudioTracks.length > 0 || allSubTracks.length > 0) {
          startDownloadBtn.style.display = "flex";

          // Audio selection block
          if (matchingAudioTracks.length > 0) {
            isDualAudio = true;
            audioSelectionWrapper.classList.remove("hidden");
            startDownloadBtn.disabled = true;
            startDownloadBtn.style.opacity = "0.5";
            audioOptionsEl.innerHTML = "";
            activeAudioUrl = "";
            activeAudioName = "";

            matchingAudioTracks.forEach(track => {
              const audioCard = document.createElement("div");
              audioCard.className = "quality-option";
              
              audioCard.innerHTML = `
                <div class="quality-info">
                  <span class="quality-name">${track.name}</span>
                  <span class="quality-meta">${track.isDefault ? "Default Track" : "Alternative Track"}</span>
                </div>
                <button class="btn-select">Select</button>
              `;

              audioCard.addEventListener("click", (e) => {
                e.stopPropagation();
                Array.from(audioOptionsEl.children).forEach(child => child.classList.remove("active"));
                audioCard.classList.add("active");
                activeAudioUrl = track.url;
                activeAudioName = track.name;
                startDownloadBtn.disabled = false;
                startDownloadBtn.style.opacity = "1";
              });

              audioOptionsEl.appendChild(audioCard);
              
              if (track.isDefault) {
                audioCard.classList.add("active");
                activeAudioUrl = track.url;
                activeAudioName = track.name;
                startDownloadBtn.disabled = false;
                startDownloadBtn.style.opacity = "1";
              }
            });
          } else {
            isDualAudio = false;
            audioSelectionWrapper.classList.add("hidden");
            startDownloadBtn.disabled = false;
            startDownloadBtn.style.opacity = "1";
          }

          // Subtitle selection checklist
          if (allSubTracks.length > 0) {
            subtitleSelectionWrapper.classList.remove("hidden");
            subtitleOptionsEl.innerHTML = "";

            allSubTracks.forEach(track => {
              const subCard = document.createElement("div");
              subCard.className = "quality-option subtitle-option";
              subCard.dataset.url = track.url;
              subCard.dataset.name = track.name;
              
              subCard.innerHTML = `
                <div class="quality-info">
                  <span class="quality-name">${track.name}</span>
                  <span class="quality-meta">${track.language ? `Language: ${track.language}` : "Subtitle Track"}</span>
                </div>
                <input type="checkbox" class="sub-checkbox" style="width: 20px; height: 20px; accent-color: var(--accent-primary);" checked>
              `;

              subCard.addEventListener("click", (e) => {
                if (e.target.tagName !== "INPUT") {
                  const checkbox = subCard.querySelector(".sub-checkbox");
                  checkbox.checked = !checkbox.checked;
                }
              });

              subtitleOptionsEl.appendChild(subCard);
            });
          } else {
            subtitleSelectionWrapper.classList.add("hidden");
          }

        } else {
          // Standard single-stream mode with no audio or subtitles
          isDualAudio = false;
          audioSelectionWrapper.classList.add("hidden");
          subtitleSelectionWrapper.classList.add("hidden");
          startDownloadBtn.style.display = "none";
          
          triggerDirectDownload(stream.url, stream.resolution);
        }
      });

      qualityOptionsEl.appendChild(optionCard);
    });

    // Start Download click listener
    startDownloadBtn.onclick = async () => {
      if (!activeQualityUrl || (isDualAudio && !activeAudioUrl)) return;
      qualityPanelEl.classList.add("hidden");
      downloadPanelEl.classList.remove("hidden");
      
      const selectedStream = streams.find(s => s.url === activeQualityUrl);
      const resolution = selectedStream ? selectedStream.resolution : "video";
      downloadStatusTxt.textContent = `Analyzing selected stream: ${resolution}...`;

      // Determine what subtitles are selected
      const selectedSubs = [];
      const subCards = document.querySelectorAll(".subtitle-option");
      subCards.forEach(card => {
        const checkbox = card.querySelector(".sub-checkbox");
        if (checkbox && checkbox.checked) {
          selectedSubs.push({
            url: card.dataset.url,
            name: card.dataset.name
          });
        }
      });
      
      activeSelectedSubs = selectedSubs;
      await startCustomDownload(activeQualityUrl, activeAudioUrl, activeAudioName, isDualAudio, activeSelectedSubs);
    };
  }

  // Renders options panel for media playlists / single HLS streams when page-sniffed subtitles are available
  function showSingleStreamSelection(url, pageSubtitles) {
    const hasSubs = pageSubtitles && pageSubtitles.length > 0;
    downloadStatusTxt.textContent = hasSubs ? "Video detected. Select subtitles." : "Video detected. Ready to download.";
    downloadPanelEl.classList.add("hidden");
    qualityPanelEl.classList.remove("hidden");
    qualityOptionsEl.innerHTML = "";
    audioOptionsEl.innerHTML = "";
    audioSelectionWrapper.classList.add("hidden");
    
    const optionCard = document.createElement("div");
    optionCard.className = "quality-option active";
    optionCard.innerHTML = `
      <div class="quality-info">
        <span class="quality-name">Standard Quality</span>
        <span class="quality-meta">HLS stream</span>
      </div>
      <button class="btn-select">Selected</button>
    `;
    qualityOptionsEl.appendChild(optionCard);
    
    activeQualityUrl = url;
    isDualAudio = false;
    activeAudioUrl = "";
    activeAudioName = "";
    activeSelectedSubs = [];
    
    if (hasSubs) {
      subtitleSelectionWrapper.classList.remove("hidden");
      subtitleOptionsEl.innerHTML = "";
      
      pageSubtitles.forEach(track => {
        const subCard = document.createElement("div");
        subCard.className = "quality-option subtitle-option";
        subCard.dataset.url = track.url;
        subCard.dataset.name = track.filename || "Subtitle";
        
        subCard.innerHTML = `
          <div class="quality-info">
            <span class="quality-name">${track.filename || "Subtitle"}</span>
            <span class="quality-meta">${track.language ? `Language: ${track.language}` : "External Subtitle"}</span>
          </div>
          <input type="checkbox" class="sub-checkbox" style="width: 20px; height: 20px; accent-color: var(--accent-primary);" checked>
        `;
  
        subCard.addEventListener("click", (e) => {
          if (e.target.tagName !== "INPUT") {
            const checkbox = subCard.querySelector(".sub-checkbox");
            checkbox.checked = !checkbox.checked;
          }
        });
  
        subtitleOptionsEl.appendChild(subCard);
      });
    } else {
      subtitleSelectionWrapper.classList.add("hidden");
    }
    
    startDownloadBtn.style.display = "flex";
    startDownloadBtn.disabled = false;
    startDownloadBtn.style.opacity = "1";
    
    startDownloadBtn.onclick = async () => {
      qualityPanelEl.classList.add("hidden");
      downloadPanelEl.classList.remove("hidden");
      downloadStatusTxt.textContent = "Analyzing video stream...";

      const selectedSubs = [];
      const subCards = document.querySelectorAll(".subtitle-option");
      subCards.forEach(card => {
        const checkbox = card.querySelector(".sub-checkbox");
        if (checkbox && checkbox.checked) {
          selectedSubs.push({
            url: card.dataset.url,
            name: card.dataset.name
          });
        }
      });
      
      activeSelectedSubs = selectedSubs;
      await startCustomDownload(url, "", "", false, activeSelectedSubs);
    };
  }

  async function triggerDirectDownload(url, resolution) {
    qualityPanelEl.classList.add("hidden");
    downloadPanelEl.classList.remove("hidden");
    downloadStatusTxt.textContent = `Analyzing selected stream: ${resolution}...`;
    
    activeSelectedSubs = [];
    try {
      await startCustomDownload(url, "", "", false, activeSelectedSubs);
    } catch (e) {
      showError("Media Stream Fetch Error", `Failed to load sub-stream: ${e.message}`);
    }
  }

  async function toBlobURL(url, mimeType) {
    const res = await fetch(url);
    const blob = await res.blob();
    return URL.createObjectURL(blob);
  }

  // Consolidated downloader that downloads video, optional audio, and multiple subtitles
  async function startCustomDownload(videoUrl, audioUrl, audioName, isDual, selectedSubs) {
    try {
      isAborted = false; // Reset abortion state
      saveBtn.classList.add("hidden");
      if (finalBlobUrl) {
        URL.revokeObjectURL(finalBlobUrl);
        finalBlobUrl = null;
      }
      const settingsPanel = document.getElementById("settings-panel");
      if (settingsPanel) settingsPanel.classList.add("hidden");

      downloadStartTime = Date.now();
      startSpeedMonitoring();

      let videoBuffer = null;
      let audioBuffer = null;

      // 1. Download Video
      downloadStatusTxt.textContent = isDual ? "Downloading Video stream (1/2)..." : "Downloading Video stream...";
      videoBuffer = await downloadPlaylist(videoUrl, isDual ? "Video (1/2)" : "Video");
      if (isAborted) return;

      // 2. Download Audio
      if (isDual) {
        downloadStatusTxt.textContent = "Downloading Audio stream (2/2)...";
        audioBuffer = await downloadPlaylist(audioUrl, `Audio: ${audioName} (2/2)`);
        if (isAborted) return;
      }

      // 3. Download Subtitles
      const subtitleFiles = []; // { name, content, ext }
      if (selectedSubs && selectedSubs.length > 0) {
        for (let i = 0; i < selectedSubs.length; i++) {
          const sub = selectedSubs[i];
          downloadStatusTxt.textContent = `Downloading subtitle track: ${sub.name}...`;
          try {
            const mergedVtt = await downloadSubtitlePlaylist(sub.url, sub.name);
            if (mergedVtt) {
              let ext = ".vtt";
              const subUrlLower = sub.url.toLowerCase();
              if (subUrlLower.includes(".srt")) ext = ".srt";
              else if (subUrlLower.includes(".ass")) ext = ".ass";
              else if (subUrlLower.includes(".ssa")) ext = ".ssa";
              else if (subUrlLower.includes(".ttml")) ext = ".ttml";
              
              subtitleFiles.push({ name: sub.name, content: mergedVtt, ext: ext });
            }
          } catch (err) {
            console.error(`Error downloading subtitle track ${sub.name}:`, err);
            alert(`Could not download subtitle track: ${sub.name}. Continuing video download.`);
          }
        }
      }

      clearInterval(speedInterval);

      // 4. Try WebAssembly Auto-Merge (Zero-Click in-memory experience)
      const cleanTitle = baseTitle.replace(/[\\/:*?"<>|]/g, "_");
      const needsMerge = isDual || (subtitleFiles && subtitleFiles.length > 0);

      if (needsMerge && window.FFmpegWASM) {
        try {
          downloadStatusTxt.textContent = "Loading WebAssembly FFmpeg Engine...";
          progressBar.style.width = "95%";
          downloadBadge.textContent = "Processing...";
          
          const { FFmpeg } = window.FFmpegWASM;
          const ffmpeg = new FFmpeg();
          
          // Load local core and wasm from extension directory directly
          const coreURL = chrome.runtime.getURL("ffmpeg-core.js");
          const wasmURL = chrome.runtime.getURL("ffmpeg-core.wasm");
          
          await ffmpeg.load({ coreURL, wasmURL });
          
          downloadStatusTxt.textContent = "Writing streams to memory...";
          // Write video and audio to virtual FS
          await ffmpeg.writeFile("video.ts", new Uint8Array(await videoBuffer.arrayBuffer()));
          if (isDual) {
            await ffmpeg.writeFile("audio.ts", new Uint8Array(await audioBuffer.arrayBuffer()));
          }
          
          // Write subtitles to virtual FS
          const encoder = new TextEncoder();
          for (let i = 0; i < subtitleFiles.length; i++) {
            const subData = encoder.encode(subtitleFiles[i].content);
            await ffmpeg.writeFile(`sub_${i}${subtitleFiles[i].ext}`, subData);
          }
          
          downloadStatusTxt.textContent = "Merging streams directly in browser...";
          
          let ffmpegArgs = ["-i", "video.ts"];
          if (isDual) {
            ffmpegArgs.push("-i", "audio.ts");
          }
          for (let i = 0; i < subtitleFiles.length; i++) {
            ffmpegArgs.push("-i", `sub_${i}${subtitleFiles[i].ext}`);
          }
          
          // Maps
          ffmpegArgs.push("-map", "0:v");
          if (isDual) {
            ffmpegArgs.push("-map", "1:a");
          } else {
            ffmpegArgs.push("-map", "0:a");
          }
          
          const subStartIdx = isDual ? 2 : 1;
          for (let i = 0; i < subtitleFiles.length; i++) {
            ffmpegArgs.push("-map", `${i + subStartIdx}:s`);
          }
          
          // Codec Copy (Use srt for subtitle streams to maximize player compatibility)
          if (subtitleFiles.length > 0) {
            ffmpegArgs.push("-c:v", "copy", "-c:a", "copy", "-c:s", "srt");
          } else {
            ffmpegArgs.push("-c", "copy");
          }
          
          // Metadata
          for (let i = 0; i < subtitleFiles.length; i++) {
            ffmpegArgs.push(`-metadata:s:s:${i}`, `title=${subtitleFiles[i].name}`);
          }
          
          const outputFilename = "output.mkv";
          ffmpegArgs.push(outputFilename);
          
          await ffmpeg.exec(ffmpegArgs);
          
          downloadStatusTxt.textContent = "Reading merged file...";
          const mergedData = await ffmpeg.readFile(outputFilename);
          
          // Download the single combined file
          downloadStatusTxt.textContent = "Saving final merged file...";
          const outBlob = new Blob([mergedData], { type: "video/x-matroska" });
          const outUrl = URL.createObjectURL(outBlob);
          const saveFilename = `${cleanTitle}_dual.mkv`;
          
          finalBlobUrl = outUrl;
          finalFilename = saveFilename;
          saveBtn.classList.remove("hidden");
          
          chrome.downloads.download({
            url: outUrl,
            filename: saveFilename,
            saveAs: true
          }, () => {
            downloadStatusTxt.textContent = "Merge complete! Click 'Save File' if you need to download again.";
            progressBar.style.width = "100%";
            downloadBadge.textContent = "100%";
            downloadBadge.className = "status-badge success";
            statEta.textContent = "Done";
            
            // Clean up WebAssembly memory
            ffmpeg.terminate();
            
            cancelBtn.innerHTML = `
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <line x1="18" y1="6" x2="6" y2="18"></line>
                <line x1="6" y1="6" x2="18" y2="18"></line>
              </svg>
              Close
            `;
          });
          
          return; // Success! Skip fallback downloads
          
        } catch (wasmErr) {
          console.error("WebAssembly FFmpeg failed, falling back to manual merge:", wasmErr);
          alert("In-browser automatic merge failed (memory or CSP restriction). Files are being downloaded separately, you can merge them using the FFmpeg command.");
        }
      }

      // Fallback: Individual downloads + show merge instructions (if needsMerge is true)
      if (needsMerge) {
        downloadStatusTxt.textContent = "Saving separate stream files...";
        progressBar.style.width = "100%";
        downloadBadge.textContent = "100%";
        downloadBadge.className = "status-badge success";

        const videoFilename = `${cleanTitle}_video.ts`;
        const audioFilename = isDual ? `${cleanTitle}_audio.ts` : "";
        const outputFilename = isDual ? `${cleanTitle}_dual.mkv` : `${cleanTitle}_subbed.mkv`;

        // Clear tracking
        for (const key in activeDownloads) delete activeDownloads[key];

        // Store merge details for downloads completion trigger
        pendingMerge = {
          video: videoFilename,
          audio: audioFilename,
          subtitles: subtitleFiles.map(sub => ({
            name: sub.name,
            filename: `${cleanTitle}_${sub.name.replace(/[\\/:*?"<>|]/g, "_")}${sub.ext}`
          })),
          output: outputFilename
        };

        // Download Video
        const videoBlob = videoBuffer;
        const videoUrlObj = URL.createObjectURL(videoBlob);
        chrome.downloads.download({
          url: videoUrlObj,
          filename: videoFilename,
          saveAs: isDual ? false : true
        }, (id) => {
          if (id) activeDownloads[id] = { filename: videoFilename, complete: false };
          setTimeout(() => URL.revokeObjectURL(videoUrlObj), 60000);
        });

        // Download Audio
        if (isDual) {
          const audioBlob = audioBuffer;
          const audioUrlObj = URL.createObjectURL(audioBlob);
          chrome.downloads.download({
            url: audioUrlObj,
            filename: audioFilename,
            saveAs: false
          }, (id) => {
            if (id) activeDownloads[id] = { filename: audioFilename, complete: false };
            setTimeout(() => URL.revokeObjectURL(audioUrlObj), 60000);
          });
        }

        // Download Subtitles
        subtitleFiles.forEach(subFile => {
          const subBlob = new Blob([subFile.content], { type: "application/octet-stream" });
          const subDownloadUrl = URL.createObjectURL(subBlob);
          const subFilename = `${cleanTitle}_${subFile.name.replace(/[\\/:*?"<>|]/g, "_")}${subFile.ext}`;

          chrome.downloads.download({
            url: subDownloadUrl,
            filename: subFilename,
            saveAs: false
          }, (id) => {
            if (id) activeDownloads[id] = { filename: subFilename, complete: false };
            setTimeout(() => URL.revokeObjectURL(subDownloadUrl), 60000);
          });
        });

        // Set status
        downloadStatusTxt.textContent = "Downloads complete! Waiting for files to save...";
        statEta.textContent = "Saving...";

        // Generate FFmpeg command
        let inputs = [`-i "${videoFilename}"`];
        if (isDual) inputs.push(`-i "${audioFilename}"`);

        let mapCmds = isDual ? " -map 0:v -map 1:a" : " -map 0:v -map 0:a";
        let subInputs = "";
        let metadataCmds = "";

        subtitleFiles.forEach((subFile, idx) => {
          const subFilename = `${cleanTitle}_${subFile.name.replace(/[\\/:*?"<>|]/g, "_")}${subFile.ext}`;
          subInputs += ` -i "${subFilename}"`;
          
          const subInputIndex = isDual ? idx + 2 : idx + 1;
          mapCmds += ` -map ${subInputIndex}:s`;
          metadataCmds += ` -metadata:s:s:${idx} title="${subFile.name}"`;
        });

        const codecParam = subtitleFiles.length > 0 ? " -c:v copy -c:a copy -c:s srt" : " -c copy";
        const ffmpegCmd = `ffmpeg ${inputs.join(" ")}${subInputs}${mapCmds}${codecParam}${metadataCmds} "${outputFilename}"`;
        ffmpegCommandBox.value = ffmpegCmd;
        mergeInstructionsPanel.classList.remove("hidden");
        autoMergeStatusPanel.classList.add("hidden");

        // Populate manual download links
        const downloadsListEl = document.getElementById("manual-downloads-list");
        if (downloadsListEl) {
          downloadsListEl.innerHTML = ""; // Clear
          
          // Helper to add button
          const addManualSaveButton = (blob, filename, label) => {
            const btn = document.createElement("button");
            btn.className = "btn-select";
            btn.style.padding = "4px 10px";
            btn.style.fontSize = "11px";
            btn.style.background = "rgba(6, 182, 212, 0.15)";
            btn.style.borderColor = "var(--accent-secondary)";
            btn.style.color = "var(--text-primary)";
            btn.style.display = "inline-flex";
            btn.style.alignItems = "center";
            btn.style.gap = "6px";
            btn.innerHTML = `
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width: 12px; height: 12px;">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
                <polyline points="7 10 12 15 17 10"></polyline>
                <line x1="12" y1="15" x2="12" y2="3"></line>
              </svg>
              Save ${label}
            `;
            
            btn.onclick = () => {
              const url = URL.createObjectURL(blob);
              chrome.downloads.download({
                url: url,
                filename: filename,
                saveAs: true
              }, () => {
                setTimeout(() => URL.revokeObjectURL(url), 10000);
              });
            };
            downloadsListEl.appendChild(btn);
          };

          // Add video save button
          addManualSaveButton(videoBuffer, videoFilename, "Video (.ts)");

          // Add audio save button
          if (isDual) {
            addManualSaveButton(audioBuffer, audioFilename, "Audio (.ts)");
          }

          // Add subtitle save buttons
          subtitleFiles.forEach(subFile => {
            const subBlob = new Blob([subFile.content], { type: "application/octet-stream" });
            const subFilename = `${cleanTitle}_${subFile.name.replace(/[\\/:*?"<>|]/g, "_")}${subFile.ext}`;
            addManualSaveButton(subBlob, subFilename, `Sub: ${subFile.name}`);
          });
        }

        // Copy button
        copyFfmpegBtn.onclick = () => {
          navigator.clipboard.writeText(ffmpegCmd).then(() => {
            copyFfmpegBtn.textContent = "Copied!";
            copyFfmpegBtn.style.background = "var(--success)";
            copyFfmpegBtn.style.color = "white";
            setTimeout(() => {
              copyFfmpegBtn.textContent = "Copy";
              copyFfmpegBtn.style.background = "";
              copyFfmpegBtn.style.color = "";
            }, 2000);
          });
        };
      } else {
        // Standard single-stream video with no subtitles
        const videoBlob = videoBuffer;
        const videoUrlObj = URL.createObjectURL(videoBlob);
        const videoFilename = `${cleanTitle}.ts`;

        finalBlobUrl = videoUrlObj;
        finalFilename = videoFilename;
        saveBtn.classList.remove("hidden");

        chrome.downloads.download({
          url: videoUrlObj,
          filename: videoFilename,
          saveAs: true
        }, () => {
          downloadStatusTxt.textContent = "Download complete! Click 'Save File' if you need to download again.";
          statEta.textContent = "Done";
          
          cancelBtn.innerHTML = `
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <line x1="18" y1="6" x2="6" y2="18"></line>
              <line x1="6" y1="6" x2="18" y2="18"></line>
            </svg>
            Close
          `;
        });
      }

    } catch (err) {
      if (!isAborted) {
        showError("Download Error", err.message || "Failed downloading HLS stream assets.");
      }
    }
  }

  // Helper to detect if a subtitle URL is part of a numbered sequence
  function detectAndDownloadSequence(url) {
    // 1. Separate URL into base (before query) and query
    const parts = url.split("?");
    const baseUrl = parts[0];
    const queryStr = parts[1] ? ("?" + parts[1]) : "";
    
    // 2. Find the filename in baseUrl
    const lastSlashIdx = baseUrl.lastIndexOf("/");
    if (lastSlashIdx === -1) return null;
    
    const path = baseUrl.substring(0, lastSlashIdx + 1);
    const filename = baseUrl.substring(lastSlashIdx + 1);
    
    // 3. Find the last digits sequence in the filename (excluding extension)
    const dotIdx = filename.lastIndexOf(".");
    const nameWithoutExt = dotIdx !== -1 ? filename.substring(0, dotIdx) : filename;
    const ext = dotIdx !== -1 ? filename.substring(dotIdx) : "";
    
    // Find the last run of digits in nameWithoutExt
    const match = nameWithoutExt.match(/(\d+)(?!.*\d)/); // matches last sequence of digits
    if (!match) {
      return null; // No digits found, not a sequence
    }
    
    const numStr = match[1];
    const startNum = parseInt(numStr, 10);
    const matchIndex = match.index; // Position of the number in nameWithoutExt
    
    // Function to construct segment URL for a given index
    function getSegmentUrl(num) {
      const paddedNum = String(num).padStart(numStr.length, "0");
      const newNameWithoutExt = nameWithoutExt.substring(0, matchIndex) + paddedNum + nameWithoutExt.substring(matchIndex + numStr.length);
      return path + newNameWithoutExt + ext + queryStr;
    }
    
    return {
      startNum,
      getSegmentUrl,
      numStr
    };
  }

  // Downloads all segments in a sequence, both backwards and forwards
  async function downloadSequenceSegments(sequenceInfo, currentSegmentText, label) {
    const { startNum, getSegmentUrl } = sequenceInfo;
    const segmentTexts = [];
    
    // Helper to check if text is a valid subtitle
    function isValidSubtitle(text) {
      if (!text || text.trim().length === 0) return false;
      const trimmed = text.trim();
      if (trimmed.startsWith("<!DOCTYPE") || trimmed.startsWith("<html") || trimmed.startsWith("<body")) {
        return false;
      }
      return trimmed.includes("WEBVTT") || trimmed.includes("-->") || trimmed.includes("[Script Info]") || trimmed.startsWith("<?xml") || trimmed.startsWith("<tt");
    }

    // 1. Fetch backwards
    const backwardTexts = [];
    let currentNum = startNum - 1;
    let consecutiveFailures = 0;
    
    while (currentNum >= 0 && consecutiveFailures < 1) {
      if (isAborted) return null;
      const url = getSegmentUrl(currentNum);
      try {
        if (!segmentFound) break;
        currentNum--;
      }

      // Then check forward
      currentNum = lastSeqNum + 1;
      while (true) {
        const segmentUrl = templateUrl.replace("{SEQ}", String(currentNum).padStart(padding, "0"));
        const segText = await tryFetchSubtitleSegment(segmentUrl);
        if (segText) {
          segmentTexts.push(segText);
          segmentFound = true;
        } else {
        const text = await fetchText(url);
        if (isValidSubtitle(text)) {
          segmentTexts.push(text);
          consecutiveFailures = 0;
        } else {
          consecutiveFailures++;
        }
      } catch (e) {
        consecutiveFailures++;
      }
      currentNum++;
    }

    // Downloaded all segments
    return segmentTexts;
  }

  // Helper to parse WebVTT timestamp into seconds
  function vttTimeToSeconds(timeStr) {
    const parts = timeStr.trim().split(":");
    let hrs = 0;
    let mins = 0;
    let secs = 0;
    if (parts.length === 3) {
      hrs = parseFloat(parts[0]);
      mins = parseFloat(parts[1]);
      secs = parseFloat(parts[2]);
    } else if (parts.length === 2) {
      mins = parseFloat(parts[0]);
      secs = parseFloat(parts[1]);
    } else {
      secs = parseFloat(parts[0]);
    }
    return hrs * 3600 + mins * 60 + secs;
  }

  // Helper to format seconds back into WebVTT timestamp (HH:MM:SS.mmm)
  function secondsToVttTime(seconds) {
    const hrs = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;
    
    const hrsStr = hrs.toString().padStart(2, "0");
    const minsStr = mins.toString().padStart(2, "0");
    const secsStr = secs.toFixed(3).padStart(6, "0"); // SS.mmm
    
    return `${hrsStr}:${minsStr}:${secsStr}`;
  }

  // Downloads and concatenates segmented WebVTT subtitle list
  async function downloadSubtitlePlaylist(subtitlePlaylistUrl, label) {
    try {
      const playlistText = await fetchText(subtitlePlaylistUrl);
      
      if (!playlistText.includes("#EXTM3U")) {
        // Standalone single subtitle file (.vtt, .srt, .ass, etc.)
        // Check if it is part of a sequence!
        const sequenceInfo = detectAndDownloadSequence(subtitlePlaylistUrl);
        if (sequenceInfo) {
          // Detected subtitle sequence, starting download
          const segmentTexts = await downloadSequenceSegments(sequenceInfo, playlistText, label);
          if (segmentTexts && segmentTexts.length > 0) {
            return mergeWebVTT(segmentTexts, null);
          }
        }
        return playlistText;
      }
      
      const lines = playlistText.split("\n");
      const segmentUrls = [];
      let currentDuration = 0;

      lines.forEach((line) => {
        line = line.trim();
        if (line.startsWith("#EXTINF:")) {
          const match = line.match(/#EXTINF:([0-9.]+)/);
          if (match) {
            currentDuration = parseFloat(match[1]);
          }
        } else if (line && !line.startsWith("#")) {
          const resolvedSegmentUrl = resolveUrl(subtitlePlaylistUrl, line);
          segmentUrls.push({
            url: resolvedSegmentUrl,
            duration: currentDuration || 10 // Fallback to 10s if not specified
          });
          currentDuration = 0; // reset
        }
      });

      if (segmentUrls.length === 0) {
        return playlistText;
      }

      const segmentTexts = [];
      const segmentOffsets = [];
      let accumulatedOffset = 0;
      for (let i = 0; i < segmentUrls.length; i++) {
        if (isAborted) return null;
        downloadStatusTxt.textContent = `Downloading ${label} subtitle segment ${i + 1}/${segmentUrls.length}...`;
        const text = await fetchText(segmentUrls[i].url);
        segmentTexts.push(text);
        segmentOffsets.push(accumulatedOffset);
        accumulatedOffset += segmentUrls[i].duration;
      }

      return mergeWebVTT(segmentTexts, segmentOffsets);
    } catch (e) {
      console.error(`Failed to download subtitle playlist: ${e.message}`);
      throw e;
    }
  }

  // Merges WebVTT text segments, filtering headers and timestamps mappings, shifting cues if relative
  function mergeWebVTT(segmentsTextArray, offsetsArray) {
    let mergedCues = [];
    
    for (let sIdx = 0; sIdx < segmentsTextArray.length; sIdx++) {
      const text = segmentsTextArray[sIdx];
      const offset = offsetsArray ? offsetsArray[sIdx] : 0;
      const lines = text.split(/\r?\n/);
      let inHeader = true;
      
      // Detect if this segment's cues are relative or absolute
      let isRelative = false;
      if (offset > 5) { // Only check if offset is significant
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i].trim();
          if (line.includes("-->")) {
            const parts = line.split("-->");
            const startSec = vttTimeToSeconds(parts[0].trim());
            if (startSec < offset) {
              isRelative = true;
            }
            break; // Just check the first cue
          }
        }
      }
      
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const trimmed = line.trim();
        
        if (inHeader) {
          if (trimmed === "WEBVTT" || trimmed.startsWith("X-TIMESTAMP-MAP") || trimmed.startsWith("NOTE") || trimmed.startsWith("STYLE")) {
            continue;
          }
          if (trimmed === "") {
            inHeader = false;
            continue;
          }
          if (trimmed.includes("-->")) {
            inHeader = false;
          } else {
            continue;
          }
        }
        
        if (line.includes("-->")) {
          const parts = line.split("-->");
          const startStr = parts[0].trim();
          const endStr = parts[1].trim();
          
          const endSpaceIdx = endStr.indexOf(" ");
          const endTimeStr = endSpaceIdx !== -1 ? endStr.substring(0, endSpaceIdx) : endStr;
          const settings = endSpaceIdx !== -1 ? endStr.substring(endSpaceIdx) : "";
          
          let startSec = vttTimeToSeconds(startStr);
          let endSec = vttTimeToSeconds(endTimeStr);
          
          if (isRelative) {
            startSec += offset;
            endSec += offset;
          }
          
          mergedCues.push(`${secondsToVttTime(startSec)} --> ${secondsToVttTime(endSec)}${settings}`);
        } else {
          mergedCues.push(line);
        }
      }
    }
    
    return "WEBVTT\n\n" + mergedCues.join("\n").trim() + "\n";
  }


  // Reusable function to download a media playlist, decrypting segments if needed, and returns the merged Uint8Array.
  async function downloadPlaylist(playlistUrl, label) {
    // 1. Fetch playlist text
    const playlistText = await fetchText(playlistUrl);
    
    // Parse Media Sequence Number
    let mediaSequence = 0;
    const seqMatch = playlistText.match(/#EXT-X-MEDIA-SEQUENCE:([0-9]+)/i);
    if (seqMatch) {
      mediaSequence = parseInt(seqMatch[1]);
    }

    const lines = playlistText.split("\n");
    let activeKeyUrl = null;
    let activeIv = null;
    const currentSegmentUrls = [];

    lines.forEach((line) => {
      line = line.trim();
      
      // Parse AES-128 Encryption Key line
      if (line.startsWith("#EXT-X-KEY:")) {
        const methodMatch = line.match(/METHOD=([^,\s]+)/i);
        if (methodMatch && methodMatch[1].toUpperCase() === "AES-128") {
          const uriMatch = line.match(/URI="([^"]+)"/i);
          if (uriMatch) {
            activeKeyUrl = resolveUrl(playlistUrl, uriMatch[1]);
          }
          
          const ivMatch = line.match(/IV=(0x[0-9a-fA-F]+)/i);
          activeIv = ivMatch ? parseHex(ivMatch[1]) : null;
        } else {
          activeKeyUrl = null;
        }
      } 
      // Segment URL
      else if (line && !line.startsWith("#")) {
        const resolvedSegmentUrl = resolveUrl(playlistUrl, line);
        currentSegmentUrls.push({
          url: resolvedSegmentUrl,
          keyUrl: activeKeyUrl,
          iv: activeIv,
          index: currentSegmentUrls.length, // local index within array
          seqIndex: mediaSequence + currentSegmentUrls.length // actual HLS seq index
        });
      }
    });

    const localTotalSegments = currentSegmentUrls.length;
    if (localTotalSegments === 0) {
      throw new Error(`No segments found in ${label} stream.`);
    }

    // Load decryption key if the playlist is encrypted
    let currentKeyInfo = null;
    if (currentSegmentUrls[0].keyUrl) {
      downloadStatusTxt.textContent = `Decrypting ${label} stream protection key...`;
      const keyUrl = currentSegmentUrls[0].keyUrl;
      const rawKey = await fetchBytes(keyUrl);
      const cryptoKey = await crypto.subtle.importKey(
        "raw",
        rawKey,
        { name: "AES-CBC" },
        false,
        ["decrypt"]
      );
      currentKeyInfo = {
        cryptoKey: cryptoKey,
        rawKey: rawKey
      };
    }

    // Concurrency setup
    const concurrencySelect = document.getElementById("concurrency-select");
    const concurrencyLimit = concurrencySelect ? parseInt(concurrencySelect.value) : 5;
    const queue = [...currentSegmentUrls];
    const segmentBuffers = new Array(localTotalSegments);
    
    let localDownloadedCount = 0;
    downloadedBytesSinceStart = 0;
    downloadStartTime = Date.now();
    
    // Update progress variables globally for stats calculation
    totalSegments = localTotalSegments;
    downloadedCount = 0;
    statSegments.textContent = `0 / ${totalSegments}`;
    
    const worker = async () => {
      while (queue.length > 0 && !isAborted) {
        const item = queue.shift();
        try {
          const segmentData = await fetchBytes(item.url);
          let finalData = segmentData;

          // Decrypt segment if encrypted
          if (item.keyUrl && currentKeyInfo) {
            let iv = item.iv;
            if (!iv) {
              iv = makeSequenceIV(item.seqIndex);
            }
            finalData = await crypto.subtle.decrypt(
              { name: "AES-CBC", iv: iv },
              currentKeyInfo.cryptoKey,
              segmentData
            );
          }

          segmentBuffers[item.index] = new Uint8Array(finalData);
          localDownloadedCount++;
          downloadedCount = localDownloadedCount;
          downloadedBytesSinceStart += finalData.byteLength;
          
          // Update progress displaying the stream type
          if (!isAborted) {
            const percentage = Math.floor((downloadedCount / totalSegments) * 100);
            progressBar.style.width = `${percentage}%`;
            downloadBadge.textContent = `${percentage}%`;
            statSegments.textContent = `${downloadedCount} / ${totalSegments}`;
            downloadStatusTxt.textContent = `Downloading ${label} segments: ${percentage}%`;
          }
        } catch (e) {
          console.error(`Failed segment ${item.index} of ${label}: ${e.message}`);
          if (!item.retries) item.retries = 0;
          if (item.retries < 3) {
            item.retries++;
            queue.push(item);
          } else {
            throw new Error(`Failed to download ${label} segment ${item.index + 1} after multiple retries.`);
          }
        }
      }
    };

    const workers = [];
    for (let i = 0; i < Math.min(concurrencyLimit, queue.length); i++) {
      workers.push(worker());
    }

    await Promise.all(workers);

    if (isAborted) {
      throw new Error("Download aborted by user.");
    }

    // Check if all segments are present
    for (let i = 0; i < localTotalSegments; i++) {
      if (!segmentBuffers[i]) {
        throw new Error(`Missing segment index ${i} in ${label}. Assembly failed.`);
      }
    }

    // Directly create a Blob from the array of segment buffers (Uint8Arrays)
    // to avoid allocating a huge contiguous memory block in RAM.
    const videoBlob = new Blob(segmentBuffers, { type: "video/mp2t" });
    return videoBlob;
  }

  // Calculates speed and ETA
  function startSpeedMonitoring() {
    speedInterval = setInterval(() => {
      if (isAborted || downloadedCount === 0) return;

      const elapsedSec = (Date.now() - downloadStartTime) / 1000;
      if (elapsedSec <= 0) return;

      const speedBytesSec = downloadedBytesSinceStart / elapsedSec;
      const speedMB = speedBytesSec / (1024 * 1024);
      statSpeed.textContent = `${speedMB.toFixed(2)} MB/s`;

      // Estimate time remaining
      const segmentsRemaining = totalSegments - downloadedCount;
      if (downloadedCount > 0) {
        const averageTimePerSegment = elapsedSec / downloadedCount;
        const etaSec = Math.round(segmentsRemaining * averageTimePerSegment);
        
        if (etaSec === Infinity || isNaN(etaSec)) {
          statEta.textContent = "--:--";
        } else {
          const mins = Math.floor(etaSec / 60).toString().padStart(2, "0");
          const secs = (etaSec % 60).toString().padStart(2, "0");
          statEta.textContent = `${mins}:${secs}`;
        }
      }
    }, 1000);
  }

  // Displays error panel
  function showError(title, message) {
    clearInterval(speedInterval);
    errorTitle.textContent = title;
    errorDesc.textContent = message;
    errorPanel.classList.remove("hidden");
    downloadPanelEl.classList.add("hidden");
    qualityPanelEl.classList.add("hidden");
    cancelBtn.classList.add("hidden");
    restartBtn.classList.remove("hidden");
  }

  // URL Utilities
  function resolveUrl(baseUrl, relativeUrl) {
    try {
      return new URL(relativeUrl, baseUrl).href;
    } catch (e) {
      return relativeUrl;
    }
  }

  function parseHex(hexStr) {
    if (hexStr.startsWith("0x") || hexStr.startsWith("0X")) {
      hexStr = hexStr.slice(2);
    }
    hexStr = hexStr.padStart(32, "0");
    const bytes = new Uint8Array(16);
    for (let i = 0; i < 16; i++) {
      bytes[i] = parseInt(hexStr.slice(i * 2, i * 2 + 2), 16);
    }
    return bytes;
  }

  function makeSequenceIV(sequenceNum) {
    const bytes = new Uint8Array(16);
    let temp = sequenceNum;
    for (let i = 15; i >= 0; i--) {
      bytes[i] = temp & 0xff;
      temp = temp >> 8;
    }
    return bytes;
  }

  // Network helpers
  async function fetchText(url) {
    // Send with credentials: "include" to pass session cookie validations
    const res = await fetch(url, { credentials: "include" });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    return await res.text();
  }

  async function fetchBytes(url) {
    // Send with credentials: "include" to pass session cookie validations
    const res = await fetch(url, { credentials: "include" });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    return await res.arrayBuffer();
  }

  // Trigger local python helper server to merge downloaded files
  async function triggerAutoMerge(mergeData) {
    downloadStatusTxt.textContent = "Connecting to local merge server...";
    try {
      const res = await fetch("http://127.0.0.1:8765/merge", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify(mergeData)
      });
      
      if (res.ok) {
        const result = await res.json();
        if (result.success) {
          downloadStatusTxt.textContent = "Merged successfully by local helper!";
          autoMergeStatusPanel.classList.remove("hidden");
          mergeInstructionsPanel.classList.add("hidden");
          
          setTimeout(() => {
            if (confirm("Download and merge complete! Would you like to close this tab?")) {
              window.close();
            }
          }, 1500);
        } else {
          throw new Error(result.error);
        }
      } else {
        throw new Error("Server error");
      }
    } catch (e) {
      console.error("Local merge server is offline or failed:", e.message);
      downloadStatusTxt.textContent = "Downloads complete! Merge files using FFmpeg.";
      mergeInstructionsPanel.classList.remove("hidden");
      autoMergeStatusPanel.classList.add("hidden");
    }
  }

  // Generates and downloads the merge_helper.bat file programmatically
  function downloadMergeScript() {
    const batContent = `@echo off
setlocal enabledelayedexpansion

echo =========================================================
echo    Advanced Video Downloader - Offline Auto Merge Tool
echo =========================================================
echo.

:: Check if ffmpeg is in current directory or in system PATH
if exist "%~dp0ffmpeg.exe" (
    set "FFMPEG_CMD=%~dp0ffmpeg.exe"
) else (
    where ffmpeg >nul 2>nul
    if errorlevel 1 (
        echo [ERROR] ffmpeg.exe was not found in this folder and is not in system PATH.
        echo Please place ffmpeg.exe in this folder or install it globally first.
        echo.
        pause
        exit /b
    ) else (
        set "FFMPEG_CMD=ffmpeg"
    )
)

:: Automatically rename any .vtt.txt, .srt.txt files to .vtt, .srt
for %%e in (vtt srt ass ssa ttml) do (
    for %%s in ("*_*.%%e.txt") do (
        set "old_name=%%s"
        set "new_name=%%~ns"
        echo Renaming "%%s" to "!new_name!"...
        ren "%%s" "!new_name!"
    )
)

echo Scanning for video and audio files to merge in:
echo %cd%
echo.

set merged_count=0

for %%f in (*_video.ts) do (
    set "vid=%%f"
    set "base=!vid:~0,-9!"
    set "aud=!base!_audio.ts"
    
    if exist "!aud!" (
        set "out=!base!_dual.mkv"
    ) else (
        set "out=!base!_subbed.mkv"
    )
    
    echo ---------------------------------------------------------
    echo Found video stream: "!vid!"
    
    set "inputs=-i "!vid!""
    if exist "!aud!" (
        echo Found matching audio stream: "!aud!"
        set "inputs=!inputs! -i "!aud!""
        set "map_cmds=-map 0:v -map 1:a"
        set /a sub_start_idx=2
    ) else (
        set "map_cmds=-map 0:v -map 0:a"
        set /a sub_start_idx=1
    )
    
    :: Scan for subtitles matching the same base name with any supported extension (.vtt, .srt, .ass, .ssa, .ttml)
    set "sub_inputs="
    set "metadata_cmds="
    set /a sub_idx=0
    
    for %%e in (vtt srt ass ssa ttml) do (
        for %%s in ("!base!_*.%%e") do (
            set "sub=%%s"
            set "sub_name=%%~ns"
            :: Extract subtitle name (strip base and underscore)
            set "lang=!sub_name:*_%=!"
            
            if not "!sub!"=="!vid!" if not "!sub!"=="!aud!" (
                set "sub_inputs=!sub_inputs! -i "!sub!""
                set /a current_idx=sub_start_idx + sub_idx
                set "map_cmds=!map_cmds! -map !current_idx!:s"
                set "metadata_cmds=!metadata_cmds! -metadata:s:s:!sub_idx! title="!lang!""
                set /a sub_idx+=1
            )
        )
    )
    
    if !sub_idx! gtr 0 (
        echo Found !sub_idx! subtitle track^(s^).
        set "codec_cmds=-c:v copy -c:a copy -c:s srt"
    ) else (
        set "codec_cmds=-c copy"
    )
    
    echo.
    echo Merging into: "!out!"...
    "!FFMPEG_CMD!" -y !inputs! !sub_inputs! !map_cmds! !codec_cmds! !metadata_cmds! "!out!"
    
    if !errorlevel! equ 0 (
        echo [SUCCESS] Merged successfully. Cleaning up temporary files...
        del "!vid!"
        if exist "!aud!" del "!aud!"
        for %%e in (vtt srt ass ssa ttml) do (
            for %%s in ("!base!_*.%%e") do (
                set "sub=%%s"
                if not "!sub!"=="!vid!" if not "!sub!"=="!aud!" (
                    del "%%s"
                )
            )
        )
        set /a merged_count+=1
    ) else (
        echo [ERROR] FFmpeg failed to merge "!base!".
    )
    echo.
)

echo ---------------------------------------------------------
if !merged_count! gtr 0 (
    echo Process complete. Merged !merged_count! video^(s^).
) else (
    echo No matching video/audio streams found. 
    echo Ensure "[Name]_video.ts" files exist in this folder.
)
echo.
pause
`;
    const blob = new Blob([batContent], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    chrome.downloads.download({
      url: url,
      filename: "merge_helper.bat",
      saveAs: false
    }, () => {
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    });
  }
});
