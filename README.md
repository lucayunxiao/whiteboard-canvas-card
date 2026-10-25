# Canvas Card

<p align="center">
  <a href="https://github.com/hacs/default"><img src="https://img.shields.io/badge/HACS-Custom-41bdf5.svg?style=for-the-badge&logo=homeassistant" alt="HACS Custom"></a>
  <a href="https://github.com/lucayunxiao/canvas-card/releases"><img src="https://img.shields.io/github/v/release/lucayunxiao/canvas-card?style=for-the-badge&color=2563eb" alt="GitHub Release"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-green.svg?style=for-the-badge" alt="License"></a>
  <img src="https://img.shields.io/badge/HA-2024.1%2B-blue.svg?style=for-the-badge&logo=homeassistant" alt="Home Assistant 2024.1+">
</p>

<p align="center">
  <b>A modern, responsive infinite-canvas drawing and printing card for Home Assistant Lovelace</b><br/>
  Featuring smooth Bézier curve strokes, dual-finger pinch-to-zoom &amp; pan, inline draggable floating text box, 300 DPI physical paper auto-fit rasterization, one-click Save/Discard/Print workflows, and multi-tier network printer integration.
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

- 🎨 **Infinite Canvas Workspace**: Draw freely without screen boundary constraints. Navigate effortlessly with responsive dual-finger pinch-to-zoom (`0.5x` to `5.0x`) and panning.
- ✍️ **Fluid Anti-Aliased Bézier Strokes**: Employs midpoint quadratic Bézier curve interpolation to eliminate jagged lines and touch latency on tablets (iPad / Android / Apple Pencil / stylus).
- 📝 **Inline Draggable Floating Text Box**:
  - Click anywhere with the `[ T ]` tool to instantiate a draggable text layer.
  - **Zero-Drift Drag Bar**: Drag offset is dynamically compensated by the viewport zoom scale ($\Delta X / \text{Scale}$), ensuring perfect alignment even when zoomed into 300%.
  - **4-Tier Font Sizing**: Small (18px), Medium (26px), Large (36px), and Extra Large (52px)—guaranteed $\ge 18\text{px}$ to prevent iOS Safari auto-viewport zoom.
  - **IME Buffer Protection**: Automatically flushes candidate buffers (`blur()`) before rasterization so multi-byte Chinese/Japanese text input is never truncated.
- 🖨️ **300 DPI Physical Paper Auto-Fit Engine**:
  - Automatically detects the tightest **bounding box** of all active strokes and text.
  - Pads with a 10mm print margin and fits content centered onto physical target media: **A4 (210 x 297 mm)**, **A3 (297 x 420 mm)**, **Letter (8.5 x 11 in)**, or **80mm Thermal Receipt roll**.
  - Renders at true **300 DPI high resolution** ($2480 \times 3508\text{ px}$ for A4), outputting razor-sharp physical printouts.
- ⚡ **Streamlined Action Workflows**:
  - **`Save + New`**: Captures drawing to IndexedDB storage and refreshes canvas for a new sketch.
  - **`Discard + New`**: Resets and clears canvas without saving (with optional confirmation dialog to prevent accidental clicks).
  - **`Print + New`**: Renders 300 DPI payload, dispatches to printer, archives drawing with "Printed" status, and resets canvas.
  - **`History`**: Slide-over drawer to browse past sketches, re-load onto canvas for secondary editing (`Re-edit`), reprint, or export PNG/PDF.
- 🌐 **Multi-Tier Printing Support**:
  - Direct local network IPP (Port 631)
  - Home Assistant Service Bridge (bypasses browser CORS / HTTPS mixed-content blocks)
  - Dedicated companion print gateways (e.g. `epson-web-printer` / CUPS)
  - Universal OS native print dialog fallback (`window.print`) compatible with AirPrint and Mopria
- 🎛️ **Full GUI Configuration Editor**: Configured effortlessly via native `<ha-form>` editor with live preview.

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
3. Add the repository URL: `https://github.com/lucayunxiao/canvas-card` with category **Plugin**.
4. Search for `Canvas Card` and click **Download**.
5. Refresh your dashboard page.

[![Open your Home Assistant instance and open a repository inside the Home Assistant Community Store.](https://my.home-assistant.io/badges/hacs_repository.svg)](https://my.home-assistant.io/redirect/hacs_repository/?owner=lucayunxiao&repository=canvas-card&category=plugin)

### Method 2: Manual Installation

1. Download [`dist/canvas-card.js`](https://raw.githubusercontent.com/lucayunxiao/canvas-card/main/dist/canvas-card.js).
2. Copy `canvas-card.js` into your Home Assistant directory under `<config>/www/`.
3. In Home Assistant, navigate to **Settings > Dashboards > Resources**.
4. Click **Add Resource**, set URL to `/local/canvas-card.js?v=1.0.0` and Resource type to `JavaScript Module`.
5. Refresh your browser cache.

---

## ⚙️ Configuration

### Visual GUI Editor
Add the card to any dashboard view. Click **Edit Card** to configure via the visual editor:

- **Card Title**: Custom title displayed in the card header.
- **Printer IP / Hostname**: Network address of your printer (e.g. `192.168.2.71`).
- **Printer Port**: Default `631` for IPP, `9100` for RAW.
- **Printing Protocol / Dispatch Mode**: Direct IPP, HA Service Bridge, Gateway URL, or OS Native Print.
- **Default Paper Format**: A4, A3, Letter, Thermal Receipt, or 1:1 Content Fit.
- **Canvas Background**: Engineering Grid, Clean White, or Dot Matrix.
- **Card Height**: Adjustable from 350px to 1200px.

### YAML Example

```yaml
type: custom:canvas-card
title: "Drawing Whiteboard"
printer_ip: "192.168.2.71"
printer_port: 631
print_mode: "ipp"
paper_size: "a4"
canvas_bg: "grid"
confirm_discard: true
height: 540
```

---

## 🤝 HACS Default Repository Submission Guide

To submit `canvas-card` to the official [hacs/default](https://github.com/hacs/default) store:

1. **Verify Local Quality**:
   Ensure `hacs.json`, `dist/canvas-card.js`, `.github/workflows/validate.yaml`, and semantic version tags (`v1.0.0`) are active.
2. **Fork the Official Repository**:
   Fork [https://github.com/hacs/default](https://github.com/hacs/default) into your GitHub account.
3. **Add Repository Entry to `plugin` File**:
   In your fork, edit the `plugin` file (no file extension).  
   > [!IMPORTANT]
   > Entries must follow **strict alphabetical order**. `canvas-card` begins with `c` and must be placed **before** `tts-broadcast-card` (`t`):
   ```text
   ...
   lucayunxiao/canvas-card
   lucayunxiao/tts-broadcast-card
   ...
   ```
4. **Submit Pull Request**:
   Create a feature branch (`git checkout -b add-canvas-card`) and open a Pull Request against `hacs/default:master` using the official PR template.

---

## 📄 License

This project is licensed under the [MIT License](LICENSE).
