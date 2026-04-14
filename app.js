const API_URL =
  "https://platform.hypegps.com/api/get_devices?user_api_hash=$2y$10$mUiiGZjTiDatqMEvRhlRAeqVpQlLAW5psz/IchLS/JzBh0HQ9uHDy";
const AUTO_REFRESH_SECONDS = 60;

const chartInstances = {};
let fleetMap;
let markersLayer;
let allFleetRows = [];
let filteredFleetRows = [];
let selectedRouteId = null;
let autoRefreshTimer = null;
let countdownTimer = null;
let refreshCountdown = AUTO_REFRESH_SECONDS;

const els = {
  kpiGrid: document.getElementById("kpiGrid"),
  insightGrid: document.getElementById("insightGrid"),
  watchlist: document.getElementById("watchlist"),
  fleetTableBody: document.getElementById("fleetTableBody"),
  searchInput: document.getElementById("searchInput"),
  statusMessage: document.getElementById("statusMessage"),
  refreshButton: document.getElementById("refreshButton"),
  lastUpdated: document.getElementById("lastUpdated"),
  loadMode: document.getElementById("loadMode"),
  refreshCountdown: document.getElementById("refreshCountdown"),
  statusFilter: document.getElementById("statusFilter"),
  freshnessFilter: document.getElementById("freshnessFilter"),
  routeFilter: document.getElementById("routeFilter"),
  clearFiltersButton: document.getElementById("clearFiltersButton"),
  detailDrawer: document.getElementById("detailDrawer"),
  detailDrawerScrim: document.getElementById("detailDrawerScrim"),
  detailCloseButton: document.getElementById("detailCloseButton"),
  detailTitle: document.getElementById("detailTitle"),
  detailBody: document.getElementById("detailBody"),
};

const palette = {
  accent: "#e76f51",
  accentSoft: "#f4a261",
  green: "#2a9d8f",
  amber: "#e9c46a",
  red: "#d1495b",
  blue: "#3a86ff",
  ink: "#14213d",
};

function includesHitm(value) {
  return String(value || "").toLowerCase().includes("hitm");
}

function isHitmRecord(group, item) {
  const deviceUsers = item?.device_data?.users || [];
  const hasHitmUser = deviceUsers.some((user) => includesHitm(user?.email));
  const groupMatch = includesHitm(group?.title);
  const routeMatch =
    includesHitm(item?.name) ||
    includesHitm(item?.device_data?.name) ||
    includesHitm(item?.device_data?.object_owner);

  return groupMatch || routeMatch || hasHitmUser;
}

