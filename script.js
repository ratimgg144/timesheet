(function () {
	"use strict";

	console.log("Timesheet JS v10 (jsonbin + chat)");

	// ======= CONFIG =======
	const DESIGNERS = ["Rati", "Steven", "Cristian", "Santiago", "Andrea", "Valentina", "Megui"];

	// Simple client-side passwords (change as needed)
	const PASSWORDS_PLAIN = {
		"Rati": "Rati#2025",
		"Steven": "Steven#2025",
		"Cristian": "Cristian#2025",
		"Santiago": "Santiago#2025",
		"Andrea": "Andrea#2025",
		"Valentina": "Valentina#2025",
		"Megui": "Megui#2025"
	};

	// Old local keys only for optional fallback/migration
	const STORAGE_KEY = "timesheet_entries_v7_local";
	const TIMER_KEY = "timesheet_active_timer_v1_local";

	// ======= JSONBIN CONFIG =======
	const JSONBIN_BIN_ID = "68dea90943b1c97be9581d23";
	const JSONBIN_KEY = "$2a$10$BCr/smrghzHthU4HHCysDuyzqeijFau.xhq.R3rANk1Qdw1pVW2aS";
	const JSONBIN_BASE = "https://api.jsonbin.io/v3";

	// ======= SAFE DOM HELPERS =======
	function $(id) { return document.getElementById(id); }
	function on(id, event, handler) { const el = $(id); if (el) el.addEventListener(event, handler); }
	function safeValue(id) { const el = $(id); return (el && typeof el.value === "string") ? el.value : ""; }
	function elExists(id) { return !!$(id); }

	// ======= STATE =======
	let entries = [];
	let activeTimer = null;
	let timerInterval = null;

	// Chat state
	let chatMessages = []; // { id, designer, text, ts }
	let chatUser = null;   // string designer name
	let chatPollTimer = null;
	let chatLastRenderedId = null;

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
	function ensureJsPDFLoaded() { return Promise.resolve(!!window.jspdf || !!window.jspdf?.jsPDF || !!window.jsPDF); }

	// ======= JSONBIN CLIENT =======
	async function jsonbinGetLatest() {
		const url = `${JSONBIN_BASE}/b/${JSONBIN_BIN_ID}/latest?ts=${Date.now()}`;
		const res = await fetch(url, {
			method: "GET",
			cache: "no-store",
			headers: { "X-Master-Key": JSONBIN_KEY, "X-Bin-Meta": "false" }
		});
		if (!res.ok) throw new Error(`GET failed: ${res.status}`);
		return await res.json();
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
			try { return await fn(); } catch (e) { lastErr = e; await new Promise(r => setTimeout(r, 400)); }
		}
		throw lastErr;
	}

	// ======= LOCAL FALLBACK =======
	function localLoadEntries() {
		try { const raw = localStorage.getItem(STORAGE_KEY); if (!raw) return []; const p = JSON.parse(raw); return Array.isArray(p) ? p : []; } catch { return []; }
	}
	function localLoadActiveTimer() {
		try { const raw = localStorage.getItem(TIMER_KEY); return raw ? JSON.parse(raw) : null; } catch { return null; }
	}

	// ======= REMOTE LOAD/SAVE =======
	async function remoteLoadAll() {
		try {
			const data = await withRetry(() => jsonbinGetLatest());
			const safe = data && typeof data === "object" ? data : {};
			const loadedEntries = Array.isArray(safe.entries) ? safe.entries : [];
			const loadedTimer = safe.activeTimer && typeof safe.activeTimer === "object" ? safe.activeTimer : null;
			const loadedChat = Array.isArray(safe.chatMessages) ? safe.chatMessages : [];

			entries = loadedEntries.map(x => ({
				id: String(x.id),
				designer: String(x.designer || ""),
				task: String(x.task || ""),
				comments: String(x.comments || ""),
				mentions: Array.isArray(x.mentions) ? x.mentions : [],
				priority: ["Low","Medium","High"].includes(x.priority) ? x.priority : "Medium",
				status: ["To Do","In Progress","Done"].includes(x.status) ? x.status : "In Progress",
				tags: Array.isArray(x.tags) ? x.tags.map(String) : [],
				thread: Array.isArray(x.thread) ? x.thread.map(m => ({ id: String(m.id), designer: String(m.designer||""), text: String(m.text||""), ts: isFinite(m.ts)?Number(m.ts):Date.now() })) : [],
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

			chatMessages = loadedChat.map(m => ({
				id: String(m.id),
				designer: String(m.designer || ""),
				text: String(m.text || ""),
				ts: isFinite(m.ts) ? Number(m.ts) : Date.now()
			})).filter(m => m.designer && m.text);
		} catch (e) {
			console.warn("jsonbin load failed, using local fallback for timesheets:", e);
			entries = localLoadEntries();
			activeTimer = localLoadActiveTimer();
			chatMessages = []; // no offline fallback for chat
		}
	}

	function remoteSaveAllNow() {
		const payload = { entries, activeTimer, chatMessages };
		return withRetry(() => jsonbinPut(payload)).catch(err => console.error("jsonbin save failed:", err));
	}

	let saveDebounce;
	function remoteSaveAllDebounced() {
		clearTimeout(saveDebounce);
		saveDebounce = setTimeout(remoteSaveAllNow, 400);
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
	function formatDate(ms) { const d = new Date(ms); return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "2-digit" }); }
	function formatTime(ms) { const d = new Date(ms); return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }); }
	function formatDuration(ms) {
		if (!isFinite(ms) || ms < 0) return "—";
		const sec = Math.floor(ms / 1000);
		const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
		return [h, m, s].map(v => String(v).padStart(2, "0")).join(":");
	}
	function getWeekRangeFromInput(weekValue) {
		if (!weekValue) return null;
		const [yearStr, weekStr] = weekValue.split("-W");
		const year = parseInt(yearStr, 10), week = parseInt(weekStr, 10);
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

    // ======= FILTERS/RENDER BASIC =======
// Badge helpers
function badgeForPriority(p) {
        const span = document.createElement("span");
        span.className = "badge " + (p === "High" ? "priority-high" : p === "Low" ? "priority-low" : "priority-medium");
        span.textContent = p;
        return span;
}
function badgeForStatus(s) {
        const span = document.createElement("span");
        const key = (s || "").toLowerCase().replace(/\s+/g, "");
        span.className = "badge status-" + key;
        span.textContent = s;
        return span;
}

function applyFilters(data) {
		const designer = safeValue("filterDesigner");
		const weekValue = safeValue("filterWeek");
		const priority = safeValue("filterPriority");
		const status = safeValue("filterStatus");
		const q = safeValue("searchTasks").toLowerCase();

		let filtered = data;
		if (designer) filtered = filtered.filter(e => e.designer === designer);
		if (priority) filtered = filtered.filter(e => e.priority === priority);
		if (status) filtered = filtered.filter(e => e.status === status);

		const range = getWeekRangeFromInput(weekValue);
		if (range) filtered = filtered.filter(e => { const s = eStart(e); return s >= range.startMs && s <= range.endMs; });

		if (q) {
			filtered = filtered.filter(e => {
				const hay = `${e.designer} ${e.task} ${e.comments || ""} ${(e.tags||[]).map(t=>`#${t}`).join(" ")}`.toLowerCase();
				return hay.includes(q);
			});
		}

		filtered.sort((a, b) => eStart(b) - eStart(a));
		return filtered;
}

    function renderTable(data) {
		if (!elExists("entriesTbody") || !elExists("entryCount")) return;
		const tbody = $("entriesTbody"), countEl = $("entryCount");
		tbody.innerHTML = "";
		for (const e of data) {
			const tr = document.createElement("tr"); tr.setAttribute("data-designer", e.designer); tr.setAttribute("data-id", e.id);
			const start = eStart(e), end = eEnd(e), duration = isFinite(end - start) ? end - start : 0;

			const c = (t, cls)=>{ const td=document.createElement("td"); if (cls) td.className = cls; if (t instanceof Node) td.appendChild(t); else td.textContent=t; return td; };
			const tagsTd = document.createElement("td");
			for (const tag of (e.tags||[])) { const span = document.createElement("span"); span.className = "tag"; span.textContent = `#${tag}`; tagsTd.appendChild(span); }
			tagsTd.className = "cell-tags";
			const threadTd = document.createElement("td");
			const threadLink = document.createElement("span"); threadLink.className = "thread-link"; threadLink.textContent = `Open (${(e.thread||[]).length})`; threadLink.addEventListener("click", ()=> openThread(e.id)); threadTd.appendChild(threadLink);
            const pEl = badgeForPriority(e.priority || "Medium"); pEl.dataset.role = "priority";
            const sEl = badgeForStatus(e.status || "In Progress"); sEl.dataset.role = "status";
            tr.append(
                c(e.designer),
                c(pEl),
                c(sEl),
				c(formatDate(start || end)),
				c(start ? formatTime(start) : "—"),
				c(end ? formatTime(end) : "—"),
				c(formatDuration(duration)),
				c(e.task, "cell-task"),
				tagsTd,
				threadTd
			);
			tbody.appendChild(tr);
		}
		countEl.textContent = String(data.length);
	}

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
		const container = $("cardsContainer"); container.innerHTML = "";
		for (const e of data) {
			const start = eStart(e), end = eEnd(e), duration = isFinite(end - start) ? end - start : 0;
			const card = document.createElement("div"); card.className = "card-item";
			const col = colorForDesigner(e.designer); if (col) card.style.borderLeft = `4px solid ${col}`;

			const title = document.createElement("div"); title.style.fontWeight = "700"; title.textContent = e.task;
			const meta = document.createElement("div"); meta.className = "meta"; meta.innerHTML = `<span>${e.designer}</span><span>${formatDate(start || end)}</span>`;
			const badges = document.createElement("div"); badges.className = "meta"; badges.append(badgeForPriority(e.priority||"Medium"), badgeForStatus(e.status||"In Progress"));
			const tagsWrap = document.createElement("div"); for (const tag of (e.tags||[])) { const span = document.createElement("span"); span.className = "tag"; span.textContent = `#${tag}`; tagsWrap.appendChild(span); }
			const times = document.createElement("div"); times.className = "meta"; times.innerHTML = `<span>${start ? formatTime(start) : "—"} → ${end ? formatTime(end) : "—"}</span><span>${formatDuration(duration)}</span>`;
			const threadLink = document.createElement("div"); threadLink.className = "thread-link"; threadLink.textContent = `Open Thread (${(e.thread||[]).length})`; threadLink.addEventListener("click", ()=> openThread(e.id));
			card.append(title, meta, badges, tagsWrap, times, threadLink);
			container.appendChild(card);
		}
	}
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
		const container = $("dailySummary"); container.innerHTML = "";
		const datesSorted = Array.from(byDate.keys()).sort((a, b) => b.localeCompare(a));
		for (const day of datesSorted) {
			const card = document.createElement("div"); card.className = "summary-card";
			const h4 = document.createElement("h4"); const d = new Date(day + "T00:00:00");
			h4.textContent = d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "2-digit" });
			card.appendChild(h4);
			const map = byDate.get(day); const designersSorted = DESIGNERS.filter(n => map.has(n));
			for (const name of designersSorted) {
				const row = document.createElement("div"); row.className = "summary-row";
				const v = map.get(name);
				row.innerHTML = `<span style="border-left:4px solid ${colorForDesigner(name)}; padding-left:8px">${name}</span><span>${v.tasks} tasks • ${formatDuration(v.duration)}</span>`;
				card.appendChild(row);
			}
			container.appendChild(card);
		}
	}
	function renderFeed(allData) {
		// optional in your current layout; safe no-op
	}

	function triggerRender() {
		const filtered = applyFilters(entries);
		renderTable(filtered);
		renderCards(filtered);
		renderSummary(filtered);
		renderChat();
		wireInlineEditing();
	}

