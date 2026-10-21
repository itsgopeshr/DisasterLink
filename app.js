// ============================================================================
// DISASTERLINK — UNIFIED FRONTEND, GPS & ESP32 WEB SERIAL ENGINE
// ============================================================================

const STORAGE_KEY = "disasterlink_alerts_v1";
const ALERT_COOLDOWN_MS = 8000; // Wait 8 seconds before logging another auto flood row

let currentLocationText = "Permission denied";
let currentLat = 30.7333; // Default map center (Chandigarh/Mohali)
let currentLng = 76.7794;
let hasValidGPS = false;

let serialPort = null;
let isWetAlertActive = false;
let lastAlertTimestamp = 0;
let audioAlarmEnabled = true;
let rescueMap = null;
let mapMarkersLayer = null;

// Cross-tab real-time sync channel
const syncChannel = ("BroadcastChannel" in window) ? new BroadcastChannel("disasterlink_sync") : null;
if (syncChannel) {
  syncChannel.onmessage = () => {
    renderAllTablesAndStats();
  };
}

// ----------------------------------------------------------------------------
// 1. INITIALIZATION ON PAGE LOAD
// ----------------------------------------------------------------------------
document.addEventListener("DOMContentLoaded", () => {
  initMapIfPresent();
  refreshGPSLocation();
  seedInitialDemoAlertIfEmpty();
  renderAllTablesAndStats();
});

// ----------------------------------------------------------------------------
// 2. GEOLOCATION ("Permission denied" fallback if blocked/unavailable)
// ----------------------------------------------------------------------------
function refreshGPSLocation() {
  if (!("geolocation" in navigator)) {
    currentLocationText = "Permission denied";
    updateLocationLabels();
    return;
  }

  navigator.geolocation.getCurrentPosition(
    (position) => {
      currentLat = position.coords.latitude;
      currentLng = position.coords.longitude;
      hasValidGPS = true;
      currentLocationText = `${currentLat.toFixed(4)}° N, ${currentLng.toFixed(4)}° E`;
      updateLocationLabels();
      if (rescueMap) {
        rescueMap.setView([currentLat, currentLng], 14);
      }
    },
    (error) => {
      console.warn("Geolocation error/denied:", error.message);
      hasValidGPS = false;
      currentLocationText = "Permission denied";
      updateLocationLabels();
    },
    { enableHighAccuracy: true, timeout: 6000, maximumAge: 0 }
  );
}

function updateLocationLabels() {
  const gpsHome = document.getElementById("user-gps-display");
  const gpsDash = document.getElementById("dashboard-gps-text");
  if (gpsHome) gpsHome.innerText = currentLocationText;
  if (gpsDash) gpsDash.innerText = currentLocationText;
}

