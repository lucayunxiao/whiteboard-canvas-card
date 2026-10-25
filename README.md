# Whiteboard Canvas Card

<p align="center">
  <a href="https://github.com/hacs/default"><img src="https://img.shields.io/badge/HACS-Custom-41bdf5.svg?style=for-the-badge&logo=homeassistant" alt="HACS Custom"></a>
  <a href="https://github.com/lucayunxiao/whiteboard-canvas-card/releases"><img src="https://img.shields.io/github/v/release/lucayunxiao/whiteboard-canvas-card?style=for-the-badge&color=2563eb" alt="GitHub Release"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-green.svg?style=for-the-badge" alt="License"></a>
  <img src="https://img.shields.io/badge/HA-2024.1%2B-blue.svg?style=for-the-badge&logo=homeassistant" alt="Home Assistant 2024.1+">
</p>

<p align="center">
  <b>A modern, responsive infinite-canvas whiteboard drawing and printing card for Home Assistant Lovelace</b><br/>
  Featuring smooth Bézier curve strokes, real-time multi-terminal sync with per-device Undo/Redo, dual-finger pinch-to-zoom &amp; pan, inline draggable floating text box, 300 DPI physical paper auto-fit rasterization, one-click Save/Discard/Print workflows, and multi-tier network printer integration.
</p>

<p align="center">
  <a href="README.md"><b>English</b></a> | <a href="README_zh.md"><b>简体中文</b></a>
</p>

---

## 📸 Overview &amp; Architecture

<p align="center">
  <img src="assets/banner.svg" alt="Canvas Card Architecture and Workflow" width="100%"/>
</p>

---

## ✨ Features

- 🎨 **Boundless Infinite Canvas Workspace**: Draw freely without canvas boundaries or accidental clipping. The engineering grid / dot matrix texture dynamically spans 100% of the viewport edge-to-edge, smoothly synchronizing with touch and mouse pan/zoom (`0.2x` to `5.0x`).
- 🔄 **Real-Time Multi-Terminal Canvas Synchronization &amp; Per-Device Undo/Redo**:
  - **Dual-Layer Engine**: Synchronizes strokes, texts, undo/redo, and clears across all devices (PC, iPad, phone, wall dashboard) via Home Assistant WebSocket events and same-device `BroadcastChannel`.
  - **Per-Device Ownership Undo/Redo**: Each device can only undo/redo strokes and text created by itself (`ownerId` isolation), preventing accidental erasure of other users' concurrent drawings while syncing undo/redo changes instantaneously (~80-byte vector operation diff).
  - **Ultra-Low Bandwidth Vector Streaming**: Streams lightweight compact coordinate packets rather than heavy image bitmaps, enabling silky smooth concurrent multi-user drawing at 60 FPS without lag.
  - **Seamless Late-Joiner Handshake**: Automatically requests and receives current canvas state when newly opened on another device.
- 📱 **Mobile-Optimized Navigation &amp; Anti-Jitter Controls**:
  - **`[ ✋ Hand ]` Pan Tool**: Dedicated pan tool in the toolbar enables single-finger canvas dragging without accidental strokes or triggering mobile system swipe gestures.
  - **Floating Zoom Pod**: Tactile `[-]`, `[🎯 100%]`, and `[+]` floating buttons at the bottom-right for instant, rock-solid zoom control.
  - **Ghost-Dot Prevention**: Delayed tap detection prevents stray marks when resting fingers or initiating pinch gestures.
- 🖱️ **Desktop Mouse Navigation**:
  - **Cursor-Centered Wheel Zoom**: Smoothly zoom in/out focused on your mouse pointer.
  - **Right-Click / Middle-Click Pan**: Hold right-click or middle-click to drag the canvas effortlessly (native context menu is cleanly suppressed).
- 🎯 **Auto-Centering on Load & Refresh**: Powered by `ResizeObserver`, the canvas automatically centers drawings in the viewport upon initial layout ready, browser refresh, or screen rotation.
- ✍️ **Fluid Anti-Aliased Bézier Strokes**: Employs midpoint quadratic Bézier curve interpolation to eliminate jagged lines and touch latency on tablets (iPad / Android / Apple Pencil / stylus).
- 📝 **Inline Draggable Floating Text Box**:
  - Click anywhere with the `[ T ]` tool to instantiate a draggable text layer directly on screen.
  - **Zero-Drift Drag Bar**: Drag offset is dynamically converted to virtual canvas space, ensuring perfect alignment at any zoom level.
  - **4-Tier Font Sizing**: Small (18px), Medium (24px), Large (32px), and Extra Large (44px)—guaranteed $\ge 18\text{px}$ to prevent iOS Safari auto-viewport zoom.
  - **IME Buffer Protection**: Automatically flushes candidate buffers (`blur()`) before rasterization so multi-byte Chinese/Japanese text input is never truncated.
