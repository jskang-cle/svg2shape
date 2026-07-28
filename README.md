# SVG → XAML

A tiny static web tool that converts SVG paths & shapes into **WPF / Avalonia** XAML
`Geometry` and `DrawingImage` resources. No build step, no dependencies — three files
of vanilla JS/CSS that run entirely in the browser.

## Use

Open `index.html` (or the hosted page). Paste SVG, drop an `.svg` file, or click **Open file**.
Output updates live.

**Options**
- **Target** — `WPF` (System.Windows.Media) or `Avalonia` (Avalonia.Media).
- **Mode**
  - `Geometry (colorless)` — merges everything into one `Geometry` mini-language string,
    ideal for a `PathIcon` / font-icon style single-color glyph.
  - `DrawingImage (colored)` — one `GeometryDrawing` per path with full fill/stroke/gradient
    fidelity, wrapped in a `DrawingImage` (usable as an `ImageSource`).
  - `Auto` — geometry when there's a single fill and no stroke, otherwise DrawingImage.
- **x:Key** — resource key on the emitted element.
- **Anchor bounds to viewBox** — prepends `M{w},{h}z M0,0z` to each geometry so all drawings
  share the viewBox bounding box (matches the BerndK *SvgToXaml* convention).

## What's supported

- Shapes: `path`, `rect` (incl. `rx`/`ry`), `circle`, `ellipse`, `line`, `polyline`, `polygon`
- Path data: all commands, relative→absolute, `H/V/S/T` expansion, arcs
- `transform` (matrix/translate/scale/rotate/skew) — **baked into coordinates**, including
  correct elliptical-arc transformation via a 2×2 SVD
- Groups `<g>` with inherited presentation styles + `style=""` attributes
- Fill / stroke / opacity / fill-opacity / stroke-opacity / fill-rule / linecap / linejoin
- `linearGradient` / `radialGradient` (stops, `spreadMethod`, `objectBoundingBox` &
  `userSpaceOnUse`, `xlink:href` stop inheritance)

## Known limitations

- `<use>` references and `gradientTransform` are not resolved (a warning is shown).
- Clip paths / masks / filters are ignored.
- Avalonia has no gradient `MappingMode`, so `userSpaceOnUse` gradients are converted to
  bounding-box-relative points (approximate for curved bounds).

## Hosting

Static — deploy the folder as-is to GitHub Pages, Cloudflare Pages, or any static host.
No server, no build.

## Files

| File | Purpose |
|------|---------|
| `index.html`  | markup + layout |
| `style.css`   | styling |
| `svg2xaml.js` | conversion core (also `module.exports` for Node tests) |
| `app.js`      | UI wiring (input, options, preview, copy/download, drag-drop) |