// ----------------------------------------------------------------------------
// 3. LAPTOP AUDIO BEEP (Web Audio API — 1000 Hz)
// ----------------------------------------------------------------------------
let audioCtx = null;
function playLaptopBeep() {
  if (!audioAlarmEnabled) return;
  try {
    if (!audioCtx) {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (audioCtx.state === "suspended") {
      audioCtx.resume();
    }
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = "square";
    osc.frequency.setValueAtTime(1000, audioCtx.currentTime); // 1000 Hz tone
    gain.gain.setValueAtTime(0.08, audioCtx.currentTime);
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.start();
    osc.stop(audioCtx.currentTime + 0.18);
  } catch (e) {
    console.warn("Audio beep skipped:", e);
  }
}

function toggleAudioAlarm() {
  audioAlarmEnabled = !audioAlarmEnabled;
  const btn = document.getElementById("mute-beep-btn");
  if (btn) {
    btn.innerText = audioAlarmEnabled ? "🔊 Laptop Beep: ON" : "🔇 Laptop Beep: MUTED";
  }
}

// ----------------------------------------------------------------------------
// 4. ESP32 USB WEB SERIAL API (115200 BAUD — Reads "WET,xxx" & "DRY,xxx")
// ----------------------------------------------------------------------------
async function connectESP32Serial() {
  if (!("serial" in navigator)) {
    alert("Web Serial API is not supported in this browser. Please open the website in Google Chrome or Microsoft Edge.");
    return;
  }

  try {
    serialPort = await navigator.serial.requestPort();
    await serialPort.open({ baudRate: 115200 });

    const statusEl = document.getElementById("serial-conn-status");
    const btnEl = document.getElementById("connect-usb-btn");
    if (statusEl) {
      statusEl.innerText = "Status: 🟢 Connected to ESP32 via USB (115200 baud — Reading GPIO4)";
      statusEl.style.color = "#22c55e";
    }
    if (btnEl) {
      btnEl.innerText = "✅ USB Connected";
      btnEl.disabled = true;
    }

    const textDecoder = new TextDecoderStream();
    serialPort.readable.pipeTo(textDecoder.writable);
    const reader = textDecoder.readable.getReader();

    let buffer = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        reader.releaseLock();
        break;
      }
      if (value) {
        buffer += value;
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop(); // Keep incomplete line in buffer
        for (const line of lines) {
          processESP32SerialLine(line.trim());
        }
      }
    }
  } catch (err) {
    console.error("USB Serial error:", err);
    const statusEl = document.getElementById("serial-conn-status");
    if (statusEl) {
      statusEl.innerText = "Status: 🔴 USB Connection Failed/Cancelled (Make sure Arduino Serial Monitor is closed)";
      statusEl.style.color = "#ef4444";
    }
  }
}

function processESP32SerialLine(line) {
  if (!line || !line.includes(",")) return;

  const parts = line.split(",");
  const state = parts[0].trim().toUpperCase(); // "WET" or "DRY"
  const adcValue = parseInt(parts[1], 10);

  if (isNaN(adcValue)) return;

  const stateEl = document.getElementById("live-water-state");
  const ledEl   = document.getElementById("live-led-indicator");
  const adcEl   = document.getElementById("live-adc-value");
  const barEl   = document.getElementById("live-water-bar");
  const lastEl  = document.getElementById("stat-last-serial");

  if (adcEl) adcEl.innerText = adcValue;
  if (lastEl) lastEl.innerText = `${state},${adcValue}`;

  // Scale bar so 300 threshold is clearly visible
  const pct = Math.min(100, Math.round((adcValue / 1500) * 100));
  if (barEl) barEl.style.width = `${pct}%`;

  const now = Date.now();

  if (state === "WET" || adcValue > 300) {
    if (stateEl) {
      stateEl.innerText = "🚨 WET — FLOOD WARNING!";
      stateEl.style.color = "#ef4444";
    }
    if (ledEl) {
      ledEl.innerText = "GPIO5 Green LED: ⚡ BLINKING FAST (150ms)";
      ledEl.style.color = "#f59e0b";
    }
    if (barEl) barEl.style.backgroundColor = "#ef4444";

    if (!isWetAlertActive || (now - lastAlertTimestamp > ALERT_COOLDOWN_MS)) {
      isWetAlertActive = true;
      lastAlertTimestamp = now;
      playLaptopBeep();
      createNewAlertRecord({
        type: "FLOOD WARNING (Auto HW-038)",
        node: `NODE-01 (ADC: ${adcValue})`,
        priority: "CRITICAL",
        location: currentLocationText,
        lat: hasValidGPS ? currentLat : 30.7333,
        lng: hasValidGPS ? currentLng : 76.7794
      });
    }
  } else {
    isWetAlertActive = false;
    if (stateEl) {
      stateEl.innerText = "✅ DRY — NORMAL";
      stateEl.style.color = "#22c55e";
    }
    if (ledEl) {
      ledEl.innerText = "GPIO5 Green LED: OFF (Normal)";
      ledEl.style.color = "#94a3b8";
    }
    if (barEl) barEl.style.backgroundColor = "#22c55e";
  }
}