- 🖨️ **Fixed-Frame Print Preview & 300 DPI Rasterizer**:
  - **Always-Infinite Drawing**: Drawing is never constrained to fixed paper boundaries.
  - **Fixed Paper Print Area**: When printing, an interactive preview dialog displays a fixed, centered physical paper frame (**A4, A5, A3, Letter, 80mm Thermal** in **Portrait / Landscape**) that never overflows the screen.
  - **Pan & Zoom Canvas into Paper**: Drag, mouse-wheel zoom, pinch-zoom, or click **`Fit Content`** / **`[-]` `[+]`** to position and scale your drawing cleanly inside the fixed paper area.
  - Renders at true **300 DPI high resolution** ($2480 \times 3508\text{ px}$ for A4), outputting razor-sharp physical printouts.
- ⚡ **Streamlined Action Workflows**:
  - **`Save + New`**: Captures drawing to IndexedDB storage and refreshes canvas for a new sketch.
  - **`Discard + New`**: Resets and clears canvas without saving (with optional confirmation dialog). Connected terminals automatically sync the clear action.
  - **`Print + New`**: Opens the interactive framing dialog, renders 300 DPI crop, dispatches to printer, archives drawing with "Printed" status, and resets canvas.
  - **`History`**: Slide-over drawer to browse past sketches, re-load onto canvas for secondary editing (`Edit`), reprint, or export. Includes configurable automatic FIFO retention limit (5–100 items, default 30).
- 🔒 **Standalone Printing Switch & Total Desensitization**:
  - Dedicated `enable_printing` toggle in the visual editor. When off, hides all printer controls for a pure digital sketchbook.
  - Zero hardcoded IP addresses or default network credentials.
- 🌐 **Multi-Tier Printing Support**:
  - Direct local network IPP (Port 631)
  - Home Assistant Service Bridge (bypasses browser CORS / HTTPS mixed-content blocks)
  - Dedicated companion print gateways (e.g. `epson-web-printer` / CUPS)
  - Universal OS native print dialog fallback (`window.print`) compatible with AirPrint and Mopria
- 🎛️ **Full GUI Configuration Editor**: Flat schema with standard `<ha-form>` dropdowns, eliminating unselectable radio states and broken data binding.

---

## 🔬 Printing Principles &amp; Supported Scope

### Technical Printing Principles

1. **Resolution-Independent Virtual Coordinates to Physical 300 DPI Rasterization**:
   - Strokes and text are captured in a virtual high-density coordinate buffer.
   - Upon dispatching a print job, the calculation engine computes the minimum bounding box $[X_{\min}, Y_{\min}, X_{\max}, Y_{\max}]$ of all non-transparent pixels, discarding infinite blank margins and adding a 10mm safety boundary.
   - An offscreen rendering canvas allocates exact 300 DPI dimensions corresponding to the chosen physical paper profile:
     $$\text{A4 Buffer} = \frac{210\text{ mm}}{25.4\text{ mm/inch}} \times 300\text{ DPI} \approx 2480\text{ px (W)} \times 3508\text{ px (H)}$$
   - The drawing is aspect-ratio locked, centered, and rendered with anti-aliasing, ensuring pristine sharpness on paper.

2. **Network Protocol Stack &amp; Browser Security Mitigation**:
   - **IPP (Internet Printing Protocol, RFC 8011)**: Operates over HTTP port 631 using binary `application/ipp` packets. Sends standard `Print-Job` operations (operation ID `0x0002`) with attributes like `media=iso_a4_210x297mm`, `print-color-mode=color/monochrome`, and `copies=1`.
   - **CORS &amp; Mixed Content Solution**: Modern web browsers block secure HTTPS dashboards (e.g. Nabu Casa or SSL domains) from making unencrypted requests to local printer HTTP IPs (`http://192.168.x.x:631`). Canvas Card handles this cleanly via a 4-tier fallback:
     1. *Direct IPP*: Used when accessing HA via local HTTP or local intranet.
     2. *HA Service Bridge*: Dispatches print data through Home Assistant backend services, eliminating all browser CORS constraints.
     3. *Dedicated Print Gateway*: Forwards payloads to a local print container (such as `/opt/epson-web-printer`).
     4. *OS Native Print Spooler*: Directly invokes the operating system's AirPrint, Mopria, or CUPS dialog via `@media print`.

### Supported Printer Scope Matrix

