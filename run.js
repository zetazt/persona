// ==UserScript==
// @name         Zeta Persona Quick Editor
// @namespace    zeta-persona-editor
// @version      1.4.5
// @description  현재 방의 유저 페르소나를 자동으로 불러와서, 페이지 이동 없이 바로 수정/자동저장하는 미니 에디터
// @match        https://zeta-ai.io/*
// @match        https://*.zeta-ai.io/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(() => {

    "use strict";

    if (window.__ZETA_PERSONA_EDITOR_RUNNING__) {
        console.log("🩶 Zeta Persona Editor already running.");
        return;
    }
    window.__ZETA_PERSONA_EDITOR_RUNNING__ = true;

    const VERSION = "1.4.5";

    const PROFILES_LIST_RE = /\/v1\/user-chat-profiles(?:\?|$)/;
    const PLOT_ROOM_RE = /\/plots\/([^/]+)\/rooms\/([^/]+)\//;
    const PLOTID_QUERY_RE = /[?&]plotId=([^&]+)/;
    const PROFILE_PATCH_URL = (id) => `https://api.zeta-ai.io/v1/user-chat-profiles/${id}`;
    const PLOT_URL = (id) => `https://api.zeta-ai.io/v1/plots/${id}`;
    const PLOT_CREATOR_URL = (id) => `https://api.zeta-ai.io/v1/plots/${id}/creator`;

    let mode = "persona"; // "persona" | "plot"
    let plotData = null;          // /creator 전체 응답 (draft 포함) 캐시
    let activePlotTargetKey = null;

    const POS_KEY = "zeta-persona-editor-pos";
    const AUTOSAVE_KEY = "zeta-persona-editor-autosave";

    function getAutosaveEnabled() {
        const v = localStorage.getItem(AUTOSAVE_KEY);
        return v === null ? true : v === "1";
    }

    function setAutosaveEnabled(on) {
        localStorage.setItem(AUTOSAVE_KEY, on ? "1" : "0");
    }

    function getPos() {
        try {
            return JSON.parse(localStorage.getItem(POS_KEY)) || { left: 16, bottom: 80 };
        } catch {
            return { left: 16, bottom: 80 };
        }
    }

    function savePos(pos) {
        localStorage.setItem(POS_KEY, JSON.stringify(pos));
    }

    function currentRoomId() {
        return location.pathname.split("/").pop();
    }

    let roomId = currentRoomId();

    function plotIdKey(id) {
        return `zeta-persona-editor-plotid-${id}`;
    }

    function getCachedPlotId(id) {
        return localStorage.getItem(plotIdKey(id));
    }

    function setCachedPlotId(id, plotId) {
        localStorage.setItem(plotIdKey(id), plotId);
    }

    let capturedAuth = null;
    let lastPlotId = getCachedPlotId(roomId);
    let personaList = [];
    let activePersonaId = null;

    function sniffOutgoingUrl(url) {
        if (!url) return;
        const m = PLOT_ROOM_RE.exec(url);
        if (m && m[2] === roomId) {
            lastPlotId = m[1];
            setCachedPlotId(roomId, m[1]);
        }
    }

    function extractAuthFromHeaders(headers) {
        if (!headers) return null;
        try {
            if (typeof headers.get === "function") {
                return headers.get("authorization") || headers.get("Authorization");
            }
            if (Array.isArray(headers)) {
                for (const pair of headers) {
                    if (pair && pair[0] && pair[0].toLowerCase() === "authorization") return pair[1];
                }
                return null;
            }
            for (const k in headers) {
                if (k.toLowerCase() === "authorization") return headers[k];
            }
        } catch { /* ignore */ }
        return null;
    }

    function handlePossiblePersonaListResponse(url, text, atRoomId) {
        try {
            const qm = PLOTID_QUERY_RE.exec(url || "");
            const urlPlotId = qm ? decodeURIComponent(qm[1]) : null;
            const knownPlotId = getCachedPlotId(atRoomId);

            if (!knownPlotId || !urlPlotId || urlPlotId !== knownPlotId) return;
            if (atRoomId !== roomId) return;

            const data = JSON.parse(text);
            const list = data && data.userChatProfiles;
            if (!Array.isArray(list)) return;

            personaList = list;
            const sel = list.find(p => p && p.selected);
            if (sel && sel.id && !userPickedManually) {
                loadPersonaIntoEditor(sel.id);
            }
            rebuildPersonaDropdown();
            console.log("🩶 PersonaEditor: 목록 감지됨", atRoomId, list.length + "개");
        } catch { /* ignore */ }
    }

    const host = document.createElement("div");
    host.id = "zeta-persona-editor-host";
    document.documentElement.appendChild(host);
    const root = host.attachShadow({ mode: "open" });

    root.innerHTML = `
<style>
  :host {
    all: initial;
    position: fixed !important;
    top: 0; left: 0;
    z-index: 2147483647 !important;
  }
  * { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }

  #btn {
    position: fixed;
    width: 32px; height: 32px; border-radius: 50%;
    background: #6b6f76; color: #fff;
    display: flex; align-items: center; justify-content: center;
    cursor: pointer;
    box-shadow: 0 3px 12px rgba(0,0,0,.5);
    border: 2px solid #fff;
    touch-action: none;
    user-select: none;
    -webkit-user-select: none;
    -webkit-touch-callout: none;
  }
  #btn svg { width: 15px; height: 15px; pointer-events: none; }
  #btn.dragging { opacity: 0.7; }
  #btn .dot {
    position: absolute; top: -2px; right: -2px;
    width: 8px; height: 8px; border-radius: 50%;
    border: 1.5px solid #17171c;
    display: none;
  }
  #btn.ready .dot { display: block; background: #9aa0a8; }
  #btn.no-auth .dot { display: block; background: #c98a4b; }

  #panel {
    position: fixed;
    width: 290px; max-height: 74vh; overflow-y: auto;
    background: #232427; color: #eee;
    border: 1px solid #6b6f76; border-radius: 12px;
    padding: 12px; font-size: 12px; line-height: 1.5;
    box-shadow: 0 6px 24px rgba(0,0,0,.6);
    display: none;
  }
  #panel.open { display: block; }

  select {
    width: 100%; background: #17181a; color: #fff;
    border: 1px solid #555; border-radius: 8px; padding: 7px 8px;
    font-size: 12px; margin-top: 6px;
  }

  textarea {
    width: 100%; height: 30vh; background: #17181a; color: #fff;
    border: 1px solid #444; border-radius: 8px; padding: 8px;
    font-size: 12px; resize: vertical; margin-top: 8px;
  }

  .row { display: flex; gap: 6px; margin-top: 8px; align-items: center; }
  button {
    background: #3a3b3e; color: #fff; border: none; border-radius: 8px;
    padding: 7px 6px; font-size: 11px; cursor: pointer; flex: 1;
  }
  button.primary { background: #6b6f76; }
  button.mode-btn.active { background: #8a8f98; font-weight: bold; }

  .title { font-weight: bold; font-size: 13px; margin-bottom: 4px; display: flex; justify-content: space-between; align-items: center; }
  .room { color: #999; font-size: 10px; margin-bottom: 8px; word-break: break-all; }
  .status { font-size: 10px; color: #ccc; background: #17181a; border: 1px solid #3a3b3e; border-radius: 8px; padding: 6px 8px; margin-bottom: 4px; word-break: break-all; }
  .status.ok { border-color: #4a5a4a; color: #9fd39f; }
  .status.bad { border-color: #6b4a2f; color: #ffb347; }

  .count-row { display:flex; justify-content:space-between; align-items:center; font-size: 10px; color:#999; margin-top:4px; }

  .error-detail {
    display: none;
    font-family: monospace;
    font-size: 10px; line-height: 1.4; color: #ff8a8a;
    background: #2a1717; border: 1px solid #5a2f2f; border-radius: 8px;
    padding: 6px 8px; margin-top: 6px; word-break: break-all; white-space: pre-wrap;
  }
  .error-detail.show { display: block; }
  .save-state { font-size: 10px; white-space: nowrap; }
  .save-state.saving { color: #ffb347; }
  .save-state.saved { color: #9fd39f; }
  .save-state.error { color: #ff6b6b; }
  .save-state.idle { color: #777; }

  hr { border: none; border-top: 1px solid #3a3b3e; margin: 10px 0; }
</style>

<div id="btn"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg><span class="dot"></span></div>
<div id="panel">
  <div class="title">
    <span>Persona Editor</span>
    <span style="font-weight:normal;font-size:10px;color:#999;">v${VERSION}</span>
  </div>
  <div class="room" id="room"></div>

  <div class="row" style="margin-top:0;">
    <button class="mode-btn active" id="mode-persona">{{user}}</button>
    <button class="mode-btn" id="mode-plot">{{char}}</button>
  </div>

  <div class="status" id="status" style="margin-top:8px;">감지 중...</div>

  <select id="target-select"><option>불러오는 중...</option></select>

  <textarea id="desc" placeholder="페르소나 description이 여기 자동으로 채워집니다."></textarea>

  <div class="count-row">
    <span id="count">0자</span>
    <span class="save-state idle" id="save-state">대기중</span>
  </div>

  <div class="error-detail" id="error-detail"></div>

  <div class="row">
    <label style="flex:1;display:flex;align-items:center;gap:6px;font-size:11px;color:#ccc;">
      <input type="checkbox" id="autosave-toggle"> 자동저장
    </label>
    <button class="primary" id="manual-save">저장</button>
  </div>

  <div class="row">
    <button id="refresh">새로고침</button>
  </div>

  <hr>

  <div class="row">
    <button id="reset-pos">버튼 위치 초기화</button>
  </div>
</div>
`;

    const el = (id) => root.getElementById(id);

    const btnEl = el("btn");
    const panelEl = el("panel");
    const roomEl = el("room");
    const statusEl = el("status");
    const selectEl = el("target-select");
    const descEl = el("desc");
    const countEl = el("count");
    const saveStateEl = el("save-state");
    const errorDetailEl = el("error-detail");
    const autosaveToggleEl = el("autosave-toggle");
    const manualSaveBtn = el("manual-save");
    const modePersonaBtn = el("mode-persona");
    const modePlotBtn = el("mode-plot");

    const BTN_SIZE = 32;
    const BTN_MARGIN = 4;

    function applyPos(pos) {
        btnEl.style.left = pos.left + "px";
        btnEl.style.bottom = pos.bottom + "px";
        panelEl.style.left = pos.left + "px";
        panelEl.style.bottom = (pos.bottom + BTN_SIZE + 10) + "px";
    }

    applyPos(getPos());

    function updateCount() {
        countEl.textContent = `${descEl.value.length.toLocaleString()}자`;
    }

    function setSaveState(state, label) {
        saveStateEl.className = "save-state " + state;
        saveStateEl.textContent = label;
    }

    function showErrorDetail(text) {
        errorDetailEl.textContent = text;
        errorDetailEl.classList.add("show");
    }

    function clearErrorDetail() {
        errorDetailEl.textContent = "";
        errorDetailEl.classList.remove("show");
    }

    // plotData는 /creator 응답 전체. 실제 편집 대상은 plotData.draft 안에 있음.
    function getDraft(obj) {
        return obj && obj.draft ? obj.draft : null;
    }

    function updateStatus() {
        if (!capturedAuth) {
            statusEl.className = "status bad";
            statusEl.textContent = "⚠ 인증 토큰 아직 못 잡음 (사이트 조작 한번 해보세요)";
        } else if (!lastPlotId) {
            statusEl.className = "status bad";
            statusEl.textContent = "⚠ 이 방의 plotId 못 잡음 (새로고침 해보세요)";
        } else if (mode === "persona") {
            if (personaList.length === 0) {
                statusEl.className = "status bad";
                statusEl.textContent = "⚠ 페르소나 목록 아직 못 잡음 → '새로고침' 눌러주세요";
            } else {
                statusEl.className = "status ok";
                statusEl.textContent = `✅ 페르소나 ${personaList.length}개 로드됨`;
            }
        } else {
            const draft = getDraft(plotData);
            if (!draft) {
                statusEl.className = "status bad";
                statusEl.textContent = "⚠ {{char}} 상세 아직 못 불러옴 → '새로고침' 눌러주세요";
            } else {
                const total = getPlotTargets(draft).reduce((sum, t) => {
                    const len = t.key === activePlotTargetKey ? descEl.value.length : t.get(draft).length;
                    return sum + len;
                }, 0);
                statusEl.className = "status ok";
                statusEl.textContent = `✅ ${draft.name || "(이름없음)"} 상세 로드됨 · 합계 ${total}자 (기본+나레+캐릭)`;
            }
        }
        btnEl.classList.toggle("no-auth", !capturedAuth);
        btnEl.classList.toggle("ready", !!(capturedAuth && (mode === "persona" ? personaList.length : getDraft(plotData))));
    }

    function rebuildPersonaDropdown() {
        selectEl.innerHTML = "";
        personaList.forEach(p => {
            const opt = document.createElement("option");
            opt.value = p.id;
            opt.textContent = `${p.name || "(이름없음)"} — ${(p.description || "").slice(0, 12)}${p.selected ? " ★" : ""}`;
            if (p.id === activePersonaId) opt.selected = true;
            selectEl.appendChild(opt);
        });
        updateStatus();
    }

    let userPickedManually = false;

    function loadPersonaIntoEditor(id) {
        const p = personaList.find(x => x.id === id);
        if (!p) return;
        activePersonaId = id;
        descEl.value = p.description || "";
        updateCount();
        setSaveState("idle", "대기중"); clearErrorDetail();
        rebuildPersonaDropdown();
    }

    //------------------------------------------
    // {{char}} 상세(plot) 모드 — draft 객체 기준으로 동작
    //------------------------------------------

    function getPlotTargets(draft) {
        if (!draft) return [];
        const targets = [
            { key: "longDescription", label: "📘 기본설정 (longDescription)", get: o => o.longDescription || "", set: (o, v) => { o.longDescription = v; } },
            { key: "narrator", label: "🗣 나레이터 설정 (narrator)", get: o => o.narrator || "", set: (o, v) => { o.narrator = v; } }
        ];
        (draft.characters || []).forEach(c => {
            targets.push({
                key: "char:" + c.id,
                label: `👤 {{char}}: ${c.name || "(이름없음)"}`,
                get: o => (o.characters.find(x => x.id === c.id) || {}).description || "",
                set: (o, v) => { const t = o.characters.find(x => x.id === c.id); if (t) t.description = v; }
            });
        });
        return targets;
    }

    function rebuildPlotDropdown() {
        const draft = getDraft(plotData);
        selectEl.innerHTML = "";
        getPlotTargets(draft).forEach(t => {
            const opt = document.createElement("option");
            opt.value = t.key;
            opt.textContent = `${t.label} (${t.get(draft).length}자)`;
            if (t.key === activePlotTargetKey) opt.selected = true;
            selectEl.appendChild(opt);
        });
        updateStatus();
    }

    function loadPlotTargetIntoEditor(key) {
        const draft = getDraft(plotData);
        const target = getPlotTargets(draft).find(t => t.key === key);
        if (!target) return;
        activePlotTargetKey = key;
        descEl.value = target.get(draft);
        updateCount();
        setSaveState("idle", "대기중"); clearErrorDetail();
        rebuildPlotDropdown();
    }

    async function fetchPlotFresh() {
        if (!capturedAuth || !lastPlotId) return null;
        try {
            const res = await originalFetch(PLOT_CREATOR_URL(lastPlotId), {
                headers: { "Authorization": capturedAuth }
            });
            if (!res.ok) return null;
            return await res.json();
        } catch {
            return null;
        }
    }

    async function refreshPlotData(preserveTarget) {
        const fresh = await fetchPlotFresh();
        if (!fresh || !fresh.draft) {
            setSaveState("error", "불러오기 실패 ❌");
            return false;
        }
        plotData = fresh;
        const targets = getPlotTargets(fresh.draft);
        if (preserveTarget && targets.find(t => t.key === activePlotTargetKey)) {
            loadPlotTargetIntoEditor(activePlotTargetKey);
        } else if (targets.length) {
            loadPlotTargetIntoEditor(targets[0].key);
        }
        updateStatus();
        return true;
    }

    function refreshRoomUI() {
        roomEl.textContent = `Room: ${roomId.slice(0, 24)}`;
        updateStatus();
    }

    autosaveToggleEl.checked = getAutosaveEnabled();
    refreshRoomUI();

    let dragging = false;
    let moved = false;
    let startX = 0, startY = 0;
    let startPos = null;

    function pointFromEvent(e) {
        if (e.touches && e.touches[0]) return { x: e.touches[0].clientX, y: e.touches[0].clientY };
        return { x: e.clientX, y: e.clientY };
    }

    function onDragStart(e) {
        dragging = true;
        moved = false;
        const p = pointFromEvent(e);
        startX = p.x;
        startY = p.y;
        startPos = getPos();
        btnEl.classList.add("dragging");
    }

    function onDragMove(e) {
        if (!dragging) return;
        const p = pointFromEvent(e);
        const dx = p.x - startX;
        const dy = p.y - startY;

        if (Math.abs(dx) > 6 || Math.abs(dy) > 6) moved = true;
        if (!moved) return;

        const newLeft = Math.min(Math.max(startPos.left + dx, 4), window.innerWidth - (BTN_SIZE + BTN_MARGIN));
        const newBottom = Math.min(Math.max(startPos.bottom - dy, 4), window.innerHeight - (BTN_SIZE + BTN_MARGIN));

        applyPos({ left: newLeft, bottom: newBottom });
    }

    function onDragEnd(e) {
        if (!dragging) return;
        dragging = false;
        btnEl.classList.remove("dragging");

        if (e && e.type === "touchend") e.preventDefault();

        if (moved) {
            savePos({
                left: parseFloat(btnEl.style.left) || 16,
                bottom: parseFloat(btnEl.style.bottom) || 80
            });
        } else {
            setPanelOpen(!panelEl.classList.contains("open"));
        }
    }

    const supportsTouch = ("ontouchstart" in window) || navigator.maxTouchPoints > 0;

    if (supportsTouch) {
        btnEl.addEventListener("touchstart", onDragStart, { passive: true });
        window.addEventListener("touchmove", onDragMove, { passive: true });
        window.addEventListener("touchend", onDragEnd, { passive: false });
        window.addEventListener("touchcancel", () => { dragging = false; btnEl.classList.remove("dragging"); });
    } else {
        btnEl.addEventListener("mousedown", onDragStart);
        window.addEventListener("mousemove", onDragMove);
        window.addEventListener("mouseup", onDragEnd);
    }

    function setPanelOpen(open) {
        panelEl.classList.toggle("open", open);
        if (open) refreshRoomUI();
    }

    document.addEventListener("click", (e) => {
        if (!panelEl.classList.contains("open")) return;
        if (host.contains(e.target) || (e.composedPath && e.composedPath().includes(host))) return;
        setPanelOpen(false);
    }, true);

    document.addEventListener("keydown", (e) => {
        if (e.key === "Escape" && panelEl.classList.contains("open")) setPanelOpen(false);
    });

    let saveDebounce = null;
    let saveInFlight = false;
    let saveQueued = false;

    async function doAutoSave() {
        if (mode === "persona") return doAutoSavePersona();
        return doAutoSavePlot();
    }

    async function doAutoSavePersona() {
        if (!activePersonaId) return;
        if (!capturedAuth) {
            setSaveState("error", "인증 없음 ❌");
            return;
        }
        if (saveInFlight) {
            saveQueued = true;
            return;
        }
        saveInFlight = true;
        setSaveState("saving", "저장 중...");
        clearErrorDetail();

        const persona = personaList.find(p => p.id === activePersonaId);
        const newDesc = descEl.value;

        try {
            const res = await originalFetch(PROFILE_PATCH_URL(activePersonaId), {
                method: "PATCH",
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": capturedAuth
                },
                body: JSON.stringify({ name: persona ? persona.name : undefined, description: newDesc })
            });

            if (res.ok) {
                if (persona) persona.description = newDesc;
                setSaveState("saved", "저장됨 ✅");
            } else {
                const t = await res.text().catch(() => "");
                setSaveState("error", `실패 ❌ (HTTP ${res.status})`);
                showErrorDetail(t || "(응답 본문 없음)");
                console.error("🩶 PersonaEditor 저장 실패:", res.status, t);
            }
        } catch (err) {
            setSaveState("error", "네트워크 오류 ❌");
            showErrorDetail(String(err && err.message));
            console.error("🩶 PersonaEditor 네트워크 오류:", err);
        } finally {
            saveInFlight = false;
            if (saveQueued) {
                saveQueued = false;
                doAutoSave();
            }
        }
    }

    // ★★★ 핵심 수정 (v1.4.5):
    // /creator 응답의 draft 객체가 편집 폼 데이터와 거의 동일한 구조라는 것을 확인.
    // draft를 기반으로 PUT 바디를 구성하되, draft 밖에 있는 몇몇 메타 필드
    // (plotId, unlimitedMonitoring*)를 최상위 fresh 객체에서 보충한다.
    // exampleConversation(단수, draft) → exampleConversations(복수, PUT 요구 필드명)로 매핑.
    function buildPlotPutBody(fresh) {
        const draft = fresh.draft || {};
        return {
            plotId: fresh.id,
            chatProfiles: draft.chatProfiles || fresh.chatProfiles || [],
            shortDescription: draft.shortDescription || "",
            hashtags: draft.hashtags || [],
            isAboutPublic: draft.isAboutPublic || false,
            about: draft.about || null,
            isCreatorCommentPublic: draft.isCreatorCommentPublic || false,
            creatorComment: draft.creatorComment || "",
            isExampleConversationPublic: draft.isExampleConversationPublic || false,
            unlimitedMonitoringStatus: fresh.unlimitedMonitoringStatus,
            unlimitedReExaminationCount: fresh.unlimitedReExaminationCount,
            unlimitedMonitoringCompletedAt: fresh.unlimitedMonitoringCompletedAt,
            lorebookIds: draft.lorebookIds || [],
            stylePreset: draft.stylePreset || null,
            infoBoxSetting: draft.infoBoxSetting || null,
            cyoaSetting: draft.cyoaSetting || null,
            name: draft.name,
            longDescription: draft.longDescription || "",
            narrator: draft.narrator || "",
            characters: draft.characters || [],
            intros: draft.intros || [],
            exampleConversations: draft.exampleConversation || draft.exampleConversations || []
        };
    }

    function sanitizeSurrogates(str) {
        return str.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:[^\uD800-\uDBFF]|^)[\uDC00-\uDFFF]/g, (m) => m.length > 1 ? m[0] : "");
    }

    async function doAutoSavePlot() {
        if (!activePlotTargetKey) return;
        if (!capturedAuth || !lastPlotId) {
            setSaveState("error", "인증/plotId 없음 ❌");
            return;
        }
        if (saveInFlight) {
            saveQueued = true;
            return;
        }
        saveInFlight = true;
        setSaveState("saving", "저장 중... (최신본 확인 중)");
        clearErrorDetail();

        const newText = descEl.value;
        const targetKey = activePlotTargetKey;

        try {
            const fresh = await fetchPlotFresh();
            if (!fresh || !fresh.draft) {
                setSaveState("error", "최신본 못 가져옴 ❌");
                return;
            }

            const draft = fresh.draft;
            const targets = getPlotTargets(draft);
            const target = targets.find(t => t.key === targetKey);
            if (!target) {
                setSaveState("error", "대상 필드를 못 찾음 ❌");
                return;
            }
            target.set(draft, newText);

            const bodyStr = sanitizeSurrogates(JSON.stringify(buildPlotPutBody(fresh)));

            const res = await originalFetch(PLOT_URL(lastPlotId), {
                method: "PUT",
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": capturedAuth
                },
                body: bodyStr
            });

            if (res.ok) {
                plotData = fresh;
                setSaveState("saved", "저장됨 ✅");
                rebuildPlotDropdown();
            } else {
                const t = await res.text().catch(() => "");
                let friendly = `실패 ❌ (HTTP ${res.status})`;
                if (t.includes("PLOT_CONTENT_CONSTRAINT_VIOLATION")) {
                    friendly = "실패 ❌ 글자수 제한 초과";
                }
                setSaveState("error", friendly);
                showErrorDetail((t || "(응답 본문 없음)") + `\n\n[전송 body 길이: ${bodyStr.length}자]`);
                console.error("🩶 PersonaEditor(plot) 저장 실패:", res.status, t);
            }
        } catch (err) {
            setSaveState("error", "네트워크 오류 ❌");
            showErrorDetail(String(err && err.message));
            console.error("🩶 PersonaEditor(plot) 네트워크 오류:", err);
        } finally {
            saveInFlight = false;
            if (saveQueued) {
                saveQueued = false;
                doAutoSave();
            }
        }
    }

    descEl.addEventListener("input", () => {
        updateCount();
        updateStatus();
        clearErrorDetail();
        if (getAutosaveEnabled()) {
            setSaveState("idle", "입력 중...");
            clearTimeout(saveDebounce);
            saveDebounce = setTimeout(doAutoSave, 800);
        } else {
            setSaveState("idle", "수정됨 (저장 필요)");
        }
    });

    autosaveToggleEl.addEventListener("change", () => {
        setAutosaveEnabled(autosaveToggleEl.checked);
        if (autosaveToggleEl.checked) {
            setSaveState("idle", "자동저장 켜짐");
        } else {
            clearTimeout(saveDebounce);
            setSaveState("idle", "수동저장 모드");
        }
    });

    manualSaveBtn.addEventListener("click", () => {
        clearTimeout(saveDebounce);
        doAutoSave();
    });

    selectEl.addEventListener("change", () => {
        const hasUnsaved = saveStateEl.textContent.includes("저장 필요") || saveStateEl.textContent.includes("입력 중");
        if (mode === "plot" && hasUnsaved && !confirm("저장 안 된 수정사항이 있어요. 그냥 다른 항목으로 바꿀까요? (지금 내용은 사라져요)")) {
            selectEl.value = activePlotTargetKey;
            return;
        }
        if (mode === "persona") {
            userPickedManually = true;
            loadPersonaIntoEditor(selectEl.value);
        } else {
            loadPlotTargetIntoEditor(selectEl.value);
        }
    });

    async function switchMode(newMode) {
        if (mode === newMode) return;
        mode = newMode;
        modePersonaBtn.classList.toggle("active", mode === "persona");
        modePlotBtn.classList.toggle("active", mode === "plot");
        clearTimeout(saveDebounce);

        if (mode === "persona") {
            if (personaList.length) {
                rebuildPersonaDropdown();
                if (activePersonaId) loadPersonaIntoEditor(activePersonaId);
            } else {
                selectEl.innerHTML = "<option>새로고침 눌러주세요</option>";
                descEl.value = "";
                updateCount();
            }
        } else {
            if (getDraft(plotData)) {
                rebuildPlotDropdown();
                if (activePlotTargetKey) loadPlotTargetIntoEditor(activePlotTargetKey);
            } else {
                selectEl.innerHTML = "<option>불러오는 중...</option>";
                descEl.value = "";
                updateCount();
                await refreshPlotData(false);
            }
        }
        updateStatus();
    }

    modePersonaBtn.addEventListener("click", () => switchMode("persona"));
    modePlotBtn.addEventListener("click", () => switchMode("plot"));

    el("refresh").addEventListener("click", async () => {
        if (mode === "persona") {
            if (!capturedAuth || !lastPlotId) {
                updateStatus();
                return;
            }
            try {
                const url = `https://api.zeta-ai.io/v1/user-chat-profiles?plotId=${lastPlotId}`;
                const res = await originalFetch(url, { headers: { "Authorization": capturedAuth } });
                if (res.ok) {
                    const data = await res.json();
                    if (Array.isArray(data.userChatProfiles)) {
                        personaList = data.userChatProfiles;
                        if (!activePersonaId || !personaList.find(p => p.id === activePersonaId)) {
                            const sel = personaList.find(p => p.selected);
                            if (sel) loadPersonaIntoEditor(sel.id);
                        }
                        rebuildPersonaDropdown();
                    }
                }
            } catch (err) {
                console.error("🩶 PersonaEditor 새로고침 실패:", err);
            }
            updateStatus();
        } else {
            await refreshPlotData(true);
        }
    });

    el("reset-pos").addEventListener("click", () => {
        const defaultPos = { left: 16, bottom: 80 };
        savePos(defaultPos);
        applyPos(defaultPos);
    });

    setInterval(() => {
        const id = currentRoomId();
        if (id !== roomId) {
            roomId = id;
            lastPlotId = getCachedPlotId(roomId);
            personaList = [];
            activePersonaId = null;
            userPickedManually = false;
            plotData = null;
            activePlotTargetKey = null;
            selectEl.innerHTML = "<option>불러오는 중...</option>";
            descEl.value = "";
            updateCount();
            refreshRoomUI();
            if (mode === "plot") refreshPlotData(false);
        }
    }, 1000);

    const originalFetch = window.fetch;

    window.fetch = async function (input, init) {
        let url = "";
        const sendRoomId = roomId;
        try {
            url = typeof input === "string" ? input : (input && input.url) || "";
            const headers = (init && init.headers) || (typeof input !== "string" && input && input.headers);
            const authVal = extractAuthFromHeaders(headers);
            if (authVal) {
                if (!capturedAuth) console.log("🩶 PersonaEditor: 인증 토큰 감지됨 (fetch)");
                capturedAuth = authVal;
                updateStatus();
            }
            sniffOutgoingUrl(url);
        } catch (err) {
            console.error("🩶 PersonaEditor 처리 실패 (fetch 요청단계)", err);
        }

        const res = await originalFetch.call(this, input, init);

        try {
            if (PROFILES_LIST_RE.test(url)) {
                res.clone().text().then(text => handlePossiblePersonaListResponse(url, text, sendRoomId)).catch(() => {});
            }
        } catch (err) {
            console.error("🩶 PersonaEditor 처리 실패 (fetch 응답단계)", err);
        }

        return res;
    };

    const OrigXHR = window.XMLHttpRequest;
    const origOpen = OrigXHR.prototype.open;
    const origSend = OrigXHR.prototype.send;
    const origSetHeader = OrigXHR.prototype.setRequestHeader;

    OrigXHR.prototype.open = function (method, url, ...rest) {
        this.__zetaMethod = (method || "GET").toUpperCase();
        this.__zetaURL = url;
        return origOpen.call(this, method, url, ...rest);
    };

    OrigXHR.prototype.setRequestHeader = function (name, value) {
        try {
            if (name && name.toLowerCase() === "authorization") {
                if (!capturedAuth) console.log("🩶 PersonaEditor: 인증 토큰 감지됨 (XHR)");
                capturedAuth = value;
                updateStatus();
            }
        } catch { /* ignore */ }
        return origSetHeader.call(this, name, value);
    };

    OrigXHR.prototype.send = function (body) {
        try {
            sniffOutgoingUrl(this.__zetaURL);

            if (this.__zetaMethod === "GET" && PROFILES_LIST_RE.test(this.__zetaURL || "")) {
                const sendRoomId = roomId;
                const sendUrl = this.__zetaURL;
                this.addEventListener("load", function () {
                    try { handlePossiblePersonaListResponse(sendUrl, this.responseText, sendRoomId); } catch { /* ignore */ }
                });
            }
        } catch (err) {
            console.error("🩶 PersonaEditor 처리 실패 (XHR)", err);
        }

        return origSend.call(this, body);
    };

    window.ZetaPersonaEditor = {
        version: VERSION,
        get mode() { return mode; },
        get roomId() { return roomId; },
        get personaList() { return personaList; },
        get activePersonaId() { return activePersonaId; },
        get plotData() { return plotData; },
        get activePlotTargetKey() { return activePlotTargetKey; },
        get hasAuth() { return !!capturedAuth; }
    };

    console.log(`🩶 Zeta Persona Editor v${VERSION} Ready`);

})();
