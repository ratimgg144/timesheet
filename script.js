(function () {
	"use strict";

	const DESIGNERS = ["Rati", "Steven", "Cristian", "Santiago", "Andrea", "Valentina", "Megui"];
	const STORAGE_KEY = "timesheet_entries_v6";
	const TIMER_KEY = "timesheet_active_timer_v1";

	let entries = loadEntries();
	let activeTimer = loadActiveTimer();
	let timerInterval = null;

	function ensureSheetJSLoaded() {
		return new Promise(resolve => {
			if (window.XLSX) return resolve(true);
			const s = document.createElement("script");
			s.src = "https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js";
			s.onload = () => resolve(true);
			s.onerror = () => resolve(false);
			document.head.appendChild(s);
		});
	}

	function ensureJsPDFLoaded() {
		return Promise.resolve(!!window.jspdf || !!window.jspdf?.jsPDF || !!window.jsPDF);
	}

	function downloadBlob(blob, filename) {
		const url = URL.createObjectURL(blob);
		const a = document.createElement("a");
		a.href = url;
		a.download = filename;
		document.body.appendChild(a);
		a.click();
		a.remove();
		URL.revokeObjectURL(url);
	}

	function exportCSV(rows, filename) {
		const headers = Object.keys(rows[0] || { Designer:"", Date:"", Start:"", End:"", Duration:"", Task:"", Comments:"" });
		const csv = [
			headers.join(","),
			...rows.map(r => headers.map(k => {
				const val = r[k] ?? "";
				const needQuote = /[",\n]/.test(String(val));
				return needQuote ? `"${String(val).replace(/"/g, '""')}"` : String(val);
			}).join(","))
		].join("\n");
		downloadBlob(new Blob([csv], { type: "text/csv;charset=utf-8" }), filename);
	}

	async function copyCSVToClipboard(rows) {
		const headers = Object.keys(rows[0] || { Designer:"", Date:"", Start:"", End:"", Duration:"", Task:"", Comments:"" });
		const csv = [
			headers.join(","),
			...rows.map(r => headers.map(k => {
				const val = r[k] ?? "";
				const needQuote = /[",\n]/.test(String(val));
				return needQuote ? `"${String(val).replace(/"/g, '""')}"` : String(val);
			}).join(","))
		].join("\n");
		await navigator.clipboard.writeText(csv);
		alert("Copied CSV to clipboard.");
	}

	function loadEntries() {
		try {
			const raw = localStorage.getItem(STORAGE_KEY);
			if (!raw) return [];
			const parsed = JSON.parse(raw);
			if (!Array.isArray(parsed)) return [];
			return parsed.map(x => ({
				id: x.id || cryptoRandomId(),
				designer: String(x.designer || ""),
				task: String(x.task || ""),
				comments: String(x.comments || ""),
				mentions: Array.isArray(x.mentions) ? x.mentions.filter(Boolean) : [],
				startMs: isFinite(x.startMs) ? Number(x.startMs) : (isFinite(x.timestamp) ? Number(x.timestamp) : null),
				endMs: isFinite(x.endMs) ? Number(x.endMs) : null
			})).filter(e => e.designer && e.task && (e.startMs || e.endMs));
		} catch {
			return [];
		}
	}

	function saveEntries() {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
	}

	function loadActiveTimer() {
		try {
			const raw = localStorage.getItem(TIMER_KEY);
			return raw ? JSON.parse(raw) : null;
		} catch {
			return null;
		}
	}

	function saveActiveTimer() {
		if (activeTimer) localStorage.setItem(TIMER_KEY, JSON.stringify(activeTimer));
		else localStorage.removeItem(TIMER_KEY);
	}

	function cryptoRandomId() {
		if (window.crypto && window.crypto.getRandomValues) {
			const buf = new Uint32Array(4);
			window.crypto.getRandomValues(buf);
			return Array.from(buf).map(n => n.toString(16).padStart(8, "0")).join("");
		}
		return String(Date.now()) + Math.random().toString(16).slice(2);
	}

	function formatDate(ms) {
		const d = new Date(ms);
		return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "2-digit" });
	}
	function formatTime(ms) {
		const d = new Date(ms);
		return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
	}
	function formatDuration(ms) {
		if (!isFinite(ms) || ms < 0) return "—";
		const sec = Math.floor(ms / 1000);
		const h = Math.floor(sec / 3600);
		const m = Math.floor((sec % 3600) / 60);
		const s = sec % 60;
		return [h, m, s].map(v => String(v).padStart(2, "0")).join(":");
	}

	function getWeekRangeFromInput(weekValue) {
		if (!weekValue) return null;
		const [yearStr, weekStr] = weekValue.split("-W");
		const year = parseInt(yearStr, 10);
		const week = parseInt(weekStr, 10);
		if (!year || !week) return null;
		const simple = new Date(Date.UTC(year, 0, 1 + (week - 1) * 7));
		const dow = simple.getUTCDay() || 7;
		const monday = new Date(simple);
		if (dow <= 4) monday.setUTCDate(simple.getUTCDate() - dow + 1);
		else monday.setUTCDate(simple.getUTCDate() + (8 - dow));
		const sunday = new Date(monday);
		sunday.setUTCDate(monday.getUTCDate() + 6);
		return { startMs: monday.getTime(), endMs: sunday.getTime() + (24*60*60*1000 - 1) };
	}

	function eStart(e) { return e.startMs ?? e.endMs ?? 0; }
	function eEnd(e) { return e.endMs ?? e.startMs ?? 0; }

	function getSmartRange(kind) {
		const now = new Date();
		const end = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999).getTime();
		if (kind === "today") {
			const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0).getTime();
			return { startMs: start, endMs: end };
		}
		if (kind === "week") {
			const day = now.getDay() || 7; // Mon=1..Sun=7
			const monday = new Date(now);
			monday.setDate(now.getDate() - day + 1);
			monday.setHours(0,0,0,0);
			return { startMs: monday.getTime(), endMs: end };
		}
		if (kind === "last30") {
			const start = new Date(now);
			start.setDate(now.getDate() - 29);
			start.setHours(0,0,0,0);
			return { startMs: start.getTime(), endMs: end };
		}
		return null;
	}

	function parseMentions(text) {
		if (!text) return [];
		const names = new Set();
		const regex = /@([A-Za-zÀ-ÖØ-öø-ÿ]+)\b/g;
		let m;
		while ((m = regex.exec(text)) !== null) {
			const name = m[1];
			if (DESIGNERS.includes(name)) names.add(name);
		}
		return Array.from(names);
	}

	function applyFilters(data) {
		const designer = document.getElementById("filterDesigner").value;
		const weekValue = document.getElementById("filterWeek").value;
		const q = document.getElementById("searchInput").value.trim().toLowerCase();

		let filtered = data;
		if (designer) filtered = filtered.filter(e => e.designer === designer);

		const range = getWeekRangeFromInput(weekValue);
		if (range) {
			filtered = filtered.filter(e => {
				const start = eStart(e);
				return start >= range.startMs && start <= range.endMs;
			});
		}

		if (q) {
			filtered = filtered.filter(e => {
				const hay = `${e.designer} ${e.task} ${e.comments}`.toLowerCase();
				return hay.includes(q);
			});
		}

		filtered.sort((a, b) => eStart(b) - eStart(a));
		return filtered;
	}

	function renderTable(data) {
		const tbody = document.getElementById("entriesTbody");
		const countEl = document.getElementById("entryCount");
		tbody.innerHTML = "";

		for (const e of data) {
			const tr = document.createElement("tr");
			tr.setAttribute("data-designer", e.designer);

			const tdDesigner = document.createElement("td");
			tdDesigner.textContent = e.designer;

			const start = eStart(e);
			const end = eEnd(e);
			const duration = isFinite(end - start) ? end - start : 0;

			const tdDate = document.createElement("td");
			tdDate.textContent = formatDate(start || end);

			const tdStart = document.createElement("td");
			tdStart.textContent = start ? formatTime(start) : "—";

			const tdEnd = document.createElement("td");
			tdEnd.textContent = end ? formatTime(end) : "—";

			const tdDuration = document.createElement("td");
			tdDuration.textContent = formatDuration(duration);

			const tdTask = document.createElement("td");
			tdTask.textContent = e.task;

			const tdComments = document.createElement("td");
			tdComments.textContent = e.comments || "";

			const tdActions = document.createElement("td");
			const wrap = document.createElement("div");
			wrap.className = "action-btns";
			const editBtn = document.createElement("button");
			editBtn.className = "action-mini secondary";
			editBtn.textContent = "Edit";
			editBtn.addEventListener("click", () => loadIntoForm(e.id));
			const delBtn = document.createElement("button");
			delBtn.className = "action-mini danger";
			delBtn.textContent = "Delete";
			delBtn.addEventListener("click", () => deleteEntry(e.id));
			wrap.append(editBtn, delBtn);
			tdActions.appendChild(wrap);

			tr.append(tdDesigner, tdDate, tdStart, tdEnd, tdDuration, tdTask, tdComments, tdActions);
			tbody.appendChild(tr);
		}
		countEl.textContent = String(data.length);
	}

	function colorForDesigner(name) {
		const map = {
			"Rati": getComputedStyle(document.documentElement).getPropertyValue("--rati").trim(),
			"Steven": getComputedStyle(document.documentElement).getPropertyValue("--steven").trim(),
			"Cristian": getComputedStyle(document.documentElement).getPropertyValue("--cristian").trim(),
			"Santiago": getComputedStyle(document.documentElement).getPropertyValue("--santiago").trim(),
			"Andrea": getComputedStyle(document.documentElement).getPropertyValue("--andrea").trim(),
			"Valentina": getComputedStyle(document.documentElement).getPropertyValue("--valentina").trim(),
			"Megui": getComputedStyle(document.documentElement).getPropertyValue("--megui").trim()
		};
		return map[name] || null;
	}

	function renderCards(data) {
		const container = document.getElementById("cardsContainer");
		container.innerHTML = "";

		for (const e of data) {
			const start = eStart(e);
			const end = eEnd(e);
			const duration = isFinite(end - start) ? end - start : 0;

			const card = document.createElement("div");
			card.className = "card-item";
			card.style.borderLeft = colorForDesigner(e.designer) ? `4px solid ${colorForDesigner(e.designer)}` : "";

			const title = document.createElement("div");
			title.style.fontWeight = "700";
			title.textContent = e.task;

			const meta = document.createElement("div");
			meta.className = "meta";
			meta.innerHTML = `<span>${e.designer}</span><span>${formatDate(start || end)}</span>`;

			const times = document.createElement("div");
			times.className = "meta";
			times.innerHTML = `<span>${start ? formatTime(start) : "—"} → ${end ? formatTime(end) : "—"}</span><span>${formatDuration(duration)}</span>`;

			const comments = document.createElement("div");
			comments.className = "meta";
			comments.textContent = e.comments || "";

			card.append(title, meta, times, comments);
			container.appendChild(card);
		}
	}

	function renderSummary(data) {
		const byDate = new Map();
		for (const e of data) {
			const dayKey = new Date(eStart(e) || eEnd(e)).toISOString().slice(0, 10);
			if (!byDate.has(dayKey)) byDate.set(dayKey, new Map());
			const map = byDate.get(dayKey);
			const prev = map.get(e.designer) || { tasks: 0, duration: 0 };
			const dur = Math.max(0, (eEnd(e) || 0) - (eStart(e) || 0));
			map.set(e.designer, { tasks: prev.tasks + 1, duration: prev.duration + dur });
		}

		const container = document.getElementById("dailySummary");
		container.innerHTML = "";

		const datesSorted = Array.from(byDate.keys()).sort((a, b) => b.localeCompare(a));
		for (const day of datesSorted) {
			const card = document.createElement("div");
			card.className = "summary-card";

			const h4 = document.createElement("h4");
			const d = new Date(day + "T00:00:00");
			h4.textContent = d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "2-digit" });

			card.appendChild(h4);

			const map = byDate.get(day);
			const designersSorted = DESIGNERS.filter(n => map.has(n));
			for (const name of designersSorted) {
				const row = document.createElement("div");
				row.className = "summary-row";
				const v = map.get(name);
				row.innerHTML = `<span style="border-left:4px solid ${colorForDesigner(name)}; padding-left:8px">${name}</span><span>${v.tasks} tasks • ${formatDuration(v.duration)}</span>`;
				card.appendChild(row);
			}

			container.appendChild(card);
		}
	}

	function renderFeed(data) {
		const feed = document.getElementById("teamFeed");
		feed.innerHTML = "";
		const sorted = [...data].sort((a, b) => eStart(b) - eStart(a)).slice(0, 50);
		for (const e of sorted) {
			const item = document.createElement("div");
			item.className = "feed-item";
			const when = formatDate(eStart(e) || eEnd(e)) + " " + (eStart(e) ? formatTime(eStart(e)) : "");
			const mentions = e.mentions && e.mentions.length ? ` • Mentions: ${e.mentions.join(", ")}` : "";
			item.innerHTML = `<div><strong>${e.designer}</strong> — ${e.task}</div><div class="small">${when}${mentions}</div><div class="small">${e.comments || ""}</div>`;
			feed.appendChild(item);
		}
	}

	function triggerRender() {
		const filtered = applyFilters(entries);
		renderTable(filtered);
		renderCards(filtered);
		renderSummary(filtered);
		renderFeed(entries);
	}

	function parseManualDateTime(dateStr, timeStr) {
		if (!dateStr || !timeStr) return null;
		const [y, m, d] = dateStr.split("-").map(n => parseInt(n, 10));
		const [hh, mm] = timeStr.split(":").map(n => parseInt(n, 10));
		const dt = new Date();
		dt.setFullYear(y, m - 1, d);
		dt.setHours(hh, mm, 0, 0);
		return dt.getTime();
	}

	function resetForm() {
		document.getElementById("entryId").value = "";
		document.getElementById("designer").value = "";
		document.getElementById("task").value = "";
		document.getElementById("manualDate").value = "";
		document.getElementById("startTime").value = "";
		document.getElementById("endTime").value = "";
		document.getElementById("comments").value = "";
	}

	function loadIntoForm(id) {
		const e = entries.find(x => x.id === id);
		if (!e) return;
		document.getElementById("entryId").value = e.id;
		document.getElementById("designer").value = e.designer;
		document.getElementById("task").value = e.task;
		const dt = new Date(eStart(e));
		document.getElementById("manualDate").value = dt.toISOString().slice(0, 10);
		document.getElementById("startTime").value = e.startMs ? new Date(e.startMs).toISOString().slice(11,16) : "";
		document.getElementById("endTime").value = e.endMs ? new Date(e.endMs).toISOString().slice(11,16) : "";
		document.getElementById("comments").value = e.comments || "";
		window.scrollTo({ top: 0, behavior: "smooth" });
	}

	function deleteEntry(id) {
		if (!confirm("Delete this entry?")) return;
		entries = entries.filter(e => e.id !== id);
		saveEntries();
		triggerRender();
	}

	function onSubmit(ev) {
		ev.preventDefault();
		const id = document.getElementById("entryId").value || cryptoRandomId();
		const designer = document.getElementById("designer").value;
		const task = document.getElementById("task").value.trim();
		const comments = document.getElementById("comments").value.trim();
		const mentions = parseMentions(comments);
		const dateStr = document.getElementById("manualDate").value;
		const startStr = document.getElementById("startTime").value;
		const endStr = document.getElementById("endTime").value;
		if (!designer || !task) return;

		let startMs = null, endMs = null;
		if (dateStr && startStr) startMs = parseManualDateTime(dateStr, startStr);
		if (dateStr && endStr) endMs = parseManualDateTime(dateStr, endStr);

		if (!startMs && !endMs) { const now = Date.now(); startMs = now; endMs = now; }
		else if (startMs && !endMs) endMs = startMs;
		else if (!startMs && endMs) startMs = endMs;
		if (endMs < startMs) { const t = startMs; startMs = endMs; endMs = t; }

		const idx = entries.findIndex(e => e.id === id);
		const payload = { id, designer, task, comments, mentions, startMs, endMs };
		if (idx >= 0) entries[idx] = payload;
		else entries.push(payload);

		saveEntries();
		resetForm();
		triggerRender();
	}

	// Timer
	function startTimer() {
		const designer = document.getElementById("timerDesigner").value;
		const task = document.getElementById("timerTask").value.trim();
		if (!designer || !task) return;
		activeTimer = { id: cryptoRandomId(), designer, task, comments: "", mentions: [], startMs: Date.now() };
		saveActiveTimer();
		updateTimerButtons();
		runTimerTick();
		timerInterval = setInterval(runTimerTick, 1000);
	}
	function stopTimer() {
		if (!activeTimer) return;
		const endMs = Date.now();
		entries.push({ ...activeTimer, endMs });
		saveEntries();
		activeTimer = null;
		saveActiveTimer();
		if (timerInterval) clearInterval(timerInterval);
		document.getElementById("timerStatus").textContent = "00:00:00";
		updateTimerButtons();
		triggerRender();
	}
	function runTimerTick() {
		if (!activeTimer) return;
		const elapsed = Date.now() - activeTimer.startMs;
		document.getElementById("timerStatus").textContent = formatDuration(elapsed);
	}
	function updateTimerButtons() {
		const startBtn = document.getElementById("startTimer");
		const stopBtn = document.getElementById("stopTimer");
		if (activeTimer) { startBtn.disabled = true; stopBtn.disabled = false; }
		else { startBtn.disabled = false; stopBtn.disabled = true; }
	}

	// Export helpers
	function getExportRange() {
		const s = document.getElementById("exportStart").value;
		const e = document.getElementById("exportEnd").value;
		if (!s && !e) return null;
		const startMs = s ? new Date(s + "T00:00:00").getTime() : 0;
		const endMs = e ? new Date(e + "T23:59:59").getTime() : Number.MAX_SAFE_INTEGER;
		return { startMs, endMs };
	}
	function getFilteredForExport() {
		const base = applyFilters(entries);
		const range = getExportRange();
		if (!range) return base;
		return base.filter(e => {
			const t = eStart(e);
			return t >= range.startMs && t <= range.endMs;
		});
	}

	async function toExcel() {
		const data = getFilteredForExport();
		if (data.length === 0) { alert("No data to export."); return; }
		const rows = data.map(e => {
			const start = eStart(e), end = eEnd(e);
			return {
				Designer: e.designer,
				Date: new Date(start || end).toISOString().slice(0, 10),
				Start: start ? new Date(start).toLocaleTimeString() : "",
				End: end ? new Date(end).toLocaleTimeString() : "",
				Duration: formatDuration((end || 0) - (start || 0)),
				Task: e.task,
				Comments: e.comments || ""
			};
		});

		const ok = await ensureSheetJSLoaded();
		if (ok && window.XLSX) {
			try {
				const ws = XLSX.utils.json_to_sheet(rows);
				ws["!cols"] = [{ wch: 12 }, { wch: 12 }, { wch: 10 }, { wch: 10 }, { wch: 10 }, { wch: 50 }, { wch: 50 }];
				const wb = XLSX.utils.book_new();
				XLSX.utils.book_append_sheet(wb, ws, "Timesheet");
				const out = XLSX.write(wb, { type: "array", bookType: "xlsx" });
				downloadBlob(new Blob([out], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), "timesheet.xlsx");
				return;
			} catch (err) {
				console.error("XLSX export failed:", err);
			}
		}
		// Fallback to CSV file
		exportCSV(rows, "timesheet.csv");
	}

	async function toPdf() {
		const data = getFilteredForExport();
		if (data.length === 0) { alert("No data to export."); return; }
		const ok = await ensureJsPDFLoaded();
		if (!ok || !window.jspdf) { alert("PDF export unavailable."); return; }
		const { jsPDF } = window.jspdf;
		const doc = new jsPDF({ unit: "pt", format: "a4" });
		const margin = 40;
		let y = margin;
		doc.setFont("helvetica", "bold");
		doc.setFontSize(14);
		doc.text("Timesheet Export", margin, y);
		y += 20;
		doc.setFont("helvetica", "normal");
		doc.setFontSize(10);

		const headers = ["Designer", "Date", "Start", "End", "Duration", "Task"];
		doc.text(headers.join("  |  "), margin, y);
		y += 14;
		for (const e of data) {
			const start = eStart(e), end = eEnd(e);
			const row = [
				e.designer,
				new Date(start || end).toISOString().slice(0,10),
				start ? new Date(start).toLocaleTimeString() : "",
				end ? new Date(end).toLocaleTimeString() : "",
				formatDuration((end||0)-(start||0)),
				e.task
			].join("  |  ");
			doc.text(row, margin, y, { maxWidth: 515 });
			y += 14;
			if (y > 780) { doc.addPage(); y = margin; }
		}
		doc.save("timesheet.pdf");
	}

	// Events
	function onSmartRangeClick(kind) {
		const r = getSmartRange(kind);
		if (!r) return;
		// Clear week filter and search, then apply date range via export fields to make it visible
		document.getElementById("filterWeek").value = "";
		document.getElementById("searchInput").value = "";
		document.getElementById("exportStart").value = new Date(r.startMs).toISOString().slice(0,10);
		document.getElementById("exportEnd").value = new Date(r.endMs).toISOString().slice(0,10);
		triggerRender();
	}

	function clearFilters() {
		document.getElementById("filterDesigner").value = "";
		document.getElementById("filterWeek").value = "";
		document.getElementById("searchInput").value = "";
		document.getElementById("exportStart").value = "";
		document.getElementById("exportEnd").value = "";
		triggerRender();
	}

	function initEvents() {
		document.getElementById("entryForm").addEventListener("submit", onSubmit);
		document.getElementById("resetForm").addEventListener("click", resetForm);
		document.getElementById("filterDesigner").addEventListener("change", triggerRender);
		document.getElementById("filterWeek").addEventListener("change", triggerRender);
		document.getElementById("searchInput").addEventListener("input", triggerRender);
		document.getElementById("toggleView").addEventListener("click", () => {
			const btn = document.getElementById("toggleView");
			const isTable = btn.getAttribute("data-view") === "table";
			if (isTable) {
				document.getElementById("tableView").hidden = true;
				document.getElementById("cardsView").hidden = false;
				btn.textContent = "Table View";
				btn.setAttribute("data-view", "cards");
			} else {
				document.getElementById("tableView").hidden = false;
				document.getElementById("cardsView").hidden = true;
				btn.textContent = "Cards View";
				btn.setAttribute("data-view", "table");
			}
		});
		document.getElementById("clearFilters").addEventListener("click", clearFilters);
		document.getElementById("downloadExcel").addEventListener("click", toExcel);
		document.getElementById("downloadPdf").addEventListener("click", toPdf);
		document.getElementById("copyCsv").addEventListener("click", () => {
			const data = getFilteredForExport();
			if (data.length === 0) { alert("No data to copy."); return; }
			const rows = data.map(e => {
				const start = eStart(e), end = eEnd(e);
				return {
					Designer: e.designer,
					Date: new Date(start || end).toISOString().slice(0, 10),
					Start: start ? new Date(start).toLocaleTimeString() : "",
					End: end ? new Date(end).toLocaleTimeString() : "",
					Duration: formatDuration((end || 0) - (start || 0)),
					Task: e.task,
					Comments: e.comments || ""
				};
			});
			copyCSVToClipboard(rows);
		});

		document.querySelectorAll(".smart").forEach(btn => {
			btn.addEventListener("click", () => onSmartRangeClick(btn.getAttribute("data-range")));
		});

		document.getElementById("startTimer").addEventListener("click", startTimer);
		document.getElementById("stopTimer").addEventListener("click", stopTimer);
	}

	function init() {
		initEvents();
		updateTimerButtons();
		if (activeTimer) {
			runTimerTick();
			timerInterval = setInterval(runTimerTick, 1000);
		}
		triggerRender();
	}

	if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
	else init();
})();