// ----------------------------------------------------------------------------
// 5. ALERT STORAGE, CREATION & ACK MANAGEMENT
// ----------------------------------------------------------------------------
function getStoredAlerts() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch (e) {
    return [];
  }
}

function saveAlerts(alerts) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(alerts));
  if (syncChannel) syncChannel.postMessage("updated");
  renderAllTablesAndStats();
}

function createNewAlertRecord({ type, node, priority, location, lat, lng }) {
  const alerts = getStoredAlerts();
  const newAlert = {
    id: "MSG-" + Math.floor(1000 + Math.random() * 9000),
    type: type || "FLOOD WARNING",
    node: node || "NODE-01 (ESP32)",
    priority: priority || "CRITICAL",
    location: location || currentLocationText || "Permission denied",
    lat: lat || currentLat,
    lng: lng || currentLng,
    time: new Date().toLocaleTimeString(),
    status: "RECEIVED"
  };

  alerts.unshift(newAlert);
  saveAlerts(alerts.slice(0, 50)); // Keep latest 50 alerts
}

function sendAckById(msgId) {
  const alerts = getStoredAlerts();
  const target = alerts.find((a) => a.id === msgId);
  if (target) {
    target.status = "ACK SENT";
    saveAlerts(alerts);
  }
}

function acknowledgeAllAlerts() {
  const alerts = getStoredAlerts().map((a) => ({ ...a, status: "ACK SENT" }));
  saveAlerts(alerts);
}

function clearAllAlerts() {
  if (confirm("Clear all recorded emergency alerts?")) {
    saveAlerts([]);
  }
}

// ----------------------------------------------------------------------------
// 6. SIMULATION & MANUAL SOS HANDLERS
// ----------------------------------------------------------------------------
function simulateHardwareFloodAlert() {
  const simulatedADC = Math.floor(450 + Math.random() * 900);
  processESP32SerialLine(`WET,${simulatedADC}`);
}

function triggerQuickManualSOS() {
  playLaptopBeep();
  createNewAlertRecord({
    type: "MANUAL HELP (SOS Button)",
    node: "NODE-01 (Field Manual)",
    priority: "CRITICAL",
    location: currentLocationText
  });
  alert(`Emergency SOS transmitted! Location: ${currentLocationText}`);
}

function submitManualSOSForm(event) {
  event.preventDefault();
  const name = document.getElementById("sos-name").value.trim();
  const type = document.getElementById("sos-type").value;
  const notes = document.getElementById("sos-notes").value.trim();

  playLaptopBeep();
  createNewAlertRecord({
    type: type,
    node: notes ? `${name} (${notes})` : name,
    priority: "CRITICAL",
    location: currentLocationText
  });

  document.getElementById("sos-form").reset();
  alert(`Alert Dispatched!\nType: ${type}\nLocation: ${currentLocationText}`);
}

function seedInitialDemoAlertIfEmpty() {
  const existing = getStoredAlerts();
  if (existing.length === 0) {
    createNewAlertRecord({
      type: "FLOOD WARNING (System Ready)",
      node: "NODE-01 (ADC: 385)",
      priority: "CRITICAL",
      location: currentLocationText
    });
  }
}

// ----------------------------------------------------------------------------
// 7. UI & LEAFLET MAP RENDERING
// ----------------------------------------------------------------------------
function initMapIfPresent() {
  const mapEl = document.getElementById("rescue-map");
  if (!mapEl || typeof L === "undefined") return;

  rescueMap = L.map("rescue-map").setView([currentLat, currentLng], 13);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: "&copy; OpenStreetMap contributors"
  }).addTo(rescueMap);

  mapMarkersLayer = L.layerGroup().addTo(rescueMap);
}

