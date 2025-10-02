(function () {
	"use strict";

	console.log("Timesheet JS v8 (jsonbin)");

	// ======= CONFIG =======
	const DESIGNERS = ["Rati", "Steven", "Cristian", "Santiago", "Andrea", "Valentina", "Megui"];

	// Old local keys kept only for optional offline fallback/migration
	const STORAGE_KEY = "timesheet_entries_v7_local";
	const TIMER_KEY = "timesheet_active_timer_v1_local";

	// ======= JSONBIN CONFIG (you provided these) =======
	const JSONBIN_BIN_ID = "68dea90943b1c97be9581d23";
	const JSONBIN_KEY = "$2a$10$BCr/smrghzHthU4HHCysDuyzqeijFau.xhq.R3rANk1Qdw1pVW2aS";
	const JSONBIN_BASE = "https://api.jsonbin.io/v3";

	// ======= SAFE DOM HELPERS =======
	function $(id) { return document.getElementById(id); }
	function on(id, event, handler) {
		const el = $(id);
		if (el) el.addEventListener(event, handler);
	}
	function safeValue(id) {
		const el = $(id);
		return (el && typeof el.value === "string") ? el.value : "";
	}
	function elExists(id) { return !!$(id); }

	// ======= STATE =======
	let entries = [];
	let activeTimer = null;
	let timerInterval = null;

	// ======= EXTERNAL LIBS =======
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

	// ======= JSONBIN CLIENT =======
	async function jsonbinGetLatest() {
		const url = `${JSONBIN_BASE}/b/${JSONBIN_BIN_ID}/latest`;
		const res = await fetch(url, {
			method: "GET",
			headers: {
				"X-Master-Key": JSONBIN_KEY,
				"X-Bin-Meta": "false"
			}
		});
		if (!res.ok) throw new Error(`GET failed: ${res.status}`);
		return await res.json(); // expect { entries: [...], activeTimer: {...}|null }
	}

	async function jsonbinPut(data) {
		const url = `${JSONBIN_BASE}/b/${JSONBIN_BIN_ID}`;
		const res = await fetch(url, {
			method: "PUT",
			headers: {
				"Content-Type": "application/json",
				"X-Master-Key": JSONBIN_KEY,
				"X-Bin-Meta": "false"
			},
			body: JSON.stringify(data)
		});
		if (!res.ok) throw new Error(`PUT failed: ${res.status}`);
		return await res.json();
	}

	async function withRetry(fn, attempts = 2) {
		let lastErr;
		for (let i = 0; i < attempts; i++) {
			try { return await fn(); }
			catch (e) { lastErr = e; await new Promise(r => setTimeout(r, 400)); }
		}
		throw lastErr;
	}

	// ======= LOCAL FALLBACK (optional) =======
	function localLoadEntries() {
		try {
			const raw = localStorage.getItem(STORAGE_KEY);
			if (!raw) return [];
			const parsed = JSON.parse(raw);
			if (!Array.isArray(parsed)) return [];
			return parsed;
		} catch { return []; }
	}
	function localLoadActiveTimer() {
		try {
			const raw = localStorage.getItem(TIMER_KEY);
			return raw ? JSON.parse(raw) : null;
		} catch { return null; }
	}

	// ======= REMOTE LOAD/SAVE =======
	async function remoteLoadAll() {
		try {
			const data = await withRetry(() => jsonbinGetLatest());
			const safe = data && typeof data === "object" ? data : {};
			const loadedEntries = Array.isArray(safe.entries) ? safe.entries : [];
			const loadedTimer = safe.activeTimer && typeof safe.activeTimer === "object" ? safe.activeTimer : null;

			entries = loadedEntries.map(x => ({
				id: String(x.id),
				designer: String(x.designer || ""),
				task: String(x.task || ""),
				comments: String(x.comments || ""),
				mentions: Array.isArray(x.mentions) ? x.mentions : [],
				startMs: isFinite(x.startMs) ? Number(x.startMs) : null,
				endMs: isFinite(x.endMs) ? Number(x.endMs) : null
			})).filter(e => e.designer && e.task && (e.startMs || e.endMs));

			activeTimer = loadedTimer && loadedTimer.startMs ? {
				id: String(loadedTimer.id),
				designer: String(loadedTimer.designer),
				task: String(loadedTimer.task),
				comments: String(loadedTimer.comments || ""),
				mentions: Array.isArray(loadedTimer.mentions) ? loadedTimer.mentions : [],
				startMs: Number(loadedTimer.startMs)
			} : null;
		} catch (e) {
			console.warn("jsonbin load failed, using local fallback:", e);
			entries = localLoadEntries();
			activeTimer = localLoadActiveTimer();
		}
	}

	let saveDebounce;
	function remoteSaveAllNow() {
		const payload = { entries, activeTimer };
		return withRetry(() => jsonbinPut(payload)).catch(err => {
			console.error("jsonbin save failed:", err);
		});
	}
	function remoteSaveAllDebounced() {
		clearTimeout(saveDebounce);
		saveDebounce = setTimeout(remoteSaveAllNow, 500);
	}

	// Optional one-time migration (push local to remote if remote is empty)
	async function migrateLocalToJsonBinIfEmpty() {
		try {
			const data = await jsonbinGetLatest();
			const isEmpty = !data || !Array.isArray(data.entries) || data.entries.length === 0;
			if (isEmpty) {
				const localE = localLoadEntries();
				const localT = localLoadActiveTimer();
				if (localE && localE.length) {
					entries = localE;
					activeTimer = localT || null;
					await remoteSaveAllNow();
				}
			}
		} catch (e) {
			console.warn("Migration skipped:", e);
		}
	}

	// ======= UTILS =======
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

	// ======= FILTERS =======
	function applyFilters(data) {
		const designer = safeValue("filterDesigner");
		const weekValue = safeValue("filterWeek");
		const q = safeValue("searchInput").trim().toLowerCase();

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
				const hay = `${e.designer} ${e.task} ${e.comments || ""}`.toLowerCase();
				return hay.includes(q);
			});
		}

		filtered.sort((a, b) => eStart(b) - eStart(a));
		return filtered;
	}

	// ======= RENDER: TABLE =======
	function renderTable(data) {
		if (!elExists("entriesTbody") || !elExists("entryCount")) return;
		const tbody = $("entriesTbody");
		const countEl = $("entryCount");
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

	// ======= RENDER: CARDS =======
	function colorForDesigner(name) {
		const css = getComputedStyle(document.documentElement);
		const map = {
			"Rati": css.getPropertyValue("--rati").trim(),
			"Steven": css.getPropertyValue("--steven").trim(),
			"Cristian": css.getPropertyValue("--cristian").trim(),
			"Santiago": css.getPropertyValue("--santiago").trim(),
			"Andrea": css.getPropertyValue("--andrea").trim(),
			"Valentina": css.getPropertyValue("--valentina").trim(),
			"Megui": css.getPropertyValue("--megui").trim()
		};
		return map[name] || null;
	}
	function renderCards(data) {
		if (!elExists("cardsContainer")) return;
		const container = $("cardsContainer");
		container.innerHTML = "";

		for (const e of data) {
			const start = eStart(e);
			const end = eEnd(e);
			const duration = isFinite(end - start) ? end - start : 0;

			const card = document.createElement("div");
			card.className = "card-item";
			const col = colorForDesigner(e.designer);
			if (col) card.style.borderLeft = `4px solid ${col}`;

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

	// ======= RENDER: SUMMARY =======
	function renderSummary(data) {
		if (!elExists("dailySummary")) return;
		const byDate = new Map();
		for (const e of data) {
			const dayKey = new Date(eStart(e) || eEnd(e)).toISOString().slice(0, 10);
			if (!byDate.has(dayKey)) byDate.set(dayKey, new Map());
			const map = byDate.get(dayKey);
			const prev = map.get(e.designer) || { tasks: 0, duration: 0 };
			const dur = Math.max(0, (eEnd(e) || 0) - (eStart(e) || 0));
			map.set(e.designer, { tasks: prev.tasks + 1, duration: prev.duration + dur });
		}

		const container = $("dailySummary");
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

	// ======= RENDER: FEED =======
	function renderFeed(allData) {
		if (!elExists("teamFeed")) return;
		const feed = $("teamFeed");
		feed.innerHTML = "";
		const sorted = [...allData].sort((a, b) => eStart(b) - eStart(a)).slice(0, 50);
		for (const e of sorted) {
			const item = document.createElement("div");
			item.className = "feed-item";
			const when = formatDate(eStart(e) || eEnd(e)) + " " + (eStart(e) ? formatTime(eStart(e)) : "");
			const mentions = e.mentions && e.mentions.length ? ` • Mentions: ${e.mentions.join(", ")}` : "";
			item.innerHTML = `<div><strong>${e.designer}</strong> — ${e.task}</div><div class="small">${when}${mentions}</div><div class="small">${e.comments || ""}</div>`;
			feed.appendChild(item);
		}
	}

	// ======= MASTER RENDER =======
	function triggerRender() {
		const filtered = applyFilters(entries);
		renderTable(filtered);
		renderCards(filtered);
		renderSummary(filtered);
		renderFeed(entries);
	}

	// ======= FORM HANDLERS =======
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
		if (!elExists("entryForm")) return;
		if (elExists("entryId")) $("entryId").value = "";
		if (elExists("designer")) $("designer").value = "";
		if (elExists("task")) $("task").value = "";
		if (elExists("manualDate")) $("manualDate").value = "";
		if (elExists("startTime")) $("startTime").value = "";
		if (elExists("endTime")) $("endTime").value = "";
		if (elExists("comments")) $("comments").value = "";
	}
	function loadIntoForm(id) {
		if (!elExists("entryForm")) return;
		const e = entries.find(x => x.id === id);
		if (!e) return;
		if (elExists("entryId")) $("entryId").value = e.id;
		if (elExists("designer")) $("designer").value = e.designer;
		if (elExists("task")) $("task").value = e.task;
		const dt = new Date(eStart(e));
		if (elExists("manualDate")) $("manualDate").value = dt.toISOString().slice(0, 10);
		if (elExists("startTime")) $("startTime").value = e.startMs ? new Date(e.startMs).toISOString().slice(11,16) : "";
		if (elExists("endTime")) $("endTime").value = e.endMs ? new Date(e.endMs).toISOString().slice(11,16) : "";
		if (elExists("comments")) $("comments").value = e.comments || "";
		window.scrollTo({ top: 0, behavior: "smooth" });
	}
	function deleteEntry(id) {
		if (!confirm("Delete this entry?")) return;
		entries = entries.filter(e => e.id !== id);
		remoteSaveAllDebounced();
		triggerRender();
	}
	function onSubmit(ev) {
		ev.preventDefault();
		const id = elExists("entryId") && $("entryId").value ? $("entryId").value : cryptoRandomId();
		const designer = safeValue("designer");
		const task = safeValue("task").trim();
		const comments = safeValue("comments").trim();
		const mentions = parseMentions(comments);
		const dateStr = safeValue("manualDate");
		const startStr = safeValue("startTime");
		const endStr = safeValue("endTime");
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
		if (idx >= 0) entries[idx] = payload; else entries.push(payload);

		remoteSaveAllDebounced();
		resetForm();
		triggerRender();
	}

	// ======= TIMER =======
	function startTimer() {
		const designer = safeValue("timerDesigner");
		const task = safeValue("timerTask").trim();
		if (!designer || !task) return;
		activeTimer = { id: cryptoRandomId(), designer, task, comments: "", mentions: [], startMs: Date.now() };
		remoteSaveAllDebounced();
		updateTimerButtons();
		runTimerTick();
		timerInterval = setInterval(runTimerTick, 1000);
	}
	function stopTimer() {
		if (!activeTimer) return;
		const endMs = Date.now();
		entries.push({ ...activeTimer, endMs });
		activeTimer = null;
		remoteSaveAllDebounced();
		if (timerInterval) clearInterval(timerInterval);
		if (elExists("timerStatus")) $("timerStatus").textContent = "00:00:00";
		updateTimerButtons();
		triggerRender();
	}
	function runTimerTick() {
		if (!activeTimer || !elExists("timerStatus")) return;
		const elapsed = Date.now() - activeTimer.startMs;
		$("timerStatus").textContent = formatDuration(elapsed);
	}
	function updateTimerButtons() {
		if (!elExists("startTimer") || !elExists("stopTimer")) return;
		const startBtn = $("startTimer");
		const stopBtn = $("stopTimer");
		if (activeTimer) { startBtn.disabled = true; stopBtn.disabled = false; }
		else { startBtn.disabled = false; stopBtn.disabled = true; }
	}

	// ======= EXPORT =======
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
		try {
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
		} catch {
			alert("Clipboard copy failed. Your browser may block clipboard access.");
		}
	}
	function getExportRange() {
		const s = safeValue("exportStart");
		const e = safeValue("exportEnd");
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
		doc.setFont("helvetica", "bold"); doc.setFontSize(14);
		doc.text("Timesheet Export", margin, y); y += 20;
		doc.setFont("helvetica", "normal"); doc.setFontSize(10);

		const headers = ["Designer", "Date", "Start", "End", "Duration", "Task"];
		doc.text(headers.join("  |  "), margin, y); y += 14;
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

	// ======= SMART RANGES =======
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

	// ======= UI EVENTS (SAFE) =======
	function initEvents() {
		// Form
		on("entryForm", "submit", onSubmit);
		on("resetForm", "click", resetForm);

		// Filters
		on("filterDesigner", "change", triggerRender);
		on("filterWeek", "change", triggerRender);
		on("searchInput", "input", triggerRender);

		// View toggle
		on("toggleView", "click", () => {
			const btn = $("toggleView");
			const isTable = btn && btn.getAttribute("data-view") === "table";
			if (isTable) {
				if (elExists("tableView")) $("tableView").hidden = true;
				if (elExists("cardsView")) $("cardsView").hidden = false;
				if (btn) { btn.textContent = "Table View"; btn.setAttribute("data-view", "cards"); }
			} else {
				if (elExists("tableView")) $("tableView").hidden = false;
				if (elExists("cardsView")) $("cardsView").hidden = true;
				if (btn) { btn.textContent = "Cards View"; btn.setAttribute("data-view", "table"); }
			}
		});

		// Clear filters
		on("clearFilters", "click", () => {
			if (elExists("filterDesigner")) $("filterDesigner").value = "";
			if (elExists("filterWeek")) $("filterWeek").value = "";
			if (elExists("searchInput")) $("searchInput").value = "";
			if (elExists("exportStart")) $("exportStart").value = "";
			if (elExists("exportEnd")) $("exportEnd").value = "";
			triggerRender();
		});

		// Exports
		on("downloadExcel", "click", toExcel);
		on("downloadPdf", "click", toPdf);
		on("copyCsv", "click", () => {
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

		// Smart quick ranges (if present)
		document.querySelectorAll(".smart").forEach(btn => {
			btn.addEventListener("click", () => {
				const kind = btn.getAttribute("data-range");
				const r = getSmartRange(kind);
				if (!r) return;
				if (elExists("filterWeek")) $("filterWeek").value = "";
				if (elExists("searchInput")) $("searchInput").value = "";
				if (elExists("exportStart")) $("exportStart").value = new Date(r.startMs).toISOString().slice(0,10);
				if (elExists("exportEnd")) $("exportEnd").value = new Date(r.endMs).toISOString().slice(0,10);
				triggerRender();
			});
		});

		// Timer
		on("startTimer", "click", startTimer);
		on("stopTimer", "click", stopTimer);
	}

	// ======= INIT =======
	async function init() {
		await remoteLoadAll();
		await migrateLocalToJsonBinIfEmpty(); // optional
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