// Inline editing for table: edit task text; click badges to cycle; click tags cell to edit
function wireInlineEditing() {
		const tbody = $("entriesTbody"); if (!tbody) return;
		for (const tr of tbody.querySelectorAll("tr")) {
			const id = tr.getAttribute("data-id");
			const entry = entries.find(e => e.id === id); if (!entry) continue;
			// Task cell inline edit on double click
			const taskCell = tr.querySelector(".cell-task");
			if (taskCell && !taskCell.dataset.bound) {
				taskCell.dataset.bound = "1";
				taskCell.addEventListener("dblclick", () => {
					const current = entry.task;
					const input = document.createElement("input"); input.type = "text"; input.value = current; input.style.width = "100%";
					taskCell.innerHTML = ""; taskCell.appendChild(input); input.focus();
					const commit = () => { entry.task = input.value.trim() || current; triggerRender(); remoteSaveAllDebounced(); };
					input.addEventListener("blur", commit);
					input.addEventListener("keydown", e => { if (e.key === "Enter") commit(); if (e.key === "Escape") triggerRender(); });
				});
			}
			// Priority/status badge click to cycle
			const cycle = (list, value) => list[(list.indexOf(value)+1)%list.length];
			const pBadge = tr.querySelector('[data-role="priority"]');
			if (pBadge && !pBadge.dataset.bound) {
				pBadge.dataset.bound = "1";
				pBadge.addEventListener("click", () => { entry.priority = cycle(["Low","Medium","High"], entry.priority||"Medium"); triggerRender(); remoteSaveAllDebounced(); });
			}
			const sBadge = tr.querySelector('[data-role="status"]');
			if (sBadge && !sBadge.dataset.bound) {
				sBadge.dataset.bound = "1";
				sBadge.addEventListener("click", () => { entry.status = cycle(["To Do","In Progress","Done"], entry.status||"In Progress"); triggerRender(); remoteSaveAllDebounced(); });
			}
			// Tags edit on double click
			const tagsCell = tr.querySelector('.cell-tags');
			if (tagsCell && !tagsCell.dataset.bound) {
				tagsCell.dataset.bound = "1";
				tagsCell.addEventListener("dblclick", () => {
					const current = (entry.tags||[]).join(", ");
					const input = document.createElement("input"); input.type = "text"; input.value = current; input.style.width = "100%";
					tagsCell.innerHTML = ""; tagsCell.appendChild(input); input.focus();
					const commit = () => { entry.tags = input.value.split(',').map(s=>s.trim().replace(/^#/,'')).filter(Boolean); triggerRender(); remoteSaveAllDebounced(); };
					input.addEventListener("blur", commit);
					input.addEventListener("keydown", e => { if (e.key === "Enter") commit(); if (e.key === "Escape") triggerRender(); });
				});
			}
		}
}

// ======= THREADS PER TASK =======
let openThreadTaskId = null;
function openThread(taskId) {
        openThreadTaskId = taskId;
        const e = entries.find(x => x.id === taskId);
        if (!e) return;
        if (elExists("threadPanel")) {
                $("threadPanel").hidden = false;
                $("threadMeta").textContent = `${e.designer} • ${e.task}`;
                renderThreadMessages(e);
        }
}
function closeThread() { if (elExists("threadPanel")) $("threadPanel").hidden = true; openThreadTaskId = null; }
function renderThreadMessages(e) {
        const box = $("threadMessages"); if (!box) return;
        box.innerHTML = "";
        for (const m of (e.thread||[]).sort((a,b)=>a.ts-b.ts)) {
                const meta = document.createElement("div"); meta.className = "chat-meta"; meta.textContent = `${m.designer} • ${new Date(m.ts).toLocaleString()}`;
                const msg = document.createElement("div"); msg.className = "chat-msg"; if (chatUser && chatUser === m.designer) msg.classList.add("me"); msg.textContent = m.text;
                const item = document.createElement("div"); item.append(meta, msg); box.appendChild(item);
        }
        box.scrollTop = box.scrollHeight;
}
function addThreadComment() {
        if (!openThreadTaskId) return;
        const e = entries.find(x => x.id === openThreadTaskId);
        if (!e) return;
        const text = safeValue("threadInput").trim(); if (!text) return;
        const who = chatUser || safeValue("chatDesigner") || "Anon";
        const m = { id: cryptoRandomId(), designer: who, text, ts: Date.now() };
        e.thread = Array.isArray(e.thread) ? e.thread : [];
        e.thread.push(m);
        if (elExists("threadInput")) $("threadInput").value = "";
        renderThreadMessages(e);
        remoteSaveAllDebounced();
}

	// ======= FORM HANDLERS =======
	function parseManualDateTime(dateStr, timeStr) {
		if (!dateStr || !timeStr) return null;
		const [y, m, d] = dateStr.split("-").map(n => parseInt(n, 10));
		const [hh, mm] = timeStr.split(":").map(n => parseInt(n, 10));
		const dt = new Date(); dt.setFullYear(y, m - 1, d); dt.setHours(hh, mm, 0, 0); return dt.getTime();
	}
	function resetForm() {
		if (!elExists("entryForm")) return;
		$("designer").value = "";
		$("task").value = "";
		// reset chips
		const pc = $("priorityChips"); if (pc) { for (const el of pc.querySelectorAll('.chip')) el.classList.remove('selected'); const low = pc.querySelector('[data-value="Low"]'); if (low) low.classList.add('selected'); }
		const sc = $("statusChips"); if (sc) { for (const el of sc.querySelectorAll('.chip')) el.classList.remove('selected'); const ip = sc.querySelector('[data-value="In Progress"]'); if (ip) ip.classList.add('selected'); }
		$("manualDate").value = "";
		$("startTime").value = "";
		$("endTime").value = "";
		if (elExists("tags")) $("tags").value = "";
	}
	function onSubmit(ev) {
		ev.preventDefault();
		const designer = safeValue("designer");
		const task = safeValue("task").trim();
		// read chips
		let priority = "Medium"; const pc = $("priorityChips"); const selP = pc ? pc.querySelector('.chip.selected') : null; if (selP) priority = selP.getAttribute('data-value') || "Medium";
		let status = "In Progress"; const sc = $("statusChips"); const selS = sc ? sc.querySelector('.chip.selected') : null; if (selS) status = selS.getAttribute('data-value') || "In Progress";
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

		entries.push({ id: cryptoRandomId(), designer, task, comments: "", mentions: [], priority, status, tags: (safeValue('tags')||'').split(',').map(s=>s.trim().replace(/^#/,'')).filter(Boolean), thread: [], startMs, endMs });
		remoteSaveAllNow();
		resetForm();
		triggerRender();
	}

	// ======= TIMER =======
	function startTimer() {
		const designer = safeValue("timerDesigner");
		const task = safeValue("timerTask").trim();
		if (!designer || !task) return;
		activeTimer = { id: cryptoRandomId(), designer, task, comments: "", mentions: [], priority: "Medium", status: "In Progress", tags: [], thread: [], startMs: Date.now() };
		remoteSaveAllNow();
		updateTimerButtons();
		runTimerTick();
		timerInterval = setInterval(runTimerTick, 1000);
	}
	function stopTimer() {
		if (!activeTimer) return;
		const endMs = Date.now();
		entries.push({ ...activeTimer, endMs });
		activeTimer = null;
		remoteSaveAllNow();
		if (timerInterval) clearInterval(timerInterval);
		if (elExists("timerStatus")) $("timerStatus").textContent = "00:00:00";
		updateTimerButtons();
		triggerRender();
	}
	function runTimerTick() { if (!activeTimer || !elExists("timerStatus")) return; $("timerStatus").textContent = formatDuration(Date.now() - activeTimer.startMs); }
	function updateTimerButtons() {
		if (!elExists("startTimer") || !elExists("stopTimer")) return;
		$("startTimer").disabled = !!activeTimer;
		$("stopTimer").disabled = !activeTimer;
	}

	// ======= CHAT =======
	function renderChat() {
		if (!elExists("chatLogin") || !elExists("chatPanel")) return;
		if (chatUser) {
			$("chatLogin").hidden = true;
			$("chatPanel").hidden = false;
			$("chatMe").textContent = `You are logged in as ${chatUser}`;
		} else {
			$("chatLogin").hidden = false;
			$("chatPanel").hidden = true;
		}
		if (chatUser) renderChatMessages();
	}
	function renderChatMessages() {
		const box = $("chatMessages");
		box.innerHTML = "";
		// Sort by timestamp descending (newest first) then reverse to show newest at bottom
		for (const m of chatMessages.sort((a,b)=>b.ts-a.ts).reverse()) {
			const wrap = document.createElement("div");
			const meta = document.createElement("div"); meta.className = "chat-meta";
			meta.textContent = `${m.designer} • ${new Date(m.ts).toLocaleTimeString()}`;
			const msg = document.createElement("div"); msg.className = "chat-msg"; if (chatUser === m.designer) msg.classList.add("me");
			msg.textContent = m.text;
			const item = document.createElement("div");
			item.append(meta, msg);
			box.appendChild(item);
			chatLastRenderedId = m.id;
		}
		box.scrollTop = box.scrollHeight;
	}
	function chatLogin() {
		const who = safeValue("chatDesigner");
		const pw = safeValue("chatPassword");
		if (!who || !pw) { alert("Select your name and enter password."); return; }
		const expected = PASSWORDS_PLAIN[who];
		if (!expected || pw !== expected) { alert("Incorrect password."); return; }
		chatUser = who;
		$("chatPassword").value = "";
		renderChat();
		if (!chatPollTimer) chatPollTimer = setInterval(refreshChatFromRemote, 4000);
	}
	function chatLogout() {
		chatUser = null;
		renderChat();
	}
	function chatSend() {
		if (!chatUser) { alert("Please login to chat."); return; }
		const text = safeValue("chatInput").trim();
		if (!text) return;
		const msg = { id: cryptoRandomId(), designer: chatUser, text, ts: Date.now() };
		chatMessages.push(msg);
		$("chatInput").value = "";
		renderChatMessages();
		remoteSaveAllDebounced();
	}
	async function refreshChatFromRemote() {
		try {
			const data = await withRetry(() => jsonbinGetLatest());
			const loadedChat = Array.isArray(data.chatMessages) ? data.chatMessages : [];
			// Only update if there are new messages
			if (loadedChat.length !== chatMessages.length) {
				chatMessages = loadedChat.map(m => ({
					id: String(m.id),
					designer: String(m.designer || ""),
					text: String(m.text || ""),
					ts: isFinite(m.ts) ? Number(m.ts) : Date.now()
				})).filter(m => m.designer && m.text);
				renderChatMessages();
			}
		} catch (e) {
			console.warn("Chat poll failed:", e);
		}
	}

	// ======= EXPORT =======
	function downloadBlob(blob, filename) {
		const url = URL.createObjectURL(blob);
		const a = document.createElement("a");
		a.href = url; a.download = filename;
		document.body.appendChild(a); a.click(); a.remove();
		URL.revokeObjectURL(url);
	}
	function exportCSV(rows, filename) {
		const headers = Object.keys(rows[0] || { Designer:"", Date:"", Start:"", End:"", Duration:"", Task:"" });
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
	function getExportRange() {
		// Your current HTML doesn't include export range inputs; keep simple
		return null;
	}
	function getFilteredForExport() {
		const base = applyFilters(entries);
		const range = getExportRange();
		if (!range) return base;
		return base.filter(e => { const t = eStart(e); return t >= range.startMs && t <= range.endMs; });
	}
	async function toExcel() {
		const data = getFilteredForExport();
		if (data.length === 0) { alert("No data to export."); return; }
		const rows = data.map(e => {
			const start = eStart(e), end = eEnd(e);
			return {
				Designer: e.designer,
				Priority: e.priority || "Medium",
				Status: e.status || "In Progress",
				Date: new Date(start || end).toISOString().slice(0, 10),
				Start: start ? new Date(start).toLocaleTimeString() : "",
				End: end ? new Date(end).toLocaleTimeString() : "",
				Duration: formatDuration((end || 0) - (start || 0)),
				Task: e.task,
				Tags: (e.tags||[]).map(t=>`#${t}`).join(" ")
			};
		});
		const ok = await ensureSheetJSLoaded();
		if (ok && window.XLSX) {
			try {
				const ws = XLSX.utils.json_to_sheet(rows);
				ws["!cols"] = [{ wch: 12 }, { wch: 10 }, { wch: 12 }, { wch: 12 }, { wch: 10 }, { wch: 10 }, { wch: 10 }, { wch: 50 }];
				const wb = XLSX.utils.book_new();
				XLSX.utils.book_append_sheet(wb, ws, "Timesheet");
				const out = XLSX.write(wb, { type: "array", bookType: "xlsx" });
				downloadBlob(new Blob([out], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), "timesheet.xlsx");
				return;
			} catch (err) { console.error("XLSX export failed:", err); }
		}
		exportCSV(rows, "timesheet.csv");
	}

	// ======= UI EVENTS =======
	function initEvents() {
		on("entryForm", "submit", onSubmit);
		// chip interactions
		const pc = $("priorityChips"); if (pc) pc.addEventListener('click', (e) => { const t = e.target.closest('.chip'); if (!t) return; for (const el of pc.querySelectorAll('.chip')) el.classList.remove('selected'); t.classList.add('selected'); });
		const sc = $("statusChips"); if (sc) sc.addEventListener('click', (e) => { const t = e.target.closest('.chip'); if (!t) return; for (const el of sc.querySelectorAll('.chip')) el.classList.remove('selected'); t.classList.add('selected'); });

		on("filterDesigner", "change", triggerRender);
		on("filterWeek", "change", triggerRender);
	if (elExists("filterPriority")) on("filterPriority", "change", triggerRender);
	if (elExists("filterStatus")) on("filterStatus", "change", triggerRender);
	const searchEl = $("searchTasks"); if (searchEl) searchEl.addEventListener("input", triggerRender);

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
		on("clearFilters", "click", () => {
			if (elExists("filterDesigner")) $("filterDesigner").value = "";
			if (elExists("filterWeek")) $("filterWeek").value = "";
			if (elExists("filterPriority")) $("filterPriority").value = "";
			if (elExists("filterStatus")) $("filterStatus").value = "";
			if (elExists("searchTasks")) $("searchTasks").value = "";
			triggerRender();
		});
		on("downloadExcel", "click", toExcel);

		// Chat
		on("chatLoginBtn", "click", chatLogin);
		on("chatLogoutBtn", "click", chatLogout);
		on("chatSendBtn", "click", chatSend);
		const input = $("chatInput");
		if (input) input.addEventListener("keydown", (e) => { if (e.key === "Enter") chatSend(); });

		// Timer
		on("startTimer", "click", startTimer);
		on("stopTimer", "click", stopTimer);

		// Threads
		on("threadSendBtn", "click", addThreadComment);
		on("threadCloseBtn", "click", closeThread);

		// Theme
	on("toggleTheme", "click", toggleTheme);
	}

// ======= THEME =======
function toggleTheme() {
	const root = document.documentElement;
	const isLight = root.getAttribute("data-theme") === "light";
	if (isLight) root.removeAttribute("data-theme"); else root.setAttribute("data-theme", "light");
	try { localStorage.setItem("timesheet_theme", isLight ? "dark" : "light"); } catch {}
}

// ======= INIT =======
	async function init() {
		await remoteLoadAll();
		initEvents();
		// Theme
		(function(){ let t = "dark"; try { t = localStorage.getItem("timesheet_theme") || "dark"; } catch {} if (t === "light") document.documentElement.setAttribute("data-theme","light"); })();
		updateTimerButtons();
		if (activeTimer) { runTimerTick(); timerInterval = setInterval(runTimerTick, 1000); }
		triggerRender();
		// start chat polling if someone logs in later; otherwise polling begins on login
	}

	if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
	else init();
})();
