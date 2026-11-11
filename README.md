# Gemini Pinboard 📌

A spatial **Pin Dispenser & Vertical Line Bookmarking** Chrome Extension (Manifest V3) purpose-built for [gemini.google.com](https://gemini.google.com).

Gemini Pinboard transforms the conversation experience into a spatial workspace: grab a pin from the floating dispenser pill, drag a glowing vertical laser guide over any line or response turn, drop to bookmark with automatic naming (`ping1`, `ping2`, ...), and jump back smoothly at any time with an eye-locking visual flash.

---

## Key Architectural Highlights

### 1. Gemini Scroll Architecture & Dynamic Detection
On `gemini.google.com`, `window` is **not** the scrolling element. Gemini uses custom scrolling containers (`infinite-scroller`, `<main>`, or deep chat wrappers) where `overflow-y` is `auto` or `scroll`.
- **Dynamic Scroll Container Detection (`getScrollContainer`)**: Walks up from conversation turns (`ms-chat-turn`, `user-query`, `model-response`, `message-content`, `infinite-scroller`) to find the exact DOM container where `overflowY === 'auto' | 'scroll'` and `scrollHeight > clientHeight`.
- **Dual Vertical Anchoring (DOM Node + Exact Scroll Offset)**:
  - Absolute vertical scroll offset:
    $$\text{absoluteY} = \text{scrollContainer.scrollTop} + (\text{dropClientY} - \text{scrollContainer.top})$$
  - Deep DOM leaf fingerprinting: captures candidate leaf elements (`clientHeight < 600`) via `document.elementsFromPoint(window.innerWidth / 2, dropClientY)` with text fingerprint (`textContent.trim().slice(0, 60)`) and relative element offset (`dropClientY - targetElement.top`).
- **Accurate Jump Execution**:
  - Searches for the leaf element by text fingerprint first, scrolling to `elementTopInScrollContainer + offsetWithinElement - (viewportHeight * 0.25)`.
  - Fallbacks seamlessly to `absoluteY - (viewportHeight * 0.25)`.
  - Flashes a glowing horizontal laser guide across the chat for **1.5 seconds**, immediately orienting the user's eye onto the exact line bookmarked.

### 2. Interaction Flow
- **Top-Right Dispenser Pill** (`top: 20px; right: 24px`):
  - **Left Zone ("The Pin Bucket")**: Interactive grab zone with pin SVG icon (`cursor: grab`).
  - **Right Zone ("Dropdown Toggle")**: Displays live pin count badge (e.g., `3`) and chevron (`▾`) toggling the single-line pin list.
  - **Zero-Empty Space Rule**: If 0 pins exist, only the compact pill is rendered with zero empty list space below it.
- **Vertical Laser Drag & Auto-Scroll**:
  - Dragging from the Pin Bucket ignores horizontal `X` placement, locking only vertical `Y` (`e.clientY`).
  - Sleek horizontal laser guide spans across the chat container width while a floating pin badge follows the cursor.
  - Automatically auto-scrolls the chat container gently if dragging within 60px of viewport top or bottom.
  - Pressing `Escape` cancels the drag cleanly.
- **Instant Default Naming (`ping{N}`)**:
  - Drops trigger an inline popover pre-filled and auto-selected with `ping{N}` (highest existing number + 1).
  - Pressing `Enter` or clicking away/blur commits the pin instantly.
  - Insertion always prepends (`.unshift(newPin)`), ensuring the **newest pin is always at the very top**.
- **Visual Pin Markers on Page**:
  - Subtle ticks anchored to the right edge of the chat column, continuously synced via `requestAnimationFrame` on scroll and layout changes.
  - Hovering reveals the pin name badge and a quick `×` delete button.
  - Clicking jumps directly to that vertical position.
- **Single-Line Dropdown Menu (`240px`)**:
  - Strict horizontal flex line layout (`height: 34px; padding: 0 10px; gap: 8px; white-space: nowrap;`).
  - Left: 6px blue dot (`#60a5fa`) + truncated pin name.
  - Right: Formatted creation time (`23:15`), inline Rename button (`✎`), and Remove button (`×`).
  - Clicking any row smooth-scrolls and flashes the horizontal guide line.
  - Auto-fits height up to 8 pins (scrollbar only when > 8 pins).

### 3. Extension Context Invalidation Safeguards
When reloaded in `chrome://extensions`, existing Gemini tabs become orphaned and normally throw `Error: Extension context invalidated`.
- **Safe Storage Wrappers (`safeGet` & `safeSet`)**:
  - Verifies `typeof chrome !== 'undefined' && chrome.runtime && !!chrome.runtime.id`.
  - Synchronously mirrors all reads and writes to `window.localStorage`.
  - Wraps `chrome.storage.local` in silent handlers that never log noisy errors.
- **Clean Remounting**: Removes any existing `<gemini-pinboard-host>` from `document.body` before mounting new instances.

### 4. UI & Aesthetic
- Clean **Shadow DOM (`mode: 'open'`)** encapsulation prevents Gemini style leakage.
- Styled with the Linear / Raycast dark theme palette:
  - Surface: `#1e1f20`
  - Elevated hover: `#2b2c2f`
  - Border: `1px solid rgba(255, 255, 255, 0.08)`
  - Text: `#e3e3e3`
  - Muted: `#9aa0a6`
  - Accent / Laser: `#60a5fa`
  - Danger: `#f87171`

---

## Installation

1. Open Google Chrome and navigate to:
   ```text
   chrome://extensions/
   ```
2. Enable **Developer mode** using the toggle switch in the top-right corner.
3. Click **Load unpacked**.
4. Select the directory:
   ```text
   /mnt/hdd/basant-data/Projects/gemini-pinboard-v2
   ```
5. Navigate to [gemini.google.com](https://gemini.google.com) and start bookmarking your conversation lines!

---

## Extension Structure

```text
gemini-pinboard-v2/
├── manifest.json      # Chrome Extension Manifest V3 configuration
├── content.js         # Core logic: scroll detection, dual anchoring, Shadow DOM UI
├── styles.css         # Page-level host styling
├── icons/             # Clean modern extension icons
│   ├── icon16.png
│   ├── icon48.png
│   └── icon128.png
└── README.md          # Documentation and engineering architecture
```

---

## Controls & Keyboard Shortcuts

- **Grab & Drag Pin Bucket**: Drag out to inspect the vertical laser guide line.
- **Escape**: Cancel active drag or dismiss inline popover.
- **Enter**: Confirm pin name in drop popover or inline rename input.
- **Click Row / Tick**: Jump to bookmark with 1.5s visual guide line flash.
- **Click ✎**: Inline rename pin.
- **Click ×**: Delete pin.
