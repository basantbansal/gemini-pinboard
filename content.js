/**
 * Gemini Pinboard - Spatial Pin Dispenser & Vertical Line Bookmarking
 * Manifest V3 Content Script for gemini.google.com
 */

(function () {
  'use strict';

  // =========================================================================
  // 1. EXTENSION CONTEXT & STORAGE RESILIENCE
  // =========================================================================

  const isContextValid = () =>
    typeof chrome !== 'undefined' && chrome.runtime && !!chrome.runtime.id;

  async function safeGet(key) {
    let localVal = null;
    try {
      const raw = window.localStorage.getItem(key);
      if (raw !== null) {
        localVal = JSON.parse(raw);
      }
    } catch (_) {}

    if (!isContextValid()) {
      return { [key]: localVal };
    }

    try {
      return new Promise((resolve) => {
        chrome.storage.local.get([key], (res) => {
          if (chrome.runtime && chrome.runtime.lastError) {
            resolve({ [key]: localVal });
          } else if (res && res[key] !== undefined) {
            try {
              window.localStorage.setItem(key, JSON.stringify(res[key]));
            } catch (_) {}
            resolve(res);
          } else {
            resolve({ [key]: localVal });
          }
        });
      });
    } catch (_) {
      return { [key]: localVal };
    }
  }

  async function safeSet(key, val) {
    try {
      window.localStorage.setItem(key, JSON.stringify(val));
    } catch (_) {}

    if (isContextValid()) {
      try {
        return new Promise((resolve) => {
          chrome.storage.local.set({ [key]: val }, () => {
            if (chrome.runtime && chrome.runtime.lastError) {
              // Ignore invalidation errors silently
            }
            resolve();
          });
        });
      } catch (_) {}
    }
  }

  function getChatId() {
    const match = window.location.pathname.match(/\/app\/([a-zA-Z0-9_-]+)/);
    return match ? match[1] : 'default';
  }

  function getStorageKey() {
    return 'gemini_pinboard_pins_' + getChatId();
  }

  // =========================================================================
  // 2. SCROLL CONTAINER & CHAT BOUNDS DETECTION
  // =========================================================================

  function getScrollContainer() {
    // 1. Walk up from conversation turn elements
    const turnSelectors = [
      'message-content',
      'ms-chat-turn',
      'user-query',
      'model-response',
      '[data-test-id*="turn"]',
      '.turn-content',
      '.conversation-container',
      '.chat-history'
    ];

    for (const sel of turnSelectors) {
      const els = document.querySelectorAll(sel);
      if (els.length > 0) {
        const target = els[els.length - 1];
        let curr = target.parentElement;
        while (curr && curr !== document.body && curr !== document.documentElement) {
          const style = window.getComputedStyle(curr);
          if (
            (style.overflowY === 'auto' || style.overflowY === 'scroll') &&
            curr.scrollHeight > curr.clientHeight
          ) {
            return curr;
          }
          curr = curr.parentElement;
        }
      }
    }

    // 2. Check main and infinite-scroller elements
    const mainCandidates = document.querySelectorAll(
      'main, infinite-scroller, [role="main"], [class*="scroller"], [class*="chat-container"]'
    );
    for (const el of mainCandidates) {
      const style = window.getComputedStyle(el);
      if (
        (style.overflowY === 'auto' || style.overflowY === 'scroll') &&
        el.scrollHeight > el.clientHeight
      ) {
        return el;
      }
      if (el.parentElement) {
        const pStyle = window.getComputedStyle(el.parentElement);
        if (
          (pStyle.overflowY === 'auto' || pStyle.overflowY === 'scroll') &&
          el.parentElement.scrollHeight > el.parentElement.clientHeight
        ) {
          return el.parentElement;
        }
      }
    }

    // 3. Fallback search across scrollable DOM elements
    const divs = document.querySelectorAll('div, section, article');
    let bestEl = null;
    let maxDiff = 0;
    for (const el of divs) {
      if (el.clientHeight > 200 && el.scrollHeight > el.clientHeight) {
        const style = window.getComputedStyle(el);
        if (style.overflowY === 'auto' || style.overflowY === 'scroll') {
          const diff = el.scrollHeight - el.clientHeight;
          if (diff > maxDiff) {
            maxDiff = diff;
            bestEl = el;
          }
        }
      }
    }
    if (bestEl) return bestEl;

    return document.scrollingElement || document.documentElement || document.body;
  }

  function getChatBounds() {
    const sc = getScrollContainer();
    const turn = document.querySelector(
      'message-content, ms-chat-turn, user-query, model-response, [data-test-id*="turn"]'
    );
    if (turn) {
      const parentCol =
        turn.closest(
          '.conversation-container, main, infinite-scroller, [class*="chat-container"], [role="main"]'
        ) || turn.parentElement;
      if (parentCol) {
        const rect = parentCol.getBoundingClientRect();
        if (rect.width > 280) {
          return {
            left: rect.left,
            right: rect.right,
            width: rect.width,
            top: rect.top,
            bottom: rect.bottom
          };
        }
      }
    }

    if (sc && sc !== document.body && sc !== document.documentElement) {
      const rect = sc.getBoundingClientRect();
      if (rect.width > 280) {
        return {
          left: rect.left,
          right: rect.right,
          width: rect.width,
          top: rect.top,
          bottom: rect.bottom
        };
      }
    }

    const colWidth = Math.min(window.innerWidth - 64, 820);
    const left = Math.max(0, (window.innerWidth - colWidth) / 2);
    return {
      left,
      right: left + colWidth,
      width: colWidth,
      top: 0,
      bottom: window.innerHeight
    };
  }

  // =========================================================================
  // 3. CLEAN INITIALIZATION & SHADOW DOM MOUNTING
  // =========================================================================

  const existingHosts = document.querySelectorAll('gemini-pinboard-host');
  existingHosts.forEach((h) => h.remove());

  const hostEl = document.createElement('gemini-pinboard-host');
  document.body.appendChild(hostEl);
  const shadow = hostEl.attachShadow({ mode: 'open' });

  // Component SVG Icons
  const SVG_PIN = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M12 17v5"></path>
    <path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"></path>
  </svg>`;

  const SVG_CHEVRON = `<svg class="chevron-icon" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
    <polyline points="6 9 12 15 18 9"></polyline>
  </svg>`;

  const SVG_PENCIL = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"></path>
  </svg>`;

  const SVG_CHECK = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
    <polyline points="20 6 9 17 4 12"></polyline>
  </svg>`;

  const SVG_CLOSE = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
    <line x1="18" y1="6" x2="6" y2="18"></line>
    <line x1="6" y1="6" x2="18" y2="18"></line>
  </svg>`;

  // Encapsulated Shadow DOM Styles
  const styleEl = document.createElement('style');
  styleEl.textContent = `
    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      -webkit-font-smoothing: antialiased;
    }

    :host {
      all: initial;
      pointer-events: none;
    }

    /* Fixed Top-Right Dispenser Pill */
    .dispenser-container {
      position: fixed;
      top: 20px;
      right: 24px;
      z-index: 2147483646;
      pointer-events: auto;
      user-select: none;
    }

    .dispenser-pill {
      display: inline-flex;
      align-items: center;
      height: 36px;
      background: #1e1f20;
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 20px;
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.45), 0 1px 3px rgba(0, 0, 0, 0.3);
      backdrop-filter: blur(14px);
      -webkit-backdrop-filter: blur(14px);
      transition: border-color 0.15s ease, box-shadow 0.15s ease;
    }

    .dispenser-pill:hover {
      border-color: rgba(255, 255, 255, 0.14);
    }

    /* Left Zone: The Pin Bucket */
    .pin-bucket-zone {
      display: flex;
      align-items: center;
      gap: 6px;
      height: 100%;
      padding: 0 12px 0 13px;
      cursor: grab;
      border-radius: 20px 0 0 20px;
      color: #c4c7c5;
      transition: background 0.15s ease, color 0.15s ease;
    }

    .pin-bucket-zone:hover {
      background: #2b2c2f;
      color: #e3e3e3;
    }

    .pin-bucket-zone:active,
    .pin-bucket-zone.grabbing {
      cursor: grabbing;
      background: #2b2c2f;
      color: #ffffff;
    }

    .bucket-label {
      font-size: 12px;
      font-weight: 500;
      color: #e3e3e3;
      letter-spacing: -0.01em;
    }

    .pill-divider {
      width: 1px;
      height: 18px;
      background: rgba(255, 255, 255, 0.08);
    }

    /* Right Zone: Dropdown Toggle */
    .dropdown-toggle-zone {
      display: flex;
      align-items: center;
      gap: 6px;
      height: 100%;
      padding: 0 13px 0 9px;
      cursor: pointer;
      border-radius: 0 20px 20px 0;
      color: #9aa0a6;
      transition: background 0.15s ease;
    }

    .dropdown-toggle-zone:hover {
      background: #2b2c2f;
    }

    .dropdown-toggle-zone.disabled {
      cursor: default;
      opacity: 0.65;
    }

    .dropdown-toggle-zone.disabled:hover {
      background: transparent;
    }

    .count-badge {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-width: 18px;
      height: 18px;
      padding: 0 5px;
      border-radius: 9px;
      background: rgba(255, 255, 255, 0.08);
      color: #e3e3e3;
      font-size: 11px;
      font-weight: 500;
      line-height: 1;
    }

    .chevron-icon {
      transition: transform 0.2s cubic-bezier(0.16, 1, 0.3, 1);
      color: #9aa0a6;
    }

    .chevron-icon.open {
      transform: rotate(180deg);
    }

    /* Dropdown Popover List */
    .dropdown-menu {
      position: absolute;
      top: calc(100% + 8px);
      right: 0;
      width: 240px;
      background: #1e1f20;
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 12px;
      box-shadow: 0 12px 36px rgba(0, 0, 0, 0.55), 0 2px 8px rgba(0, 0, 0, 0.3);
      backdrop-filter: blur(14px);
      -webkit-backdrop-filter: blur(14px);
      display: none;
      flex-direction: column;
      overflow: hidden;
      z-index: 2147483647;
      animation: fadeInDropdown 0.15s ease-out;
    }

    .dropdown-menu.visible {
      display: flex;
    }

    @keyframes fadeInDropdown {
      from {
        opacity: 0;
        transform: translateY(-4px) scale(0.98);
      }
      to {
        opacity: 1;
        transform: translateY(0) scale(1);
      }
    }

    .pins-scroll-list {
      display: flex;
      flex-direction: column;
      max-height: 272px; /* 8 rows * 34px = 272px */
      overflow-y: auto;
      overscroll-behavior: contain;
    }

    .pins-scroll-list::-webkit-scrollbar {
      width: 5px;
    }

    .pins-scroll-list::-webkit-scrollbar-track {
      background: transparent;
    }

    .pins-scroll-list::-webkit-scrollbar-thumb {
      background: rgba(255, 255, 255, 0.12);
      border-radius: 4px;
    }

    .pins-scroll-list::-webkit-scrollbar-thumb:hover {
      background: rgba(255, 255, 255, 0.22);
    }

    /* STRICT SINGLE-LINE PIN ROW */
    .pin-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      height: 34px;
      padding: 0 10px;
      gap: 8px;
      white-space: nowrap;
      cursor: pointer;
      transition: background 0.12s ease;
      position: relative;
    }

    .pin-row:hover {
      background: #2b2c2f;
    }

    .pin-row-left {
      display: flex;
      align-items: center;
      gap: 7px;
      flex: 1;
      min-width: 0;
    }

    .pin-blue-dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: #c4c7c5;
      flex-shrink: 0;
      box-shadow: 0 0 4px rgba(255, 255, 255, 0.2);
    }

    .pin-name {
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-size: 13px;
      color: #e3e3e3;
      font-weight: 400;
      line-height: 1.2;
    }

    .pin-row-right {
      display: flex;
      align-items: center;
      gap: 6px;
      flex-shrink: 0;
    }

    .pin-time {
      font-size: 11px;
      color: #8e918f;
      font-variant-numeric: tabular-nums;
      user-select: none;
    }

    .pin-action-btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 20px;
      height: 20px;
      border-radius: 4px;
      border: none;
      background: transparent;
      color: #9aa0a6;
      cursor: pointer;
      padding: 0;
      opacity: 0.6;
      transition: opacity 0.12s ease, background 0.12s ease, color 0.12s ease;
    }

    .pin-action-btn:hover {
      opacity: 1;
      background: rgba(255, 255, 255, 0.08);
      color: #e3e3e3;
    }

    .pin-remove-btn:hover {
      opacity: 1;
      background: rgba(255, 255, 255, 0.1);
      color: #ffffff;
    }

    /* Inline Rename Row */
    .rename-container {
      display: flex;
      align-items: center;
      gap: 6px;
      width: 100%;
      padding: 0 4px;
    }

    .rename-input {
      flex: 1;
      height: 24px;
      background: #141517;
      border: 1px solid rgba(255, 255, 255, 0.2);
      border-radius: 4px;
      color: #e3e3e3;
      font-size: 12px;
      padding: 0 6px;
      outline: none;
      box-shadow: 0 0 0 2px rgba(255, 255, 255, 0.06);
    }

    /* Dragging Laser Guide & Floating Badge */
    .laser-guide-line {
      position: fixed;
      left: 0;
      width: 100%;
      height: 2px;
      pointer-events: none;
      z-index: 2147483645;
      background: linear-gradient(
        90deg,
        rgba(255, 255, 255, 0) 0%,
        rgba(255, 255, 255, 0.6) 15%,
        rgba(255, 255, 255, 0.9) 50%,
        rgba(255, 255, 255, 0.6) 85%,
        rgba(255, 255, 255, 0) 100%
      );
      box-shadow: 0 0 8px rgba(255, 255, 255, 0.4), 0 0 16px rgba(255, 255, 255, 0.15);
      display: none;
    }

    .floating-drag-badge {
      position: fixed;
      pointer-events: none;
      z-index: 2147483647;
      transform: translate(-50%, -130%);
      background: #1e1f20;
      border: 1px solid rgba(255, 255, 255, 0.16);
      border-radius: 12px;
      padding: 4px 10px;
      font-size: 11px;
      font-weight: 500;
      color: #e3e3e3;
      display: none;
      align-items: center;
      gap: 5px;
      box-shadow: 0 6px 20px rgba(0, 0, 0, 0.6);
      white-space: nowrap;
    }

    /* Jump Guide Flash Line */
    .jump-flash-line {
      position: fixed;
      left: 0;
      width: 100%;
      height: 2px;
      pointer-events: none;
      z-index: 2147483645;
      background: linear-gradient(
        90deg,
        rgba(255, 255, 255, 0) 0%,
        rgba(255, 255, 255, 0.85) 20%,
        rgba(255, 255, 255, 0.85) 80%,
        rgba(255, 255, 255, 0) 100%
      );
      box-shadow: 0 0 12px rgba(255, 255, 255, 0.5), 0 0 24px rgba(255, 255, 255, 0.2);
      animation: guidePulse 1.5s cubic-bezier(0.16, 1, 0.3, 1) forwards;
    }

    @keyframes guidePulse {
      0% {
        opacity: 1;
        transform: scaleY(2.2);
      }
      40% {
        opacity: 1;
        transform: scaleY(1);
      }
      80% {
        opacity: 0.8;
      }
      100% {
        opacity: 0;
        transform: scaleY(0.5);
      }
    }

    /* Inline Drop Naming Popover */
    .naming-popover {
      position: fixed;
      z-index: 2147483647;
      pointer-events: auto;
      background: #1e1f20;
      border: 1px solid rgba(255, 255, 255, 0.14);
      border-radius: 10px;
      padding: 6px 8px;
      box-shadow: 0 12px 32px rgba(0, 0, 0, 0.6), 0 0 0 1px rgba(255, 255, 255, 0.05);
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
      display: none;
      align-items: center;
      gap: 6px;
      animation: popIn 0.16s cubic-bezier(0.16, 1, 0.3, 1);
    }

    @keyframes popIn {
      from {
        opacity: 0;
        transform: scale(0.92);
      }
      to {
        opacity: 1;
        transform: scale(1);
      }
    }

    .naming-popover input {
      width: 130px;
      height: 26px;
      background: #141517;
      border: 1px solid rgba(255, 255, 255, 0.14);
      border-radius: 6px;
      color: #e3e3e3;
      font-size: 12px;
      padding: 0 8px;
      outline: none;
      transition: border-color 0.15s ease, box-shadow 0.15s ease;
    }

    .naming-popover input:focus {
      border-color: rgba(255, 255, 255, 0.35);
      box-shadow: 0 0 0 2px rgba(255, 255, 255, 0.08);
    }

    .naming-popover button {
      height: 26px;
      padding: 0 10px;
      background: #2b2c2f;
      border: 1px solid rgba(255, 255, 255, 0.12);
      border-radius: 6px;
      color: #e3e3e3;
      font-size: 11px;
      font-weight: 500;
      cursor: pointer;
      transition: background 0.15s ease, color 0.15s ease;
    }

    .naming-popover button:hover {
      background: #383a3e;
      color: #ffffff;
    }

    /* Visual Pin Markers on Chat Right Edge */
    .page-pin-marker {
      position: fixed;
      pointer-events: auto;
      z-index: 2147483640;
      display: flex;
      flex-direction: row-reverse;
      align-items: center;
      transform: translateY(-50%);
      transition: opacity 0.15s ease;
    }

    .page-pin-tick {
      width: 8px;
      height: 16px;
      background: #8e918f;
      border-radius: 4px;
      cursor: pointer;
      box-shadow: 0 0 6px rgba(255, 255, 255, 0.2);
      transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1);
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
    }

    .page-pin-marker:hover .page-pin-tick {
      width: 12px;
      background: #e3e3e3;
      box-shadow: 0 0 10px rgba(255, 255, 255, 0.4);
    }

    .page-pin-hover-badge {
      display: none;
      align-items: center;
      gap: 6px;
      background: #1e1f20;
      border: 1px solid rgba(255, 255, 255, 0.14);
      border-radius: 12px;
      padding: 3px 8px 3px 10px;
      margin-right: 6px;
      box-shadow: 0 4px 16px rgba(0, 0, 0, 0.5);
      white-space: nowrap;
      cursor: pointer;
    }

    .page-pin-marker:hover .page-pin-hover-badge {
      display: inline-flex;
    }

    .page-pin-hover-text {
      font-size: 11px;
      color: #e3e3e3;
      font-weight: 500;
    }

    .page-pin-hover-delete {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 16px;
      height: 16px;
      border-radius: 50%;
      color: #9aa0a6;
      cursor: pointer;
      font-size: 13px;
      line-height: 1;
      transition: background 0.12s ease, color 0.12s ease;
    }

    .page-pin-hover-delete:hover {
      background: rgba(255, 255, 255, 0.12);
      color: #ffffff;
    }
  `;
  shadow.appendChild(styleEl);

  // Wrapper element
  const container = document.createElement('div');
  container.className = 'gemini-pinboard-root';
  shadow.appendChild(container);

  // Create UI Structure
  container.innerHTML = `
    <!-- Top-Right Dispenser Pill -->
    <div class="dispenser-container">
      <div class="dispenser-pill" id="dispenserPill">
        <div class="pin-bucket-zone" id="pinBucket" title="Drag to place vertical pin bookmark">
          ${SVG_PIN}
          <span class="bucket-label">Pin</span>
        </div>
        <div class="pill-divider"></div>
        <div class="dropdown-toggle-zone" id="dropdownToggle" title="Toggle pinned bookmarks">
          <span class="count-badge" id="pinCountBadge">0</span>
          ${SVG_CHEVRON}
        </div>
      </div>
      <div class="dropdown-menu" id="dropdownMenu">
        <div class="pins-scroll-list" id="pinsScrollList"></div>
      </div>
    </div>

    <!-- Dragging Guides -->
    <div class="laser-guide-line" id="laserGuide"></div>
    <div class="floating-drag-badge" id="dragBadge">
      ${SVG_PIN}
      <span>Drop to place pin</span>
    </div>

    <!-- Naming Popover -->
    <div class="naming-popover" id="namingPopover">
      <input type="text" id="pinNameInput" placeholder="Pin name" maxlength="30" spellcheck="false" />
      <button id="savePinBtn">Save</button>
    </div>

    <!-- Container for dynamic visual markers on page -->
    <div id="pageMarkersContainer"></div>
  `;

  // UI Elements
  const dispenserPill = shadow.getElementById('dispenserPill');
  const pinBucket = shadow.getElementById('pinBucket');
  const dropdownToggle = shadow.getElementById('dropdownToggle');
  const pinCountBadge = shadow.getElementById('pinCountBadge');
  const dropdownMenu = shadow.getElementById('dropdownMenu');
  const pinsScrollList = shadow.getElementById('pinsScrollList');
  const chevronIcon = shadow.querySelector('.chevron-icon');
  const laserGuide = shadow.getElementById('laserGuide');
  const dragBadge = shadow.getElementById('dragBadge');
  const namingPopover = shadow.getElementById('namingPopover');
  const pinNameInput = shadow.getElementById('pinNameInput');
  const savePinBtn = shadow.getElementById('savePinBtn');
  const pageMarkersContainer = shadow.getElementById('pageMarkersContainer');

  // State
  let pins = [];
  let isDropdownOpen = true;
  let activeDropData = null;
  let dropTimestamp = 0;
  let isDragging = false;
  let autoScrollRaf = null;
  let currentPointerY = 0;
  let editingPinId = null;

  // =========================================================================
  // 4. STORAGE SYNC & URL SPA MANAGEMENT
  // =========================================================================

  let currentChatKey = getStorageKey();

  async function loadPins() {
    const key = getStorageKey();
    currentChatKey = key;
    const res = await safeGet(key);
    pins = Array.isArray(res[key]) ? res[key] : [];
    renderUI();
  }

  async function persistPins() {
    await safeSet(currentChatKey, pins);
    renderUI();
  }

  // Observe URL changes for SPA navigation in Gemini
  let lastUrl = window.location.href;
  setInterval(() => {
    if (window.location.href !== lastUrl) {
      lastUrl = window.location.href;
      const newKey = getStorageKey();
      if (newKey !== currentChatKey) {
        // If transitioning from default /app to /app/<id>, migrate pins seamlessly
        if (currentChatKey.endsWith('_default') && pins.length > 0) {
          const oldPins = [...pins];
          currentChatKey = newKey;
          safeGet(newKey).then((existing) => {
            if (!existing[newKey] || existing[newKey].length === 0) {
              pins = oldPins;
              persistPins();
            } else {
              loadPins();
            }
          });
        } else {
          loadPins();
        }
      }
    }
  }, 1000);

  window.addEventListener('popstate', () => {
    loadPins();
  });

  // =========================================================================
  // 5. RENDERING (DROPDOWN + PAGE PIN MARKERS)
  // =========================================================================

  function renderUI() {
    const count = pins.length;
    pinCountBadge.textContent = count;

    if (count === 0) {
      dropdownToggle.classList.add('disabled');
      dropdownMenu.classList.remove('visible');
      chevronIcon.classList.remove('open');
    } else {
      dropdownToggle.classList.remove('disabled');
      if (isDropdownOpen) {
        dropdownMenu.classList.add('visible');
        chevronIcon.classList.add('open');
      } else {
        dropdownMenu.classList.remove('visible');
        chevronIcon.classList.remove('open');
      }
    }

    renderDropdownList();
    renderPageMarkers();
  }

  function renderDropdownList() {
    pinsScrollList.innerHTML = '';

    if (pins.length === 0) {
      return;
    }

    pins.forEach((pin) => {
      const row = document.createElement('div');
      row.className = 'pin-row';
      row.dataset.id = pin.id;

      if (editingPinId === pin.id) {
        // Inline rename input mode
        row.innerHTML = `
          <div class="rename-container">
            <input type="text" class="rename-input" value="${escapeHtml(pin.name)}" maxlength="30" spellcheck="false" />
            <button class="pin-action-btn" title="Confirm" data-action="confirm-rename">${SVG_CHECK}</button>
          </div>
        `;

        const renameInput = row.querySelector('.rename-input');
        setTimeout(() => {
          renameInput.focus();
          renameInput.select();
        }, 10);

        const commitRename = () => {
          const newName = renameInput.value.trim();
          if (newName && newName !== pin.name) {
            pin.name = newName;
            persistPins();
          }
          editingPinId = null;
          renderDropdownList();
        };

        renameInput.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') {
            commitRename();
          } else if (e.key === 'Escape') {
            editingPinId = null;
            renderDropdownList();
          }
        });

        renameInput.addEventListener('blur', () => {
          commitRename();
        });

        row.querySelector('[data-action="confirm-rename"]').addEventListener('click', (e) => {
          e.stopPropagation();
          commitRename();
        });
      } else {
        // STRICT SINGLE-LINE PIN ROW
        row.innerHTML = `
          <div class="pin-row-left">
            <div class="pin-blue-dot"></div>
            <span class="pin-name" title="${escapeHtml(pin.name)}">${escapeHtml(pin.name)}</span>
          </div>
          <div class="pin-row-right">
            <span class="pin-time">${escapeHtml(pin.timeStr || '')}</span>
            <button class="pin-action-btn pin-rename-btn" title="Rename pin" data-action="rename">
              ${SVG_PENCIL}
            </button>
            <button class="pin-action-btn pin-remove-btn" title="Delete pin" data-action="remove">
              ${SVG_CLOSE}
            </button>
          </div>
        `;

        // Row click -> Accurate Jump
        row.addEventListener('click', (e) => {
          if (e.target.closest('.pin-action-btn')) return;
          jumpToPin(pin);
        });

        // Rename click
        const renameBtn = row.querySelector('[data-action="rename"]');
        renameBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          editingPinId = pin.id;
          renderDropdownList();
        });

        // Remove click
        const removeBtn = row.querySelector('[data-action="remove"]');
        removeBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          deletePin(pin.id);
        });
      }

      pinsScrollList.appendChild(row);
    });
  }

  function deletePin(pinId) {
    pins = pins.filter((p) => p.id !== pinId);
    persistPins();
  }

  function escapeHtml(str) {
    if (!str) return '';
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // =========================================================================
  // 6. DUAL VERTICAL ANCHORING & ACCURATE JUMP EXECUTION
  // =========================================================================

  function capturePinTarget(dropClientY) {
    const scrollContainer = getScrollContainer();
    const scRect = scrollContainer.getBoundingClientRect();
    const absoluteY = scrollContainer.scrollTop + (dropClientY - scRect.top);

    // Filter elements at the vertical line
    const elements = document.elementsFromPoint(window.innerWidth / 2, dropClientY) || [];
    let targetElement = null;

    for (const el of elements) {
      if (el.closest('gemini-pinboard-host')) continue;
      if (el === scrollContainer || el === document.body || el === document.documentElement)
        continue;
      const text = el.textContent ? el.textContent.trim() : '';
      if (text && el.clientHeight < 600) {
        targetElement = el;
        break;
      }
    }

    if (!targetElement) {
      for (const el of elements) {
        if (el.closest('gemini-pinboard-host')) continue;
        if (el !== scrollContainer && el !== document.body && el !== document.documentElement) {
          targetElement = el;
          break;
        }
      }
    }

    let fingerprint = '';
    let offsetWithinElement = 0;

    if (targetElement) {
      const text = targetElement.textContent ? targetElement.textContent.trim() : '';
      fingerprint = text.slice(0, 60);
      const targetRect = targetElement.getBoundingClientRect();
      offsetWithinElement = dropClientY - targetRect.top;
    }

    return {
      absoluteY,
      dropClientY,
      fingerprint,
      offsetWithinElement
    };
  }

  function jumpToPin(pin) {
    const scrollContainer = getScrollContainer();
    const viewportHeight = window.innerHeight;

    let matchedElement = null;
    if (pin.fingerprint) {
      const candidates = scrollContainer.querySelectorAll(
        'p, li, code, pre, h1, h2, h3, h4, h5, h6, span, blockquote, div'
      );
      for (const el of candidates) {
        if (el.clientHeight < 600 && el.textContent) {
          const txt = el.textContent.trim().slice(0, 60);
          if (txt === pin.fingerprint) {
            matchedElement = el;
            break;
          }
        }
      }
    }

    let targetScrollTop;
    let flashAbsoluteY;

    if (matchedElement) {
      const elRect = matchedElement.getBoundingClientRect();
      const scRect = scrollContainer.getBoundingClientRect();
      const elementTopInScrollContainer = elRect.top - scRect.top + scrollContainer.scrollTop;
      flashAbsoluteY = elementTopInScrollContainer + (pin.offsetWithinElement || 0);
      targetScrollTop = flashAbsoluteY - viewportHeight * 0.25;
    } else {
      flashAbsoluteY = pin.absoluteY;
      targetScrollTop = pin.absoluteY - viewportHeight * 0.25;
    }

    scrollContainer.scrollTo({
      top: Math.max(0, targetScrollTop),
      behavior: 'smooth'
    });

    // Flash a horizontal guide line across chat at that exact vertical spot for 1.5 seconds
    flashHorizontalLine(flashAbsoluteY);
  }

  function flashHorizontalLine(flashAbsoluteY) {
    // Remove previous flash line if active
    const oldFlash = shadow.querySelector('.jump-flash-line');
    if (oldFlash) oldFlash.remove();

    const flash = document.createElement('div');
    flash.className = 'jump-flash-line';
    shadow.appendChild(flash);

    const chatBounds = getChatBounds();
    flash.style.left = `${chatBounds.left}px`;
    flash.style.width = `${chatBounds.width}px`;

    const startTime = performance.now();
    const duration = 1500;

    function updateFlash() {
      const scrollContainer = getScrollContainer();
      const scRect = scrollContainer.getBoundingClientRect();
      const currentClientY = flashAbsoluteY - scrollContainer.scrollTop + scRect.top;

      flash.style.top = `${currentClientY}px`;

      if (performance.now() - startTime < duration) {
        requestAnimationFrame(updateFlash);
      } else {
        flash.remove();
      }
    }

    requestAnimationFrame(updateFlash);
  }

  // =========================================================================
  // 7. VISUAL PIN MARKERS ON THE PAGE
  // =========================================================================

  function renderPageMarkers() {
    pageMarkersContainer.innerHTML = '';
    if (pins.length === 0) return;

    pins.forEach((pin) => {
      const marker = document.createElement('div');
      marker.className = 'page-pin-marker';
      marker.dataset.pinId = pin.id;
      marker.innerHTML = `
        <div class="page-pin-tick" title="Pin: ${escapeHtml(pin.name)}"></div>
        <div class="page-pin-hover-badge">
          <span class="page-pin-hover-text">${escapeHtml(pin.name)}</span>
          <span class="page-pin-hover-delete" title="Delete pin">×</span>
        </div>
      `;

      marker.querySelector('.page-pin-tick').addEventListener('click', (e) => {
        e.stopPropagation();
        jumpToPin(pin);
      });

      marker.querySelector('.page-pin-hover-badge').addEventListener('click', (e) => {
        if (e.target.classList.contains('page-pin-hover-delete')) return;
        e.stopPropagation();
        jumpToPin(pin);
      });

      marker.querySelector('.page-pin-hover-delete').addEventListener('click', (e) => {
        e.stopPropagation();
        deletePin(pin.id);
      });

      pageMarkersContainer.appendChild(marker);
    });

    updateMarkerPositions();
  }

  let markerSyncScheduled = false;
  function scheduleMarkerSync() {
    if (!markerSyncScheduled) {
      markerSyncScheduled = true;
      requestAnimationFrame(() => {
        markerSyncScheduled = false;
        updateMarkerPositions();
      });
    }
  }

  function updateMarkerPositions() {
    if (pins.length === 0) return;
    const scrollContainer = getScrollContainer();
    const scRect = scrollContainer.getBoundingClientRect();
    const chatBounds = getChatBounds();
    const markers = pageMarkersContainer.querySelectorAll('.page-pin-marker');

    markers.forEach((marker) => {
      const pinId = marker.dataset.pinId;
      const pin = pins.find((p) => p.id === pinId);
      if (!pin) {
        marker.style.display = 'none';
        return;
      }

      let clientY;
      let matchedEl = null;
      if (pin.fingerprint) {
        const candidates = scrollContainer.querySelectorAll(
          'p, li, code, pre, h1, h2, h3, h4, h5, h6, span, blockquote, div'
        );
        for (const el of candidates) {
          if (el.clientHeight < 600 && el.textContent) {
            const txt = el.textContent.trim().slice(0, 60);
            if (txt === pin.fingerprint) {
              matchedEl = el;
              break;
            }
          }
        }
      }

      if (matchedEl) {
        const elRect = matchedEl.getBoundingClientRect();
        clientY = elRect.top + (pin.offsetWithinElement || 0);
      } else {
        clientY = scRect.top + (pin.absoluteY - scrollContainer.scrollTop);
      }

      // Check if within visible bounds of scroll container
      if (clientY < scRect.top - 20 || clientY > scRect.bottom + 20) {
        marker.style.display = 'none';
      } else {
        marker.style.display = 'flex';
        marker.style.top = `${clientY}px`;
        const markerX = Math.min(window.innerWidth - 18, Math.max(20, chatBounds.right));
        marker.style.left = `${markerX}px`;
      }
    });
  }

  // Hook scroll and resize events for marker syncing
  window.addEventListener('resize', scheduleMarkerSync, { passive: true });
  window.addEventListener('scroll', scheduleMarkerSync, { passive: true, capture: true });

  // Periodically check if scroll container changed or layout shifted
  setInterval(() => {
    scheduleMarkerSync();
  }, 400);

  // =========================================================================
  // 8. INTERACTION FLOW: DRAG FROM BUCKET & VERTICAL LASER GUIDE
  // =========================================================================

  function startAutoScroll() {
    if (autoScrollRaf) return;
    const scrollLoop = () => {
      if (!isDragging) {
        autoScrollRaf = null;
        return;
      }
      const scrollContainer = getScrollContainer();
      const edge = 60;
      const vh = window.innerHeight;

      if (currentPointerY < edge && currentPointerY >= 0) {
        const delta = Math.max(3, (edge - currentPointerY) * 0.3);
        scrollContainer.scrollTop -= delta;
        scheduleMarkerSync();
      } else if (currentPointerY > vh - edge && currentPointerY <= vh) {
        const delta = Math.max(3, (currentPointerY - (vh - edge)) * 0.3);
        scrollContainer.scrollTop += delta;
        scheduleMarkerSync();
      }
      autoScrollRaf = requestAnimationFrame(scrollLoop);
    };
    autoScrollRaf = requestAnimationFrame(scrollLoop);
  }

  function stopAutoScroll() {
    if (autoScrollRaf) {
      cancelAnimationFrame(autoScrollRaf);
      autoScrollRaf = null;
    }
  }

  pinBucket.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return; // Only primary button
    e.preventDefault();
    e.stopPropagation();

    isDragging = true;
    currentPointerY = e.clientY;
    pinBucket.classList.add('grabbing');

    // Close naming popover if open
    namingPopover.style.display = 'none';
    activeDropData = null;

    // Show guide elements
    laserGuide.style.display = 'block';
    dragBadge.style.display = 'flex';

    updateDragGuides(e.clientX, e.clientY);
    startAutoScroll();

    const onPointerMove = (moveEvt) => {
      if (!isDragging) return;
      currentPointerY = moveEvt.clientY;
      updateDragGuides(moveEvt.clientX, moveEvt.clientY);
    };

    const onPointerUp = (upEvt) => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('keydown', onKeyDown);

      if (!isDragging) return;
      isDragging = false;
      stopAutoScroll();
      pinBucket.classList.remove('grabbing');

      laserGuide.style.display = 'none';
      dragBadge.style.display = 'none';

      // Check if dropped inside dispenser pill
      const pillRect = dispenserPill.getBoundingClientRect();
      const isInsidePill =
        upEvt.clientX >= pillRect.left &&
        upEvt.clientX <= pillRect.right &&
        upEvt.clientY >= pillRect.top &&
        upEvt.clientY <= pillRect.bottom;

      if (isInsidePill) {
        return; // Canceled drop onto pill
      }

      handleDropPin(upEvt.clientX, upEvt.clientY);
    };

    const onKeyDown = (keyEvt) => {
      if (keyEvt.key === 'Escape') {
        window.removeEventListener('pointermove', onPointerMove);
        window.removeEventListener('pointerup', onPointerUp);
        window.removeEventListener('keydown', onKeyDown);

        isDragging = false;
        stopAutoScroll();
        pinBucket.classList.remove('grabbing');
        laserGuide.style.display = 'none';
        dragBadge.style.display = 'none';
      }
    };

    window.addEventListener('pointermove', onPointerMove, { passive: true });
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('keydown', onKeyDown);
  });

  function updateDragGuides(clientX, clientY) {
    const chatBounds = getChatBounds();
    laserGuide.style.left = `${chatBounds.left}px`;
    laserGuide.style.width = `${chatBounds.width}px`;
    laserGuide.style.top = `${clientY}px`;

    dragBadge.style.left = `${clientX}px`;
    dragBadge.style.top = `${clientY}px`;
  }

  // =========================================================================
  // 9. DROPPING & INSTANT NAMING (ping{N} default, Newest at Top)
  // =========================================================================

  function calculateNextPingName() {
    let maxNum = 0;
    pins.forEach((p) => {
      const match = (p.name || '').match(/^ping(\d+)$/i);
      if (match) {
        const n = parseInt(match[1], 10);
        if (!isNaN(n) && n > maxNum) {
          maxNum = n;
        }
      }
    });
    return `ping${maxNum + 1}`;
  }

  function handleDropPin(dropClientX, dropClientY) {
    const dropData = capturePinTarget(dropClientY);
    const defaultName = calculateNextPingName();

    activeDropData = {
      ...dropData,
      defaultName
    };
    dropTimestamp = performance.now();

    // Position naming popover near drop point, clamped safely inside viewport
    const popoverX = Math.min(window.innerWidth - 220, Math.max(16, dropClientX - 90));
    const popoverY = Math.max(16, Math.min(window.innerHeight - 60, dropClientY - 20));

    namingPopover.style.left = `${popoverX}px`;
    namingPopover.style.top = `${popoverY}px`;
    namingPopover.style.display = 'flex';

    pinNameInput.value = defaultName;
    setTimeout(() => {
      pinNameInput.focus();
      pinNameInput.select();
    }, 20);
  }

  function commitNewPin() {
    if (!activeDropData) return;

    const enteredName = pinNameInput.value.trim();
    const pinName = enteredName || activeDropData.defaultName;

    const timeStr = new Date().toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    });

    const newPin = {
      id: `pin_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      name: pinName,
      absoluteY: activeDropData.absoluteY,
      dropClientY: activeDropData.dropClientY,
      fingerprint: activeDropData.fingerprint,
      offsetWithinElement: activeDropData.offsetWithinElement,
      createdAt: Date.now(),
      timeStr
    };

    // IMPORTANT: Always insert at VERY TOP (.unshift(newPin)), never sort by absoluteY
    pins.unshift(newPin);
    isDropdownOpen = true; // Dropdown stays open when new pin is added
    persistPins();

    activeDropData = null;
    namingPopover.style.display = 'none';

    // Flash horizontal guide line at dropped location
    flashHorizontalLine(newPin.absoluteY);
  }

  pinNameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      commitNewPin();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      activeDropData = null;
      namingPopover.style.display = 'none';
    }
  });

  savePinBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    commitNewPin();
  });

  pinNameInput.addEventListener('blur', (e) => {
    if (e.relatedTarget === savePinBtn) return;
    // Commit only if click was outside after the popover was active
    if (activeDropData && performance.now() - dropTimestamp > 400) {
      commitNewPin();
    }
  });

  // =========================================================================
  // 10. DROPDOWN TOGGLE & GLOBAL CLICKS
  // =========================================================================

  dropdownToggle.addEventListener('click', (e) => {
    e.stopPropagation();
    if (pins.length === 0) return;

    // Toggle dropdown manually
    isDropdownOpen = !isDropdownOpen;
    if (isDropdownOpen) {
      dropdownMenu.classList.add('visible');
      chevronIcon.classList.add('open');
    } else {
      dropdownMenu.classList.remove('visible');
      chevronIcon.classList.remove('open');
      editingPinId = null;
      renderDropdownList();
    }
  });

  // Only commit naming popover if clicked outside after it has been displayed for > 400ms
  window.addEventListener('click', (e) => {
    const path = e.composedPath();

    if (activeDropData && !path.includes(namingPopover)) {
      if (performance.now() - dropTimestamp > 400) {
        commitNewPin();
      }
    }
  });

  // Initial load
  loadPins();
})();
