// ==UserScript==
// @name         Zeta Persona Quick Editor
// @namespace    zeta-persona-editor
// @version      2.2.9
// @description  현재 방의 유저 페르소나(+추천 프로필) / {{char}} 상세 / 로어북을 자동으로 불러와서, 페이지 이동 없이 바로 수정/자동저장하는 미니 에디터
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

    const VERSION = "2.3.1";

    const PROFILES_LIST_RE = /\/v1\/user-chat-profiles(?:\?|$)/;
    const PLOT_ROOM_RE = /\/plots\/([^/]+)\/rooms\/([^/]+)\//;
    const PLOTID_QUERY_RE = /[?&]plotId=([^&]+)/;
    const PROFILE_PATCH_URL = (id) => `https://api.zeta-ai.io/v1/user-chat-profiles/${id}`;
    const PLOT_URL = (id) => `https://api.zeta-ai.io/v1/plots/${id}`;
    const PLOT_STATUS_URL = (id) => `https://api.zeta-ai.io/v1/plots/${id}/status`;
    const LOREBOOK_URL = (id) => `https://api.zeta-ai.io/v1/lorebooks/${id}`;
    const LOREBOOK_LIST_URL = (cursor) => `https://api.zeta-ai.io/v1/lorebooks?limit=15` + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : "");
    const PLOT_CREATOR_URL = (id) => `https://api.zeta-ai.io/v1/plots/${id}/creator`;
    const ROOM_URL = (id) => `https://api.zeta-ai.io/v1/rooms/${id}`;
    const REC_PATCH_URL = (roomId) => `https://api.zeta-ai.io/v1/rooms/${roomId}/user-plot-chat-profiles/me`;
    const REC_KEY_PREFIX = "rec:";

    function isRecKey(key) { return typeof key === "string" && key.indexOf(REC_KEY_PREFIX) === 0; }
    function recIdFromKey(key) { return key.slice(REC_KEY_PREFIX.length); }

    let mode = "persona"; // "persona" | "plot" | "lorebook"
    let plotData = null;          // /creator 전체 응답 (draft 포함) 캐시
    let activePlotTargetKey = null;
    let recRoomData = null;       // /rooms/{roomId} 전체 응답 캐시 (추천 프로필 목록/이름/이미지용)
    let recMeData = null;         // /rooms/{roomId}/user-plot-chat-profiles/me 응답 캐시 (유저창 실제 설명)
    let recMeFetchedForRoom = null; // 이 방에서 recMeData를 "성공적으로" 이미 한 번 가져왔는지
    let recMeFetchInFlight = false;
    let recMeRecheckDoneForRoom = null; // 이 방에서 "지연 재확인"을 이미 예약했는지 (서버 지연 대응용)
    let myLorebooks = [];         // 내 로어북 전체 목록 (각 항목까지 포함)
    let activeLorebookId = null;
    let activeLorebookItemId = null;

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

    function personaSelectionKey(id) {
        return `zeta-persona-editor-lastpersona-${id}`;
    }

    function getSavedPersonaSelection(id) {
        return localStorage.getItem(personaSelectionKey(id));
    }

    function saveSavedPersonaSelection(id, key) {
        if (key) localStorage.setItem(personaSelectionKey(id), key);
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

    // [수정: v2.2.9] 예전에는 "이미 캐시된 plotId(knownPlotId)"가 있어야만 이 응답을 받아들였다.
    // 그런데 방에 처음 들어갔을 때는 /plots/{id}/rooms/{id}/ 형태의 요청이 아직 한 번도
    // 지나가지 않아서 knownPlotId가 비어있는 경우가 흔했고, 그러면 이 함수가 그냥 return 해버려서
    // personaList가 계속 빈 배열로 남았다. (그래서 hasActiveCustomPersona()가 항상 false가 되고,
    // recMeData의 부정확한 값에 기대게 되어 기본/추천 프로필에만 엉뚱하게 🔗가 붙었던 것.)
    // 유저창을 한번 열었다 닫으면 그제서야 같은 요청이 다시 발생하면서 그때는 plotId가 이미
    // 캐시돼 있어 정상 반영됐던 것이 이 버그의 정체.
    //
    // 응답 URL 자체에 이미 ?plotId=... 가 들어있으므로, 그 값을 그대로 신뢰해서 즉시 캐시하고
    // personaList를 채우도록 바꿨다. lastPlotId가 이미 있는 상태에서 다른 plotId의 응답이
    // (예: 방 이동 중 늦게 도착한 이전 방 응답) 섞여 들어오는 것은 여전히 걸러낸다.
    function handlePossiblePersonaListResponse(url, text, atRoomId) {
        try {
            if (atRoomId !== roomId) return;

            const qm = PLOTID_QUERY_RE.exec(url || "");
            const urlPlotId = qm ? decodeURIComponent(qm[1]) : null;
            if (!urlPlotId) return;

            if (!lastPlotId) {
                // 이 방의 plotId를 아직 몰랐다면, 이 응답의 plotId를 그대로 확정해서 캐시한다.
                lastPlotId = urlPlotId;
                setCachedPlotId(atRoomId, urlPlotId);
            } else if (urlPlotId !== lastPlotId) {
                // 이미 알고 있는 plotId와 다르면 (다른 방/다른 plot에서 온 응답) 무시.
                return;
            }

            const data = JSON.parse(text);
            const list = data && data.userChatProfiles;
            if (!Array.isArray(list)) return;

            personaList = list;
            if (!tryApplySavedPersonaSelection() && !userPickedManually && !activePersonaId) {
                const sel = list.find(p => p && p.selected);
                if (sel && sel.id) loadPersonaIntoEditor(sel.id);
            }
            rebuildPersonaDropdown();

            // 이 목록(personaList)은 방금 잡혔는데, 연결 정보(recRoomData/recMeData)가
            // 아직 없는 상태로 먼저 그려졌을 수 있다 (경쟁 상태). 뒤늦게라도 받아와서
            // 다시 그려서 🔗 표시/정렬이 스스로 맞게 고쳐지도록 한다.
            if (!recRoomData && atRoomId === roomId && capturedAuth) {
                refreshRecData().then(ok => {
                    if (ok && roomId === atRoomId) {
                        rebuildPersonaDropdown();
                        updateStatus();
                    }
                });
            }

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

  select, input[type="text"] {
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
  .count-row #count.over { color: #ff6b6b; font-weight: bold; }

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
    <button class="mode-btn" id="mode-lorebook">로어북</button>
  </div>

  <div class="status" id="status" style="margin-top:8px;">감지 중...</div>

  <select id="lorebook-select" style="display:none;"><option>불러오는 중...</option></select>
  <div class="row" id="lorebook-link-row" style="display:none;">
    <button id="lorebook-link-toggle">연결 상태 확인 중...</button>
  </div>
  <div class="row" id="lorebook-manage-row" style="display:none;">
    <button id="lorebook-item-new">➕ 새 항목</button>
  </div>

  <select id="target-select"><option>불러오는 중...</option></select>

  <input type="text" id="lorebook-item-name" placeholder="항목 이름 (예: {{char}}, {{user}})" style="display:none;">
  <input type="text" id="lorebook-item-keywords" placeholder="키워드 (쉼표로 구분)" style="display:none;">

  <textarea id="desc" placeholder="내용이 여기 자동으로 채워집니다."></textarea>

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
    const modeLorebookBtn = el("mode-lorebook");
    const lorebookSelectEl = el("lorebook-select");
    const lorebookLinkRowEl = el("lorebook-link-row");
    const lorebookLinkToggleBtn = el("lorebook-link-toggle");
    const lorebookManageRowEl = el("lorebook-manage-row");
    const lorebookItemNewBtn = el("lorebook-item-new");
    const lorebookItemNameEl = el("lorebook-item-name");
    const lorebookItemKeywordsEl = el("lorebook-item-keywords");

    const BTN_SIZE = 32;
    const BTN_MARGIN = 4;

    function applyPos(pos) {
        btnEl.style.left = pos.left + "px";
        btnEl.style.bottom = pos.bottom + "px";
        panelEl.style.left = pos.left + "px";
        panelEl.style.bottom = (pos.bottom + BTN_SIZE + 10) + "px";
    }

    applyPos(getPos());

    function currentFieldLimit() {
        if (mode === "persona" && isRecKey(activePersonaId)) return 500;
        return null;
    }

    function updateCount() {
        const limit = currentFieldLimit();
        const len = descEl.value.length;
        if (limit) {
            countEl.textContent = `${len.toLocaleString()}/${limit}자`;
            countEl.classList.toggle("over", len > limit);
        } else {
            countEl.textContent = `${len.toLocaleString()}자`;
            countEl.classList.remove("over");
        }
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

    function getDraft(obj) {
        return obj && obj.draft ? obj.draft : null;
    }

    // [v2.2.8] "내 페르소나(personaList)"에서 실제로 selected:true인 게 있으면,
    // 그게 이 방의 진짜 연결된 프로필이다. recMeData(/user-plot-chat-profiles/me)는
    // 이 방에서 실제로 내 페르소나를 쓰고 있어도 항상 "기본 추천프로필" 값을 그대로
    // 돌려주는 경우가 있어서, 이 값만으로 추천프로필을 연결됨으로 표시하면 안 된다.
    function hasActiveCustomPersona() {
        return personaList.some(p => p && p.selected);
    }

    function getRecTargets(roomData) {
        const list = (roomData && roomData.plot && roomData.plot.chatProfiles) || [];
        return list.map(cp => ({
            key: cp.id,
            label: `🌟 추천프로필: ${cp.name || "이름없음"}`,
            get: () => {
                if (recMeData && recMeData.plotChatProfileId === cp.id && typeof recMeData.description === "string") {
                    return recMeData.description;
                }
                return cp.description || "";
            }
        }));
    }

    function updateStatus() {
        if (!capturedAuth) {
            statusEl.className = "status bad";
            statusEl.textContent = "⚠ 인증 토큰 아직 못 잡음 (사이트 조작 한번 해보세요)";
        } else if (!lastPlotId) {
            statusEl.className = "status bad";
            statusEl.textContent = "⚠ 이 방의 plotId 못 잡음 (새로고침 해보세요)";
        } else if (mode === "persona") {
            const recCount = getRecTargets(recRoomData).length;
            if (personaList.length === 0 && recCount === 0) {
                statusEl.className = "status bad";
                statusEl.textContent = "⚠ 목록 아직 못 잡음 → '새로고침' 눌러주세요";
            } else {
                statusEl.className = "status ok";
                statusEl.textContent = `✅ 추천 ${recCount}개 + 내 페르소나 ${personaList.length}개 로드됨`;
            }
        } else if (mode === "plot") {
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
                statusEl.textContent = `✅ ${draft.name || "(이름없음)"} 상세 로드됨 · 합계 ${total}자 (기본+내레+캐릭)`;
            }
        } else {
            if (myLorebooks.length === 0) {
                statusEl.className = "status bad";
                statusEl.textContent = "⚠ 로어북 목록 아직 못 불러옴 → '새로고침' 눌러주세요";
            } else {
                const lb = myLorebooks.find(x => x.id === activeLorebookId);
                statusEl.className = "status ok";
                statusEl.textContent = lb
                    ? `✅ 내 로어북 ${myLorebooks.length}개 중 "${lb.title}" 편집 중`
                    : `✅ 내 로어북 ${myLorebooks.length}개 로드됨`;
            }
        }
        btnEl.classList.toggle("no-auth", !capturedAuth);
        btnEl.classList.toggle("ready", !!(capturedAuth && (
            mode === "persona" ? (personaList.length || getRecTargets(recRoomData).length) :
            mode === "plot" ? getDraft(plotData) :
            myLorebooks.length
        )));
    }

    function rebuildPersonaDropdown() {
        selectEl.innerHTML = "";
        ensureRecMeData(); // 아직 연결 정보를 못 가져왔으면 백그라운드로 시도 (끝나면 알아서 다시 그림)
        const recTargets = getRecTargets(recRoomData);

        const entries = [];
        const customActive = hasActiveCustomPersona();
        recTargets.forEach((t, idx) => {
            // 내 페르소나 쪽이 선택돼 있으면 추천프로필은 절대 연결됨(🔗)으로 표시하지 않는다.
            // [v2.3.1] recMeData.plotChatProfileId가 있다고 무조건 연결된 게 아니다 —
            // 그 기록이 "이 방에서 한 번이라도 커스터마이징된 적 있는 프로필"이라는 뜻일 뿐일 수 있고,
            // 진짜 지금 활성화된 건지는 recMeData.selected 필드로 확인해야 한다.
            // (selected:false인데 plotChatProfileId만 남아있는 경우가 실제로 확인됨 → 이게 기본
            // 프로필에 엉뚱하게 🔗가 붙던 원인.)
            const isActive = !customActive && !!(recMeData && recMeData.plotChatProfileId === t.key && recMeData.selected);
            entries.push({
                value: REC_KEY_PREFIX + t.key,
                label: `${isActive ? "🔗 " : ""}${t.label} (${t.get().length}자)`,
                isActive,
                order: idx
            });
        });
        personaList.forEach((p, idx) => {
            const isActive = !!p.selected;
            entries.push({
                value: p.id,
                label: `${isActive ? "🔗 " : ""}${p.name || "(이름없음)"} — ${(p.description || "").slice(0, 12)}`,
                isActive,
                order: recTargets.length + idx
            });
        });

        // 연결된 것이 위로 오도록 정렬 (그룹 내부 순서는 원래 순서 유지) — 로어북과 동일한 방식
        entries.sort((a, b) => {
            const diff = (b.isActive ? 1 : 0) - (a.isActive ? 1 : 0);
            return diff !== 0 ? diff : a.order - b.order;
        });

        entries.forEach(e => {
            const opt = document.createElement("option");
            opt.value = e.value;
            opt.textContent = e.label;
            if (e.value === activePersonaId) opt.selected = true;
            selectEl.appendChild(opt);
        });

        updateStatus();
    }

    let userPickedManually = false;

    function loadPersonaIntoEditor(key) {
        if (isRecKey(key)) {
            const recId = recIdFromKey(key);
            const t = getRecTargets(recRoomData).find(x => x.key === recId);
            if (!t) return;
            activePersonaId = key;
            saveSavedPersonaSelection(roomId, key);
            descEl.value = t.get();
            updateCount();
            setSaveState("idle", "대기중"); clearErrorDetail();
            rebuildPersonaDropdown();
            return;
        }
        const p = personaList.find(x => x.id === key);
        if (!p) return;
        activePersonaId = key;
        saveSavedPersonaSelection(roomId, key);
        descEl.value = p.description || "";
        updateCount();
        setSaveState("idle", "대기중"); clearErrorDetail();
        rebuildPersonaDropdown();
    }

    function tryApplySavedPersonaSelection() {
        if (userPickedManually) return false;
        const saved = getSavedPersonaSelection(roomId);
        if (!saved) return false;
        if (activePersonaId === saved) return true;
        if (isRecKey(saved)) {
            const recId = recIdFromKey(saved);
            if (getRecTargets(recRoomData).some(t => t.key === recId)) {
                loadPersonaIntoEditor(saved);
                return true;
            }
        } else if (personaList.some(p => p.id === saved)) {
            loadPersonaIntoEditor(saved);
            return true;
        }
        return false;
    }

    async function fetchRoomFresh() {
        if (!capturedAuth) return null;
        try {
            const res = await originalFetch(ROOM_URL(roomId), {
                headers: { "Authorization": capturedAuth }
            });
            if (!res.ok) return null;
            return await res.json();
        } catch {
            return null;
        }
    }

    // plotId를 "몰래 훔쳐보기"로만 잡으면, 그 특정 요청이 안 지나간 방에서는 영영 못 잡는다.
    // /v1/rooms/{roomId} 응답 안에 plot.id가 직접 들어있으므로, 필요하면 능동적으로 물어봐서 확실히 잡는다.
    async function resolvePlotIdActively() {
        if (lastPlotId) return true;
        const data = await fetchRoomFresh();
        if (data && data.plot && data.plot.id) {
            lastPlotId = data.plot.id;
            setCachedPlotId(roomId, data.plot.id);
            // 방 데이터(recRoomData)는 여기서 캐싱하지 않는다 — recMeData(연결 정보)
            // 없이 절반만 캐싱되면, 이후 refreshRecData()가 "이미 있음"으로 착각해서
            // 건너뛰어버려 연결 표시가 계속 틀리게 남는 버그가 있었음.
            return true;
        }
        return false;
    }

    async function fetchRecMeFresh() {
        if (!capturedAuth) return null;
        try {
            const res = await originalFetch(REC_PATCH_URL(roomId), {
                headers: { "Authorization": capturedAuth }
            });
            if (!res.ok) return null;
            return await res.json();
        } catch {
            return null;
        }
    }

    // [수정: v2.2.7] fetchRecMeFresh()가 실패(null)해도 "이미 가져왔음"으로 확정짓지 않는다.
    // 예전에는 recMeFetchedForRoom을 무조건 roomId로 찍어버려서, 방 진입 직후 이 특정
    // 엔드포인트만 일시적으로 실패하는 경우 연결(🔗) 정보가 영영 다시 시도되지 않고
    // null로 굳어버리는 문제가 있었다. 그래서 유저가 사이트 자체 UI(유저프로필 열고 닫기)를
    // 건드려 다른 경로로 재요청이 발생해야만 그제서야 반영되는 것처럼 보였던 것.
    async function refreshRecData() {
        const [fresh, me] = await Promise.all([fetchRoomFresh(), fetchRecMeFresh()]);
        if (!fresh || !fresh.plot) return false;
        recRoomData = fresh;
        recMeData = me;
        if (me !== null) {
            recMeFetchedForRoom = roomId;
        }
        scheduleRecMeDelayedRecheck(roomId);
        return true;
    }

    // [v2.3.0] recMeData(연결된 프로필 정보) 서버 API가 방에 막 들어간 직후엔
    // 부정확한 값(예: 기본/추천 프로필)을 돌려주다가, 몇 초 뒤 다시 물어보면
    // 정확한 값으로 바뀌는 경우가 있는 것으로 보인다. (유저가 사이트에서 유저창을
    // 열었다 닫으면 저절로 고쳐지는 것도 결국 이 API를 한 번 더 호출하게 만드는
    // 것뿐이라 같은 효과.) 그래서 이 방에서 최초로 정보를 받아온 뒤, 1.5초 뒤에
    // 자동으로 한 번 더 조용히 재확인해서 값이 바뀌었으면 스스로 고치도록 한다.
    function scheduleRecMeDelayedRecheck(forRoom) {
        if (recMeRecheckDoneForRoom === forRoom) return;
        recMeRecheckDoneForRoom = forRoom;
        setTimeout(async () => {
            if (roomId !== forRoom || !capturedAuth) return;
            const me = await fetchRecMeFresh();
            if (me !== null) {
                recMeData = me;
                recMeFetchedForRoom = forRoom;
                if (mode === "persona") {
                    rebuildPersonaDropdown();
                    updateStatus();
                }
            }
        }, 1500);
    }

    // rebuildPersonaDropdown이 어디서 호출되든(경쟁 상태로 recMeData 없이 먼저 그려졌더라도),
    // 이 방에서 아직 "성공적으로" recMeData를 못 가져왔으면 백그라운드로 가져와서 다시 그린다.
    // (fire-and-forget: await 안 하고 그냥 던져둠 — 끝나면 스스로 재렌더링됨)
    // [수정: v2.2.7] 실패(me === null)했을 때는 recMeFetchedForRoom을 확정하지 않아서
    // 패널을 다시 열거나 재렌더링될 때마다 자동으로 재시도되도록 함.
    function ensureRecMeData() {
        if (recMeFetchedForRoom === roomId || recMeFetchInFlight || !capturedAuth || !roomId) return;
        recMeFetchInFlight = true;
        const forRoom = roomId;
        fetchRecMeFresh().then(me => {
            recMeFetchInFlight = false;
            if (forRoom !== roomId) return; // 그 사이 방이 바뀌었으면 무시
            if (me !== null) {
                recMeFetchedForRoom = forRoom;
                recMeData = me;
            }
            if (mode === "persona") {
                rebuildPersonaDropdown();
                updateStatus();
            }
        });
    }

    function getPlotTargets(draft) {
        if (!draft) return [];
        const targets = [
            { key: "longDescription", label: "📘 기본설정 (longDescription)", get: o => o.longDescription || "", set: (o, v) => { o.longDescription = v; } },
            { key: "narrator", label: "🗣 내레이터 설정 (narrator)", get: o => o.narrator || "", set: (o, v) => { o.narrator = v; } }
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

    //------------------------------------------
    // 로어북 모드
    //------------------------------------------

    async function fetchMyLorebooks() {
        if (!capturedAuth) return [];
        const all = [];
        let cursor = null;
        for (let page = 0; page < 5; page++) { // 최대 5페이지(75개)까지만, 무한루프 방지
            try {
                const res = await originalFetch(LOREBOOK_LIST_URL(cursor), {
                    headers: { "Authorization": capturedAuth }
                });
                if (!res.ok) break;
                const data = await res.json();
                if (Array.isArray(data.lorebooks)) all.push(...data.lorebooks);
                if (!data.nextCursor) break;
                cursor = data.nextCursor;
            } catch {
                break;
            }
        }
        return all;
    }

    async function refreshMyLorebooks(preserveSelection) {
        const list = await fetchMyLorebooks();
        myLorebooks = list;
        rebuildLorebookSelect();
        if (preserveSelection && activeLorebookId && list.find(lb => lb.id === activeLorebookId)) {
            loadLorebookIntoEditor(activeLorebookId, true);
        } else if (list.length) {
            loadLorebookIntoEditor(list[0].id);
        }
        updateStatus();
        return list.length > 0;
    }

    function currentDraftLorebookIds() {
        const draft = getDraft(plotData);
        return (draft && Array.isArray(draft.lorebookIds)) ? draft.lorebookIds : null;
    }

    function rebuildLorebookSelect() {
        lorebookSelectEl.innerHTML = "";
        const linkedIds = currentDraftLorebookIds();
        const isLinked = (lb) => !!(linkedIds && linkedIds.includes(lb.id));

        // 연결된 로어북이 위로 오도록 정렬 (그룹 내부 순서는 원래 순서 유지)
        const sorted = myLorebooks
            .map((lb, idx) => ({ lb, idx }))
            .sort((a, b) => {
                const linkDiff = (isLinked(b.lb) ? 1 : 0) - (isLinked(a.lb) ? 1 : 0);
                return linkDiff !== 0 ? linkDiff : a.idx - b.idx;
            })
            .map(x => x.lb);

        sorted.forEach(lb => {
            const opt = document.createElement("option");
            opt.value = lb.id;
            const linkedMark = isLinked(lb) ? "🔗 " : "";
            opt.textContent = `${linkedMark}${lb.title || "(제목없음)"} (${(lb.items || []).length}항목)`;
            if (lb.id === activeLorebookId) opt.selected = true;
            lorebookSelectEl.appendChild(opt);
        });
    }

    function updateLorebookLinkButton() {
        const linkedIds = currentDraftLorebookIds();
        if (!activeLorebookId || !linkedIds) {
            lorebookLinkToggleBtn.textContent = "연결 상태 확인 중...";
            lorebookLinkToggleBtn.disabled = true;
            return;
        }
        lorebookLinkToggleBtn.disabled = false;
        if (linkedIds.includes(activeLorebookId)) {
            lorebookLinkToggleBtn.textContent = "🔗 이 방에 연결됨 (해제하기)";
        } else {
            lorebookLinkToggleBtn.textContent = "⛓️‍💥 연결 안 됨 (연결하기)";
        }
    }

    const NEW_ITEM_KEY = "__new__";

    function getLorebookItems(lb) {
        if (!lb) return [];
        return (lb.items || []).map(it => ({
            key: it.id,
            label: `📄 ${it.name || "(이름없음)"}`,
            name: it.name || "",
            keywords: it.keywords || [],
            content: it.content || ""
        }));
    }

    function rebuildLorebookItemDropdown() {
        const lb = myLorebooks.find(x => x.id === activeLorebookId);
        selectEl.innerHTML = "";
        getLorebookItems(lb).forEach(t => {
            const opt = document.createElement("option");
            opt.value = t.key;
            opt.textContent = `${t.label} (${t.content.length}자)`;
            if (t.key === activeLorebookItemId) opt.selected = true;
            selectEl.appendChild(opt);
        });
        if (activeLorebookItemId === NEW_ITEM_KEY) {
            const opt = document.createElement("option");
            opt.value = NEW_ITEM_KEY;
            opt.textContent = "✨ (새 항목 - 아직 저장 안 됨)";
            opt.selected = true;
            selectEl.appendChild(opt);
        }
        updateStatus();
    }

    const DEFAULT_DESC_PLACEHOLDER = "내용이 여기 자동으로 채워집니다.";

    function loadLorebookItemIntoEditor(itemId) {
        if (itemId === NEW_ITEM_KEY) {
            activeLorebookItemId = NEW_ITEM_KEY;
            lorebookItemNameEl.value = "";
            lorebookItemKeywordsEl.value = "";
            descEl.value = "";
            descEl.placeholder = "새 항목 내용을 직접 입력해주세요 (자동으로 채워지지 않아요).";
            updateCount();
            setSaveState("idle", "새 항목 (아직 저장 안 됨)"); clearErrorDetail();
            rebuildLorebookItemDropdown();
            lorebookItemNameEl.focus();
            return;
        }
        descEl.placeholder = DEFAULT_DESC_PLACEHOLDER;
        const lb = myLorebooks.find(x => x.id === activeLorebookId);
        const target = getLorebookItems(lb).find(t => t.key === itemId);
        if (!target) return;
        activeLorebookItemId = itemId;
        lorebookItemNameEl.value = target.name;
        lorebookItemKeywordsEl.value = target.keywords.join(", ");
        descEl.value = target.content;
        updateCount();
        setSaveState("idle", "대기중"); clearErrorDetail();
        rebuildLorebookItemDropdown();
    }

    function loadLorebookIntoEditor(lorebookId, skipItemReset) {
        activeLorebookId = lorebookId;
        const lb = myLorebooks.find(x => x.id === lorebookId);
        const items = getLorebookItems(lb);
        rebuildLorebookSelect();
        updateLorebookLinkButton();
        if (!skipItemReset || !items.find(t => t.key === activeLorebookItemId)) {
            if (items.length) loadLorebookItemIntoEditor(items[0].key);
        } else {
            rebuildLorebookItemDropdown();
        }
        updateStatus();
    }

    // 로어북 저장 — GET 응답 그대로 PUT하면 안 되고, 알려진 필드만 골라서 보내야 함
    // (id/createdAt/updatedAt/creator/stats 등은 PUT에서 안 받는 읽기 전용 필드).
    // 새 항목은 id가 없으므로 JSON.stringify가 자동으로 그 필드를 생략한다 (서버가 새로 발급해줄 것으로 기대).
    function buildLorebookPutBody(lb) {
        return {
            title: lb.title || "",
            description: lb.description || "",
            items: (lb.items || []).map(it => ({
                id: it.id, // 새 항목은 undefined → JSON.stringify가 자동 생략
                name: it.name,
                keywords: it.keywords || [],
                content: it.content || ""
            })),
            isSharingEnabled: !!lb.isSharingEnabled
        };
    }

    async function doAutoSaveLorebookItem() {
        if (!activeLorebookId || !activeLorebookItemId) return;
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

        const isNew = activeLorebookItemId === NEW_ITEM_KEY;
        const newName = lorebookItemNameEl.value.trim();
        const newKeywords = lorebookItemKeywordsEl.value.split(",").map(s => s.trim()).filter(Boolean);
        const newContent = sanitizeSurrogates(descEl.value);
        const savedItemId = activeLorebookItemId;

        try {
            const res0 = await originalFetch(LOREBOOK_URL(activeLorebookId), {
                headers: { "Authorization": capturedAuth }
            });
            if (!res0.ok) {
                setSaveState("error", "최신본 못 가져옴 ❌");
                return;
            }
            const fresh = await res0.json();
            if (!Array.isArray(fresh.items)) fresh.items = [];

            if (isNew) {
                fresh.items.push({ name: newName, keywords: newKeywords, content: newContent });
            } else {
                const item = fresh.items.find(it => it.id === savedItemId);
                if (!item) {
                    setSaveState("error", "대상 항목을 못 찾음 ❌");
                    return;
                }
                item.name = newName;
                item.keywords = newKeywords;
                item.content = newContent;
            }

            const bodyStr = JSON.stringify(buildLorebookPutBody(fresh));

            const res = await originalFetch(LOREBOOK_URL(activeLorebookId), {
                method: "PUT",
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": capturedAuth
                },
                body: bodyStr
            });

            if (res.ok) {
                // 서버가 새 항목에 진짜 id를 발급해줬을 수 있으니 다시 받아와서 동기화한다.
                const res2 = await originalFetch(LOREBOOK_URL(activeLorebookId), {
                    headers: { "Authorization": capturedAuth }
                });
                const refreshed = res2.ok ? await res2.json() : fresh;

                const idx = myLorebooks.findIndex(x => x.id === activeLorebookId);
                if (idx !== -1) myLorebooks[idx] = refreshed;

                if (isNew) {
                    // 방금 만든 항목을 이름+내용으로 최대한 찾아서 선택해준다.
                    const match = (refreshed.items || []).find(it => it.name === newName && it.content === newContent);
                    activeLorebookItemId = match ? match.id : null;
                }

                // loadLorebookItemIntoEditor는 내부에서 상태를 "대기중"으로 되돌리므로,
                // 반드시 그 다음에 "저장됨"을 표시해야 화면에 제대로 남는다.
                if (activeLorebookItemId && activeLorebookItemId !== NEW_ITEM_KEY) {
                    loadLorebookItemIntoEditor(activeLorebookItemId);
                } else {
                    rebuildLorebookItemDropdown();
                }
                setSaveState("saved", "저장됨 ✅");
            } else {
                const t = await res.text().catch(() => "");
                setSaveState("error", `실패 ❌ (HTTP ${res.status})`);
                showErrorDetail((t || "(응답 본문 없음)") + `\n\n[전송 body 길이: ${bodyStr.length}자]`);
                console.error("🩶 PersonaEditor(lorebook) 저장 실패:", res.status, t);
            }
        } catch (err) {
            setSaveState("error", "네트워크 오류 ❌");
            showErrorDetail(String(err && err.message));
            console.error("🩶 PersonaEditor(lorebook) 네트워크 오류:", err);
        } finally {
            saveInFlight = false;
            if (saveQueued) {
                saveQueued = false;
                doAutoSave();
            }
        }
    }

    // {{char}} 저장(PUT+RELEASE)과 같은 안전장치(저장 직전 최신본 재확인)를 써서
    // lorebookIds 배열만 토글한다.
    async function doToggleLorebookLink() {
        if (!activeLorebookId || !capturedAuth || !lastPlotId) return;
        lorebookLinkToggleBtn.disabled = true;
        lorebookLinkToggleBtn.textContent = "처리 중...";

        try {
            const fresh = await fetchPlotFresh();
            if (!fresh || !fresh.draft) {
                showErrorDetail("최신 {{char}} 정보를 못 가져와서 연결 상태를 바꿀 수 없어요.");
                updateLorebookLinkButton();
                return;
            }
            const draft = fresh.draft;
            if (!Array.isArray(draft.lorebookIds)) draft.lorebookIds = [];

            const idx = draft.lorebookIds.indexOf(activeLorebookId);
            if (idx === -1) {
                draft.lorebookIds.push(activeLorebookId);
            } else {
                draft.lorebookIds.splice(idx, 1);
            }

            const bodyStr = sanitizeSurrogates(JSON.stringify(buildPlotPutBody(fresh)));
            const res = await originalFetch(PLOT_URL(lastPlotId), {
                method: "PUT",
                headers: { "Content-Type": "application/json", "Authorization": capturedAuth },
                body: bodyStr
            });

            if (!res.ok) {
                const t = await res.text().catch(() => "");
                showErrorDetail(`연결 상태 변경 실패 ❌ (HTTP ${res.status})\n` + (t || "(응답 본문 없음)"));
                updateLorebookLinkButton();
                return;
            }

            const relRes = await originalFetch(PLOT_STATUS_URL(lastPlotId), {
                method: "PATCH",
                headers: { "Content-Type": "application/json", "Authorization": capturedAuth },
                body: JSON.stringify({ status: "RELEASE" })
            });

            plotData = fresh;
            if (relRes.ok) {
                clearErrorDetail();
            } else {
                const relT = await relRes.text().catch(() => "");
                showErrorDetail(`연결은 저장됐지만 반영 실패 ❌ (HTTP ${relRes.status})\n` + (relT || "(응답 본문 없음)"));
            }
            rebuildLorebookSelect();
            updateLorebookLinkButton();
        } catch (err) {
            showErrorDetail("네트워크 오류: " + String(err && err.message));
            updateLorebookLinkButton();
        }
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

    async function setPanelOpen(open) {
        panelEl.classList.toggle("open", open);
        if (open) {
            refreshRoomUI();
            if (!lastPlotId && capturedAuth && roomId) {
                await resolvePlotIdActively();
                refreshRoomUI();
            }
            if (mode === "persona" && !recRoomData && capturedAuth && roomId) {
                const ok = await refreshRecData();
                if (ok) {
                    rebuildPersonaDropdown();
                    if (!tryApplySavedPersonaSelection() && !activePersonaId) {
                        const selectedCustom = personaList.find(p => p && p.selected);
                        if (selectedCustom) {
                            loadPersonaIntoEditor(selectedCustom.id);
                        } else {
                            const recTargets = getRecTargets(recRoomData);
                            if (recTargets.length) {
                                loadPersonaIntoEditor(REC_KEY_PREFIX + recTargets[0].key);
                            }
                        }
                    }
                    updateStatus();
                }
            }
        }
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
        if (mode === "persona") {
            if (isRecKey(activePersonaId)) return doAutoSaveRec();
            return doAutoSavePersona();
        }
        if (mode === "lorebook") return doAutoSaveLorebookItem();
        return doAutoSavePlot();
    }

    async function doAutoSavePersona() {
        if (!activePersonaId || isRecKey(activePersonaId)) return;
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

    async function doAutoSaveRec() {
        if (!isRecKey(activePersonaId)) return;
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

        const recId = recIdFromKey(activePersonaId);
        const newDesc = descEl.value;

        try {
            const res = await originalFetch(REC_PATCH_URL(roomId), {
                method: "PATCH",
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": capturedAuth
                },
                body: JSON.stringify({ description: newDesc })
            });

            if (res.ok) {
                const saved = await res.json().catch(() => null);
                if (saved) {
                    recMeData = saved;
                } else {
                    recMeData = { plotChatProfileId: recId, description: newDesc };
                }
                setSaveState("saved", "저장됨 ✅");
                rebuildPersonaDropdown();
            } else {
                const t = await res.text().catch(() => "");
                let friendly = `실패 ❌ (HTTP ${res.status})`;
                if (t.includes("CONSTRAINT")) friendly = "실패 ❌ 글자수 제한 초과 (500자)";
                setSaveState("error", friendly);
                showErrorDetail(t || "(응답 본문 없음)");
                console.error("🩶 PersonaEditor(rec) 저장 실패:", res.status, t);
            }
        } catch (err) {
            setSaveState("error", "네트워크 오류 ❌");
            showErrorDetail(String(err && err.message));
            console.error("🩶 PersonaEditor(rec) 네트워크 오류:", err);
        } finally {
            saveInFlight = false;
            if (saveQueued) {
                saveQueued = false;
                doAutoSave();
            }
        }
    }

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

                // draft 저장만으로는 실제 반영이 안 되고 "임시저장" 상태로 남는다.
                // 실제 화면(대화)에 반영되려면 이 status API로 RELEASE를 한 번 더 보내야 한다.
                setSaveState("saving", "저장됨, 반영 중...");
                try {
                    const relRes = await originalFetch(PLOT_STATUS_URL(lastPlotId), {
                        method: "PATCH",
                        headers: {
                            "Content-Type": "application/json",
                            "Authorization": capturedAuth
                        },
                        body: JSON.stringify({ status: "RELEASE" })
                    });
                    if (relRes.ok) {
                        setSaveState("saved", "저장+반영 완료 ✅");
                    } else {
                        const relT = await relRes.text().catch(() => "");
                        setSaveState("error", `저장은 됐지만 반영 실패 ❌ (HTTP ${relRes.status})`);
                        showErrorDetail("[반영(RELEASE) 실패]\n" + (relT || "(응답 본문 없음)"));
                        console.error("🩶 PersonaEditor(plot) 반영 실패:", relRes.status, relT);
                    }
                } catch (relErr) {
                    setSaveState("error", "저장은 됐지만 반영 중 네트워크 오류 ❌");
                    showErrorDetail("[반영(RELEASE) 오류] " + String(relErr && relErr.message));
                    console.error("🩶 PersonaEditor(plot) 반영 네트워크 오류:", relErr);
                }

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

    function onEditableInput() {
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
    }

    descEl.addEventListener("input", onEditableInput);
    lorebookItemNameEl.addEventListener("input", onEditableInput);
    lorebookItemKeywordsEl.addEventListener("input", onEditableInput);

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
        const isLimitedTarget = mode === "plot" || mode === "lorebook" || (mode === "persona" && isRecKey(selectEl.value));
        if (isLimitedTarget && hasUnsaved && !confirm("저장 안 된 수정사항이 있어요. 그냥 다른 항목으로 바꿀까요? (지금 내용은 사라져요)")) {
            selectEl.value = mode === "persona" ? activePersonaId : (mode === "plot" ? activePlotTargetKey : activeLorebookItemId);
            return;
        }
        if (mode === "persona") {
            userPickedManually = true;
            loadPersonaIntoEditor(selectEl.value);
        } else if (mode === "lorebook") {
            loadLorebookItemIntoEditor(selectEl.value);
        } else {
            loadPlotTargetIntoEditor(selectEl.value);
        }
    });

    lorebookSelectEl.addEventListener("change", () => {
        const hasUnsaved = saveStateEl.textContent.includes("저장 필요") || saveStateEl.textContent.includes("입력 중");
        if (hasUnsaved && !confirm("저장 안 된 수정사항이 있어요. 다른 로어북으로 바꿀까요? (지금 내용은 사라져요)")) {
            lorebookSelectEl.value = activeLorebookId;
            return;
        }
        loadLorebookIntoEditor(lorebookSelectEl.value);
    });

    lorebookLinkToggleBtn.addEventListener("click", doToggleLorebookLink);

    lorebookItemNewBtn.addEventListener("click", () => {
        if (!activeLorebookId) {
            alert("먼저 로어북을 하나 선택해주세요.");
            return;
        }
        const hasUnsaved = saveStateEl.textContent.includes("저장 필요") || saveStateEl.textContent.includes("입력 중");
        if (hasUnsaved && !confirm("저장 안 된 수정사항이 있어요. 그냥 새 항목을 만들까요? (지금 내용은 사라져요)")) {
            return;
        }
        loadLorebookItemIntoEditor(NEW_ITEM_KEY);
    });

    async function switchMode(newMode) {
        if (mode === newMode) return;
        mode = newMode;
        modePersonaBtn.classList.toggle("active", mode === "persona");
        modePlotBtn.classList.toggle("active", mode === "plot");
        modeLorebookBtn.classList.toggle("active", mode === "lorebook");
        lorebookSelectEl.style.display = mode === "lorebook" ? "" : "none";
        lorebookLinkRowEl.style.display = mode === "lorebook" ? "" : "none";
        lorebookManageRowEl.style.display = mode === "lorebook" ? "" : "none";
        lorebookItemNameEl.style.display = mode === "lorebook" ? "" : "none";
        lorebookItemKeywordsEl.style.display = mode === "lorebook" ? "" : "none";
        if (mode !== "lorebook") descEl.placeholder = DEFAULT_DESC_PLACEHOLDER;
        clearTimeout(saveDebounce);

        if (mode === "persona") {
            if (!recRoomData && capturedAuth && roomId) {
                await refreshRecData();
            }
            if (personaList.length || getRecTargets(recRoomData).length) {
                rebuildPersonaDropdown();
                if (!tryApplySavedPersonaSelection()) {
                    if (activePersonaId) {
                        loadPersonaIntoEditor(activePersonaId);
                    } else {
                        const selectedCustom = personaList.find(p => p && p.selected);
                        if (selectedCustom) {
                            loadPersonaIntoEditor(selectedCustom.id);
                        } else {
                            const recTargets = getRecTargets(recRoomData);
                            if (recTargets.length) {
                                loadPersonaIntoEditor(REC_KEY_PREFIX + recTargets[0].key);
                            } else if (personaList[0]) {
                                loadPersonaIntoEditor(personaList[0].id);
                            }
                        }
                    }
                }
            } else {
                selectEl.innerHTML = "<option>새로고침 눌러주세요</option>";
                descEl.value = "";
                updateCount();
            }
        } else if (mode === "plot") {
            if (getDraft(plotData)) {
                rebuildPlotDropdown();
                if (activePlotTargetKey) loadPlotTargetIntoEditor(activePlotTargetKey);
            } else {
                selectEl.innerHTML = "<option>불러오는 중...</option>";
                descEl.value = "";
                updateCount();
                await refreshPlotData(false);
            }
        } else {
            // lorebook 모드는 plot draft(lorebookIds 연결 상태 표시용)도 같이 필요하다.
            if (!getDraft(plotData)) await refreshPlotData(false);
            if (myLorebooks.length) {
                rebuildLorebookSelect();
                if (activeLorebookId) {
                    loadLorebookIntoEditor(activeLorebookId, true);
                } else if (myLorebooks.length) {
                    loadLorebookIntoEditor(myLorebooks[0].id);
                }
            } else {
                lorebookSelectEl.innerHTML = "<option>불러오는 중...</option>";
                selectEl.innerHTML = "<option>불러오는 중...</option>";
                descEl.value = "";
                updateCount();
                await refreshMyLorebooks(false);
            }
        }
        updateStatus();
    }

    modePersonaBtn.addEventListener("click", () => switchMode("persona"));
    modePlotBtn.addEventListener("click", () => switchMode("plot"));
    modeLorebookBtn.addEventListener("click", () => switchMode("lorebook"));

    el("refresh").addEventListener("click", async () => {
        if (!lastPlotId) await resolvePlotIdActively();

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
                    }
                }
            } catch (err) {
                console.error("🩶 PersonaEditor 새로고침 실패:", err);
            }
            await refreshRecData();
            if (!tryApplySavedPersonaSelection() && !activePersonaId) {
                const selectedCustom = personaList.find(p => p && p.selected);
                if (selectedCustom) {
                    loadPersonaIntoEditor(selectedCustom.id);
                } else {
                    const recTargets = getRecTargets(recRoomData);
                    if (recTargets.length) {
                        loadPersonaIntoEditor(REC_KEY_PREFIX + recTargets[0].key);
                    }
                }
            }
            rebuildPersonaDropdown();
            updateStatus();
        } else if (mode === "plot") {
            await refreshPlotData(true);
        } else {
            await refreshPlotData(true); // lorebookIds 연결 상태도 최신화
            await refreshMyLorebooks(true);
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
            recRoomData = null;
            recMeData = null;
            recMeFetchedForRoom = null;
            recMeRecheckDoneForRoom = null;
            selectEl.innerHTML = "<option>불러오는 중...</option>";
            descEl.value = "";
            updateCount();
            refreshRoomUI();
            if (mode === "plot") refreshPlotData(false);
            if (mode === "persona") {
                refreshRecData().then(() => {
                    rebuildPersonaDropdown();
                    tryApplySavedPersonaSelection();
                    rebuildPersonaDropdown();
                    updateStatus();
                });
            }
            if (mode === "lorebook") {
                refreshPlotData(false).then(() => {
                    rebuildLorebookSelect();
                    updateLorebookLinkButton();
                    updateStatus();
                });
            }
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
        get recRoomData() { return recRoomData; },
        get recMeData() { return recMeData; },
        get myLorebooks() { return myLorebooks; },
        get activeLorebookId() { return activeLorebookId; },
        get hasAuth() { return !!capturedAuth; }
    };

    console.log(`🩶 Zeta Persona Editor v${VERSION} Ready`);

})();