| Manufacturer / Category | Supported Model Families | Supported Protocols | Recommended Mode |
| :--- | :--- | :--- | :--- |
| **Epson** | EcoTank series (ET-5150, ET-2800, ET-8550, L-series), WorkForce, Expression | IPP (Port 631), ESC/P-R, RAW 9100, AirPrint | Direct IPP / HA Bridge / Gateway |
| **HP** | LaserJet, OfficeJet Pro, DeskJet, ENVY series | IPP / IPPS, ePrint, AirPrint, PCL3GUI | Direct IPP / HA IPP Integration |
| **Canon** | PIXMA (TS/G series), MAXIFY, imageRUNNER | IPP, UFR II, AirPrint | Direct IPP / AirPrint |
| **Brother** | HL Laser series, MFC Multi-function, DCP series | IPP, B-Net, RAW 9100 | Direct IPP / RAW 9100 |
| **Thermal / Label Printers** | Xprinter, Gprinter, MUNBYN, Epson TM series | ESC/POS (Port 9100), TSPL, IPP | RAW 9100 / HA Bridge |
| **Universal Client Print** | Any printer connected to your phone, tablet, or PC | iOS AirPrint, Android Mopria, Windows Spooler, CUPS | OS Native Print Dialog |

---

## 📦 Installation

### Method 1: Via HACS (Recommended)

1. Open **HACS** in your Home Assistant dashboard.
2. Click the three dots in the top-right corner $\to$ **Custom repositories**.
3. Add the repository URL: `https://github.com/lucayunxiao/whiteboard-canvas-card` with category **Plugin**.
4. Search for `Whiteboard Canvas Card` and click **Download**.
5. Refresh your dashboard page.

[![Open your Home Assistant instance and open a repository inside the Home Assistant Community Store.](https://my.home-assistant.io/badges/hacs_repository.svg)](https://my.home-assistant.io/redirect/hacs_repository/?owner=lucayunxiao&repository=whiteboard-canvas-card&category=plugin)

### Method 2: Manual Installation

1. Download [`dist/whiteboard-canvas-card.js`](https://raw.githubusercontent.com/lucayunxiao/whiteboard-canvas-card/main/dist/whiteboard-canvas-card.js).
2. Copy `whiteboard-canvas-card.js` into your Home Assistant directory under `<config>/www/`.
3. In Home Assistant, navigate to **Settings > Dashboards > Resources**.
4. Click **Add Resource**, set URL to `/local/whiteboard-canvas-card.js?v=1.1.0` and Resource type to `JavaScript Module`.
5. Refresh your browser cache.

---

## ⚙️ Configuration

### Visual GUI Editor
Add the card to any dashboard view. Click **Edit Card** to configure via the visual editor:

- **Card Title**: Custom title displayed in the card header.
- **Max History Items**: Configurable history retention limit (slider from 5 to 100, default 30). Automatically prunes older sketches in FIFO order.
- **Enable Printing Feature**: Standalone toggle. When disabled, hides all print buttons and printer status badges for a pure distraction-free digital sketchbook.
- **Printer IP Address / Hostname**: Network address of your printer (optional, e.g. `192.168.1.100` or `printer.local`). Left empty by default.
- **Printer Port**: Default `631` for IPP.
- **Printing Protocol / Dispatch Mode**: Direct IPP, Home Assistant Service Bridge, Dedicated Gateway URL, or OS Native Print Dialog.
- **Canvas Background**: Engineering Grid (Light Blue), Clean Pure White, or Dot Matrix.
- **Card Viewport Height**: Adjustable from 350px to 1200px.
- **Confirm before Discarding**: Optional confirmation modal to prevent accidental drawing loss.

### YAML Example

#### Pure Digital Sketchbook Mode (Printing Disabled):
```yaml
type: custom:whiteboard-canvas-card
title: "Drawing Whiteboard"
enable_printing: false
canvas_bg: "grid"
confirm_discard: true
max_history_items: 30
height: 560
```

#### With Network Printing & Framing Enabled:
```yaml
type: custom:whiteboard-canvas-card
title: "Studio Canvas & Print"
enable_printing: true
printer_ip: "192.168.1.100"
printer_port: 631
print_mode: "ipp"
canvas_bg: "grid"
confirm_discard: true
max_history_items: 50
height: 600
```

---

## 🤝 HACS Default Repository Submission Guide

To submit `whiteboard-canvas-card` to the official [hacs/default](https://github.com/hacs/default) store:

1. **Verify Local Quality**:
   Ensure `hacs.json`, `whiteboard-canvas-card.js`, `.github/workflows/validate.yaml`, and semantic version tags (`v1.1.0`) are active.
2. **Fork the Official Repository**:
   Fork [https://github.com/hacs/default](https://github.com/hacs/default) into your GitHub account.
3. **Add Repository Entry to `plugin` File**:
   In your fork, edit the `plugin` file (no file extension).  
   > [!IMPORTANT]
   > Entries must follow **strict alphabetical order**. `whiteboard-canvas-card` begins with `w` and is placed in the `lucayunxiao/...` section right after `lucayunxiao/tts-broadcast-card` (`t`):
   ```text
   ...
   lucayunxiao/tts-broadcast-card
   lucayunxiao/whiteboard-canvas-card
   ...
   ```
4. **Submit Pull Request**:
   Create a feature branch (`git checkout -b add-whiteboard-canvas-card`) and open a Pull Request against `hacs/default:master` using the official PR template.

---

## 📄 License

This project is licensed under the [MIT License](LICENSE).