function parseDate(dateString) {
  if (!dateString || dateString === "-" || dateString === "Not connected") return null;

  if (/^\d{2}-\d{2}-\d{4}/.test(dateString)) {
    const [datePart, timePart = "00:00:00"] = dateString.split(" ");
    const [day, month, year] = datePart.split("-").map(Number);
    const [hour, minute, second] = timePart.split(":").map(Number);
    return new Date(year, month - 1, day, hour, minute, second);
  }

  const parsed = new Date(dateString);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function extractInfoXml(item) {
  const raw = item?.device_data?.traccar?.other || item?.traccar?.other || "";
  const pairs = [...raw.matchAll(/<([a-zA-Z0-9_]+)>(.*?)<\/\1>/g)];
  const data = {};

  for (const [, key, value] of pairs) {
    if (value === "true") data[key] = true;
    else if (value === "false") data[key] = false;
    else if (value !== "" && !Number.isNaN(Number(value))) data[key] = Number(value);
    else data[key] = value;
  }

  return data;
}

function hoursBetween(date) {
  if (!date) return null;
  return (Date.now() - date.getTime()) / 3600000;
}

function formatNumber(value, digits = 0) {
  if (value === null || value === undefined || Number.isNaN(value)) return "--";
  return new Intl.NumberFormat("en-IN", {
    maximumFractionDigits: digits,
    minimumFractionDigits: digits,
  }).format(value);
}

function formatDate(value) {
  if (!value) return "--";
  return new Intl.DateTimeFormat("en-IN", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(value);
}

function formatRelativeHours(hours) {
  if (hours === null || Number.isNaN(hours)) return "No telemetry";
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))} min ago`;
  if (hours < 24) return `${formatNumber(hours, 1)} h ago`;
  return `${formatNumber(hours / 24, 1)} d ago`;
}

function expiryInDays(dateString) {
  const dt = parseDate(dateString);
  if (!dt) return null;
  return Math.round((dt.getTime() - Date.now()) / 86400000);
}

function routeDisplayName(row) {
  return row.name || row.imei || "Unnamed route";
}

function deriveActivityLabel(row) {
  if (row.status === "offline") return "Offline";
  if (row.speed > 0 || row.status === "online") return "Active";
  return "Parked";
}

function isActiveToday(row) {
  return row.lastSeenHours !== null && row.lastSeenHours < 24;
}

function activeTodayScore(row) {
  const freshnessScore = row.lastSeenHours === null ? 0 : Math.max(0, 24 - row.lastSeenHours);
  const movementBonus = row.speed > 0 ? row.speed / 4 : 0;
  return freshnessScore + movementBonus;
}

function normalizeData(payload) {
  const rows = [];

  (Array.isArray(payload) ? payload : []).forEach((group) => {
    (group.items || []).forEach((item) => {
      if (!isHitmRecord(group, item)) return;

      const info = extractInfoXml(item);
      const lastSeen = item.timestamp ? new Date(item.timestamp * 1000) : parseDate(item.time);
      rows.push({
        id: item.id,
        name: item.name || item?.device_data?.name || "Unnamed route",
        imei: item?.device_data?.imei || "--",
        group: group.title || "Ungrouped",
        status: item.online || "unknown",
        speed: Number(item.speed || 0),
        lat: Number(item.lat || 0),
        lng: Number(item.lng || 0),
        totalDistance: Number(item.total_distance || 0),
        stopDurationSec: Number(item.stop_duration_sec || 0),
        stopDurationText: item.stop_duration || "--",
        timeText: item.time_text || "--",
        lastSeen,
        lastSeenHours: hoursBetween(lastSeen),
        battery: null,
        charge: Boolean(info.charge),
        ignition: info.ignition ?? item.engine_status ?? null,
        engineHours: Number(info.enginehours || 0) / 3600,
        satellites: Number(info.sat || 0),
        rssi: Number(info.rssi || 0),
        simExpiryDays: expiryInDays(item?.device_data?.sim_expiration_date),
        simExpiryText: item?.device_data?.sim_expiration_date || "--",
        protocol: item.protocol || item?.device_data?.traccar?.protocol || "--",
        course: Number(item.course || 0),
        routeHealthScore: 100,
      });
    });
  });

  rows.forEach((row) => {
    let score = 100;
    if (row.status === "offline") score -= 30;
    if ((row.lastSeenHours || 0) > 24) score -= 15;
    if ((row.lastSeenHours || 0) > 72) score -= 20;
    if (row.satellites > 0 && row.satellites < 4) score -= 15;
    if (row.simExpiryDays !== null && row.simExpiryDays >= 0 && row.simExpiryDays <= 30) score -= 10;
    if (row.speed === 0 && row.status === "online") score -= 5;
    row.routeHealthScore = Math.max(10, score);
  });

  return rows.sort((a, b) => routeDisplayName(a).localeCompare(routeDisplayName(b)));
}

function buildKpis(rows) {
  const total = rows.length;
  const moving = rows.filter((row) => row.speed > 0 || row.status === "online").length;
  const parked = rows.filter((row) => row.status === "ack" || (row.speed === 0 && row.status !== "offline")).length;
  const offline = rows.filter((row) => row.status === "offline").length;
  const avgDistance = rows.reduce((sum, row) => sum + row.totalDistance, 0) / Math.max(total, 1);
  const activeToday = rows.filter((row) => isActiveToday(row)).length;
  const expiringSoon = rows.filter((row) => row.simExpiryDays !== null && row.simExpiryDays >= 0 && row.simExpiryDays <= 30).length;

  return [
    ["Fleet Size", formatNumber(total), "Visible under current filters", palette.accent],
    ["Live or Moving", formatNumber(moving), `${formatNumber((moving / Math.max(total, 1)) * 100, 1)}% currently active`, palette.green],
    ["Parked", formatNumber(parked), "Stopped but still reporting", palette.amber],
    ["Offline", formatNumber(offline), "Need telemetry review", palette.red],
    ["Avg Lifetime Km", formatNumber(avgDistance, 0), "Mean route distance traveled", palette.blue],
    ["Active Today", formatNumber(activeToday), `${expiringSoon} SIM cards expiring within 30 days`, palette.accentSoft],
  ].map(([label, value, sub, accent]) => ({ label, value, sub, accent }));
}

function renderKpis(kpis) {
  els.kpiGrid.innerHTML = kpis
    .map(
      (kpi) => `
        <article class="kpi-card" style="--card-accent:${kpi.accent}">
          <div class="kpi-card__label">${kpi.label}</div>
          <div class="kpi-card__value">${kpi.value}</div>
          <div class="kpi-card__sub">${kpi.sub}</div>
        </article>
      `
    )
    .join("");
}

function buildInsights(rows) {
  const topDistance = [...rows].sort((a, b) => b.totalDistance - a.totalDistance)[0];
  const quickest = [...rows].filter((row) => row.speed > 0).sort((a, b) => b.speed - a.speed)[0];
  const weakest = [...rows].sort((a, b) => a.routeHealthScore - b.routeHealthScore)[0];

  return [
    {
      label: "Most Utilized Route",
      title: topDistance ? routeDisplayName(topDistance) : "No route data",
      copy: topDistance
        ? `${formatNumber(topDistance.totalDistance)} km logged so far, making it the highest-mileage route in the current view.`
        : "Distance data is not available for the active filter selection.",
      accent: palette.accent,
    },
    {
      label: "Fastest Active Bus",
      title: quickest ? routeDisplayName(quickest) : "No active bus right now",
      copy: quickest
        ? `Currently moving at ${formatNumber(quickest.speed)} km/h and ideal for live route monitoring.`
        : "No buses are moving inside the current filter selection.",
      accent: palette.green,
    },
    {
      label: "Priority Intervention",
      title: weakest ? routeDisplayName(weakest) : "All healthy",
      copy: weakest
        ? `Health score ${formatNumber(weakest.routeHealthScore)}. This route has the strongest combination of stale telemetry, weak GPS lock, or expiry risk.`
        : "No weak health signals found.",
      accent: palette.red,
    },
  ];
}

function renderInsights(insights) {
  els.insightGrid.innerHTML = insights
    .map(
      (item) => `
        <article class="insight-card" style="--card-accent:${item.accent}">
          <div class="insight-card__label">${item.label}</div>
          <div class="insight-card__title">${item.title}</div>
          <div class="insight-card__copy">${item.copy}</div>
        </article>
      `
    )
    .join("");
}

function watchReason(row) {
  const reasons = [];
  if (row.status === "offline") reasons.push("offline");
  if ((row.lastSeenHours || 0) > 48) reasons.push("stale telemetry");
  if (row.satellites > 0 && row.satellites < 4) reasons.push("weak GPS lock");
  if (row.simExpiryDays !== null && row.simExpiryDays >= 0 && row.simExpiryDays <= 30) reasons.push("SIM expiry near");
  return reasons.length ? reasons.join(", ") : "monitoring recommended";
}

function renderWatchlist(rows) {
  const list = [...rows].sort((a, b) => a.routeHealthScore - b.routeHealthScore).slice(0, 6);
  els.watchlist.innerHTML = list
    .map(
      (row) => `
        <article class="watch-item" data-route-id="${row.id}">
          <div class="watch-item__top">
            <div class="watch-item__name">${routeDisplayName(row)}</div>
            <span class="badge badge--${row.status}">${deriveActivityLabel(row)}</span>
          </div>
          <div class="watch-item__reason">
            ${row.group} • ${watchReason(row)} • last seen ${formatRelativeHours(row.lastSeenHours)}
          </div>
        </article>
      `
    )
    .join("");
}

function axisConfig(title = "") {
  return {
    beginAtZero: true,
    ticks: {
      color: "rgba(20,33,61,0.66)",
      font: { family: "IBM Plex Mono" },
    },
    title: title
      ? {
          display: true,
          text: title,
          color: "rgba(20,33,61,0.72)",
          font: { family: "Space Grotesk" },
        }
      : undefined,
    grid: { color: "rgba(20,33,61,0.08)" },
  };
}

function baseChartOptions(extra = {}) {
  return {
    responsive: true,
    maintainAspectRatio: false,
    animation: { duration: 850, easing: "easeOutQuart" },
    plugins: {
      legend: {
        labels: {
          color: palette.ink,
          font: { family: "Space Grotesk" },
        },
      },
      tooltip: {
        titleFont: { family: "Space Grotesk" },
        bodyFont: { family: "IBM Plex Mono" },
      },
    },
    scales: { x: axisConfig(), y: axisConfig() },
    ...extra,
  };
}

function destroyChart(id) {
  if (chartInstances[id]) chartInstances[id].destroy();
}

function buildChart(id, config) {
  destroyChart(id);
  const canvas = document.getElementById(id);
  if (!canvas) return;
  chartInstances[id] = new Chart(canvas, config);
}

function renderCharts(rows) {
  const movingCount = rows.filter((row) => row.speed > 0 || row.status === "online").length;
  const parkedCount = rows.filter((row) => row.status === "ack" || (row.speed === 0 && row.status !== "offline")).length;
  const offlineCount = rows.filter((row) => row.status === "offline").length;

  buildChart("statusChart", {
    type: "doughnut",
    data: {
      labels: ["Moving/Live", "Parked", "Offline"],
      datasets: [
        {
          data: [movingCount, parkedCount, offlineCount],
          backgroundColor: [palette.green, palette.amber, palette.red],
          borderWidth: 0,
        },
      ],
    },
    options: baseChartOptions(),
  });

  const healthBands = {
    Healthy: rows.filter((row) => row.routeHealthScore >= 80).length,
    Warning: rows.filter((row) => row.routeHealthScore >= 55 && row.routeHealthScore < 80).length,
    Critical: rows.filter((row) => row.routeHealthScore < 55).length,
  };

  buildChart("healthChart", {
    type: "doughnut",
    data: {
      labels: Object.keys(healthBands),
      datasets: [
        {
          data: Object.values(healthBands),
          backgroundColor: [palette.green, palette.amber, palette.red],
          borderWidth: 0,
        },
      ],
    },
    options: baseChartOptions(),
  });

  const topDistance = [...rows].sort((a, b) => b.totalDistance - a.totalDistance).slice(0, 12);
  buildChart("distanceChart", {
    type: "bar",
    data: {
      labels: topDistance.map((row) => routeDisplayName(row)),
      datasets: [
        {
          label: "Total distance (km)",
          data: topDistance.map((row) => row.totalDistance),
          backgroundColor: topDistance.map((_, index) => (index < 3 ? palette.accent : palette.blue)),
          borderRadius: 12,
        },
      ],
    },
    options: baseChartOptions({ indexAxis: "y" }),
  });

  const liveSpeedRows = [...rows]
    .filter((row) => row.speed > 0 || row.status === "online" || row.status === "ack")
    .sort((a, b) => b.speed - a.speed)
    .slice(0, 16);

  buildChart("speedChart", {
    type: "bar",
    data: {
      labels: liveSpeedRows.map((row) => routeDisplayName(row)),
      datasets: [
        {
          label: "Current speed (km/h)",
          data: liveSpeedRows.map((row) => row.speed),
          backgroundColor: liveSpeedRows.map((row) =>
            row.speed >= 40 ? palette.green : row.speed >= 15 ? palette.blue : palette.amber
          ),
          borderRadius: 10,
        },
      ],
    },
    options: baseChartOptions({ indexAxis: "y" }),
  });

  const longestIdleRows = [...rows]
    .sort((a, b) => b.stopDurationSec - a.stopDurationSec)
    .slice(0, 12);

  buildChart("idleChart", {
    type: "bar",
    data: {
      labels: longestIdleRows.map((row) => routeDisplayName(row)),
      datasets: [
        {
          label: "Idle hours",
          data: longestIdleRows.map((row) => row.stopDurationSec / 3600),
          backgroundColor: longestIdleRows.map((row) =>
            row.stopDurationSec >= 86400 ? palette.red : row.stopDurationSec >= 21600 ? palette.amber : palette.blue
          ),
          borderRadius: 10,
        },
      ],
    },
    options: baseChartOptions({ indexAxis: "y" }),
  });

  const activityRows = [...rows]
    .filter((row) => isActiveToday(row))
    .sort((a, b) => activeTodayScore(b) - activeTodayScore(a))
    .slice(0, 16);
  buildChart("activityChart", {
    type: "bar",
    data: {
      labels: activityRows.map((row) => routeDisplayName(row)),
      datasets: [
        {
          label: "Activity score",
          data: activityRows.map((row) => activeTodayScore(row)),
          backgroundColor: activityRows.map((row) =>
            row.speed > 0 ? palette.green : row.lastSeenHours < 6 ? palette.blue : palette.amber
          ),
          borderRadius: 10,
        },
      ],
    },
    options: baseChartOptions({ indexAxis: "y" }),
  });

  const telemetryRiskRows = [...rows]
    .sort((a, b) => {
      const telemetryPenaltyA = (a.lastSeenHours || 0) * 10 - a.satellites * 2;
      const telemetryPenaltyB = (b.lastSeenHours || 0) * 10 - b.satellites * 2;
      return telemetryPenaltyB - telemetryPenaltyA;
    })
    .slice(0, 12);

  buildChart("telemetryChart", {
    type: "bar",
    data: {
      labels: telemetryRiskRows.map((row) => routeDisplayName(row)),
      datasets: [
        {
          label: "Hours since last check-in",
          data: telemetryRiskRows.map((row) => row.lastSeenHours || 0),
          backgroundColor: telemetryRiskRows.map((row) =>
            (row.lastSeenHours || 0) >= 24 ? palette.red : row.satellites < 4 ? palette.amber : palette.blue
          ),
          borderRadius: 10,
        },
      ],
    },
    options: baseChartOptions({ indexAxis: "y" }),
  });
}

function statusToMarkerClass(status, speed) {
  if (status === "offline") return "custom-marker custom-marker--offline";
  if (speed > 0 || status === "online") return "custom-marker custom-marker--moving";
  return "custom-marker custom-marker--stopped";
}

function ensureMap() {
  if (fleetMap) return;
  fleetMap = L.map("map", { zoomControl: true });
  L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png", {
    attribution: "&copy; OpenStreetMap &copy; CARTO",
  }).addTo(fleetMap);
  markersLayer = L.layerGroup().addTo(fleetMap);
}

function findRouteById(routeId) {
  return allFleetRows.find((row) => String(row.id) === String(routeId)) || null;
}

function renderMap(rows) {
  ensureMap();
  markersLayer.clearLayers();
  const validRows = rows.filter((row) => row.lat && row.lng);

  validRows.forEach((row) => {
    const icon = L.divIcon({
      className: "",
      html: `<div class="${statusToMarkerClass(row.status, row.speed)}"></div>`,
      iconSize: [18, 18],
    });

    const marker = L.marker([row.lat, row.lng], { icon });
    marker.on("click", () => openRouteDetails(row.id));
    marker.bindPopup(`
      <strong>${routeDisplayName(row)}</strong><br />
      ${row.group}<br />
      Status: ${deriveActivityLabel(row)}<br />
      Speed: ${formatNumber(row.speed)} km/h<br />
      Last seen: ${formatDate(row.lastSeen)}
    `);
    markersLayer.addLayer(marker);
  });

  if (validRows.length) {
    fleetMap.fitBounds(L.latLngBounds(validRows.map((row) => [row.lat, row.lng])).pad(0.2));
  } else {
    fleetMap.setView([17.385, 78.4867], 8);
  }
}

function buildDetailStat(label, value) {
  return `
    <div class="detail-stat">
      <div class="detail-stat__label">${label}</div>
      <div class="detail-stat__value">${value}</div>
    </div>
  `;
}

function renderRouteDetails(route) {
  if (!route) {
    els.detailTitle.textContent = "Select a route";
    els.detailBody.innerHTML =
      '<p class="detail-empty">Click a bus on the map or in the table to inspect its live details.</p>';
    return;
  }

  els.detailTitle.textContent = routeDisplayName(route);
  els.detailBody.innerHTML = `
    <section class="detail-section">
      <h3>Current status</h3>
      <div class="detail-grid">
        ${buildDetailStat("Activity", deriveActivityLabel(route))}
        ${buildDetailStat("Last seen", formatRelativeHours(route.lastSeenHours))}
        ${buildDetailStat("Current speed", `${formatNumber(route.speed)} km/h`)}
        ${buildDetailStat("Stop duration", route.stopDurationText)}
      </div>
    </section>
    <section class="detail-section">
      <h3>Telemetry and power</h3>
      <div class="detail-grid">
        ${buildDetailStat("Satellites", route.satellites ? formatNumber(route.satellites) : "--")}
        ${buildDetailStat("Signal quality", route.satellites >= 8 ? "Strong" : route.satellites >= 4 ? "Fair" : route.satellites > 0 ? "Weak" : "No lock")}
        ${buildDetailStat("Charge", route.charge ? "Charging" : "Not charging")}
        ${buildDetailStat("RSSI", route.rssi ? formatNumber(route.rssi) : "--")}
      </div>
    </section>
    <section class="detail-section">
      <h3>Route profile</h3>
      <div class="detail-grid">
        ${buildDetailStat("Group", route.group)}
        ${buildDetailStat("IMEI", route.imei)}
        ${buildDetailStat("Total distance", `${formatNumber(route.totalDistance)} km`)}
        ${buildDetailStat("Engine hours", `${formatNumber(route.engineHours, 1)} h`)}
      </div>
    </section>
    <section class="detail-section">
      <h3>Operational details</h3>
      <div class="detail-grid">
        ${buildDetailStat("Health score", formatNumber(route.routeHealthScore))}
        ${buildDetailStat("Protocol", route.protocol || "--")}
        ${buildDetailStat("SIM expiry", route.simExpiryText)}
        ${buildDetailStat("Coordinates", `${formatNumber(route.lat, 5)}, ${formatNumber(route.lng, 5)}`)}
      </div>
    </section>
  `;
}

function openRouteDetails(routeId) {
  selectedRouteId = routeId;
  renderRouteDetails(findRouteById(routeId));
  els.detailDrawer.classList.add("is-open");
  els.detailDrawer.setAttribute("aria-hidden", "false");
}

function closeRouteDetails() {
  els.detailDrawer.classList.remove("is-open");
  els.detailDrawer.setAttribute("aria-hidden", "true");
}

function paintTable(rows) {
  els.fleetTableBody.innerHTML = rows
    .map(
      (row) => `
        <tr class="is-clickable" data-route-id="${row.id}">
          <td>
            <strong>${routeDisplayName(row)}</strong><br />
            <span class="mono">${row.imei}</span>
          </td>
          <td><span class="badge badge--${row.status}">${deriveActivityLabel(row)}</span></td>
          <td>${row.group}</td>
          <td>${formatRelativeHours(row.lastSeenHours)}</td>
          <td class="mono">${formatNumber(row.speed)} km/h</td>
          <td class="mono">${formatNumber(row.totalDistance)}</td>
          <td class="mono">${row.satellites ? `${formatNumber(row.satellites)} sats` : "--"}</td>
          <td>${row.simExpiryText}</td>
        </tr>
      `
    )
    .join("");
}

function renderTable(rows) {
  filteredFleetRows = rows;
  paintTable(rows);
}

function populateRouteFilter(rows) {
  const currentValue = els.routeFilter.value || "all";
  const options = ["<option value=\"all\">All HITM routes</option>"]
    .concat(
      rows.map(
        (row) =>
          `<option value="${row.id}">${routeDisplayName(row)}</option>`
      )
    )
    .join("");

  els.routeFilter.innerHTML = options;
  els.routeFilter.value = rows.some((row) => String(row.id) === currentValue) ? currentValue : "all";
}

function applyFilters(rows) {
  const term = els.searchInput.value.trim().toLowerCase();
  const statusFilter = els.statusFilter.value;
  const freshnessFilter = els.freshnessFilter.value;
  const routeFilter = els.routeFilter.value;

  return rows.filter((row) => {
    if (statusFilter === "active" && !(row.speed > 0 || row.status === "online")) return false;
    if (statusFilter === "parked" && !(row.status === "ack" || (row.speed === 0 && row.status !== "offline"))) return false;
    if (statusFilter === "offline" && row.status !== "offline") return false;

    if (freshnessFilter === "fresh" && !((row.lastSeenHours || Infinity) < 6)) return false;
    if (freshnessFilter === "stale" && !((row.lastSeenHours || 0) >= 24)) return false;

    if (routeFilter !== "all" && String(row.id) !== routeFilter) return false;

    if (
      term &&
      ![routeDisplayName(row), row.imei, row.group, row.status, row.protocol]
        .join(" ")
        .toLowerCase()
        .includes(term)
    ) {
      return false;
    }

    return true;
  });
}

function refreshRenderedView() {
  const rows = applyFilters(allFleetRows);
  renderKpis(buildKpis(rows));
  renderInsights(buildInsights(rows));
  renderWatchlist(rows);
  renderCharts(rows);
  renderMap(rows);
  renderTable(
    [...rows].sort((a, b) => {
      if (a.status === b.status) return (a.lastSeenHours || 0) - (b.lastSeenHours || 0);
      return a.status.localeCompare(b.status);
    })
  );
  updateMeta(rows, "Live API • HITM only");

  if (selectedRouteId && findRouteById(selectedRouteId)) {
    renderRouteDetails(findRouteById(selectedRouteId));
  }
}

function updateMeta(rows, source) {
  const activeNow = rows.filter((row) => row.speed > 0 || row.status === "online").length;
  const stale = rows.filter((row) => (row.lastSeenHours || 0) > 24).length;
  els.lastUpdated.textContent = formatDate(new Date());
  els.loadMode.textContent = source;
  els.statusMessage.textContent = `${formatNumber(rows.length)} buses visible. ${formatNumber(activeNow)} active now, ${formatNumber(stale)} routes have telemetry older than 24 hours.`;
}

async function fetchFleetData() {
  const response = await fetch(API_URL, { cache: "no-store" });
  if (!response.ok) throw new Error(`API request failed with ${response.status}`);
  return response.json();
}

function resetAutoRefreshCountdown() {
  refreshCountdown = AUTO_REFRESH_SECONDS;
  els.refreshCountdown.textContent = `${refreshCountdown}s`;
}

function startAutoRefresh() {
  if (autoRefreshTimer) clearInterval(autoRefreshTimer);
  if (countdownTimer) clearInterval(countdownTimer);

  resetAutoRefreshCountdown();
  countdownTimer = setInterval(() => {
    refreshCountdown -= 1;
    if (refreshCountdown < 0) refreshCountdown = AUTO_REFRESH_SECONDS;
    els.refreshCountdown.textContent = `${refreshCountdown}s`;
  }, 1000);

  autoRefreshTimer = setInterval(() => {
    loadDashboard({ silent: true });
  }, AUTO_REFRESH_SECONDS * 1000);
}

async function loadDashboard({ silent = false } = {}) {
  if (!silent) {
    els.statusMessage.textContent = "Loading live fleet telemetry...";
  }

  try {
    const payload = await fetchFleetData();
    allFleetRows = normalizeData(payload);
    populateRouteFilter(allFleetRows);
    refreshRenderedView();
    resetAutoRefreshCountdown();
  } catch (error) {
    console.error(error);
    els.loadMode.textContent = "Load failed";
    els.statusMessage.textContent =
      "Live API fetch failed. Open this page with internet access and refresh to load the bus fleet.";
  }
}

function clearFilters() {
  els.statusFilter.value = "all";
  els.freshnessFilter.value = "all";
  els.routeFilter.value = "all";
  els.searchInput.value = "";
  refreshRenderedView();
}

els.searchInput.addEventListener("input", refreshRenderedView);
els.statusFilter.addEventListener("change", refreshRenderedView);
els.freshnessFilter.addEventListener("change", refreshRenderedView);
els.routeFilter.addEventListener("change", refreshRenderedView);
els.clearFiltersButton.addEventListener("click", clearFilters);
els.refreshButton.addEventListener("click", () => loadDashboard());
els.detailCloseButton.addEventListener("click", closeRouteDetails);
els.detailDrawerScrim.addEventListener("click", closeRouteDetails);

els.fleetTableBody.addEventListener("click", (event) => {
  const row = event.target.closest("[data-route-id]");
  if (!row) return;
  openRouteDetails(row.dataset.routeId);
});

els.watchlist.addEventListener("click", (event) => {
  const row = event.target.closest("[data-route-id]");
  if (!row) return;
  openRouteDetails(row.dataset.routeId);
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    closeRouteDetails();
  }
});

startAutoRefresh();
loadDashboard();
