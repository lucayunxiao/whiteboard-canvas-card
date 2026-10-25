/**
 * Whiteboard Canvas Card - Infinite Canvas Drawing & 300 DPI Printing Card for Home Assistant Lovelace
 * Repository: https://github.com/lucayunxiao/whiteboard-canvas-card
 * Version: 1.0.9
 * License: MIT
 *
 * 100% Pure English UI
 * Features:
 *  - Infinite Canvas with smooth Quadratic Bézier stroke interpolation & anti-aliasing
 *  - Continuous, Boundless Viewport Grid / Dot Matrix tiling dynamically with pan & zoom
 *  - High-performance GPU hardware accelerated 3200x3200 virtual drawing surface
 *  - Desktop CAD/Figma Navigation: Mouse wheel cursor-centered zoom + Right/Middle-click drag to pan
 *  - Mobile Navigation Pod: Bottom-right [-] [100%] [+] zoom buttons & Toolbar [Hand] tool for jitter-free pan
 *  - Dual-touch gesture isolation with zero ghost/stray dots
 *  - Automatic Viewport Centering & Full-Screen Zoom-to-Fit Content
 *  - Multi-Terminal Real-Time Sync: Dual-layer BroadcastChannel + HA WebSocket event bus (canvas_card_sync)
 *  - Real-Time Undo / Redo / Clear / Stroke / Text / History Restore synchronization across all terminals
 *  - Interactive Print Framing Dialog: Crop & Print with aspect-ratio locked framing box (A4, A5, A3, Letter, Thermal)
 *  - Multi-tier Print Engine: Direct IPP (Port 631), HA Service Bridge, Gateway, OS Print
 *  - Standalone Printing Toggle & Dynamic Header Synchronization
 *  - Configurable History retention limit (Default: 30, Max: 100) with automatic FIFO pruning
 *  - Flattened GUI Visual Form Editor (<ha-form>) with deselectable dropdowns
 */