function renderAllTablesAndStats() {
  const alerts = getStoredAlerts();

  // Stats counters
  const totalEl = document.getElementById("stat-total-alerts");
  const floodEl = document.getElementById("stat-flood-alerts");
  const ackEl   = document.getElementById("stat-ack-alerts");
  const homeCountEl = document.getElementById("home-active-count");

  if (totalEl) totalEl.innerText = alerts.length;
  if (floodEl) floodEl.innerText = alerts.filter((a) => a.type.includes("FLOOD")).length;
  if (ackEl)   ackEl.innerText   = alerts.filter((a) => a.status === "ACK SENT").length;
  if (homeCountEl) homeCountEl.innerText = alerts.length;

  // 1. Dashboard Table
  const dashBody = document.getElementById("alertBody");
  if (dashBody) {
    dashBody.innerHTML = alerts.map((a) => `
      <tr class="${a.type.includes('FLOOD') ? 'wet-row' : ''}">
        <td><strong>${a.id}</strong></td>
        <td><span style="color: ${a.type.includes('FLOOD') ? '#f87171' : '#fbbf24'}; font-weight: 700;">${a.type}</span></td>
        <td>${a.node}</td>
        <td><span class="badge badge-critical">${a.priority}</span></td>
        <td>${a.location}</td>
        <td>${a.time}</td>
        <td>
          <span class="badge ${a.status === 'ACK SENT' ? 'badge-ack' : 'badge-high'}">${a.status}</span>
        </td>
        <td>
          <button class="btn ${a.status === 'ACK SENT' ? 'btn-outline' : 'btn-success'}"
                  style="padding: 0.3rem 0.65rem; font-size: 0.78rem;"
                  ${a.status === 'ACK SENT' ? 'disabled' : ''}
                  onclick="sendAckById('${a.id}')">
            ${a.status === 'ACK SENT' ? 'Confirmed' : 'Send ACK'}
          </button>
        </td>
      </tr>
    `).join("");
  }

  // 2. Admin Table
  const adminBody = document.getElementById("admin-alert-body");
  if (adminBody) {
    adminBody.innerHTML = alerts.map((a) => `
      <tr class="${a.type.includes('FLOOD') ? 'wet-row' : ''}">
        <td><strong>${a.id}</strong></td>
        <td><strong>${a.type}</strong></td>
        <td>${a.node}</td>
        <td><span class="badge badge-critical">${a.priority}</span></td>
        <td>${a.location}</td>
        <td>${a.time}</td>
        <td><span class="badge ${a.status === 'ACK SENT' ? 'badge-ack' : 'badge-high'}">${a.status}</span></td>
        <td>
          <button class="btn btn-success" style="padding: 0.3rem 0.65rem; font-size: 0.78rem;"
                  ${a.status === 'ACK SENT' ? 'disabled' : ''}
                  onclick="sendAckById('${a.id}')">
            ${a.status === 'ACK SENT' ? 'ACK Confirmed' : 'Transmit ACK'}
          </button>
        </td>
      </tr>
    `).join("");
  }

  // 3. Home Recent Alerts Table
  const recentBody = document.getElementById("recent-alerts-body");
  if (recentBody) {
    recentBody.innerHTML = alerts.slice(0, 5).map((a) => `
      <tr>
        <td><strong>${a.id}</strong></td>
        <td>${a.type}</td>
        <td>${a.location}</td>
        <td><span class="badge ${a.status === 'ACK SENT' ? 'badge-ack' : 'badge-high'}">${a.status}</span></td>
      </tr>
    `).join("");
  }

  // 4. Update Map Markers
  if (rescueMap && mapMarkersLayer) {
    mapMarkersLayer.clearLayers();
    alerts.slice(0, 15).forEach((a) => {
      if (a.lat && a.lng) {
        L.marker([a.lat, a.lng])
          .addTo(mapMarkersLayer)
          .bindPopup(`<strong>${a.type}</strong><br/>Node: ${a.node}<br/>Location: ${a.location}<br/>Status: ${a.status}`);
      }
    });
  }
}
