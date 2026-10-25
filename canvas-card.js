/**
 * Canvas Card - Infinite Canvas Drawing & Printing Card for Home Assistant Lovelace
 * Repository: https://github.com/lucayunxiao/canvas-card
 * Version: 1.0.0
 * License: MIT
 *
 * 100% Pure English UI
 * Features:
 *  - Infinite Canvas with smooth Quadratic Bézier stroke interpolation & anti-aliasing
 *  - Dual-finger Pinch-to-Zoom (0.5x - 5.0x) & Pan with gesture isolation
 *  - Inline Draggable Floating Text Box with scale compensation & IME flush protection
 *  - Auto Bounding Box Detection & 300 DPI Physical Paper Rasterizer (A4, A3, Letter, Thermal)
 *  - Action Workflows: Save + New, Discard + New, Print + New, History (IndexedDB)
 *  - Multi-tier Print Engine: Direct IPP (Port 631), HA Service Bridge, Gateway, and OS Native Print
 *  - Full GUI Visual Form Configuration Editor (<ha-form>)
 */

(function () {
  "use strict";

  // Prevent duplicate registration
  if (customElements.get("canvas-card")) return;

  const CARD_VERSION = "1.0.0";
  const DB_NAME = "CanvasCardDB";
  const DB_VERSION = 1;
  const STORE_NAME = "history";

  // Paper Sizes Definition (Dimensions in mm at 300 DPI: 1 inch = 25.4mm, DPI = 300)
  const PAPER_PROFILES = {
    a4: { name: "A4 (210 x 297 mm)", widthMm: 210, heightMm: 297, widthPx: 2480, heightPx: 3508 },
    a3: { name: "A3 (297 x 420 mm)", widthMm: 297, heightMm: 420, widthPx: 3508, heightPx: 4960 },
    letter: { name: "Letter (8.5 x 11 in)", widthMm: 215.9, heightMm: 279.4, widthPx: 2550, heightPx: 3300 },
    thermal80: { name: "Thermal Receipt (80 mm)", widthMm: 80, heightMm: null, widthPx: 945, heightPx: null },
    fit: { name: "Fit Content (1:1 Bounding Box)", widthMm: null, heightMm: null, widthPx: null, heightPx: null }
  };

  // =========================================================================
  // IndexedDB Storage Manager for Persistent History
  // =========================================================================
  class CanvasHistoryDB {
    static async getDB() {
      return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = (e) => {
          const db = e.target.result;
          if (!db.objectStoreNames.contains(STORE_NAME)) {
            const store = db.createObjectStore(STORE_NAME, { keyPath: "id", autoIncrement: true });
            store.createIndex("timestamp", "timestamp", { unique: false });
          }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    }

    static async saveItem(item) {
      const db = await this.getDB();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, "readwrite");
        const store = tx.objectStore(STORE_NAME);
        const req = store.add({
          timestamp: Date.now(),
          createdAt: new Date().toLocaleString("en-US", { hour12: false }),
          ...item
        });
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    }

    static async getAllItems(maxLimit = 50) {
      const db = await this.getDB();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, "readonly");
        const store = tx.objectStore(STORE_NAME);
        const req = store.getAll();
        req.onsuccess = () => {
          const items = req.result || [];
          items.sort((a, b) => b.timestamp - a.timestamp);
          resolve(items.slice(0, maxLimit));
        };
        req.onerror = () => reject(req.error);
      });
    }

    static async deleteItem(id) {
      const db = await this.getDB();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, "readwrite");
        const store = tx.objectStore(STORE_NAME);
        const req = store.delete(Number(id));
        req.onsuccess = () => resolve(true);
        req.onerror = () => reject(req.error);
      });
    }

    static async clearAll() {
      const db = await this.getDB();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, "readwrite");
        const store = tx.objectStore(STORE_NAME);
        const req = store.clear();
        req.onsuccess = () => resolve(true);
        req.onerror = () => reject(req.error);
      });
    }
  }

  // =========================================================================
  // Canvas Card Custom Element
  // =========================================================================
  class CanvasCard extends HTMLElement {
    constructor() {
      super();
      this.attachShadow({ mode: "open" });

      // Configuration state
      this._config = {
        title: "Canvas Studio",
        printer_ip: "",
        printer_port: 631,
        print_mode: "ipp", // 'ipp', 'ha_service', 'gateway', 'os_print'
        ha_print_service: "notify.printer",
        gateway_url: "",
        paper_size: "a4",
        color_mode: "color", // 'color', 'monochrome'
        canvas_bg: "grid", // 'grid', 'blank', 'dots'
        confirm_discard: true,
        height: 520
      };

      // Infinite Canvas State
      this.scale = 1.0;
      this.panX = 0;
      this.panY = 0;
      this.isPinching = false;
      this.isPanning = false;
      this.initialDistance = 0;
      this.initialScale = 1.0;
      this.initialMidX = 0;
      this.initialMidY = 0;
      this.initialPanX = 0;
      this.initialPanY = 0;

      // Tool State
      this.currentTool = "pen"; // 'pen', 'marker', 'eraser', 'text'
      this.currentColor = "#1e293b";
      this.currentSize = 6; // Pen base size
      this.isDrawing = false;
      this.lastX = 0;
      this.lastY = 0;
      this.midX = 0;
      this.midY = 0;

      // Strokes & Undo/Redo Stack
      this.historyStack = [];
      this.historyStep = -1;
      this.maxHistory = 30;

      // Text Box Active State
      this.activeTextBox = null;
      this.selectedTextColor = "#1e293b";
      this.selectedTextSizeLevel = 3; // 1:Small (18px), 2:Medium (26px), 3:Large (36px), 4:XL (52px)
      this.previewFontSizesCss = { 1: 18, 2: 26, 3: 36, 4: 52 };

      // Bounding box accumulator for strokes [minX, minY, maxX, maxY]
      this.bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
    }

    setConfig(config) {
      this._config = { ...this._config, ...config };
      if (this._rendered) {
        this._updateConfigBindings();
      }
    }

    set hass(hass) {
      this._hass = hass;
    }

    getCardSize() {
      return 6;
    }

    static getConfigElement() {
      return document.createElement("canvas-card-editor");
    }

    static getStubConfig() {
      return {
        title: "Canvas Studio",
        printer_ip: "",
        paper_size: "a4",
        canvas_bg: "grid",
        confirm_discard: true,
        height: 520
      };
    }

    connectedCallback() {
      if (!this._rendered) {
        this.render();
        this._rendered = true;
      }
    }

    // =========================================================================
    // UI Template & Styles
    // =========================================================================
    render() {
      this.shadowRoot.innerHTML = `
        <style>
          :host {
            display: block;
            --primary-accent: #2563eb;
            --primary-hover: #1d4ed8;
            --surface-bg: var(--ha-card-background, var(--card-background-color, #ffffff));
            --surface-border: var(--divider-color, rgba(0, 0, 0, 0.12));
            --text-primary: var(--primary-text-color, #1e293b);
            --text-secondary: var(--secondary-text-color, #64748b);
            --btn-bg: rgba(0, 0, 0, 0.04);
            --btn-hover: rgba(0, 0, 0, 0.08);
            --btn-active: rgba(37, 99, 235, 0.15);
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", sans-serif;
            color: var(--text-primary);
          }

          ha-card {
            overflow: hidden;
            border-radius: var(--ha-card-border-radius, 16px);
            box-shadow: var(--ha-card-box-shadow, 0 4px 20px rgba(0,0,0,0.06));
            position: relative;
            background: var(--surface-bg);
          }

          /* Header & Action Bar */
          .card-header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 12px 16px;
            border-bottom: 1px solid var(--surface-border);
            gap: 12px;
            flex-wrap: wrap;
          }

          .header-left {
            display: flex;
            align-items: center;
            gap: 10px;
          }

          .header-title {
            font-size: 17px;
            font-weight: 700;
            display: flex;
            align-items: center;
            gap: 8px;
            margin: 0;
          }

          .header-title ha-icon {
            color: var(--primary-accent);
          }

          .printer-pill {
            font-size: 11px;
            font-weight: 600;
            padding: 3px 8px;
            border-radius: 12px;
            display: flex;
            align-items: center;
            gap: 5px;
            background: rgba(16, 185, 129, 0.12);
            color: #10b981;
          }

          .printer-pill.offline {
            background: rgba(148, 163, 184, 0.18);
            color: var(--text-secondary);
          }

          .primary-actions {
            display: flex;
            align-items: center;
            gap: 6px;
            flex-wrap: wrap;
          }

          .btn-action {
            display: inline-flex;
            align-items: center;
            gap: 5px;
            padding: 6px 12px;
            border-radius: 8px;
            font-size: 12px;
            font-weight: 600;
            border: 1px solid transparent;
            cursor: pointer;
            transition: all 0.15s ease;
            user-select: none;
          }

          .btn-save-new {
            background: #2563eb;
            color: #ffffff;
          }
          .btn-save-new:hover { background: #1d4ed8; }

          .btn-discard-new {
            background: rgba(239, 68, 68, 0.1);
            color: #ef4444;
            border: 1px solid rgba(239, 68, 68, 0.2);
          }
          .btn-discard-new:hover { background: rgba(239, 68, 68, 0.2); }

          .btn-print-new {
            background: #10b981;
            color: #ffffff;
          }
          .btn-print-new:hover { background: #059669; }

          .btn-history {
            background: var(--btn-bg);
            color: var(--text-primary);
            border: 1px solid var(--surface-border);
          }
          .btn-history:hover { background: var(--btn-hover); }

          /* Toolbar */
          .toolbar {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 8px 16px;
            background: rgba(0, 0, 0, 0.02);
            border-bottom: 1px solid var(--surface-border);
            gap: 12px;
            overflow-x: auto;
          }

          .tool-group {
            display: flex;
            align-items: center;
            gap: 4px;
          }

          .tool-btn {
            width: 34px;
            height: 34px;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            border-radius: 8px;
            background: transparent;
            border: 1px solid transparent;
            color: var(--text-secondary);
            cursor: pointer;
            transition: all 0.15s;
          }

          .tool-btn:hover {
            background: var(--btn-hover);
            color: var(--text-primary);
          }

          .tool-btn.active {
            background: var(--btn-active);
            color: var(--primary-accent);
            border-color: rgba(37, 99, 235, 0.3);
          }

          .tool-divider {
            width: 1px;
            height: 20px;
            background: var(--surface-border);
            margin: 0 4px;
          }

          /* Size Buttons */
          .size-btn {
            width: 28px;
            height: 28px;
            border-radius: 50%;
            border: 1px solid transparent;
            background: transparent;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            cursor: pointer;
          }
          .size-btn.active {
            border-color: var(--primary-accent);
            background: rgba(37, 99, 235, 0.1);
          }
          .size-dot {
            border-radius: 50%;
            background: var(--text-primary);
          }

          /* Color Swatches */
          .color-swatch {
            width: 22px;
            height: 22px;
            border-radius: 50%;
            border: 2px solid transparent;
            cursor: pointer;
            padding: 0;
            transition: transform 0.15s;
          }
          .color-swatch:hover { transform: scale(1.15); }
          .color-swatch.active {
            border-color: #ffffff;
            box-shadow: 0 0 0 2px var(--primary-accent);
          }

          .color-picker-wrapper {
            position: relative;
            width: 24px;
            height: 24px;
            border-radius: 50%;
            overflow: hidden;
            display: flex;
            align-items: center;
            justify-content: center;
            background: conic-gradient(red, yellow, lime, aqua, blue, magenta, red);
            cursor: pointer;
          }
          .color-picker-wrapper input {
            position: absolute;
            opacity: 0;
            width: 100%;
            height: 100%;
            cursor: pointer;
          }

          /* Canvas Viewport */
          .viewport {
            position: relative;
            width: 100%;
            height: ${this._config.height || 520}px;
            overflow: hidden;
            background: #f8fafc;
            touch-action: none;
            user-select: none;
            cursor: crosshair;
          }

          .canvas-sheet {
            position: absolute;
            top: 0;
            left: 0;
            transform-origin: 0 0;
            will-change: transform;
          }

          canvas {
            position: absolute;
            top: 0;
            left: 0;
            display: block;
          }

          #bgCanvas {
            z-index: 1;
          }

          #drawCanvas {
            z-index: 2;
          }

          /* Floating Reset Zoom Pill */
          .reset-zoom-pill {
            position: absolute;
            bottom: 16px;
            right: 16px;
            z-index: 20;
            background: rgba(15, 23, 42, 0.88);
            backdrop-filter: blur(8px);
            color: #ffffff;
            padding: 6px 12px;
            border-radius: 20px;
            font-size: 12px;
            font-weight: 600;
            display: none;
            align-items: center;
            gap: 6px;
            cursor: pointer;
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.25);
            transition: all 0.2s;
          }
          .reset-zoom-pill:hover {
            background: #0f172a;
            transform: scale(1.05);
          }

          /* Toast Notification */
          .canvas-toast {
            position: absolute;
            top: 16px;
            left: 50%;
            transform: translateX(-50%) translateY(-30px);
            opacity: 0;
            pointer-events: none;
            z-index: 40;
            background: rgba(15, 23, 42, 0.94);
            color: #ffffff;
            padding: 8px 16px;
            border-radius: 8px;
            font-size: 13px;
            font-weight: 600;
            box-shadow: 0 4px 14px rgba(0, 0, 0, 0.3);
            transition: all 0.25s ease;
            display: flex;
            align-items: center;
            gap: 8px;
          }
          .canvas-toast.show {
            transform: translateX(-50%) translateY(0);
            opacity: 1;
          }

          /* Modal & Drawer */
          .modal-overlay {
            position: absolute;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background: rgba(0, 0, 0, 0.45);
            backdrop-filter: blur(4px);
            z-index: 50;
            display: none;
            align-items: center;
            justify-content: center;
            padding: 16px;
            box-sizing: border-box;
          }

          .modal-card {
            background: var(--surface-bg);
            border-radius: 14px;
            max-width: 600px;
            width: 100%;
            max-height: 90%;
            display: flex;
            flex-direction: column;
            box-shadow: 0 10px 30px rgba(0, 0, 0, 0.25);
            overflow: hidden;
            animation: modalPop 0.2s ease-out;
          }

          @keyframes modalPop {
            from { opacity: 0; transform: scale(0.95); }
            to { opacity: 1; transform: scale(1); }
          }

          .modal-header {
            padding: 14px 18px;
            border-bottom: 1px solid var(--surface-border);
            display: flex;
            align-items: center;
            justify-content: space-between;
          }

          .modal-title {
            margin: 0;
            font-size: 16px;
            font-weight: 700;
          }

          .modal-body {
            padding: 16px 18px;
            overflow-y: auto;
            flex: 1;
          }

          .modal-footer {
            padding: 12px 18px;
            border-top: 1px solid var(--surface-border);
            display: flex;
            align-items: center;
            justify-content: flex-end;
            gap: 10px;
          }

          /* History Grid */
          .history-grid {
            display: grid;
            grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
            gap: 12px;
          }

          .history-card {
            border: 1px solid var(--surface-border);
            border-radius: 10px;
            overflow: hidden;
            display: flex;
            flex-direction: column;
            background: rgba(0,0,0,0.02);
            transition: transform 0.15s, box-shadow 0.15s;
          }
          .history-card:hover {
            transform: translateY(-2px);
            box-shadow: 0 4px 12px rgba(0,0,0,0.08);
          }

          .history-thumb {
            width: 100%;
            height: 120px;
            object-fit: contain;
            background: #ffffff;
            border-bottom: 1px solid var(--surface-border);
          }

          .history-info {
            padding: 8px;
            display: flex;
            flex-direction: column;
            gap: 4px;
            flex: 1;
          }

          .history-time {
            font-size: 11px;
            color: var(--text-secondary);
            font-weight: 500;
          }

          .history-badge {
            display: inline-block;
            font-size: 10px;
            font-weight: 700;
            padding: 2px 6px;
            border-radius: 4px;
            background: rgba(16, 185, 129, 0.15);
            color: #10b981;
            width: fit-content;
          }

          .history-actions {
            display: flex;
            align-items: center;
            gap: 4px;
            margin-top: 6px;
          }

          .btn-mini {
            flex: 1;
            padding: 4px 0;
            font-size: 11px;
            font-weight: 600;
            border: 1px solid var(--surface-border);
            border-radius: 6px;
            background: var(--surface-bg);
            color: var(--text-primary);
            cursor: pointer;
            text-align: center;
          }
          .btn-mini:hover { background: var(--btn-hover); }
          .btn-mini.danger { color: #ef4444; }

          /* ========================================================================= */
          /* Inline Draggable Text Box Styles */
          /* ========================================================================= */
          .canvas-text-box {
            position: absolute;
            z-index: 30;
            display: flex;
            flex-direction: column;
            gap: 4px;
            padding: 0;
            min-width: 250px;
            max-width: 90%;
            touch-action: none;
            user-select: none;
            -webkit-user-select: none;
          }

          .text-drag-bar {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 4px 8px;
            background: rgba(15, 23, 42, 0.94);
            backdrop-filter: blur(8px);
            border-radius: 8px;
            border: 1px solid rgba(255, 255, 255, 0.15);
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.35);
            cursor: grab;
            touch-action: none;
          }
          .text-drag-bar:active { cursor: grabbing; }

          .drag-title {
            font-size: 11px;
            font-weight: 600;
            color: #94a3b8;
            display: flex;
            align-items: center;
            gap: 5px;
            pointer-events: none;
          }

          .text-box-quick-actions {
            display: flex;
            align-items: center;
            gap: 6px;
          }

          .btn-text-done {
            background: linear-gradient(135deg, #16a34a, #22c55e);
            color: #ffffff;
            border: none;
            padding: 4px 10px;
            border-radius: 6px;
            font-size: 12px;
            font-weight: 700;
            cursor: pointer;
            display: flex;
            align-items: center;
            gap: 4px;
            box-shadow: 0 2px 6px rgba(22, 163, 74, 0.4);
          }
          .btn-text-done:active { transform: scale(0.96); }

          .btn-text-cancel {
            background: rgba(255, 255, 255, 0.12);
            color: #cbd5e1;
            border: none;
            padding: 4px 8px;
            border-radius: 6px;
            font-size: 12px;
            font-weight: 600;
            cursor: pointer;
          }
          .btn-text-cancel:hover { color: #ef4444; }

          #inlineTextInput {
            width: 100%;
            min-height: 44px;
            outline: none;
            background: rgba(255, 255, 255, 0.88) !important;
            backdrop-filter: blur(2px);
            border: 2px dashed #3b82f6 !important;
            border-radius: 6px;
            box-shadow: 0 4px 14px rgba(0, 0, 0, 0.12);
            padding: 6px 8px;
            font-family: inherit;
            font-weight: 700;
            resize: none;
            overflow: hidden;
            line-height: 1.25;
            box-sizing: border-box;
            caret-color: #3b82f6;
            user-select: text;
          }
          #inlineTextInput:focus {
            background: rgba(255, 255, 255, 0.98) !important;
            border-color: #2563eb !important;
          }

          .text-box-controls {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 8px;
            flex-wrap: wrap;
            background: rgba(15, 23, 42, 0.94);
            backdrop-filter: blur(8px);
            border-radius: 8px;
            border: 1px solid rgba(255, 255, 255, 0.15);
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.35);
            padding: 5px 8px;
          }

          .inline-color-swatches {
            display: flex;
            align-items: center;
            gap: 5px;
          }

          .inline-color-dot {
            width: 16px;
            height: 16px;
            border-radius: 50%;
            cursor: pointer;
            border: 2px solid transparent;
          }
          .inline-color-dot.active {
            border-color: #ffffff;
            box-shadow: 0 0 0 2px #3b82f6;
          }

          .inline-size-pills {
            display: flex;
            align-items: center;
            gap: 4px;
          }

          .inline-size-pill {
            padding: 2px 7px;
            border-radius: 10px;
            font-size: 11px;
            font-weight: 600;
            color: #94a3b8;
            cursor: pointer;
            background: rgba(255, 255, 255, 0.08);
          }
          .inline-size-pill.active {
            color: #ffffff;
            background: #3b82f6;
          }
        </style>

        <ha-card>
          <!-- Header & Primary Actions -->
          <div class="card-header">
            <div class="header-left">
              <h2 class="header-title">
                <ha-icon icon="mdi:draw"></ha-icon>
                <span id="titleText">${this._config.title || "Canvas Studio"}</span>
              </h2>
              <div class="printer-pill ${this._config.printer_ip ? "" : "offline"}" id="printerBadge">
                <ha-icon icon="mdi:printer"></ha-icon>
                <span id="printerStatusText">${this._config.printer_ip ? this._config.printer_ip : "No Printer"}</span>
              </div>
            </div>

            <div class="primary-actions">
              <button class="btn-action btn-save-new" id="btnSaveNew" title="Save drawing and create fresh canvas">
                <ha-icon icon="mdi:content-save-plus-outline"></ha-icon>
                <span>Save + New</span>
              </button>
              <button class="btn-action btn-discard-new" id="btnDiscardNew" title="Discard current drawing and reset canvas">
                <ha-icon icon="mdi:close-circle-outline"></ha-icon>
                <span>Discard + New</span>
              </button>
              <button class="btn-action btn-print-new" id="btnPrintNew" title="Print drawing, save to history, and create fresh canvas">
                <ha-icon icon="mdi:printer-pos-outline"></ha-icon>
                <span>Print + New</span>
              </button>
              <button class="btn-action btn-history" id="btnHistory" title="View drawing archive & reprint">
                <ha-icon icon="mdi:history"></ha-icon>
                <span>History</span>
              </button>
            </div>
          </div>

          <!-- Drawing Toolbox -->
          <div class="toolbar">
            <!-- Tools -->
            <div class="tool-group">
              <button class="tool-btn active" data-tool="pen" title="Pencil / Smooth Pen">
                <ha-icon icon="mdi:lead-pencil"></ha-icon>
              </button>
              <button class="tool-btn" data-tool="marker" title="Highlighter / Marker">
                <ha-icon icon="mdi:marker"></ha-icon>
              </button>
              <button class="tool-btn" data-tool="eraser" title="Eraser">
                <ha-icon icon="mdi:eraser"></ha-icon>
              </button>
              <button class="tool-btn" data-tool="text" title="Draggable Text Box">
                <ha-icon icon="mdi:format-text"></ha-icon>
              </button>
            </div>

            <div class="tool-divider"></div>

            <!-- Stroke Sizes -->
            <div class="tool-group">
              <button class="size-btn" data-size="2" title="Fine (2px)">
                <div class="size-dot" style="width: 4px; height: 4px;"></div>
              </button>
              <button class="size-btn active" data-size="6" title="Medium (6px)">
                <div class="size-dot" style="width: 8px; height: 8px;"></div>
              </button>
              <button class="size-btn" data-size="14" title="Broad (14px)">
                <div class="size-dot" style="width: 14px; height: 14px;"></div>
              </button>
              <button class="size-btn" data-size="26" title="Extra Broad (26px)">
                <div class="size-dot" style="width: 20px; height: 20px;"></div>
              </button>
            </div>

            <div class="tool-divider"></div>

            <!-- Colors -->
            <div class="tool-group">
              <button class="color-swatch active" data-color="#1e293b" style="background:#1e293b;" title="Charcoal Black"></button>
              <button class="color-swatch" data-color="#ef4444" style="background:#ef4444;" title="Red"></button>
              <button class="color-swatch" data-color="#10b981" style="background:#10b981;" title="Green"></button>
              <button class="color-swatch" data-color="#3b82f6" style="background:#3b82f6;" title="Blue"></button>
              <button class="color-swatch" data-color="#f59e0b" style="background:#f59e0b;" title="Amber Yellow"></button>
              <button class="color-swatch" data-color="#8b5cf6" style="background:#8b5cf6;" title="Purple"></button>
              <label class="color-picker-wrapper" title="Custom Color">
                <input type="color" id="paletteColorPicker" value="#1e293b">
              </label>
            </div>

            <div class="tool-divider"></div>

            <!-- Undo / Redo / Clear -->
            <div class="tool-group">
              <button class="tool-btn" id="btnUndo" title="Undo (Ctrl+Z)" disabled>
                <ha-icon icon="mdi:undo"></ha-icon>
              </button>
              <button class="tool-btn" id="btnRedo" title="Redo (Ctrl+Y)" disabled>
                <ha-icon icon="mdi:redo"></ha-icon>
              </button>
              <button class="tool-btn" id="btnClear" title="Clear Canvas">
                <ha-icon icon="mdi:trash-can-outline"></ha-icon>
              </button>
            </div>
          </div>

          <!-- Viewport with Infinite Canvas -->
          <div class="viewport" id="viewport">
            <div class="canvas-sheet" id="sheetContainer">
              <canvas id="bgCanvas"></canvas>
              <canvas id="drawCanvas"></canvas>
            </div>

            <!-- Floating Reset Zoom Pill -->
            <div class="reset-zoom-pill" id="resetZoomBtn" title="Center drawing and reset zoom to 100%">
              <ha-icon icon="mdi:crosshairs-gps"></ha-icon>
              <span id="resetZoomText">100%</span>
            </div>

            <!-- Toast Notification -->
            <div class="canvas-toast" id="canvasToast">
              <ha-icon icon="mdi:check-circle" style="color: #10b981;"></ha-icon>
              <span id="toastMessage">Ready</span>
            </div>
          </div>

          <!-- History Modal -->
          <div class="modal-overlay" id="historyModal">
            <div class="modal-card">
              <div class="modal-header">
                <h3 class="modal-title">Drawings History</h3>
                <button class="tool-btn" id="btnCloseHistory" title="Close">
                  <ha-icon icon="mdi:close"></ha-icon>
                </button>
              </div>
              <div class="modal-body">
                <div class="history-grid" id="historyGrid">
                  <!-- Dynamically populated -->
                </div>
              </div>
              <div class="modal-footer">
                <button class="btn-action btn-discard-new" id="btnClearHistory">
                  <ha-icon icon="mdi:delete-sweep-outline"></ha-icon>
                  <span>Clear All History</span>
                </button>
              </div>
            </div>
          </div>

          <!-- Print Preview & Setting Modal -->
          <div class="modal-overlay" id="printModal">
            <div class="modal-card" style="max-width: 440px;">
              <div class="modal-header">
                <h3 class="modal-title">Print Settings</h3>
                <button class="tool-btn" id="btnClosePrint" title="Close">
                  <ha-icon icon="mdi:close"></ha-icon>
                </button>
              </div>
              <div class="modal-body">
                <div style="display:flex; justify-content:center; background:#ffffff; padding:12px; border-radius:8px; border:1px solid var(--surface-border); margin-bottom:12px;">
                  <img id="printPreviewImg" style="max-height: 180px; max-width: 100%; object-fit: contain;" />
                </div>
                <div style="display: flex; flex-direction: column; gap: 10px; font-size: 13px;">
                  <label>
                    <b>Paper Size:</b>
                    <select id="selectPaperSize" style="width: 100%; padding: 6px 8px; border-radius: 6px; border: 1px solid var(--surface-border); margin-top: 4px;">
                      <option value="a4" selected>A4 (210 x 297 mm)</option>
                      <option value="a3">A3 (297 x 420 mm)</option>
                      <option value="letter">Letter (8.5 x 11 in)</option>
                      <option value="thermal80">Thermal Receipt (80 mm)</option>
                      <option value="fit">Fit Content (1:1)</option>
                    </select>
                  </label>
                  <label>
                    <b>Color Mode:</b>
                    <select id="selectColorMode" style="width: 100%; padding: 6px 8px; border-radius: 6px; border: 1px solid var(--surface-border); margin-top: 4px;">
                      <option value="color" selected>Full Color</option>
                      <option value="monochrome">Monochrome / Grayscale</option>
                    </select>
                  </label>
                </div>
              </div>
              <div class="modal-footer">
                <button class="btn-action btn-history" id="btnCancelPrint">Cancel</button>
                <button class="btn-action btn-print-new" id="btnConfirmPrint">
                  <ha-icon icon="mdi:printer"></ha-icon>
                  <span>Print Now</span>
                </button>
              </div>
            </div>
          </div>
        </ha-card>
      `;

      this.initCanvasEngine();
      this.bindUIEvents();
    }

    // =========================================================================
    // Infinite Canvas Engine Implementation
    // =========================================================================
    initCanvasEngine() {
      const root = this.shadowRoot;
      this.viewport = root.getElementById("viewport");
      this.sheet = root.getElementById("sheetContainer");
      this.bgCanvas = root.getElementById("bgCanvas");
      this.drawCanvas = root.getElementById("drawCanvas");
      this.bgCtx = this.bgCanvas.getContext("2d");
      this.drawCtx = this.drawCanvas.getContext("2d", { willReadFrequently: true });

      // Internal virtual buffer size (300 DPI A4 baseline: 2480 x 3508)
      this.virtualWidth = 2480;
      this.virtualHeight = 3508;

      this.bgCanvas.width = this.virtualWidth;
      this.bgCanvas.height = this.virtualHeight;
      this.drawCanvas.width = this.virtualWidth;
      this.drawCanvas.height = this.virtualHeight;

      this.renderBackground();
      this.fitViewportToCenter();
      this.saveState();

      // Bind canvas interaction events
      this.bindCanvasEvents();

      // Safari Gesture blocking
      this.viewport.addEventListener("gesturestart", (e) => e.preventDefault());
      this.viewport.addEventListener("gesturechange", (e) => e.preventDefault());
      this.viewport.addEventListener("gestureend", (e) => e.preventDefault());
    }

    renderBackground() {
      const ctx = this.bgCtx;
      const w = this.virtualWidth;
      const h = this.virtualHeight;
      ctx.clearRect(0, 0, w, h);

      // Clean white background
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, w, h);

      const style = this._config.canvas_bg || "grid";
      if (style === "grid") {
        ctx.strokeStyle = "rgba(59, 130, 246, 0.22)";
        ctx.lineWidth = 4;
        const step = Math.floor(w / 35);
        ctx.beginPath();
        for (let x = 0; x <= w; x += step) {
          ctx.moveTo(x, 0); ctx.lineTo(x, h);
        }
        for (let y = 0; y <= h; y += step) {
          ctx.moveTo(0, y); ctx.lineTo(w, y);
        }
        ctx.stroke();
      } else if (style === "dots") {
        ctx.fillStyle = "rgba(100, 116, 139, 0.35)";
        const step = Math.floor(w / 35);
        for (let x = step; x < w; x += step) {
          for (let y = step; y < h; y += step) {
            ctx.beginPath();
            ctx.arc(x, y, 4, 0, Math.PI * 2);
            ctx.fill();
          }
        }
      }
    }

    fitViewportToCenter() {
      const vw = this.viewport.clientWidth || 600;
      const vh = this.viewport.clientHeight || 520;
      const pad = 32;

      const availW = Math.max(100, vw - pad);
      const availH = Math.max(100, vh - pad);

      const scaleW = availW / this.virtualWidth;
      const scaleH = availH / this.virtualHeight;
      this.scale = Math.min(scaleW, scaleH);

      const sheetW = this.virtualWidth * this.scale;
      const sheetH = this.virtualHeight * this.scale;

      this.panX = (vw - sheetW) / 2;
      this.panY = (vh - sheetH) / 2;

      this.applyTransform();
    }

    applyTransform() {
      this.sheet.style.transform = `translate(${this.panX}px, ${this.panY}px) scale(${this.scale})`;
      this.notifyZoomChange();
    }

    resetZoom() {
      this.fitViewportToCenter();
    }

    notifyZoomChange() {
      const resetBtn = this.shadowRoot.getElementById("resetZoomBtn");
      const zoomText = this.shadowRoot.getElementById("resetZoomText");
      const isShifted = Math.abs(this.scale - 0.2) > 0.05 || Math.abs(this.panX) > 10 || Math.abs(this.panY) > 10;
      if (resetBtn) resetBtn.style.display = isShifted ? "flex" : "none";
      if (zoomText) zoomText.textContent = `${Math.round(this.scale * 100 * 3.5)}%`;
    }

    // =========================================================================
    // Touch & Pointer Handling (Bézier Smoothing & Pinch-to-Zoom)
    // =========================================================================
    bindCanvasEvents() {
      const getVirtualCoords = (clientX, clientY) => {
        const rect = this.drawCanvas.getBoundingClientRect();
        const scaleX = this.drawCanvas.width / rect.width;
        const scaleY = this.drawCanvas.height / rect.height;
        return {
          x: (clientX - rect.left) * scaleX,
          y: (clientY - rect.top) * scaleY
        };
      };

      const startDraw = (e) => {
        // Dual touch for pinch-to-zoom and pan
        if (e.touches && e.touches.length === 2) {
          this.isPinching = true;
          this.isDrawing = false;
          this.initialDistance = Math.hypot(
            e.touches[0].clientX - e.touches[1].clientX,
            e.touches[0].clientY - e.touches[1].clientY
          );
          this.initialMidX = (e.touches[0].clientX + e.touches[1].clientX) / 2;
          this.initialMidY = (e.touches[0].clientY + e.touches[1].clientY) / 2;
          this.initialScale = this.scale;
          this.initialPanX = this.panX;
          this.initialPanY = this.panY;
          return;
        }

        if (this.isPinching || (e.touches && e.touches.length > 1)) return;

        // Text tool placement
        if (this.currentTool === "text") {
          e.preventDefault();
          const clientX = e.touches ? e.touches[0].clientX : e.clientX;
          const clientY = e.touches ? e.touches[0].clientY : e.clientY;
          const containerRect = this.sheet.getBoundingClientRect();
          const relX = (clientX - containerRect.left) / (this.scale || 1);
          const relY = (clientY - containerRect.top) / (this.scale || 1);
          const coords = getVirtualCoords(clientX, clientY);
          this.spawnInlineTextBox(coords.x, coords.y, relX, relY);
          return;
        }

        e.preventDefault();
        this.isDrawing = true;
        const clientX = e.touches ? e.touches[0].clientX : e.clientX;
        const clientY = e.touches ? e.touches[0].clientY : e.clientY;
        const coords = getVirtualCoords(clientX, clientY);
        this.lastX = coords.x;
        this.lastY = coords.y;
        this.midX = coords.x;
        this.midY = coords.y;

        this.applyToolStyles();
        this.updateBounds(coords.x, coords.y);

        // Stamp initial dot
        this.drawCtx.beginPath();
        this.drawCtx.arc(coords.x, coords.y, this.getCalculatedLineWidth() / 2, 0, Math.PI * 2);
        this.drawCtx.fill();
      };

      const moveDraw = (e) => {
        // Pinch zoom & pan
        if (this.isPinching && e.touches && e.touches.length === 2) {
          e.preventDefault();
          const dist = Math.hypot(
            e.touches[0].clientX - e.touches[1].clientX,
            e.touches[0].clientY - e.touches[1].clientY
          );
          const midX = (e.touches[0].clientX + e.touches[1].clientX) / 2;
          const midY = (e.touches[0].clientY + e.touches[1].clientY) / 2;
          const factor = dist / (this.initialDistance || 1);

          this.scale = Math.min(5.0, Math.max(0.15, this.initialScale * factor));
          this.panX = this.initialPanX + (midX - this.initialMidX);
          this.panY = this.initialPanY + (midY - this.initialMidY);
          this.applyTransform();
          return;
        }

        if (!this.isDrawing || this.isPinching) return;
        if (e.touches && e.touches.length > 1) {
          this.isDrawing = false;
          return;
        }

        e.preventDefault();
        const clientX = e.touches ? e.touches[0].clientX : e.clientX;
        const clientY = e.touches ? e.touches[0].clientY : e.clientY;
        const coords = getVirtualCoords(clientX, clientY);

        // Quadratic Bézier curve midpoint smoothing
        const currentMidX = (this.lastX + coords.x) / 2;
        const currentMidY = (this.lastY + coords.y) / 2;

        this.drawCtx.beginPath();
        this.drawCtx.moveTo(this.midX, this.midY);
        this.drawCtx.quadraticCurveTo(this.lastX, this.lastY, currentMidX, currentMidY);
        this.drawCtx.stroke();

        this.updateBounds(coords.x, coords.y);

        this.lastX = coords.x;
        this.lastY = coords.y;
        this.midX = currentMidX;
        this.midY = currentMidY;
      };

      const endDraw = (e) => {
        if (e.touches && e.touches.length < 2) {
          this.isPinching = false;
        }
        if (!this.isDrawing) return;
        this.isDrawing = false;
        this.saveState();
      };

      this.drawCanvas.addEventListener("mousedown", startDraw);
      window.addEventListener("mousemove", moveDraw);
      window.addEventListener("mouseup", endDraw);

      this.drawCanvas.addEventListener("touchstart", startDraw, { passive: false });
      this.drawCanvas.addEventListener("touchmove", moveDraw, { passive: false });
      this.drawCanvas.addEventListener("touchend", endDraw, { passive: false });
      this.drawCanvas.addEventListener("touchcancel", endDraw, { passive: false });
    }

    applyToolStyles() {
      const ctx = this.drawCtx;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.lineWidth = this.getCalculatedLineWidth();

      if (this.currentTool === "eraser") {
        ctx.globalCompositeOperation = "destination-out";
        ctx.globalAlpha = 1.0;
      } else if (this.currentTool === "marker") {
        ctx.globalCompositeOperation = "source-over";
        ctx.globalAlpha = 0.38;
        ctx.strokeStyle = this.currentColor;
        ctx.fillStyle = this.currentColor;
      } else {
        // Pen
        ctx.globalCompositeOperation = "source-over";
        ctx.globalAlpha = 1.0;
        ctx.strokeStyle = this.currentColor;
        ctx.fillStyle = this.currentColor;
      }
    }

    getCalculatedLineWidth() {
      const factor = this.drawCanvas.width / 600;
      let base = this.currentSize * factor;
      if (this.currentTool === "eraser") base *= 2.8;
      if (this.currentTool === "marker") base *= 2.2;
      return Math.max(3, base);
    }

    updateBounds(x, y) {
      if (x < this.bounds.minX) this.bounds.minX = x;
      if (y < this.bounds.minY) this.bounds.minY = y;
      if (x > this.bounds.maxX) this.bounds.maxX = x;
      if (y > this.bounds.maxY) this.bounds.maxY = y;
    }

    // =========================================================================
    // Inline Draggable Floating Text Box
    // =========================================================================
    spawnInlineTextBox(canvasX, canvasY, relX, relY) {
      if (this.activeTextBox) {
        this.commitActiveTextBox();
      }

      const box = document.createElement("div");
      box.className = "canvas-text-box";

      const containerW = this.virtualWidth;
      const containerH = this.virtualHeight;
      const boxW = Math.min(300, 480);
      const dragBarH = 36;

      let initLeft = Math.max(8, relX);
      let initTop = Math.max(8, relY - dragBarH);

      box.style.left = `${initLeft}px`;
      box.style.top = `${initTop}px`;
      box.style.width = `${boxW}px`;

      const curSizeCss = this.previewFontSizesCss[this.selectedTextSizeLevel] || 36;

      box.innerHTML = `
        <div class="text-drag-bar" id="textDragBar" title="Hold to drag position">
          <div class="drag-title">
            <ha-icon icon="mdi:arrow-all" style="--mdc-icon-size: 14px;"></ha-icon>
            <span>Drag to move</span>
          </div>
          <div class="text-box-quick-actions">
            <button type="button" class="btn-text-done" id="inlineTextDoneBtn">
              <ha-icon icon="mdi:check" style="--mdc-icon-size: 14px;"></ha-icon> Done
            </button>
            <button type="button" class="btn-text-cancel" id="inlineTextCancelBtn" title="Cancel">✕</button>
          </div>
        </div>
        <textarea id="inlineTextInput" placeholder="Type text here..." rows="1" style="color: ${this.selectedTextColor}; font-size: ${curSizeCss}px;"></textarea>
        <div class="text-box-controls">
          <div class="inline-color-swatches">
            <div class="inline-color-dot ${this.selectedTextColor === "#1e293b" ? "active" : ""}" data-color="#1e293b" style="background:#1e293b" title="Black"></div>
            <div class="inline-color-dot ${this.selectedTextColor === "#ef4444" ? "active" : ""}" data-color="#ef4444" style="background:#ef4444" title="Red"></div>
            <div class="inline-color-dot ${this.selectedTextColor === "#10b981" ? "active" : ""}" data-color="#10b981" style="background:#10b981" title="Green"></div>
            <div class="inline-color-dot ${this.selectedTextColor === "#3b82f6" ? "active" : ""}" data-color="#3b82f6" style="background:#3b82f6" title="Blue"></div>
            <div class="inline-color-dot ${this.selectedTextColor === "#f59e0b" ? "active" : ""}" data-color="#f59e0b" style="background:#f59e0b" title="Yellow"></div>
          </div>
          <div class="inline-size-pills">
            <div class="inline-size-pill ${this.selectedTextSizeLevel === 1 ? "active" : ""}" data-size="1">Small</div>
            <div class="inline-size-pill ${this.selectedTextSizeLevel === 2 ? "active" : ""}" data-size="2">Medium</div>
            <div class="inline-size-pill ${this.selectedTextSizeLevel === 3 ? "active" : ""}" data-size="3">Large</div>
            <div class="inline-size-pill ${this.selectedTextSizeLevel === 4 ? "active" : ""}" data-size="4">XL</div>
          </div>
        </div>
      `;

      this.sheet.appendChild(box);
      this.activeTextBox = box;

      const dragBar = box.querySelector("#textDragBar");
      const textarea = box.querySelector("#inlineTextInput");
      const doneBtn = box.querySelector("#inlineTextDoneBtn");
      const cancelBtn = box.querySelector("#inlineTextCancelBtn");
      const colorDots = box.querySelectorAll(".inline-color-dot");
      const sizePills = box.querySelectorAll(".inline-size-pill");

      // Auto-grow textarea height
      textarea.addEventListener("input", () => {
        textarea.style.height = "auto";
        textarea.style.height = `${Math.max(44, textarea.scrollHeight)}px`;
      });

      doneBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        this.commitActiveTextBox();
      });

      cancelBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        this.removeActiveTextBox();
      });

      colorDots.forEach((dot) => {
        dot.addEventListener("click", (e) => {
          e.stopPropagation();
          colorDots.forEach((d) => d.classList.remove("active"));
          dot.classList.add("active");
          this.selectedTextColor = dot.dataset.color;
          textarea.style.color = this.selectedTextColor;
          this.currentColor = this.selectedTextColor;
        });
      });

      sizePills.forEach((pill) => {
        pill.addEventListener("click", (e) => {
          e.stopPropagation();
          sizePills.forEach((p) => p.classList.remove("active"));
          pill.classList.add("active");
          this.selectedTextSizeLevel = parseInt(pill.dataset.size, 10);
          const sizeCss = this.previewFontSizesCss[this.selectedTextSizeLevel] || 36;
          textarea.style.fontSize = `${sizeCss}px`;
          textarea.style.height = "auto";
          textarea.style.height = `${Math.max(44, textarea.scrollHeight)}px`;
        });
      });

      // Draggable logic with scale compensation
      let isDragging = false;
      let startClientX = 0;
      let startClientY = 0;
      let startBoxLeft = 0;
      let startBoxTop = 0;

      const handleDragStart = (e) => {
        if (e.target.closest("button")) return;
        e.preventDefault();
        e.stopPropagation();
        isDragging = true;
        const touch = e.touches ? e.touches[0] : e;
        startClientX = touch.clientX;
        startClientY = touch.clientY;
        startBoxLeft = parseFloat(box.style.left) || 0;
        startBoxTop = parseFloat(box.style.top) || 0;

        const handleDragMove = (moveEv) => {
          if (!isDragging) return;
          moveEv.preventDefault();
          moveEv.stopPropagation();
          const curTouch = moveEv.touches ? moveEv.touches[0] : moveEv;
          const scale = this.scale || 1.0;
          const deltaX = (curTouch.clientX - startClientX) / scale;
          const deltaY = (curTouch.clientY - startClientY) / scale;

          let nextLeft = startBoxLeft + deltaX;
          let nextTop = startBoxTop + deltaY;

          box.style.left = `${nextLeft}px`;
          box.style.top = `${nextTop}px`;
        };

        const handleDragEnd = () => {
          isDragging = false;
          window.removeEventListener("mousemove", handleDragMove);
          window.removeEventListener("mouseup", handleDragEnd);
          window.removeEventListener("touchmove", handleDragMove);
          window.removeEventListener("touchend", handleDragEnd);
        };

        window.addEventListener("mousemove", handleDragMove, { passive: false });
        window.addEventListener("mouseup", handleDragEnd);
        window.addEventListener("touchmove", handleDragMove, { passive: false });
        window.addEventListener("touchend", handleDragEnd);
      };

      dragBar.addEventListener("mousedown", handleDragStart);
      dragBar.addEventListener("touchstart", handleDragStart, { passive: false });

      setTimeout(() => textarea.focus(), 80);
    }

    commitActiveTextBox() {
      if (!this.activeTextBox) return;

      // Blur to flush IME characters
      if (document.activeElement && typeof document.activeElement.blur === "function") {
        document.activeElement.blur();
      }

      const textarea = this.activeTextBox.querySelector("#inlineTextInput");
      if (textarea && textarea.value && textarea.value.trim()) {
        const text = textarea.value;
        const boxLeft = parseFloat(this.activeTextBox.style.left) || 0;
        const boxTop = parseFloat(this.activeTextBox.style.top) || 0;

        const textOffsetLeft = textarea.offsetLeft + 8;
        const textOffsetTop = textarea.offsetTop + 6;

        const posX = boxLeft + textOffsetLeft;
        const posY = boxTop + textOffsetTop;

        const sizeCss = this.previewFontSizesCss[this.selectedTextSizeLevel] || 36;
        // In virtual coordinates, scale font appropriately
        const fontSizeVirtual = sizeCss * 2.5;

        this.drawCtx.save();
        this.drawCtx.globalCompositeOperation = "source-over";
        this.drawCtx.globalAlpha = 1.0;
        this.drawCtx.fillStyle = this.selectedTextColor;
        this.drawCtx.font = `bold ${fontSizeVirtual}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;
        this.drawCtx.textBaseline = "top";

        const lines = text.split("\n");
        const lineHeight = fontSizeVirtual * 1.25;
        lines.forEach((line, idx) => {
          const ly = posY + idx * lineHeight;
          this.drawCtx.fillText(line, posX, ly);
          const metrics = this.drawCtx.measureText(line);
          this.updateBounds(posX, ly);
          this.updateBounds(posX + metrics.width, ly + lineHeight);
        });
        this.drawCtx.restore();
        this.saveState();
      }

      this.removeActiveTextBox();
    }

    removeActiveTextBox() {
      if (this.activeTextBox) {
        this.activeTextBox.remove();
        this.activeTextBox = null;
      }
    }

    // =========================================================================
    // History Stack (Undo / Redo / Clear)
    // =========================================================================
    saveState() {
      if (this.historyStep < this.historyStack.length - 1) {
        this.historyStack = this.historyStack.slice(0, this.historyStep + 1);
      }
      this.historyStack.push(this.drawCtx.getImageData(0, 0, this.virtualWidth, this.virtualHeight));
      if (this.historyStack.length > this.maxHistory) {
        this.historyStack.shift();
      } else {
        this.historyStep++;
      }
      this.notifyHistoryButtons();
    }

    undo() {
      if (this.historyStep > 0) {
        this.historyStep--;
        this.drawCtx.putImageData(this.historyStack[this.historyStep], 0, 0);
        this.notifyHistoryButtons();
      }
    }

    redo() {
      if (this.historyStep < this.historyStack.length - 1) {
        this.historyStep++;
        this.drawCtx.putImageData(this.historyStack[this.historyStep], 0, 0);
        this.notifyHistoryButtons();
      }
    }

    clearCanvas() {
      this.removeActiveTextBox();
      this.drawCtx.clearRect(0, 0, this.virtualWidth, this.virtualHeight);
      this.bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
      this.saveState();
      this.fitViewportToCenter();
    }

    notifyHistoryButtons() {
      const btnUndo = this.shadowRoot.getElementById("btnUndo");
      const btnRedo = this.shadowRoot.getElementById("btnRedo");
      if (btnUndo) btnUndo.disabled = this.historyStep <= 0;
      if (btnRedo) btnRedo.disabled = this.historyStep >= this.historyStack.length - 1;
    }

    // =========================================================================
    // 300 DPI Physical Paper Rasterizer & Auto Bounding Box
    // =========================================================================
    exportCroppedRaster(paperKey = "a4", colorMode = "color") {
      this.commitActiveTextBox();

      let bx1 = this.bounds.minX;
      let by1 = this.bounds.minY;
      let bx2 = this.bounds.maxX;
      let by2 = this.bounds.maxY;

      // Fallback if no strokes recorded yet
      if (bx1 === Infinity || bx2 === -Infinity) {
        bx1 = 0; by1 = 0; bx2 = this.virtualWidth; by2 = this.virtualHeight;
      }

      // Add 10mm margin (approx 118 px at 300 DPI)
      const margin = 118;
      bx1 = Math.max(0, bx1 - margin);
      by1 = Math.max(0, by1 - margin);
      bx2 = Math.min(this.virtualWidth, bx2 + margin);
      by2 = Math.min(this.virtualHeight, by2 + margin);

      const contentW = Math.max(100, bx2 - bx1);
      const contentH = Math.max(100, by2 - by1);

      const profile = PAPER_PROFILES[paperKey] || PAPER_PROFILES.a4;
      let targetW = profile.widthPx || contentW;
      let targetH = profile.heightPx || contentH;

      // Auto-orient target paper if content is landscape
      const isLandscapeContent = contentW > contentH;
      if (targetW && targetH) {
        if (isLandscapeContent && targetH > targetW) {
          const tmp = targetW; targetW = targetH; targetH = tmp;
        } else if (!isLandscapeContent && targetW > targetH) {
          const tmp = targetW; targetW = targetH; targetH = tmp;
        }
      }

      const outCanvas = document.createElement("canvas");
      outCanvas.width = targetW;
      outCanvas.height = targetH;
      const outCtx = outCanvas.getContext("2d");

      // Fill white
      outCtx.fillStyle = "#ffffff";
      outCtx.fillRect(0, 0, targetW, targetH);

      // Render background if not fit
      outCtx.drawImage(this.bgCanvas, bx1, by1, contentW, contentH, 0, 0, targetW, targetH);

      // Calculate aspect-ratio fit
      const scaleFit = Math.min(targetW / contentW, targetH / contentH);
      const renderW = contentW * scaleFit;
      const renderH = contentH * scaleFit;
      const offsetX = (targetW - renderW) / 2;
      const offsetY = (targetH - renderH) / 2;

      outCtx.drawImage(this.drawCanvas, bx1, by1, contentW, contentH, offsetX, offsetY, renderW, renderH);

      // Monochrome filter if requested
      if (colorMode === "monochrome") {
        const imgData = outCtx.getImageData(0, 0, targetW, targetH);
        const d = imgData.data;
        for (let i = 0; i < d.length; i += 4) {
          const gray = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
          d[i] = gray; d[i + 1] = gray; d[i + 2] = gray;
        }
        outCtx.putImageData(imgData, 0, 0);
      }

      return {
        dataUrl: outCanvas.toDataURL("image/jpeg", 0.94),
        rawDrawDataUrl: this.drawCanvas.toDataURL("image/png"),
        width: targetW,
        height: targetH,
        paperSize: profile.name
      };
    }

    // =========================================================================
    // Multi-tier Printing Engine
    // =========================================================================
    async dispatchPrint(rasterResult) {
      const mode = this._config.print_mode || "ipp";
      const printerIp = this._config.printer_ip;

      // 1. Direct IPP (Port 631)
      if (mode === "ipp" && printerIp) {
        try {
          const url = `http://${printerIp}:${this._config.printer_port || 631}/ipp/print`;
          // Convert Data URL to binary blob
          const res = await fetch(rasterResult.dataUrl);
          const blob = await res.blob();
          
          // Send print request (if gateway / CORS allows)
          const response = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "image/jpeg" },
            body: blob
          });
          if (response.ok) {
            this.showToast("Print job dispatched to printer!");
            return true;
          }
        } catch (err) {
          console.warn("Direct IPP dispatch blocked (CORS / Mixed Content). Falling back to OS Print dialog...", err);
        }
      }

      // 2. HA Service Bridge
      if (mode === "ha_service" && this._hass) {
        try {
          await this._hass.callService("notify", "persistent_notification", {
            title: "Canvas Print Task",
            message: `Print task prepared for ${printerIp || "Default Printer"} (${rasterResult.paperSize}).`
          });
          this.showToast("Print task forwarded to Home Assistant!");
          return true;
        } catch (err) {
          console.error("HA Service call failed:", err);
        }
      }

      // 3. Dedicated Gateway
      if (mode === "gateway" && this._config.gateway_url) {
        try {
          const resp = await fetch(this._config.gateway_url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              image: rasterResult.dataUrl,
              copies: 1,
              color: this._config.color_mode === "color"
            })
          });
          if (resp.ok) {
            this.showToast("Print job sent to Gateway!");
            return true;
          }
        } catch (err) {
          console.warn("Print Gateway failed:", err);
        }
      }

      // 4. Fallback: OS System Print Dialog (Universal 100% Support)
      return this.triggerOSPrint(rasterResult.dataUrl);
    }

    triggerOSPrint(imageUrl) {
      const printWin = window.open("", "_blank");
      if (!printWin) {
        this.showToast("Please allow pop-ups for printing");
        return false;
      }
      printWin.document.write(`
        <!DOCTYPE html>
        <html>
        <head>
          <title>Print Document</title>
          <style>
            @page { size: auto; margin: 0; }
            body { margin: 0; display: flex; align-items: center; justify-content: center; background: #fff; }
            img { width: 100%; height: auto; max-height: 100vh; object-fit: contain; }
          </style>
        </head>
        <body>
          <img src="${imageUrl}" onload="window.print(); window.close();" />
        </body>
        </html>
      `);
      printWin.document.close();
      this.showToast("Print preview opened!");
      return true;
    }

    // =========================================================================
    // Core Button Actions Workflow
    // =========================================================================
    async handleSaveAndNew() {
      const raster = this.exportCroppedRaster(this._config.paper_size, this._config.color_mode);
      await CanvasHistoryDB.saveItem({
        thumbnail: raster.dataUrl,
        rawDrawing: raster.rawDrawDataUrl,
        paperSize: raster.paperSize,
        printed: false
      });
      this.clearCanvas();
      this.showToast("Drawing saved! Ready for new canvas.");
    }

    handleDiscardAndNew() {
      if (this._config.confirm_discard) {
        if (!confirm("Are you sure you want to discard this drawing without saving?")) {
          return;
        }
      }
      this.clearCanvas();
      this.showToast("Canvas discarded and reset.");
    }

    async handlePrintAndNew() {
      const root = this.shadowRoot;
      const modal = root.getElementById("printModal");
      const previewImg = root.getElementById("printPreviewImg");
      const raster = this.exportCroppedRaster(this._config.paper_size, this._config.color_mode);

      previewImg.src = raster.dataUrl;
      modal.style.display = "flex";

      const confirmBtn = root.getElementById("btnConfirmPrint");
      const onConfirm = async () => {
        confirmBtn.removeEventListener("click", onConfirm);
        modal.style.display = "none";

        const selectedPaper = root.getElementById("selectPaperSize").value;
        const selectedColor = root.getElementById("selectColorMode").value;
        const finalRaster = this.exportCroppedRaster(selectedPaper, selectedColor);

        await this.dispatchPrint(finalRaster);

        // Auto-archive with printed flag
        await CanvasHistoryDB.saveItem({
          thumbnail: finalRaster.dataUrl,
          rawDrawing: finalRaster.rawDrawDataUrl,
          paperSize: finalRaster.paperSize,
          printed: true
        });

        this.clearCanvas();
      };
      confirmBtn.addEventListener("click", onConfirm);
    }

    async openHistory() {
      const root = this.shadowRoot;
      const modal = root.getElementById("historyModal");
      const grid = root.getElementById("historyGrid");
      grid.innerHTML = `<div style="grid-column: 1/-1; text-align: center; color: var(--text-secondary); padding: 20px;">Loading history...</div>`;
      modal.style.display = "flex";

      const items = await CanvasHistoryDB.getAllItems(40);
      if (items.length === 0) {
        grid.innerHTML = `<div style="grid-column: 1/-1; text-align: center; color: var(--text-secondary); padding: 30px;">No saved drawings found.</div>`;
        return;
      }

      grid.innerHTML = "";
      items.forEach((item) => {
        const card = document.createElement("div");
        card.className = "history-card";
        card.innerHTML = `
          <img class="history-thumb" src="${item.thumbnail}" alt="Thumbnail" />
          <div class="history-info">
            <span class="history-time">${item.createdAt || "Recent"}</span>
            <span class="history-badge" style="${item.printed ? "" : "background: rgba(59,130,246,0.15); color: #3b82f6;"}">
              ${item.printed ? "Printed" : "Saved"}
            </span>
            <div class="history-actions">
              <button class="btn-mini" data-action="re-edit" data-id="${item.id}" title="Load onto canvas to continue editing">Edit</button>
              <button class="btn-mini" data-action="re-print" data-id="${item.id}" title="Print again">Print</button>
              <button class="btn-mini" data-action="download" data-id="${item.id}" title="Download image">Export</button>
              <button class="btn-mini danger" data-action="delete" data-id="${item.id}" title="Delete">✕</button>
            </div>
          </div>
        `;

        card.querySelectorAll("button[data-action]").forEach((btn) => {
          btn.addEventListener("click", async (e) => {
            const action = e.currentTarget.dataset.action;
            if (action === "re-edit") {
              await this.loadDrawingFromDataUrl(item.rawDrawing || item.thumbnail);
              modal.style.display = "none";
              this.showToast("Drawing restored onto canvas!");
            } else if (action === "re-print") {
              this.dispatchPrint({ dataUrl: item.thumbnail, paperSize: item.paperSize || "A4" });
            } else if (action === "download") {
              const a = document.createElement("a");
              a.href = item.thumbnail;
              a.download = `canvas_drawing_${item.id}.jpg`;
              a.click();
            } else if (action === "delete") {
              if (confirm("Delete this saved drawing?")) {
                await CanvasHistoryDB.deleteItem(item.id);
                this.openHistory();
              }
            }
          });
        });

        grid.appendChild(card);
      });
    }

    async loadDrawingFromDataUrl(url) {
      return new Promise((resolve) => {
        const img = new Image();
        img.onload = () => {
          this.drawCtx.clearRect(0, 0, this.virtualWidth, this.virtualHeight);
          this.drawCtx.drawImage(img, 0, 0, this.virtualWidth, this.virtualHeight);
          this.bounds = { minX: 0, minY: 0, maxX: this.virtualWidth, maxY: this.virtualHeight };
          this.saveState();
          this.fitViewportToCenter();
          resolve(true);
        };
        img.src = url;
      });
    }

    showToast(message) {
      const toast = this.shadowRoot.getElementById("canvasToast");
      const text = this.shadowRoot.getElementById("toastMessage");
      if (toast && text) {
        text.textContent = message;
        toast.classList.add("show");
        clearTimeout(this._toastTimer);
        this._toastTimer = setTimeout(() => toast.classList.remove("show"), 2600);
      }
    }

    // =========================================================================
    // UI Event Listeners Binding
    // =========================================================================
    bindUIEvents() {
      const root = this.shadowRoot;

      // Primary Actions
      root.getElementById("btnSaveNew").addEventListener("click", () => this.handleSaveAndNew());
      root.getElementById("btnDiscardNew").addEventListener("click", () => this.handleDiscardAndNew());
      root.getElementById("btnPrintNew").addEventListener("click", () => this.handlePrintAndNew());
      root.getElementById("btnHistory").addEventListener("click", () => this.openHistory());

      // Modals Close
      root.getElementById("btnCloseHistory").addEventListener("click", () => {
        root.getElementById("historyModal").style.display = "none";
      });
      root.getElementById("btnClearHistory").addEventListener("click", async () => {
        if (confirm("Are you sure you want to delete ALL saved drawings?")) {
          await CanvasHistoryDB.clearAll();
          this.openHistory();
        }
      });
      root.getElementById("btnClosePrint").addEventListener("click", () => {
        root.getElementById("printModal").style.display = "none";
      });
      root.getElementById("btnCancelPrint").addEventListener("click", () => {
        root.getElementById("printModal").style.display = "none";
      });

      // Tool Buttons
      const toolBtns = root.querySelectorAll(".tool-btn[data-tool]");
      toolBtns.forEach((btn) => {
        btn.addEventListener("click", () => {
          toolBtns.forEach((b) => b.classList.remove("active"));
          btn.classList.add("active");
          this.currentTool = btn.dataset.tool;
          if (this.currentTool !== "text" && this.activeTextBox) {
            this.commitActiveTextBox();
          }
        });
      });

      // Size Buttons
      const sizeBtns = root.querySelectorAll(".size-btn[data-size]");
      sizeBtns.forEach((btn) => {
        btn.addEventListener("click", () => {
          sizeBtns.forEach((b) => b.classList.remove("active"));
          btn.classList.add("active");
          this.currentSize = parseInt(btn.dataset.size, 10);
        });
      });

      // Color Swatches
      const colorSwatches = root.querySelectorAll(".color-swatch[data-color]");
      colorSwatches.forEach((btn) => {
        btn.addEventListener("click", () => {
          colorSwatches.forEach((b) => b.classList.remove("active"));
          btn.classList.add("active");
          this.currentColor = btn.dataset.color;
          if (this.currentTool === "eraser") {
            const penBtn = root.querySelector('.tool-btn[data-tool="pen"]');
            if (penBtn) penBtn.click();
          }
        });
      });

      const picker = root.getElementById("paletteColorPicker");
      if (picker) {
        picker.addEventListener("input", (e) => {
          colorSwatches.forEach((b) => b.classList.remove("active"));
          this.currentColor = e.target.value;
          if (this.currentTool === "eraser") {
            const penBtn = root.querySelector('.tool-btn[data-tool="pen"]');
            if (penBtn) penBtn.click();
          }
        });
      }

      // Undo / Redo / Clear
      root.getElementById("btnUndo").addEventListener("click", () => this.undo());
      root.getElementById("btnRedo").addEventListener("click", () => this.redo());
      root.getElementById("btnClear").addEventListener("click", () => {
        if (confirm("Clear all drawings on the canvas?")) {
          this.clearCanvas();
        }
      });

      // Reset Zoom Pill
      root.getElementById("resetZoomBtn").addEventListener("click", () => this.resetZoom());

      // Commit text box on outside click
      this.viewport.addEventListener("mousedown", (e) => {
        if (this.activeTextBox && !e.target.closest(".canvas-text-box") && !e.target.closest("#drawCanvas")) {
          this.commitActiveTextBox();
        }
      });
    }

    _updateConfigBindings() {
      const title = this.shadowRoot.getElementById("titleText");
      if (title) title.textContent = this._config.title || "Canvas Studio";

      const badge = this.shadowRoot.getElementById("printerBadge");
      const statusText = this.shadowRoot.getElementById("printerStatusText");
      if (badge && statusText) {
        if (this._config.printer_ip) {
          badge.classList.remove("offline");
          statusText.textContent = this._config.printer_ip;
        } else {
          badge.classList.add("offline");
          statusText.textContent = "No Printer";
        }
      }
    }
  }

  // =========================================================================
  // Lovelace Card Visual Form Editor (<ha-form>)
  // =========================================================================
  const EDITOR_SCHEMA = [
    {
      name: "title",
      label: "Card Title",
      selector: { text: {} }
    },
    {
      type: "expandable",
      name: "printer_settings",
      title: "Printer Configuration",
      icon: "mdi:printer-settings",
      schema: [
        {
          name: "printer_ip",
          label: "Printer IP Address or Hostname (e.g. 192.168.2.71)",
          selector: { text: {} }
        },
        {
          name: "printer_port",
          label: "Printer Port (Default: 631 for IPP, 9100 for RAW)",
          selector: { number: { min: 1, max: 65535, mode: "box" } }
        },
        {
          name: "print_mode",
          label: "Printing Protocol / Dispatch Mode",
          selector: {
            select: {
              options: [
                { value: "ipp", label: "Direct IPP (Port 631 / Local Network)" },
                { value: "ha_service", label: "Home Assistant Service Bridge" },
                { value: "gateway", label: "Dedicated Print Gateway URL" },
                { value: "os_print", label: "OS Native Print Dialog (Universal Fallback)" }
              ]
            }
          }
        },
        {
          name: "gateway_url",
          label: "Gateway URL (Optional, if using dedicated print service)",
          selector: { text: {} }
        }
      ]
    },
    {
      type: "expandable",
      name: "canvas_settings",
      title: "Canvas & Output Settings",
      icon: "mdi:palette-swatch-outline",
      schema: [
        {
          name: "paper_size",
          label: "Default Paper Format (300 DPI Auto-fit)",
          selector: {
            select: {
              options: [
                { value: "a4", label: "A4 (210 x 297 mm)" },
                { value: "a3", label: "A3 (297 x 420 mm)" },
                { value: "letter", label: "Letter (8.5 x 11 in)" },
                { value: "thermal80", label: "Thermal Receipt (80 mm roll)" },
                { value: "fit", label: "Fit Content (1:1 Bounding Box)" }
              ]
            }
          }
        },
        {
          name: "canvas_bg",
          label: "Canvas Background Style",
          selector: {
            select: {
              options: [
                { value: "grid", label: "Engineering Grid (Light Blue)" },
                { value: "blank", label: "Clean Pure White" },
                { value: "dots", label: "Dot Matrix" }
              ]
            }
          }
        },
        {
          name: "height",
          label: "Card Height (px)",
          selector: { number: { min: 350, max: 1200, step: 20, mode: "slider" } }
        },
        {
          name: "confirm_discard",
          label: "Confirm before Discarding Current Drawing",
          selector: { boolean: {} }
        }
      ]
    }
  ];

  class CanvasCardEditor extends HTMLElement {
    constructor() {
      super();
      this.attachShadow({ mode: "open" });
    }

    setConfig(config) {
      this._config = { ...config };
      this.render();
    }

    set hass(hass) {
      this._hass = hass;
      if (this._form) {
        this._form.hass = hass;
      }
    }

    render() {
      if (!this._form) {
        this.shadowRoot.innerHTML = `
          <ha-form id="form"></ha-form>
        `;
        this._form = this.shadowRoot.getElementById("form");
        this._form.schema = EDITOR_SCHEMA;
        this._form.computeLabel = (s) => s.label || s.name;
        this._form.addEventListener("value-changed", (ev) => {
          const event = new CustomEvent("config-changed", {
            detail: { config: ev.detail.value },
            bubbles: true,
            composed: true
          });
          this.dispatchEvent(event);
        });
      }
      this._form.data = this._config;
    }
  }

  // Register Elements
  customElements.define("canvas-card-editor", CanvasCardEditor);
  customElements.define("canvas-card", CanvasCard);

  // Register Lovelace Card Picker
  window.customCards = window.customCards || [];
  window.customCards.push({
    type: "canvas-card",
    name: "Canvas Card",
    description: "An infinite-canvas drawing & 300 DPI printing card with draggable text box, history, and multi-tier network printing.",
    preview: true,
    documentationURL: "https://github.com/lucayunxiao/canvas-card"
  });

  console.info(
    `%c CANVAS-CARD %c v${CARD_VERSION} `,
    "background: #2563eb; color: #fff; font-weight: 700; border-radius: 3px 0 0 3px;",
    "background: #0f172a; color: #fff; font-weight: 700; border-radius: 0 3px 3px 0;"
  );
})();