(function () {
  "use strict";

  // Prevent duplicate registration
  if (customElements.get("whiteboard-canvas-card")) return;

  const CARD_VERSION = "1.1.0";
  const DB_NAME = "CanvasCardDB";
  const DB_VERSION = 1;
  const STORE_NAME = "history";

  // Standard Paper Profiles (Dimensions in mm and 300 DPI raster pixels: 1 inch = 25.4 mm)
  const PAPER_PROFILES = {
    a4: { name: "A4 (210 x 297 mm)", widthMm: 210, heightMm: 297, widthPx: 2480, heightPx: 3508 },
    a5: { name: "A5 (148 x 210 mm)", widthMm: 148, heightMm: 210, widthPx: 1748, heightPx: 2480 },
    a3: { name: "A3 (297 x 420 mm)", widthMm: 297, heightMm: 420, widthPx: 3508, heightPx: 4960 },
    letter: { name: "US Letter (8.5 x 11 in)", widthMm: 215.9, heightMm: 279.4, widthPx: 2550, heightPx: 3300 },
    thermal80: { name: "Thermal Receipt (80 mm)", widthMm: 80, heightMm: 140, widthPx: 945, heightPx: 1654 }
  };

  const DEFAULT_CONFIG = {
    title: "Canvas Studio",
    enable_printing: false,
    printer_ip: "",
    printer_port: 631,
    print_mode: "ipp", // 'ipp', 'ha_service', 'gateway', 'os_print'
    ha_print_service: "notify.printer",
    gateway_url: "",
    canvas_bg: "grid", // 'grid', 'blank', 'dots'
    confirm_discard: true,
    height: 560,
    max_history_items: 30,
    sync_channel: "canvas_studio",
    enable_sync: true
  };

  // =========================================================================
  // IndexedDB Storage Manager for Persistent History with Configurable Limit
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

    static async saveItem(item, maxLimit = 30) {
      const db = await this.getDB();
      await new Promise((resolve, reject) => {
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

      // Automatic FIFO limit pruning
      try {
        const all = await this.getAllItems(200);
        const limit = Math.max(5, Math.min(100, Number(maxLimit) || 30));
        if (all.length > limit) {
          const toDelete = all.slice(limit);
          for (const record of toDelete) {
            await this.deleteItem(record.id);
          }
        }
      } catch (err) {
        console.warn("History limit pruning error:", err);
      }
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
  // Whiteboard Canvas Card Custom Element
  // =========================================================================
  class WhiteboardCanvasCard extends HTMLElement {
    constructor() {
      super();
      this.attachShadow({ mode: "open" });

      // Configuration state
      this._config = { ...DEFAULT_CONFIG };

      // Unique Client ID for multi-terminal sync
      this.clientId = "client_" + Math.random().toString(36).slice(2, 9);
      this._seenEvents = new Set();
      this._broadcastChannel = null;
      this._unsubHassSync = null;

      // Virtual Canvas Dimensions (GPU hardware accelerated <= 4096px boundary)
      this.virtualWidth = 3200;
      this.virtualHeight = 3200;

      // Infinite Canvas Viewport State
      this.scale = 1.0;
      this.panX = 0;
      this.panY = 0;
      this.isPinching = false;
      this.isPanning = false;
      this.isPanningCanvas = false;
      this.panStartX = 0;
      this.panStartY = 0;
      this.initialDistance = 0;
      this.initialScale = 1.0;
      this.initialMidX = 0;
      this.initialMidY = 0;
      this.initialPanX = 0;
      this.initialPanY = 0;

      // Tool State
      this.currentTool = "pen"; // 'pen', 'marker', 'eraser', 'text', 'hand'
      this.currentColor = "#1e293b";
      this.currentSize = 6; // Pen base size
      this.isDrawing = false;
      this.hasMoved = false; // Tracks if gesture produced actual movement
      this.startX = 0;
      this.startY = 0;
      this.lastX = 0;
      this.lastY = 0;
      this.midX = 0;
      this.midY = 0;
      this._vpRect = null; // Cached viewport rect to prevent layout thrashing
      this.currentStrokePoints = [];

      // Per-Device Collaborative Operation Stack & Local Redo Stack
      this.operations = [];
      this.redoStack = [];
      this._baseImageElement = null;
      this._baseImageDataUrl = null;
      this.historyStack = [];
      this.historyStep = -1;
      this.maxHistory = 30;

      // Floating Text Box State
      this.activeTextBox = null;
      this.selectedTextColor = "#1e293b";
      this.selectedTextSizeLevel = 3;
      this.previewFontSizesCss = { 1: 18, 2: 24, 3: 32, 4: 44 };

      // Bounding box accumulator for strokes [minX, minY, maxX, maxY]
      this.bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };

      this._initialCentered = false;
      this._lastFittedScale = null;
      this._resizeObserver = null;
    }

    setConfig(config) {
      const pSettings = config.printer_settings || {};
      const cSettings = config.canvas_settings || {};

      const printerIp = (config.printer_ip !== undefined ? config.printer_ip : pSettings.printer_ip) || "";
      const enablePrinting = (config.enable_printing !== undefined)
        ? Boolean(config.enable_printing)
        : (pSettings.enable_printing !== undefined ? Boolean(pSettings.enable_printing) : false);

      this._config = {
        title: config.title || "Canvas Studio",
        enable_printing: enablePrinting,
        printer_ip: String(printerIp).trim(),
        printer_port: Number(config.printer_port ?? pSettings.printer_port ?? 631),
        print_mode: config.print_mode ?? pSettings.print_mode ?? "ipp",
        ha_print_service: config.ha_print_service ?? pSettings.ha_print_service ?? "notify.printer",
        gateway_url: String(config.gateway_url ?? pSettings.gateway_url ?? "").trim(),
        canvas_bg: config.canvas_bg ?? cSettings.canvas_bg ?? "grid",
        height: Number(config.height ?? cSettings.height ?? 560),
        confirm_discard: (config.confirm_discard !== undefined)
          ? Boolean(config.confirm_discard)
          : (cSettings.confirm_discard !== undefined ? Boolean(cSettings.confirm_discard) : true),
        max_history_items: Number(config.max_history_items ?? cSettings.max_history_items ?? 30),
        sync_channel: String(config.sync_channel || "canvas_studio").trim(),
        enable_sync: config.enable_sync !== undefined ? Boolean(config.enable_sync) : true
      };

      if (this._rendered) {
        this._updateConfigBindings();
      }
    }

    set hass(hass) {
      this._hass = hass;
      if (!this._unsubHassSync && this._rendered) {
        this.setupHassSync();
      }
    }

    getCardSize() {
      return 6;
    }

    static getConfigElement() {
      return document.createElement("whiteboard-canvas-card-editor");
    }

    static getStubConfig() {
      return {
        title: "Canvas Studio",
        enable_printing: false,
        printer_ip: "",
        printer_port: 631,
        print_mode: "ipp",
        canvas_bg: "grid",
        height: 560,
        confirm_discard: true,
        max_history_items: 30,
        sync_channel: "canvas_studio",
        enable_sync: true
      };
    }

    isPrintingEnabled() {
      return Boolean(this._config.enable_printing);
    }

    hasStrokes() {
      return (
        this.bounds &&
        this.bounds.minX !== Infinity &&
        this.bounds.maxX !== -Infinity &&
        (this.bounds.maxX > this.bounds.minX || this.bounds.maxY > this.bounds.minY)
      );
    }

    connectedCallback() {
      if (!this._rendered) {
        this.render();
        this._rendered = true;
      }
      this.initSyncEngine();
      if (this._hass) {
        this.setupHassSync();
      }
    }

    disconnectedCallback() {
      if (this._resizeObserver) {
        this._resizeObserver.disconnect();
        this._resizeObserver = null;
      }
      if (this._broadcastChannel) {
        this._broadcastChannel.close();
        this._broadcastChannel = null;
      }
      if (this._unsubHassSync) {
        if (typeof this._unsubHassSync === "function") {
          this._unsubHassSync();
        } else if (typeof this._unsubHassSync.then === "function") {
          this._unsubHassSync.then((unsub) => { if (typeof unsub === "function") unsub(); });
        }
        this._unsubHassSync = null;
      }
    }

    // =========================================================================
    // UI Template & Styles
    // =========================================================================
    render() {
      const isPrint = this.isPrintingEnabled();

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

          /* Boundless Canvas Viewport */
          .viewport {
            position: relative;
            width: 100%;
            height: ${this._config.height || 560}px;
            overflow: hidden;
            background-color: #ffffff;
            touch-action: none;
            user-select: none;
            cursor: crosshair;
          }

          .canvas-sheet {
            position: absolute;
            top: 0;
            left: 0;
            width: ${this.virtualWidth}px;
            height: ${this.virtualHeight}px;
            transform-origin: 0 0;
            will-change: transform;
            pointer-events: auto;
          }

          #drawCanvas {
            position: absolute;
            top: 0;
            left: 0;
            display: block;
            width: ${this.virtualWidth}px;
            height: ${this.virtualHeight}px;
            z-index: 2;
          }

          /* Floating Viewport Control Pod (Bottom-Right) */
          .viewport-control-pod {
            position: absolute;
            bottom: 16px;
            right: 16px;
            z-index: 20;
            display: flex;
            align-items: center;
            background: rgba(15, 23, 42, 0.92);
            backdrop-filter: blur(8px);
            border-radius: 24px;
            box-shadow: 0 4px 16px rgba(0, 0, 0, 0.3);
            border: 1px solid rgba(255, 255, 255, 0.15);
            padding: 2px 4px;
            gap: 2px;
          }

          .pod-btn {
            background: transparent;
            border: none;
            color: #ffffff;
            padding: 6px 10px;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            gap: 4px;
            font-size: 12px;
            font-weight: 700;
            cursor: pointer;
            border-radius: 20px;
            transition: all 0.15s ease;
            user-select: none;
          }
          .pod-btn:hover {
            background: rgba(255, 255, 255, 0.18);
          }
          .pod-btn:active {
            transform: scale(0.95);
          }

          .pod-center-btn {
            padding: 6px 12px;
            background: rgba(255, 255, 255, 0.08);
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

          /* Modals */
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
            max-width: 620px;
            width: 100%;
            max-height: 94%;
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
            display: flex;
            align-items: center;
            gap: 8px;
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
          /* Print Framing Modal Styles */
          /* ========================================================================= */
          .print-framing-card {
            max-width: 660px;
          }

          .print-settings-bar {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 12px;
            flex-wrap: wrap;
            margin-bottom: 12px;
            padding: 10px 14px;
            background: rgba(0, 0, 0, 0.03);
            border-radius: 10px;
            border: 1px solid var(--surface-border);
          }

          .setting-item {
            display: flex;
            flex-direction: column;
            gap: 4px;
          }

          .setting-item label {
            font-size: 11px;
            font-weight: 700;
            text-transform: uppercase;
            letter-spacing: 0.5px;
            color: var(--text-secondary);
          }

          .print-select {
            padding: 6px 10px;
            border-radius: 6px;
            border: 1px solid var(--surface-border);
            background: var(--surface-bg);
            color: var(--text-primary);
            font-size: 13px;
            font-weight: 600;
            font-family: inherit;
            cursor: pointer;
            outline: none;
          }
          .print-select:hover {
            border-color: var(--primary-accent);
          }

          .orientation-btn-group {
            display: flex;
            align-items: center;
            gap: 2px;
            background: var(--surface-border);
            padding: 2px;
            border-radius: 6px;
          }

          .orientation-btn {
            display: inline-flex;
            align-items: center;
            gap: 4px;
            padding: 5px 10px;
            border: none;
            background: transparent;
            font-size: 12px;
            font-weight: 600;
            color: var(--text-secondary);
            border-radius: 4px;
            cursor: pointer;
            transition: all 0.15s ease;
          }

          .orientation-btn.active {
            background: var(--surface-bg);
            color: var(--primary-accent);
            box-shadow: 0 1px 4px rgba(0,0,0,0.12);
          }

          /* Interactive Framing Stage */
          .framing-stage-container {
            width: 100%;
            height: 330px;
            position: relative;
            background: #0f172a;
            border-radius: 10px;
            overflow: hidden;
            display: flex;
            align-items: center;
            justify-content: center;
            user-select: none;
            touch-action: none;
          }

          .framing-stage {
            position: relative;
            width: 100%;
            height: 100%;
            cursor: grab;
            touch-action: none;
          }
          .framing-stage:active {
            cursor: grabbing;
          }

          #framingPreviewCanvas {
            position: absolute;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            display: block;
          }

          /* Fixed Paper Framing Box with outer vignette mask */
          .framing-box {
            position: absolute;
            border: 2.5px solid #3b82f6;
            box-shadow: 0 0 0 9999px rgba(15, 23, 42, 0.65), 0 0 16px rgba(59, 130, 246, 0.4);
            pointer-events: none;
            box-sizing: border-box;
            transition: width 0.18s ease, height 0.18s ease, left 0.18s ease, top 0.18s ease;
          }

          .frame-rule {
            position: absolute;
            background: rgba(59, 130, 246, 0.22);
            pointer-events: none;
          }
          .rule-v1 { top: 0; bottom: 0; left: 33.33%; width: 1px; }
          .rule-v2 { top: 0; bottom: 0; left: 66.66%; width: 1px; }
          .rule-h1 { left: 0; right: 0; top: 33.33%; height: 1px; }
          .rule-h2 { left: 0; right: 0; top: 66.66%; height: 1px; }

          .frame-badge {
            position: absolute;
            top: 6px;
            left: 6px;
            background: rgba(15, 23, 42, 0.88);
            color: #ffffff;
            font-size: 10px;
            font-weight: 700;
            padding: 3px 8px;
            border-radius: 4px;
            pointer-events: none;
            border: 1px solid rgba(255, 255, 255, 0.15);
          }

          .framing-tools {
            display: flex;
            align-items: center;
            gap: 8px;
            margin-top: 10px;
          }

          .btn-framing-tool {
            display: inline-flex;
            align-items: center;
            gap: 4px;
            padding: 5px 10px;
            font-size: 12px;
            font-weight: 600;
            border: 1px solid var(--surface-border);
            background: var(--surface-bg);
            color: var(--text-primary);
            border-radius: 6px;
            cursor: pointer;
          }
          .btn-framing-tool:hover {
            background: var(--btn-hover);
          }

          .framing-hint {
            font-size: 12px;
            color: var(--text-secondary);
            margin-left: auto;
          }

          /* ========================================================================= */
          /* Inline Draggable Floating Text Box */
          /* ========================================================================= */
          .canvas-text-box {
            position: absolute;
            z-index: 45;
            display: flex;
            flex-direction: column;
            gap: 6px;
            padding: 0;
            width: min(380px, calc(100% - 32px));
            touch-action: none;
            user-select: none;
            -webkit-user-select: none;
            filter: drop-shadow(0 12px 28px rgba(0, 0, 0, 0.28));
          }

          .text-drag-bar {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 6px 12px;
            background: rgba(15, 23, 42, 0.96);
            backdrop-filter: blur(8px);
            border-radius: 10px;
            border: 1px solid rgba(255, 255, 255, 0.15);
            cursor: grab;
            touch-action: none;
          }
          .text-drag-bar:active { cursor: grabbing; }

          .drag-title {
            font-size: 12px;
            font-weight: 600;
            color: #94a3b8;
            display: flex;
            align-items: center;
            gap: 6px;
            pointer-events: none;
          }

          .text-box-quick-actions {
            display: flex;
            align-items: center;
            gap: 8px;
          }

          .btn-text-done {
            background: linear-gradient(135deg, #16a34a, #22c55e);
            color: #ffffff;
            border: none;
            padding: 6px 14px;
            border-radius: 6px;
            font-size: 13px;
            font-weight: 700;
            cursor: pointer;
            display: flex;
            align-items: center;
            gap: 5px;
            box-shadow: 0 2px 8px rgba(22, 163, 74, 0.4);
            user-select: none;
          }
          .btn-text-done:active { transform: scale(0.96); }

          .btn-text-cancel {
            background: rgba(255, 255, 255, 0.14);
            color: #e2e8f0;
            border: none;
            padding: 6px 12px;
            border-radius: 6px;
            font-size: 13px;
            font-weight: 700;
            cursor: pointer;
            user-select: none;
          }
          .btn-text-cancel:hover { color: #ef4444; background: rgba(239, 68, 68, 0.2); }

          #inlineTextInput {
            width: 100%;
            min-height: 52px;
            outline: none;
            background: rgba(255, 255, 255, 0.96) !important;
            backdrop-filter: blur(4px);
            border: 2px solid #3b82f6 !important;
            border-radius: 8px;
            box-shadow: 0 6px 20px rgba(0, 0, 0, 0.15);
            padding: 8px 12px;
            font-family: inherit;
            font-weight: 700;
            resize: none;
            overflow: hidden;
            line-height: 1.3;
            box-sizing: border-box;
            caret-color: #2563eb;
            user-select: text;
          }
          #inlineTextInput:focus {
            background: #ffffff !important;
            border-color: #1d4ed8 !important;
            box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.25);
          }

          .text-box-controls {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 8px;
            flex-wrap: wrap;
            background: rgba(15, 23, 42, 0.96);
            backdrop-filter: blur(8px);
            border-radius: 10px;
            border: 1px solid rgba(255, 255, 255, 0.15);
            padding: 6px 12px;
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
              <div class="printer-pill ${this._config.printer_ip ? "" : "offline"}" id="printerBadge" style="display: ${isPrint ? "flex" : "none"};">
                <ha-icon icon="mdi:printer"></ha-icon>
                <span id="printerStatusText">${this._config.printer_ip ? this._config.printer_ip : "OS Print"}</span>
              </div>
            </div>

            <div class="primary-actions">
              <button class="btn-action btn-save-new" id="btnSaveNew" title="Save drawing to history and create fresh canvas">
                <ha-icon icon="mdi:content-save-plus-outline"></ha-icon>
                <span>Save + New</span>
              </button>
              <button class="btn-action btn-discard-new" id="btnDiscardNew" title="Discard current drawing and reset canvas">
                <ha-icon icon="mdi:close-circle-outline"></ha-icon>
                <span>Discard + New</span>
              </button>
              <button class="btn-action btn-print-new" id="btnPrintNew" title="Frame drawing, print at 300 DPI, archive, and reset" style="display: ${isPrint ? "inline-flex" : "none"};">
                <ha-icon icon="mdi:printer-pos-outline"></ha-icon>
                <span>Print + New</span>
              </button>
              <button class="btn-action btn-history" id="btnHistory" title="View drawing history archive">
                <ha-icon icon="mdi:history"></ha-icon>
                <span>History</span>
              </button>
            </div>
          </div>

          <!-- Drawing Toolbox (Always Infinite Canvas) -->
          <div class="toolbar">
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
              <button class="tool-btn" data-tool="hand" title="Hand / Pan Viewport (Single-finger drag)">
                <ha-icon icon="mdi:hand-back-right-outline"></ha-icon>
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

          <!-- Viewport with Boundless Canvas -->
          <div class="viewport" id="viewport">
            <div class="canvas-sheet" id="sheetContainer">
              <canvas id="drawCanvas"></canvas>
            </div>

            <!-- Floating Viewport Control Pod (Bottom-Right) -->
            <div class="viewport-control-pod" id="controlPod">
              <button class="pod-btn" id="btnZoomOut" title="Zoom Out (-20%)">
                <ha-icon icon="mdi:minus"></ha-icon>
              </button>
              <button class="pod-btn pod-center-btn" id="btnZoomReset" title="Fit to Content / Reset (100%)">
                <ha-icon icon="mdi:crosshairs-gps"></ha-icon>
                <span id="zoomPercentText">100%</span>
              </button>
              <button class="pod-btn" id="btnZoomIn" title="Zoom In (+20%)">
                <ha-icon icon="mdi:plus"></ha-icon>
              </button>
            </div>

            <!-- Toast Notification -->
            <div class="canvas-toast" id="canvasToast">
              <ha-icon icon="mdi:check-circle" style="color: #10b981;"></ha-icon>
              <span id="toastMessage">Ready</span>
            </div>
          </div>

          <!-- History Archive Modal -->
          <div class="modal-overlay" id="historyModal">
            <div class="modal-card">
              <div class="modal-header">
                <h3 class="modal-title" id="historyModalTitle">
                  <ha-icon icon="mdi:history" style="color: var(--primary-accent);"></ha-icon>
                  <span>Drawings History</span>
                </h3>
                <button class="tool-btn" id="btnCloseHistory" title="Close">
                  <ha-icon icon="mdi:close"></ha-icon>
                </button>
              </div>
              <div class="modal-body">
                <div class="history-grid" id="historyGrid"></div>
              </div>
              <div class="modal-footer">
                <button class="btn-action btn-discard-new" id="btnClearHistory">
                  <ha-icon icon="mdi:delete-sweep-outline"></ha-icon>
                  <span>Clear All History</span>
                </button>
              </div>
            </div>
          </div>

          <!-- Interactive Print Framing Modal -->
          <div class="modal-overlay" id="printModal">
            <div class="modal-card print-framing-card">
              <div class="modal-header">
                <h3 class="modal-title">
                  <ha-icon icon="mdi:crop-rotate" style="color: var(--primary-accent);"></ha-icon>
                  Frame & Print Drawing
                </h3>
                <button class="tool-btn" id="btnClosePrint" title="Close">
                  <ha-icon icon="mdi:close"></ha-icon>
                </button>
              </div>
              <div class="modal-body">
                <!-- Settings Toolbar -->
                <div class="print-settings-bar">
                  <div class="setting-item">
                    <label>Paper Size</label>
                    <select id="selectPaperSize" class="print-select">
                      <option value="a4" selected>A4 (210 x 297 mm)</option>
                      <option value="a5">A5 (148 x 210 mm)</option>
                      <option value="a3">A3 (297 x 420 mm)</option>
                      <option value="letter">Letter (8.5 x 11 in)</option>
                      <option value="thermal80">Thermal Receipt (80 mm)</option>
                    </select>
                  </div>
                  <div class="setting-item">
                    <label>Orientation</label>
                    <div class="orientation-btn-group">
                      <button type="button" class="orientation-btn active" id="btnOrientPortrait">
                        <ha-icon icon="mdi:crop-portrait"></ha-icon>
                        <span>Portrait</span>
                      </button>
                      <button type="button" class="orientation-btn" id="btnOrientLandscape">
                        <ha-icon icon="mdi:crop-landscape"></ha-icon>
                        <span>Landscape</span>
                      </button>
                    </div>
                  </div>
                  <div class="setting-item">
                    <label>Color Mode</label>
                    <select id="selectColorMode" class="print-select">
                      <option value="color" selected>Full Color</option>
                      <option value="monochrome">Monochrome</option>
                    </select>
                  </div>
                </div>

                <!-- Interactive Framing Stage -->
                <div class="framing-stage-container" id="framingStageContainer">
                  <div class="framing-stage" id="framingStage">
                    <canvas id="framingPreviewCanvas"></canvas>
                    <div class="framing-box" id="framingBox">
                      <div class="frame-rule rule-v1"></div>
                      <div class="frame-rule rule-v2"></div>
                      <div class="frame-rule rule-h1"></div>
                      <div class="frame-rule rule-h2"></div>
                      <div class="frame-badge" id="frameDimensionsBadge">A4 Portrait</div>
                    </div>
                  </div>
                </div>

                <!-- Quick framing controls -->
                <div class="framing-tools">
                  <button type="button" class="btn-framing-tool" id="btnFrameFitAll" title="Scale & center drawing to fit inside paper">
                    <ha-icon icon="mdi:fit-to-page-outline"></ha-icon>
                    <span>Fit Content</span>
                  </button>
                  <button type="button" class="btn-framing-tool" id="btnFrameZoomOut" title="Zoom Out Drawing">
                    <ha-icon icon="mdi:minus"></ha-icon>
                  </button>
                  <button type="button" class="btn-framing-tool" id="btnFrameZoomIn" title="Zoom In Drawing">
                    <ha-icon icon="mdi:plus"></ha-icon>
                  </button>
                  <button type="button" class="btn-framing-tool" id="btnFrameReset" title="Reset 1:1 View">
                    <ha-icon icon="mdi:restore"></ha-icon>
                    <span>Reset View</span>
                  </button>
                  <span class="framing-hint">Drag or scroll canvas to fit inside paper frame</span>
                </div>
              </div>
              <div class="modal-footer">
                <button class="btn-action btn-history" id="btnCancelPrint">Cancel</button>
                <button class="btn-action btn-print-new" id="btnConfirmPrint">
                  <ha-icon icon="mdi:printer"></ha-icon>
                  <span>Print Framed Area</span>
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
    // Canvas Engine Implementation
    // =========================================================================
    initCanvasEngine() {
      const root = this.shadowRoot;
      this.viewport = root.getElementById("viewport");
      this.sheet = root.getElementById("sheetContainer");
      this.drawCanvas = root.getElementById("drawCanvas");

      this.drawCanvas.width = this.virtualWidth;
      this.drawCanvas.height = this.virtualHeight;
      this.drawCtx = this.drawCanvas.getContext("2d", { willReadFrequently: true });

      // Save initial clean state
      this.saveState();

      // Bind drawing and pan/zoom interactions
      this.bindCanvasEvents();

      // ResizeObserver for automatic centering upon layout ready
      if (window.ResizeObserver) {
        this._resizeObserver = new ResizeObserver((entries) => {
          for (const entry of entries) {
            if (entry.contentRect.width > 50 && entry.contentRect.height > 50) {
              if (!this._initialCentered) {
                this._initialCentered = true;
                this.fitViewportToCenter();
              } else {
                this.updateViewportBackground();
              }
            }
          }
        });
        this._resizeObserver.observe(this.viewport);
      }

      // Initial center fallback
      requestAnimationFrame(() => {
        if (!this._initialCentered) {
          this._initialCentered = true;
          this.fitViewportToCenter();
        }
      });

      // Prevent default gestures on touch devices
      this.viewport.addEventListener("gesturestart", (e) => e.preventDefault());
      this.viewport.addEventListener("gesturechange", (e) => e.preventDefault());
      this.viewport.addEventListener("gestureend", (e) => e.preventDefault());
    }

    // =========================================================================
    // Multi-Terminal Real-Time Sync Engine
    // =========================================================================
    initSyncEngine() {
      const channel = this._config.sync_channel || "canvas_studio";
      if (this._broadcastChannel) {
        this._broadcastChannel.close();
      }
      try {
        this._broadcastChannel = new BroadcastChannel("canvas_card_" + channel);
        this._broadcastChannel.onmessage = (ev) => this.handleRemoteEvent(ev.data);
      } catch (err) {
        console.warn("BroadcastChannel not supported in this environment:", err);
      }
    }

    async setupHassSync() {
      if (!this._hass || !this._hass.connection || this._unsubHassSync) return;
      try {
        this._unsubHassSync = await this._hass.connection.subscribeEvents((ev) => {
          this.handleRemoteEvent(ev.data);
        }, "canvas_card_sync");

        // Ask any existing active device for initial drawing state
        setTimeout(() => {
          this.broadcastSyncEvent({
            action: "request_canvas",
            clientId: this.clientId
          });
        }, 400);
      } catch (err) {
        console.warn("HA WebSocket sync subscription warning:", err);
      }
    }

    broadcastSyncEvent(payload) {
      if (!this._config.enable_sync) return;
      payload.clientId = this.clientId;
      payload.channel = this._config.sync_channel || "canvas_studio";
      payload.timestamp = Date.now();
      payload.eventId = `${this.clientId}_${payload.timestamp}_${Math.random().toString(36).slice(2, 7)}`;

      // 1. BroadcastChannel (same browser / tabs - 0ms)
      if (this._broadcastChannel) {
        try {
          this._broadcastChannel.postMessage(payload);
        } catch (e) {}
      }

      // 2. Home Assistant WebSocket Event Bus (cross-device)
      if (this._hass && this._hass.connection) {
        this._hass.connection.sendMessagePromise({
          type: "fire_event",
          event_type: "canvas_card_sync",
          event_data: payload
        }).catch((err) => {
          // Non-critical network warning
        });
      }
    }

    buildCanvasPatchPayload(actionName, extra = {}) {
      const accurate = this.computeAccurateBounds();
      if (accurate) {
        this.bounds = accurate;
      } else {
        this.bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
      }

      if (!this.hasStrokes()) {
        return {
          action: actionName,
          isEmpty: true,
          bounds: { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity },
          ...extra
        };
      }

      const bx = Math.max(0, Math.floor(this.bounds.minX) - 4);
      const by = Math.max(0, Math.floor(this.bounds.minY) - 4);
      const bw = Math.min(this.virtualWidth - bx, Math.ceil(this.bounds.maxX - bx) + 8);
      const bh = Math.min(this.virtualHeight - by, Math.ceil(this.bounds.maxY - by) + 8);

      const patchCanvas = document.createElement("canvas");
      patchCanvas.width = Math.max(1, bw);
      patchCanvas.height = Math.max(1, bh);
      const pCtx = patchCanvas.getContext("2d");
      pCtx.drawImage(this.drawCanvas, bx, by, bw, bh, 0, 0, bw, bh);

      return {
        action: actionName,
        isEmpty: false,
        bounds: { ...this.bounds },
        patchX: bx,
        patchY: by,
        patchW: bw,
        patchH: bh,
        patch: patchCanvas.toDataURL("image/png"),
        ...extra
      };
    }

    applyRemoteStatePatch(data, autoFit = false) {
      if (data.isEmpty) {
        if (data.action === "undo") {
          this.historyStep = 0;
        }
        this.drawCtx.clearRect(0, 0, this.virtualWidth, this.virtualHeight);
        this.bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
        if (this.historyStack[this.historyStep]) {
          const snap = this.historyStack[this.historyStep];
          snap.getContext("2d").clearRect(0, 0, this.virtualWidth, this.virtualHeight);
          snap.bounds = { ...this.bounds };
        }
        this.notifyHistoryButtons();
        return;
      }

      let steppedExistingFrame = false;
      if (data.action === "undo") {
        if (this.historyStep > 1) {
          this.historyStep--;
          steppedExistingFrame = true;
          this.drawCtx.clearRect(0, 0, this.virtualWidth, this.virtualHeight);
          this.drawCtx.drawImage(this.historyStack[this.historyStep], 0, 0);
        } else if (this.historyStep === 1) {
          steppedExistingFrame = true;
        }
      } else if (data.action === "redo") {
        if (this.historyStep < this.historyStack.length - 1) {
          this.historyStep++;
          steppedExistingFrame = true;
          this.drawCtx.clearRect(0, 0, this.virtualWidth, this.virtualHeight);
          this.drawCtx.drawImage(this.historyStack[this.historyStep], 0, 0);
        }
      }

      const imgSrc = data.patch || data.image;
      if (!imgSrc) {
        if (data.bounds) this.bounds = { ...data.bounds };
        this.notifyHistoryButtons();
        return;
      }

      const img = new Image();
      img.onload = () => {
        this.drawCtx.clearRect(0, 0, this.virtualWidth, this.virtualHeight);
        if (data.patch) {
          this.drawCtx.drawImage(
            img,
            data.patchX || 0,
            data.patchY || 0,
            data.patchW || img.width,
            data.patchH || img.height
          );
        } else {
          this.drawCtx.drawImage(img, 0, 0, this.virtualWidth, this.virtualHeight);
        }

        if (data.bounds && data.bounds.minX !== Infinity) {
          this.bounds = { ...data.bounds };
        } else {
          const acc = this.computeAccurateBounds();
          this.bounds = acc || { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
        }

        if (!steppedExistingFrame || this.historyStep <= 0 || !this.historyStack[this.historyStep]) {
          this.saveState();
        } else {
          const snap = this.historyStack[this.historyStep];
          const sCtx = snap.getContext("2d");
          sCtx.clearRect(0, 0, this.virtualWidth, this.virtualHeight);
          sCtx.drawImage(this.drawCanvas, 0, 0);
          snap.bounds = { ...this.bounds };
          this.notifyHistoryButtons();
        }

        if (autoFit) {
          this.fitViewportToCenter();
        }
      };
      img.src = imgSrc;
    }

    handleRemoteEvent(data) {
      if (!data || data.clientId === this.clientId) return;
      if (data.channel !== (this._config.sync_channel || "canvas_studio")) return;

      const eventKey = data.eventId || `${data.clientId}_${data.action}_${data.timestamp}`;
      if (this._seenEvents && this._seenEvents.has(eventKey)) return;
      if (!this._seenEvents) this._seenEvents = new Set();
      this._seenEvents.add(eventKey);
      if (this._seenEvents.size > 200) {
        const oldest = Array.from(this._seenEvents).slice(0, 50);
        oldest.forEach((k) => this._seenEvents.delete(k));
      }

      if (data.action === "stroke") {
        const op = {
          opId: data.opId || `op_${data.clientId}_${data.timestamp}`,
          ownerId: data.ownerId || data.clientId,
          type: "stroke",
          tool: data.tool,
          color: data.color,
          size: data.size,
          points: data.points
        };
        if (!this.operations.some((item) => item.opId === op.opId)) {
          this.operations.push(op);
          this.renderOperationToContext(this.drawCtx, op, true);
          this.notifyHistoryButtons();
        }
      } else if (data.action === "text") {
        const op = {
          opId: data.opId || `op_${data.clientId}_${data.timestamp}`,
          ownerId: data.ownerId || data.clientId,
          type: "text",
          text: data.text,
          x: data.x,
          y: data.y,
          sizeLevel: data.sizeLevel,
          fontSizeVirtual: data.fontSizeVirtual,
          color: data.color
        };
        if (!this.operations.some((item) => item.opId === op.opId)) {
          this.operations.push(op);
          this.renderOperationToContext(this.drawCtx, op, true);
          this.notifyHistoryButtons();
        }
      } else if (data.action === "undo_op") {
        const idx = this.operations.findIndex((item) => item.opId === data.targetOpId);
        if (idx !== -1) {
          this.operations.splice(idx, 1);
          this.redrawAllOperations();
        }
      } else if (data.action === "redo_op") {
        if (data.op && !this.operations.some((item) => item.opId === data.op.opId)) {
          this.operations.push(data.op);
          this.redrawAllOperations();
        }
      } else if (data.action === "clear") {
        this.operations = [];
        this.redoStack = [];
        this._baseImageElement = null;
        this._baseImageDataUrl = null;
        this.drawCtx.clearRect(0, 0, this.virtualWidth, this.virtualHeight);
        this.bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
        this.notifyHistoryButtons();
        this.showToast("Canvas reset by remote user");
      } else if (data.action === "undo" || data.action === "redo" || data.action === "sync_state") {
        this.applyRemoteStatePatch(data, false);
      } else if (data.action === "request_canvas") {
        if (this.operations.length > 0 || this._baseImageDataUrl || this.hasStrokes()) {
          this.broadcastSyncEvent({
            action: "sync_ops",
            targetClientId: data.clientId,
            operations: this.operations,
            baseImage: this._baseImageDataUrl || null
          });
        }
      } else if (data.action === "sync_ops") {
        if (data.targetClientId === this.clientId) {
          this.operations = Array.isArray(data.operations) ? [...data.operations] : [];
          if (data.baseImage) {
            this.loadDrawingFromDataUrl(data.baseImage, null, true);
          } else {
            this.redrawAllOperations();
            this.fitViewportToCenter();
          }
          this.showToast("Canvas synchronized with active session");
        }
      } else if (data.action === "sync_canvas") {
        if (!data.targetClientId || data.targetClientId === this.clientId) {
          if (data.image) {
            this.operations = [];
            this.redoStack = [];
            this.loadDrawingFromDataUrl(data.image, data.bounds);
          } else {
            this.applyRemoteStatePatch(data, true);
          }
          this.showToast("Canvas synchronized with active session");
        }
      }
    }

    renderOperationToContext(ctx, op, updateBoundsFlag = true) {
      if (!op) return;
      if (op.type === "stroke") {
        if (!op.points || op.points.length < 2) return;
        ctx.save();
        ctx.lineCap = "round";
        ctx.lineJoin = "round";

        let lineWidth = op.size || 6;
        if (op.tool === "eraser") {
          ctx.globalCompositeOperation = "destination-out";
          ctx.globalAlpha = 1.0;
          lineWidth *= 3.0;
        } else if (op.tool === "marker") {
          ctx.globalCompositeOperation = "source-over";
          ctx.globalAlpha = 0.38;
          ctx.strokeStyle = op.color || "#1e293b";
          ctx.fillStyle = op.color || "#1e293b";
          lineWidth *= 2.5;
        } else {
          ctx.globalCompositeOperation = "source-over";
          ctx.globalAlpha = 1.0;
          ctx.strokeStyle = op.color || "#1e293b";
          ctx.fillStyle = op.color || "#1e293b";
        }
        const finalWidth = Math.max(2, lineWidth);
        ctx.lineWidth = finalWidth;
        const radius = finalWidth / 2;

        const pts = op.points;
        if (pts.length === 2) {
          ctx.beginPath();
          ctx.arc(pts[0], pts[1], radius, 0, Math.PI * 2);
          ctx.fill();
          if (updateBoundsFlag && op.tool !== "eraser") {
            this.updateBounds(pts[0], pts[1], radius);
          }
        } else {
          let lastX = pts[0];
          let lastY = pts[1];
          let midX = pts[0];
          let midY = pts[1];
          if (updateBoundsFlag && op.tool !== "eraser") {
            this.updateBounds(lastX, lastY, radius);
          }

          for (let i = 2; i < pts.length; i += 2) {
            const curX = pts[i];
            const curY = pts[i + 1];
            const cMidX = (lastX + curX) / 2;
            const cMidY = (lastY + curY) / 2;

            ctx.beginPath();
            ctx.moveTo(midX, midY);
            ctx.quadraticCurveTo(lastX, lastY, cMidX, cMidY);
            ctx.stroke();

            if (updateBoundsFlag && op.tool !== "eraser") {
              this.updateBounds(curX, curY, radius);
            }
            lastX = curX;
            lastY = curY;
            midX = cMidX;
            midY = cMidY;
          }
        }
        ctx.restore();
      } else if (op.type === "text") {
        if (!op.text) return;
        const screenFontSize = this.previewFontSizesCss[op.sizeLevel] || 24;
        const fontSizeVirtual = op.fontSizeVirtual || screenFontSize;

        ctx.save();
        ctx.globalCompositeOperation = "source-over";
        ctx.globalAlpha = 1.0;
        ctx.fillStyle = op.color || "#1e293b";
        ctx.font = `bold ${fontSizeVirtual}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;
        ctx.textBaseline = "top";

        const lines = op.text.split("\n");
        const lineHeight = fontSizeVirtual * 1.3;
        lines.forEach((line, idx) => {
          const ly = op.y + idx * lineHeight;
          ctx.fillText(line, op.x, ly);
          if (updateBoundsFlag) {
            const metrics = ctx.measureText(line);
            this.updateBounds(op.x, ly, 2);
            this.updateBounds(op.x + metrics.width, ly + lineHeight, 2);
          }
        });
        ctx.restore();
      }
    }

    redrawAllOperations() {
      this.drawCtx.clearRect(0, 0, this.virtualWidth, this.virtualHeight);
      this.bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };

      if (this._baseImageElement) {
        this.drawCtx.drawImage(this._baseImageElement, 0, 0, this.virtualWidth, this.virtualHeight);
      }

      for (const op of this.operations) {
        this.renderOperationToContext(this.drawCtx, op, true);
      }

      if ((this._baseImageElement || this.operations.some((o) => o.tool === "eraser")) && !this.hasStrokes()) {
        const acc = this.computeAccurateBounds();
        if (acc) this.bounds = acc;
      }

      this.notifyHistoryButtons();
    }

    // =========================================================================
    // Boundless Viewport Grid / Dot Matrix Background
    // =========================================================================
    updateViewportBackground() {
      if (!this.viewport) return;
      const bg = this._config.canvas_bg || "grid";

      if (bg === "blank") {
        this.viewport.style.backgroundColor = "#ffffff";
        this.viewport.style.backgroundImage = "none";
        return;
      }

      const baseStep = 32;
      const step = Math.max(12, baseStep * this.scale);
      const ox = ((this.panX % step) + step) % step;
      const oy = ((this.panY % step) + step) % step;

      this.viewport.style.backgroundColor = "#ffffff";
      this.viewport.style.backgroundPosition = `${ox}px ${oy}px`;
      this.viewport.style.backgroundSize = `${step}px ${step}px`;

      if (bg === "dots") {
        const dotRadius = Math.max(1, Math.min(2.5, 1.2 * this.scale));
        this.viewport.style.backgroundImage = `radial-gradient(circle, rgba(100, 116, 139, 0.35) ${dotRadius}px, transparent ${dotRadius}px)`;
      } else {
        this.viewport.style.backgroundImage = `linear-gradient(to right, rgba(59, 130, 246, 0.16) 1px, transparent 1px), linear-gradient(to bottom, rgba(59, 130, 246, 0.16) 1px, transparent 1px)`;
      }
    }

    // Fast accurate pixel scan of the canvas to compute true stroke/text bounding box
    computeAccurateBounds() {
      try {
        const imgData = this.drawCtx.getImageData(0, 0, this.virtualWidth, this.virtualHeight);
        const data = imgData.data;
        const w = this.virtualWidth;
        const h = this.virtualHeight;
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

        // Sample every 4 pixels for ultra-fast (~10ms) scan
        for (let y = 0; y < h; y += 4) {
          const row = y * w * 4;
          for (let x = 0; x < w; x += 4) {
            if (data[row + x * 4 + 3] > 10) {
              if (x < minX) minX = x;
              if (x > maxX) maxX = x;
              if (y < minY) minY = y;
              if (y > maxY) maxY = y;
            }
          }
        }

        if (minX !== Infinity) {
          return {
            minX: Math.max(0, minX - 8),
            minY: Math.max(0, minY - 8),
            maxX: Math.min(w, maxX + 8),
            maxY: Math.min(h, maxY + 8)
          };
        }
      } catch (err) {
        console.warn("Bounds calculation warning:", err);
      }
      return null;
    }

    // =========================================================================
    // Auto Centering and Zoom-to-Fit Content (已绘制区域全屏居中)
    // =========================================================================
    fitViewportToCenter() {
      const vw = this.viewport ? this.viewport.clientWidth : 600;
      const vh = this.viewport ? this.viewport.clientHeight : (this._config.height || 560);
      if (vw <= 0 || vh <= 0) return "100%";

      const accurate = this.computeAccurateBounds();
      if (accurate) {
        this.bounds = accurate;
      } else {
        this.bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
      }

      let zoomResult = "100%";

      if (this.hasStrokes()) {
        const bw = Math.max(60, this.bounds.maxX - this.bounds.minX);
        const bh = Math.max(60, this.bounds.maxY - this.bounds.minY);
        const cx = (this.bounds.minX + this.bounds.maxX) / 2;
        const cy = (this.bounds.minY + this.bounds.maxY) / 2;

        // Leave ~8-10% padding so the drawn content occupies ~80-84% of the viewport (full-screen fit)
        const padX = Math.max(36, Math.round(vw * 0.08));
        const padY = Math.max(36, Math.round(vh * 0.08));

        const scaleW = (vw - padX * 2) / bw;
        const scaleH = (vh - padY * 2) / bh;

        // Auto-scale to fill viewport, clamp between 0.25x and 3.5x
        this.scale = Math.min(3.5, Math.max(0.25, Math.min(scaleW, scaleH)));
        this._lastFittedScale = this.scale;

        this.panX = Math.round(vw / 2 - cx * this.scale);
        this.panY = Math.round(vh / 2 - cy * this.scale);
        zoomResult = `${Math.round(this.scale * 100)}%`;
      } else {
        this.scale = 1.0;
        this._lastFittedScale = null;
        this.panX = Math.round((vw - this.virtualWidth) / 2);
        this.panY = Math.round((vh - this.virtualHeight) / 2);
        zoomResult = "100%";
      }

      this.applyTransform();
      return zoomResult;
    }

    resetToDefaultCenter() {
      const vw = this.viewport ? this.viewport.clientWidth : 600;
      const vh = this.viewport ? this.viewport.clientHeight : (this._config.height || 560);
      this.scale = 1.0;
      this._lastFittedScale = null;

      const accurate = this.computeAccurateBounds();
      if (accurate) {
        this.bounds = accurate;
      }

      if (this.hasStrokes()) {
        const cx = (this.bounds.minX + this.bounds.maxX) / 2;
        const cy = (this.bounds.minY + this.bounds.maxY) / 2;
        this.panX = Math.round(vw / 2 - cx);
        this.panY = Math.round(vh / 2 - cy);
      } else {
        this.panX = Math.round((vw - this.virtualWidth) / 2);
        this.panY = Math.round((vh - this.virtualHeight) / 2);
      }
      this.applyTransform();
    }

    applyTransform() {
      if (this.sheet) {
        this.sheet.style.transform = `translate(${this.panX}px, ${this.panY}px) scale(${this.scale})`;
      }
      this.updateViewportBackground();
      this.notifyZoomChange();
    }

    zoomBy(deltaPercent) {
      this._lastFittedScale = null;
      const factor = 1 + deltaPercent;
      const nextScale = Math.min(5.0, Math.max(0.2, this.scale * factor));
      const vw = this.viewport ? this.viewport.clientWidth : 600;
      const vh = this.viewport ? this.viewport.clientHeight : 520;
      const midX = vw / 2;
      const midY = vh / 2;

      this.panX = midX - (midX - this.panX) * (nextScale / this.scale);
      this.panY = midY - (midY - this.panY) * (nextScale / this.scale);
      this.scale = nextScale;
      this.applyTransform();
    }

    notifyZoomChange() {
      const zoomText = this.shadowRoot.getElementById("zoomPercentText");
      if (zoomText) {
        zoomText.textContent = `${Math.round(this.scale * 100)}%`;
      }
    }

    // =========================================================================
    // Desktop Wheel Zoom + Right-Click Pan + Mobile Touch Gestures
    // =========================================================================
    bindCanvasEvents() {
      const getVirtualCoords = (clientX, clientY) => {
        if (!this._vpRect) {
          this._vpRect = this.viewport.getBoundingClientRect();
        }
        const screenX = clientX - this._vpRect.left;
        const screenY = clientY - this._vpRect.top;
        return {
          x: (screenX - this.panX) / this.scale,
          y: (screenY - this.panY) / this.scale
        };
      };

      // Desktop: Cursor-centered Wheel Zoom
      this.viewport.addEventListener(
        "wheel",
        (e) => {
          e.preventDefault();
          this._vpRect = this.viewport.getBoundingClientRect();
          const mouseX = e.clientX - this._vpRect.left;
          const mouseY = e.clientY - this._vpRect.top;
          const zoomFactor = e.deltaY < 0 ? 1.15 : 0.85;
          const nextScale = Math.min(5.0, Math.max(0.2, this.scale * zoomFactor));

          this._lastFittedScale = null;
          this.panX = mouseX - (mouseX - this.panX) * (nextScale / this.scale);
          this.panY = mouseY - (mouseY - this.panY) * (nextScale / this.scale);
          this.scale = nextScale;
          this.applyTransform();
        },
        { passive: false }
      );

      // Desktop: Suppress context menu for smooth right-click drag pan
      this.viewport.addEventListener("contextmenu", (e) => e.preventDefault());

      const startDraw = (e) => {
        // Desktop: Right-click (2) or Middle-click (1) or Hand Tool pan
        if (e.button === 2 || e.button === 1 || this.currentTool === "hand") {
          e.preventDefault();
          this.isPanningCanvas = true;
          const touch = e.touches ? e.touches[0] : e;
          this.panStartX = touch.clientX;
          this.panStartY = touch.clientY;
          this.initialPanX = this.panX;
          this.initialPanY = this.panY;
          this.viewport.style.cursor = "grabbing";
          return;
        }

        // Mobile: Dual touch for pinch-to-zoom and pan
        if (e.touches && e.touches.length >= 2) {
          if (this.isDrawing && this.hasMoved) {
            this.saveState();
          }
          this.isPinching = true;
          this.isDrawing = false;
          this.hasMoved = false;
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

        this._vpRect = this.viewport.getBoundingClientRect();

        // Text tool placement on canvas click
        if (this.currentTool === "text") {
          e.preventDefault();
          const clientX = e.touches ? e.touches[0].clientX : e.clientX;
          const clientY = e.touches ? e.touches[0].clientY : e.clientY;
          const screenX = clientX - this._vpRect.left - 40;
          const screenY = clientY - this._vpRect.top - 20;
          this.spawnInlineTextBox(screenX, screenY);
          return;
        }

        e.preventDefault();
        this.isDrawing = true;
        this.hasMoved = false;

        const clientX = e.touches ? e.touches[0].clientX : e.clientX;
        const clientY = e.touches ? e.touches[0].clientY : e.clientY;
        const coords = getVirtualCoords(clientX, clientY);

        this.startX = coords.x;
        this.startY = coords.y;
        this.lastX = coords.x;
        this.lastY = coords.y;
        this.midX = coords.x;
        this.midY = coords.y;
        this.currentStrokePoints = [Math.round(coords.x), Math.round(coords.y)];

        this.applyToolStyles();
      };

      const moveDraw = (e) => {
        // Desktop / Hand Tool: Panning viewport
        if (this.isPanningCanvas) {
          e.preventDefault();
          this._lastFittedScale = null;
          const touch = e.touches ? e.touches[0] : e;
          const dx = touch.clientX - this.panStartX;
          const dy = touch.clientY - this.panStartY;
          this.panX = this.initialPanX + dx;
          this.panY = this.initialPanY + dy;
          this.applyTransform();
          return;
        }

        // Mobile: Pinch zoom & pan
        if (this.isPinching && e.touches && e.touches.length === 2) {
          e.preventDefault();
          this._lastFittedScale = null;
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

        // Filter micro-jitter threshold (2 virtual pixels)
        if (!this.hasMoved) {
          if (Math.hypot(coords.x - this.startX, coords.y - this.startY) < 2) {
            return;
          }
          this.hasMoved = true;
        }

        // Quadratic Bézier curve midpoint smoothing
        const currentMidX = (this.lastX + coords.x) / 2;
        const currentMidY = (this.lastY + coords.y) / 2;

        this.drawCtx.beginPath();
        this.drawCtx.moveTo(this.midX, this.midY);
        this.drawCtx.quadraticCurveTo(this.lastX, this.lastY, currentMidX, currentMidY);
        this.drawCtx.stroke();

        this.updateBounds(coords.x, coords.y);
        this.currentStrokePoints.push(Math.round(coords.x), Math.round(coords.y));

        this.lastX = coords.x;
        this.lastY = coords.y;
        this.midX = currentMidX;
        this.midY = currentMidY;
      };

      const endDraw = (e) => {
        if (this.isPanningCanvas) {
          this.isPanningCanvas = false;
          this.viewport.style.cursor = this.currentTool === "hand" ? "grab" : "crosshair";
          return;
        }

        if (e.touches && e.touches.length < 2) {
          this.isPinching = false;
        }
        if (!this.isDrawing) return;
        this.isDrawing = false;

        // If never moved, this was an intentional single tap / click dot
        if (!this.hasMoved && !this.isPinching) {
          this.applyToolStyles();
          this.drawCtx.beginPath();
          this.drawCtx.arc(this.startX, this.startY, this.getCalculatedLineWidth() / 2, 0, Math.PI * 2);
          this.drawCtx.fill();
          this.updateBounds(this.startX, this.startY);
          this.currentStrokePoints = [Math.round(this.startX), Math.round(this.startY)];
        }

        // Record per-device vector operation & broadcast to other active terminals
        if (this.currentStrokePoints.length >= 2) {
          const op = {
            opId: `op_${this.clientId}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
            ownerId: this.clientId,
            type: "stroke",
            tool: this.currentTool,
            color: this.currentColor,
            size: this.currentSize,
            points: [...this.currentStrokePoints]
          };
          this.operations.push(op);
          this.redoStack = [];
          this.notifyHistoryButtons();

          this.broadcastSyncEvent({
            action: "stroke",
            ...op
          });
        }
        this.currentStrokePoints = [];
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
      let base = this.currentSize;
      if (this.currentTool === "eraser") base *= 3.0;
      if (this.currentTool === "marker") base *= 2.5;
      return Math.max(2, base);
    }

    updateBounds(x, y, radius = 0) {
      const r = radius || (this.getCalculatedLineWidth ? this.getCalculatedLineWidth() / 2 : 6);
      if (x - r < this.bounds.minX) this.bounds.minX = Math.max(0, x - r);
      if (y - r < this.bounds.minY) this.bounds.minY = Math.max(0, y - r);
      if (x + r > this.bounds.maxX) this.bounds.maxX = Math.min(this.virtualWidth, x + r);
      if (y + r > this.bounds.maxY) this.bounds.maxY = Math.min(this.virtualHeight, y + r);
    }

    // =========================================================================
    // Inline Draggable Floating Text Box
    // =========================================================================
    spawnInlineTextBox(screenX, screenY) {
      if (this.activeTextBox) {
        this.commitActiveTextBox();
      }

      const box = document.createElement("div");
      box.className = "canvas-text-box";

      const vw = this.viewport ? this.viewport.clientWidth : 600;
      const vh = this.viewport ? this.viewport.clientHeight : 520;
      const boxW = Math.min(380, vw - 32);

      let initLeft = (screenX !== undefined && !isNaN(screenX)) ? screenX : (vw - boxW) / 2;
      let initTop = (screenY !== undefined && !isNaN(screenY)) ? screenY : (vh - 160) / 2;

      initLeft = Math.max(12, Math.min(vw - boxW - 12, initLeft));
      initTop = Math.max(12, Math.min(vh - 180, initTop));

      box.style.left = `${initLeft}px`;
      box.style.top = `${initTop}px`;
      box.style.width = `${boxW}px`;

      const curSizeCss = this.previewFontSizesCss[this.selectedTextSizeLevel] || 24;

      box.innerHTML = `
        <div class="text-drag-bar" id="textDragBar" title="Hold to drag position">
          <div class="drag-title">
            <ha-icon icon="mdi:arrow-all" style="--mdc-icon-size: 15px;"></ha-icon>
            <span>Drag to place</span>
          </div>
          <div class="text-box-quick-actions">
            <button type="button" class="btn-text-done" id="inlineTextDoneBtn">
              <ha-icon icon="mdi:check" style="--mdc-icon-size: 15px;"></ha-icon> Done
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

      this.viewport.appendChild(box);
      this.activeTextBox = box;

      const dragBar = box.querySelector("#textDragBar");
      const textarea = box.querySelector("#inlineTextInput");
      const doneBtn = box.querySelector("#inlineTextDoneBtn");
      const cancelBtn = box.querySelector("#inlineTextCancelBtn");
      const colorDots = box.querySelectorAll(".inline-color-dot");
      const sizePills = box.querySelectorAll(".inline-size-pill");

      textarea.addEventListener("input", () => {
        textarea.style.height = "auto";
        textarea.style.height = `${Math.max(48, textarea.scrollHeight)}px`;
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
          const sizeCss = this.previewFontSizesCss[this.selectedTextSizeLevel] || 24;
          textarea.style.fontSize = `${sizeCss}px`;
          textarea.style.height = "auto";
          textarea.style.height = `${Math.max(48, textarea.scrollHeight)}px`;
        });
      });

      // Draggable logic directly inside viewport
      let isDragging = false;
      let startClientX = 0;
      let startClientY = 0;
      let startBoxLeft = 0;
      let startBoxTop = 0;

      const handleDragStart = (e) => {
        if (e.target.closest("button") || e.target.closest(".inline-color-dot") || e.target.closest(".inline-size-pill") || e.target.closest("textarea")) return;
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
          const deltaX = curTouch.clientX - startClientX;
          const deltaY = curTouch.clientY - startClientY;

          let nextLeft = startBoxLeft + deltaX;
          let nextTop = startBoxTop + deltaY;

          const maxLeft = this.viewport.clientWidth - (box.offsetWidth || 360);
          const maxTop = this.viewport.clientHeight - (box.offsetHeight || 160);
          nextLeft = Math.max(0, Math.min(Math.max(0, maxLeft), nextLeft));
          nextTop = Math.max(0, Math.min(Math.max(0, maxTop), nextTop));

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

      if (document.activeElement && typeof document.activeElement.blur === "function") {
        document.activeElement.blur();
      }

      const textarea = this.activeTextBox.querySelector("#inlineTextInput");
      if (textarea && textarea.value && textarea.value.trim()) {
        const text = textarea.value;

        const boxLeft = parseFloat(this.activeTextBox.style.left) || 0;
        const boxTop = parseFloat(this.activeTextBox.style.top) || 0;

        const textOffsetLeft = textarea.offsetLeft + 12;
        const textOffsetTop = textarea.offsetTop + 10;

        const screenX = boxLeft + textOffsetLeft;
        const screenY = boxTop + textOffsetTop;

        const scale = this.scale || 1.0;
        const virtualX = (screenX - this.panX) / scale;
        const virtualY = (screenY - this.panY) / scale;

        const screenFontSize = this.previewFontSizesCss[this.selectedTextSizeLevel] || 24;
        const fontSizeVirtual = screenFontSize / scale;

        this.drawCtx.save();
        this.drawCtx.globalCompositeOperation = "source-over";
        this.drawCtx.globalAlpha = 1.0;
        this.drawCtx.fillStyle = this.selectedTextColor;
        this.drawCtx.font = `bold ${fontSizeVirtual}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;
        this.drawCtx.textBaseline = "top";

        const lines = text.split("\n");
        const lineHeight = fontSizeVirtual * 1.3;
        lines.forEach((line, idx) => {
          const ly = virtualY + idx * lineHeight;
          this.drawCtx.fillText(line, virtualX, ly);
          const metrics = this.drawCtx.measureText(line);
          this.updateBounds(virtualX, ly);
          this.updateBounds(virtualX + metrics.width, ly + lineHeight);
        });

        this.drawCtx.restore();
        const op = {
          opId: `op_${this.clientId}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          ownerId: this.clientId,
          type: "text",
          text,
          x: virtualX,
          y: virtualY,
          sizeLevel: this.selectedTextSizeLevel,
          fontSizeVirtual,
          color: this.selectedTextColor
        };
        this.operations.push(op);
        this.redoStack = [];
        this.notifyHistoryButtons();
        this.showToast("Text added to canvas");

        // Broadcast text operation to peers
        this.broadcastSyncEvent({
          action: "text",
          ...op
        });
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
    // Per-Device Collaborative Undo / Redo & Canvas Reset
    // =========================================================================
    saveState() {
      this.notifyHistoryButtons();
    }

    undo(broadcast = true) {
      // Only undo operations authored on THIS device (ownerId === this.clientId)
      let targetIdx = -1;
      for (let i = this.operations.length - 1; i >= 0; i--) {
        if (this.operations[i].ownerId === this.clientId) {
          targetIdx = i;
          break;
        }
      }

      if (targetIdx === -1) {
        this.notifyHistoryButtons();
        return;
      }

      const [removedOp] = this.operations.splice(targetIdx, 1);
      this.redoStack.push(removedOp);
      this.redrawAllOperations();

      if (broadcast) {
        this.broadcastSyncEvent({
          action: "undo_op",
          targetOpId: removedOp.opId,
          ownerId: this.clientId
        });
      }
    }

    redo(broadcast = true) {
      if (this.redoStack.length === 0) {
        this.notifyHistoryButtons();
        return;
      }

      const restoredOp = this.redoStack.pop();
      this.operations.push(restoredOp);
      this.redrawAllOperations();

      if (broadcast) {
        this.broadcastSyncEvent({
          action: "redo_op",
          op: restoredOp,
          ownerId: this.clientId
        });
      }
    }

    clearCanvas(broadcast = true) {
      this.removeActiveTextBox();
      this.operations = [];
      this.redoStack = [];
      this._baseImageElement = null;
      this._baseImageDataUrl = null;
      this.drawCtx.clearRect(0, 0, this.virtualWidth, this.virtualHeight);
      this.bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
      this.notifyHistoryButtons();
      this.fitViewportToCenter();
      if (broadcast) {
        this.broadcastSyncEvent({ action: "clear" });
      }
    }

    notifyHistoryButtons() {
      const btnUndo = this.shadowRoot.getElementById("btnUndo");
      const btnRedo = this.shadowRoot.getElementById("btnRedo");
      const hasOwnOps = this.operations.some((op) => op.ownerId === this.clientId);
      if (btnUndo) btnUndo.disabled = !hasOwnOps;
      if (btnRedo) btnRedo.disabled = this.redoStack.length === 0;
    }

    // =========================================================================
    // Interactive Print Framing Modal (Fixed Paper Frame + Pan/Zoom Drawing)
    // =========================================================================
    openPrintFramingModal() {
      this.commitActiveTextBox();

      const root = this.shadowRoot;
      const modal = root.getElementById("printModal");
      const stage = root.getElementById("framingStage");
      const previewCanvas = root.getElementById("framingPreviewCanvas");
      const previewCtx = previewCanvas.getContext("2d");
      const framingBox = root.getElementById("framingBox");
      const dimensionsBadge = root.getElementById("frameDimensionsBadge");

      const selectPaper = root.getElementById("selectPaperSize");
      const selectColor = root.getElementById("selectColorMode");
      const btnPortrait = root.getElementById("btnOrientPortrait");
      const btnLandscape = root.getElementById("btnOrientLandscape");
      const btnFitAll = root.getElementById("btnFrameFitAll");
      const btnZoomOut = root.getElementById("btnFrameZoomOut");
      const btnZoomIn = root.getElementById("btnFrameZoomIn");
      const btnReset = root.getElementById("btnFrameReset");
      const btnConfirm = root.getElementById("btnConfirmPrint");

      modal.style.display = "flex";

      const stageW = stage.clientWidth || 580;
      const stageH = stage.clientHeight || 330;
      previewCanvas.width = stageW;
      previewCanvas.height = stageH;

      // Ensure accurate bounds of current drawing
      const acc = this.computeAccurateBounds();
      if (acc) {
        this.bounds = acc;
      }

      let minX = this.bounds.minX;
      let minY = this.bounds.minY;
      let maxX = this.bounds.maxX;
      let maxY = this.bounds.maxY;

      if (!this.hasStrokes()) {
        minX = 1100; minY = 1100; maxX = 2100; maxY = 2100;
      }

      const contentW = Math.max(80, maxX - minX);
      const contentH = Math.max(80, maxY - minY);
      const contentCX = (minX + maxX) / 2;
      const contentCY = (minY + maxY) / 2;

      let currentOrientation = btnLandscape.classList.contains("active") ? "landscape" : "portrait";
      let frameX = 0;
      let frameY = 0;
      let frameW = 0;
      let frameH = 0;

      // Transform state of the underlying virtual drawing inside the preview stage
      let pScale = 0.25;
      let pPanX = 0;
      let pPanY = 0;

      const getPaperDimensions = () => {
        const key = selectPaper.value || "a4";
        const profile = PAPER_PROFILES[key] || PAPER_PROFILES.a4;
        const w = profile.widthPx;
        const h = profile.heightPx;
        const name = profile.name;
        if (currentOrientation === "landscape") {
          return { width: Math.max(w, h), height: Math.min(w, h), name: `${name} Landscape` };
        }
        return { width: Math.min(w, h), height: Math.max(w, h), name: `${name} Portrait` };
      };

      // Compute fixed centered paper frame geometry inside the preview stage
      const updateFixedPaperFrame = () => {
        const paper = getPaperDimensions();
        const aspect = paper.width / paper.height;
        const margin = 24;
        const availW = Math.max(100, stageW - margin * 2);
        const availH = Math.max(100, stageH - margin * 2);

        if (availW / availH > aspect) {
          frameH = availH;
          frameW = frameH * aspect;
        } else {
          frameW = availW;
          frameH = frameW / aspect;
        }

        frameX = (stageW - frameW) / 2;
        frameY = (stageH - frameH) / 2;

        framingBox.style.left = `${Math.round(frameX)}px`;
        framingBox.style.top = `${Math.round(frameY)}px`;
        framingBox.style.width = `${Math.round(frameW)}px`;
        framingBox.style.height = `${Math.round(frameH)}px`;
        dimensionsBadge.textContent = paper.name;
      };

      const renderPreviewStage = () => {
        // Fill outer stage background with subtle light slate, and paper frame interior with pure white
        previewCtx.fillStyle = "#f1f5f9";
        previewCtx.fillRect(0, 0, stageW, stageH);

        previewCtx.fillStyle = "#ffffff";
        previewCtx.fillRect(frameX, frameY, frameW, frameH);

        previewCtx.save();
        previewCtx.translate(pPanX, pPanY);
        previewCtx.scale(pScale, pScale);
        previewCtx.drawImage(this.drawCanvas, 0, 0);
        previewCtx.restore();
      };

      // Scale and center the drawn content so it fits neatly inside the fixed paper frame
      const fitContentIntoFrame = () => {
        updateFixedPaperFrame();
        const innerW = frameW * 0.86;
        const innerH = frameH * 0.86;
        pScale = Math.min(innerW / contentW, innerH / contentH);
        pScale = Math.min(2.5, Math.max(0.05, pScale));

        const frameCenterX = frameX + frameW / 2;
        const frameCenterY = frameY + frameH / 2;
        pPanX = frameCenterX - contentCX * pScale;
        pPanY = frameCenterY - contentCY * pScale;

        renderPreviewStage();
      };

      // Reset view to standard 1:1 canvas overview centered on drawing
      const resetViewStandard = () => {
        updateFixedPaperFrame();
        const stdSpan = 1200;
        pScale = Math.min(frameW / stdSpan, frameH / stdSpan);
        const frameCenterX = frameX + frameW / 2;
        const frameCenterY = frameY + frameH / 2;
        pPanX = frameCenterX - contentCX * pScale;
        pPanY = frameCenterY - contentCY * pScale;
        renderPreviewStage();
      };

      const zoomPreviewBy = (factor, pivotX = frameX + frameW / 2, pivotY = frameY + frameH / 2) => {
        const nextScale = Math.min(4.0, Math.max(0.04, pScale * factor));
        pPanX = pivotX - (pivotX - pPanX) * (nextScale / pScale);
        pPanY = pivotY - (pivotY - pPanY) * (nextScale / pScale);
        pScale = nextScale;
        renderPreviewStage();
      };

      // Initial layout: fit content cleanly into the fixed paper frame
      fitContentIntoFrame();

      btnPortrait.onclick = () => {
        btnPortrait.classList.add("active");
        btnLandscape.classList.remove("active");
        currentOrientation = "portrait";
        fitContentIntoFrame();
      };

      btnLandscape.onclick = () => {
        btnLandscape.classList.add("active");
        btnPortrait.classList.remove("active");
        currentOrientation = "landscape";
        fitContentIntoFrame();
      };

      selectPaper.onchange = () => {
        fitContentIntoFrame();
      };

      btnFitAll.onclick = () => fitContentIntoFrame();
      btnReset.onclick = () => resetViewStandard();
      if (btnZoomOut) btnZoomOut.onclick = () => zoomPreviewBy(0.84);
      if (btnZoomIn) btnZoomIn.onclick = () => zoomPreviewBy(1.18);

      // Mouse wheel zoom inside preview stage
      stage.onwheel = (e) => {
        e.preventDefault();
        const rect = stage.getBoundingClientRect();
        const mx = e.clientX - rect.left;
        const my = e.clientY - rect.top;
        const factor = e.deltaY < 0 ? 1.12 : 0.88;
        zoomPreviewBy(factor, mx, my);
      };

      // Drag / Pinch canvas inside preview stage
      let isDraggingStage = false;
      let isPinchingStage = false;
      let startPointerX = 0;
      let startPointerY = 0;
      let startPanX = 0;
      let startPanY = 0;
      let startPinchDist = 0;
      let startPinchScale = 1;
      let startPinchMidX = 0;
      let startPinchMidY = 0;

      const handleStagePointerDown = (e) => {
        e.preventDefault();
        const rect = stage.getBoundingClientRect();

        if (e.touches && e.touches.length >= 2) {
          isPinchingStage = true;
          isDraggingStage = false;
          startPinchDist = Math.hypot(
            e.touches[0].clientX - e.touches[1].clientX,
            e.touches[0].clientY - e.touches[1].clientY
          );
          startPinchMidX = (e.touches[0].clientX + e.touches[1].clientX) / 2 - rect.left;
          startPinchMidY = (e.touches[0].clientY + e.touches[1].clientY) / 2 - rect.top;
          startPinchScale = pScale;
          startPanX = pPanX;
          startPanY = pPanY;
          return;
        }

        isDraggingStage = true;
        isPinchingStage = false;
        const touch = e.touches ? e.touches[0] : e;
        startPointerX = touch.clientX;
        startPointerY = touch.clientY;
        startPanX = pPanX;
        startPanY = pPanY;

        const handleStagePointerMove = (moveEv) => {
          if (!isDraggingStage && !isPinchingStage) return;
          moveEv.preventDefault();

          if (isPinchingStage && moveEv.touches && moveEv.touches.length >= 2) {
            const curDist = Math.hypot(
              moveEv.touches[0].clientX - moveEv.touches[1].clientX,
              moveEv.touches[0].clientY - moveEv.touches[1].clientY
            );
            const curMidX = (moveEv.touches[0].clientX + moveEv.touches[1].clientX) / 2 - rect.left;
            const curMidY = (moveEv.touches[0].clientY + moveEv.touches[1].clientY) / 2 - rect.top;
            const factor = curDist / (startPinchDist || 1);
            const nextScale = Math.min(4.0, Math.max(0.04, startPinchScale * factor));

            pPanX = curMidX - (startPinchMidX - startPanX) * (nextScale / startPinchScale);
            pPanY = curMidY - (startPinchMidY - startPanY) * (nextScale / startPinchScale);
            pScale = nextScale;
            renderPreviewStage();
            return;
          }

          if (isDraggingStage) {
            const curTouch = moveEv.touches ? moveEv.touches[0] : moveEv;
            pPanX = startPanX + (curTouch.clientX - startPointerX);
            pPanY = startPanY + (curTouch.clientY - startPointerY);
            renderPreviewStage();
          }
        };

        const handleStagePointerUp = () => {
          isDraggingStage = false;
          isPinchingStage = false;
          window.removeEventListener("mousemove", handleStagePointerMove);
          window.removeEventListener("mouseup", handleStagePointerUp);
          window.removeEventListener("touchmove", handleStagePointerMove);
          window.removeEventListener("touchend", handleStagePointerUp);
        };

        window.addEventListener("mousemove", handleStagePointerMove, { passive: false });
        window.addEventListener("mouseup", handleStagePointerUp);
        window.addEventListener("touchmove", handleStagePointerMove, { passive: false });
        window.addEventListener("touchend", handleStagePointerUp);
      };

      stage.onmousedown = handleStagePointerDown;
      stage.ontouchstart = handleStagePointerDown;

      const executePrint = async () => {
        btnConfirm.removeEventListener("click", executePrint);
        modal.style.display = "none";

        const paper = getPaperDimensions();
        const colorMode = selectColor.value || "color";

        // Virtual canvas coordinates currently visible inside the fixed paper frame
        const virtualCropX = (frameX - pPanX) / pScale;
        const virtualCropY = (frameY - pPanY) / pScale;
        const virtualCropW = frameW / pScale;

        const targetW = paper.width;
        const targetH = paper.height;

        const outCanvas = document.createElement("canvas");
        outCanvas.width = targetW;
        outCanvas.height = targetH;
        const outCtx = outCanvas.getContext("2d");

        outCtx.fillStyle = "#ffffff";
        outCtx.fillRect(0, 0, targetW, targetH);

        // Exact 300 DPI affine transform mapping the paper frame region to physical pixels
        const dpiScale = targetW / virtualCropW;
        outCtx.save();
        outCtx.translate(-virtualCropX * dpiScale, -virtualCropY * dpiScale);
        outCtx.scale(dpiScale, dpiScale);
        outCtx.drawImage(this.drawCanvas, 0, 0);
        outCtx.restore();

        if (colorMode === "monochrome") {
          const imgData = outCtx.getImageData(0, 0, targetW, targetH);
          const d = imgData.data;
          for (let i = 0; i < d.length; i += 4) {
            const gray = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
            d[i] = gray; d[i + 1] = gray; d[i + 2] = gray;
          }
          outCtx.putImageData(imgData, 0, 0);
        }

        const rasterResult = {
          dataUrl: outCanvas.toDataURL("image/jpeg", 0.94),
          rawDrawDataUrl: this.drawCanvas.toDataURL("image/png"),
          paperSize: paper.name
        };

        await this.dispatchPrint(rasterResult);

        await CanvasHistoryDB.saveItem({
          thumbnail: rasterResult.dataUrl,
          rawDrawing: rasterResult.rawDrawDataUrl,
          paperSize: rasterResult.paperSize,
          printed: true
        }, this._config.max_history_items || 30);

        this.clearCanvas(true);
        this.showToast("Print dispatched & canvas archived!");
      };

      btnConfirm.onclick = executePrint;
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
          const res = await fetch(rasterResult.dataUrl);
          const blob = await res.blob();

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
          console.warn("Direct IPP dispatch blocked (CORS/Mixed Content). Falling back to OS Print...", err);
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
              copies: 1
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

      // 4. Universal Fallback: OS System Print Dialog
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
      this.showToast("Print preview ready");
      return true;
    }

    // =========================================================================
    // Core Button Actions Workflow
    // =========================================================================
    async handleSaveAndNew() {
      this.commitActiveTextBox();

      let bx1 = this.bounds.minX;
      let by1 = this.bounds.minY;
      let bx2 = this.bounds.maxX;
      let by2 = this.bounds.maxY;

      if (!this.hasStrokes()) {
        bx1 = 1000; by1 = 1000; bx2 = 2200; by2 = 2200;
      }

      const pad = 80;
      bx1 = Math.max(0, bx1 - pad);
      by1 = Math.max(0, by1 - pad);
      bx2 = Math.min(this.virtualWidth, bx2 + pad);
      by2 = Math.min(this.virtualHeight, by2 + pad);

      const targetW = Math.max(200, bx2 - bx1);
      const targetH = Math.max(200, by2 - by1);

      const outCanvas = document.createElement("canvas");
      outCanvas.width = targetW;
      outCanvas.height = targetH;
      const outCtx = outCanvas.getContext("2d");

      outCtx.fillStyle = "#ffffff";
      outCtx.fillRect(0, 0, targetW, targetH);
      outCtx.drawImage(this.drawCanvas, bx1, by1, targetW, targetH, 0, 0, targetW, targetH);

      const thumbnail = outCanvas.toDataURL("image/jpeg", 0.92);
      const rawDrawing = this.drawCanvas.toDataURL("image/png");

      await CanvasHistoryDB.saveItem({
        thumbnail,
        rawDrawing,
        paperSize: "Infinite Canvas",
        printed: false
      }, this._config.max_history_items || 30);

      this.clearCanvas(true);
      this.showToast("Drawing saved! Ready for new sketch.");
    }

    handleDiscardAndNew() {
      if (this._config.confirm_discard) {
        if (!confirm("Discard current drawing and reset canvas?")) {
          return;
        }
      }
      this.clearCanvas(true);
      this.showToast("Canvas discarded and reset.");
    }

    async openHistory() {
      const root = this.shadowRoot;
      const modal = root.getElementById("historyModal");
      const grid = root.getElementById("historyGrid");
      const titleSpan = root.getElementById("historyModalTitle");
      const maxLimit = Math.max(5, Math.min(100, Number(this._config.max_history_items) || 30));

      grid.innerHTML = `<div style="grid-column: 1/-1; text-align: center; color: var(--text-secondary); padding: 20px;">Loading history...</div>`;
      modal.style.display = "flex";

      const items = await CanvasHistoryDB.getAllItems(maxLimit);
      if (titleSpan) {
        titleSpan.innerHTML = `<ha-icon icon="mdi:history" style="color: var(--primary-accent);"></ha-icon> <span>Drawings History (${items.length} / ${maxLimit})</span>`;
      }

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
              ${this.isPrintingEnabled() ? `<button class="btn-mini" data-action="re-print" data-id="${item.id}" title="Print again">Print</button>` : ""}
              <button class="btn-mini" data-action="download" data-id="${item.id}" title="Download image">Export</button>
              <button class="btn-mini danger" data-action="delete" data-id="${item.id}" title="Delete">✕</button>
            </div>
          </div>
        `;

        card.querySelectorAll("button[data-action]").forEach((btn) => {
          btn.addEventListener("click", async (e) => {
            const action = e.currentTarget.dataset.action;
            if (action === "re-edit") {
              this.operations = [];
              this.redoStack = [];
              await this.loadDrawingFromDataUrl(item.rawDrawing || item.thumbnail);
              modal.style.display = "none";
              this.showToast("Drawing restored onto canvas!");
              // Broadcast newly restored drawing to peers
              const payload = this.buildCanvasPatchPayload("sync_state");
              this.broadcastSyncEvent(payload);
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

    async loadDrawingFromDataUrl(url, initialBounds = null, preserveOperations = false) {
      return new Promise((resolve) => {
        const img = new Image();
        img.onload = () => {
          this._baseImageElement = img;
          this._baseImageDataUrl = url;
          if (!preserveOperations) {
            this.operations = [];
            this.redoStack = [];
          }
          this.redrawAllOperations();
          if (initialBounds) {
            this.bounds = { ...initialBounds };
          } else {
            const acc = this.computeAccurateBounds();
            this.bounds = acc || { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
          }
          this.notifyHistoryButtons();
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
      const printBtn = root.getElementById("btnPrintNew");
      if (printBtn) {
        printBtn.addEventListener("click", () => this.openPrintFramingModal());
      }
      root.getElementById("btnHistory").addEventListener("click", () => this.openHistory());

      // Modals Close
      root.getElementById("btnCloseHistory").addEventListener("click", () => {
        root.getElementById("historyModal").style.display = "none";
      });
      root.getElementById("btnClearHistory").addEventListener("click", async () => {
        if (confirm("Delete all saved drawings from history?")) {
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

          if (this.currentTool === "hand") {
            this.viewport.style.cursor = "grab";
          } else {
            this.viewport.style.cursor = "crosshair";
          }

          if (this.currentTool === "text") {
            this.spawnInlineTextBox();
          } else if (this.activeTextBox) {
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
          if (this.currentTool === "eraser" || this.currentTool === "hand") {
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
          if (this.currentTool === "eraser" || this.currentTool === "hand") {
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
          this.clearCanvas(true);
        }
      });

      // Viewport Control Pod Buttons
      root.getElementById("btnZoomOut").addEventListener("click", () => this.zoomBy(-0.2));
      root.getElementById("btnZoomIn").addEventListener("click", () => this.zoomBy(0.2));
      root.getElementById("btnZoomReset").addEventListener("click", () => {
        const isFitted = this._lastFittedScale && Math.abs(this.scale - this._lastFittedScale) < 0.03;
        if (this.hasStrokes() && !isFitted) {
          const zoomText = this.fitViewportToCenter();
          this.showToast(`Fit to content (${zoomText})`);
        } else {
          this.resetToDefaultCenter();
          this.showToast("Canvas centered (100%)");
        }
      });

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

      const isPrint = this.isPrintingEnabled();
      const badge = this.shadowRoot.getElementById("printerBadge");
      const statusText = this.shadowRoot.getElementById("printerStatusText");
      const printBtn = this.shadowRoot.getElementById("btnPrintNew");

      if (printBtn) {
        printBtn.style.display = isPrint ? "inline-flex" : "none";
      }

      if (badge) {
        badge.style.display = isPrint ? "flex" : "none";
        if (this._config.printer_ip) {
          badge.classList.remove("offline");
          if (statusText) statusText.textContent = `${this._config.printer_ip}:${this._config.printer_port || 631}`;
        } else {
          badge.classList.add("offline");
          if (statusText) statusText.textContent = "OS Print";
        }
      }

      if (this.viewport && this._config.height) {
        this.viewport.style.height = `${this._config.height}px`;
      }

      this.updateViewportBackground();
      this.initSyncEngine();
    }
  }

  // =========================================================================
  // Lovelace Visual Form Configuration Editor (<ha-form>)
  // =========================================================================
  const EDITOR_SCHEMA = [
    {
      name: "title",
      label: "Card Title",
      selector: { text: {} }
    },
    {
      name: "enable_printing",
      label: "Enable Printing Feature (Header Button & History)",
      selector: { boolean: {} }
    },
    {
      name: "printer_ip",
      label: "Printer IP Address or Hostname (e.g. 192.168.1.100)",
      selector: { text: {} }
    },
    {
      name: "printer_port",
      label: "Printer Port (Default: 631 for IPP)",
      selector: { number: { min: 1, max: 65535, mode: "box" } }
    },
    {
      name: "print_mode",
      label: "Printing Protocol / Dispatch Mode",
      selector: {
        select: {
          mode: "dropdown",
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
    },
    {
      name: "canvas_bg",
      label: "Canvas Background Style",
      selector: {
        select: {
          mode: "dropdown",
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
      label: "Card Viewport Height (px)",
      selector: { number: { min: 350, max: 1200, step: 20, mode: "slider" } }
    },
    {
      name: "max_history_items",
      label: "Max History Drawings to Retain (Default: 30, Max: 100)",
      selector: { number: { min: 5, max: 100, step: 5, mode: "slider" } }
    },
    {
      name: "sync_channel",
      label: "Multi-Terminal Sync Channel Name",
      selector: { text: {} }
    },
    {
      name: "enable_sync",
      label: "Enable Real-Time Multi-Terminal Sync",
      selector: { boolean: {} }
    },
    {
      name: "confirm_discard",
      label: "Confirm before Discarding Current Drawing",
      selector: { boolean: {} }
    }
  ];

  class WhiteboardCanvasCardEditor extends HTMLElement {
    constructor() {
      super();
      this.attachShadow({ mode: "open" });
    }

    setConfig(config) {
      const pSettings = config.printer_settings || {};
      const cSettings = config.canvas_settings || {};

      const enablePrinting = (config.enable_printing !== undefined)
        ? Boolean(config.enable_printing)
        : (pSettings.enable_printing !== undefined ? Boolean(pSettings.enable_printing) : false);

      this._config = {
        ...DEFAULT_CONFIG,
        ...config,
        enable_printing: enablePrinting,
        printer_ip: config.printer_ip !== undefined ? config.printer_ip : (pSettings.printer_ip || ""),
        printer_port: config.printer_port !== undefined ? config.printer_port : (pSettings.printer_port || 631),
        print_mode: config.print_mode !== undefined ? config.print_mode : (pSettings.print_mode || "ipp"),
        gateway_url: config.gateway_url !== undefined ? config.gateway_url : (pSettings.gateway_url || ""),
        canvas_bg: config.canvas_bg !== undefined ? config.canvas_bg : (cSettings.canvas_bg || "grid"),
        height: config.height !== undefined ? config.height : (cSettings.height || 560),
        max_history_items: Number(config.max_history_items ?? cSettings.max_history_items ?? 30),
        sync_channel: String(config.sync_channel ?? cSettings.sync_channel ?? "canvas_studio").trim(),
        enable_sync: config.enable_sync !== undefined ? Boolean(config.enable_sync) : true,
        confirm_discard: config.confirm_discard !== undefined ? config.confirm_discard : (cSettings.confirm_discard !== undefined ? cSettings.confirm_discard : true)
      };

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
          const newConfig = { ...ev.detail.value };
          newConfig.enable_printing = Boolean(newConfig.enable_printing);
          newConfig.enable_sync = newConfig.enable_sync !== undefined ? Boolean(newConfig.enable_sync) : true;
          newConfig.max_history_items = Number(newConfig.max_history_items) || 30;
          const event = new CustomEvent("config-changed", {
            detail: { config: newConfig },
            bubbles: true,
            composed: true
          });
          this.dispatchEvent(event);
        });
      }
      this._form.data = this._config;
    }
  }

  // Register Primary Custom Elements (whiteboard-canvas-card)
  if (!customElements.get("whiteboard-canvas-card-editor")) {
    customElements.define("whiteboard-canvas-card-editor", WhiteboardCanvasCardEditor);
  }
  if (!customElements.get("whiteboard-canvas-card")) {
    customElements.define("whiteboard-canvas-card", WhiteboardCanvasCard);
  }

  // Backward-compatible alias registration for legacy "canvas-card"
  if (!customElements.get("canvas-card-editor")) {
    customElements.define("canvas-card-editor", class extends WhiteboardCanvasCardEditor {});
  }
  if (!customElements.get("canvas-card")) {
    customElements.define("canvas-card", class extends WhiteboardCanvasCard {});
  }

  // Register Lovelace Card Picker Entry
  window.customCards = window.customCards || [];
  window.customCards.push({
    type: "whiteboard-canvas-card",
    name: "Whiteboard Canvas Card",
    description: "An infinite-canvas whiteboard drawing & 300 DPI printing card with multi-device real-time sync, per-device undo/redo, mobile zoom pod, interactive framing, history, and network printing.",
    preview: true,
    documentationURL: "https://github.com/lucayunxiao/whiteboard-canvas-card"
  });

  console.info(
    `%c WHITEBOARD-CANVAS-CARD %c v${CARD_VERSION} `,
    "background: #2563eb; color: #fff; font-weight: 700; border-radius: 3px 0 0 3px;",
    "background: #0f172a; color: #fff; font-weight: 700; border-radius: 0 3px 3px 0;"
  );
})();
