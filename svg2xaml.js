/*
 * svg2xaml.js — convert an SVG document into WPF / Avalonia XAML geometry.
 *
 * Output modes:
 *   - "geometry"     : a single <PathGeometry>/Geometry mini-language string
 *                      (colorless, ideal for PathIcon / font-icon style use).
 *   - "drawingimage" : a <DrawingImage> whose DrawingGroup holds one
 *                      GeometryDrawing per drawn path (full colour fidelity).
 *   - "auto"         : geometry when there is a single fill and no stroke,
 *                      otherwise drawingimage.
 *
 * No dependencies. Uses the browser's DOMParser to read the SVG and a shared
 * <canvas> 2d context to normalise CSS colours.
 */
(function (global) {
  "use strict";

  var PREC = 5; // decimal places for baked/transformed coordinates

  // ---- number / string helpers -----------------------------------------

  function round(n) {
    if (!isFinite(n)) return 0;
    var r = Math.round(n * 1e5) / 1e5;
    return Object.is(r, -0) ? 0 : r;
  }
  function fmt(n) {
    return String(round(n));
  }
  function pt(x, y) {
    return fmt(x) + "," + fmt(y);
  }

  // ---- colour normalisation ---------------------------------------------

  var _ctx = null;
  function colorCtx() {
    if (!_ctx) {
      var c = document.createElement("canvas");
      c.width = c.height = 1;
      _ctx = c.getContext("2d");
    }
    return _ctx;
  }

  // Returns {hex6:"RRGGBB", a:0..1} or null for "none"/transparent-unset.
  function parseColor(css) {
    if (css == null) return null;
    css = String(css).trim();
    if (css === "" || css === "none") return null;
    if (css === "transparent") return { hex6: "000000", a: 0 };
    if (css === "currentColor") css = "black";
    var ctx = colorCtx();
    ctx.fillStyle = "#000";
    ctx.fillStyle = css;
    var s = ctx.fillStyle; // normalised: "#rrggbb" or "rgba(r, g, b, a)"
    if (s[0] === "#") {
      return { hex6: s.slice(1).toUpperCase(), a: 1 };
    }
    var m = s.match(/rgba?\(([^)]+)\)/);
    if (m) {
      var p = m[1].split(",").map(function (v) { return v.trim(); });
      var r = (+p[0] | 0), g = (+p[1] | 0), b = (+p[2] | 0);
      var a = p.length > 3 ? parseFloat(p[3]) : 1;
      return { hex6: hx(r) + hx(g) + hx(b), a: a };
    }
    return { hex6: "000000", a: 1 };
  }
  function hx(n) {
    n = Math.max(0, Math.min(255, n | 0));
    return (n < 16 ? "0" : "") + n.toString(16).toUpperCase();
  }
  // Combine a colour with an extra opacity multiplier -> "#AARRGGBB".
  function argb(color, opacity) {
    var a = Math.round(Math.max(0, Math.min(1, color.a * (opacity == null ? 1 : opacity))) * 255);
    return "#" + hx(a) + color.hex6;
  }

  // ---- matrices (SVG: a b c d e f) --------------------------------------

  var I = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
  function mul(m, n) {
    return {
      a: m.a * n.a + m.c * n.b,
      b: m.b * n.a + m.d * n.b,
      c: m.a * n.c + m.c * n.d,
      d: m.b * n.c + m.d * n.d,
      e: m.a * n.e + m.c * n.f + m.e,
      f: m.b * n.e + m.d * n.f + m.f
    };
  }
  function apply(m, x, y) {
    return [m.a * x + m.c * y + m.e, m.b * x + m.d * y + m.f];
  }
  function isIdentity(m) {
    return m.a === 1 && m.b === 0 && m.c === 0 && m.d === 1 && m.e === 0 && m.f === 0;
  }

  function parseTransform(str) {
    var m = I;
    if (!str) return m;
    var re = /(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/g, r;
    while ((r = re.exec(str))) {
      var n = r[2].split(/[\s,]+/).map(parseFloat).filter(function (v) { return !isNaN(v); });
      var t = I;
      switch (r[1]) {
        case "matrix": t = { a: n[0], b: n[1], c: n[2], d: n[3], e: n[4], f: n[5] }; break;
        case "translate": t = { a: 1, b: 0, c: 0, d: 1, e: n[0] || 0, f: n[1] || 0 }; break;
        case "scale": t = { a: n[0], b: 0, c: 0, d: (n.length > 1 ? n[1] : n[0]), e: 0, f: 0 }; break;
        case "rotate":
          var ang = (n[0] || 0) * Math.PI / 180, co = Math.cos(ang), si = Math.sin(ang);
          t = { a: co, b: si, c: -si, d: co, e: 0, f: 0 };
          if (n.length > 2) t = mul({ a: 1, b: 0, c: 0, d: 1, e: n[1], f: n[2] }, mul(t, { a: 1, b: 0, c: 0, d: 1, e: -n[1], f: -n[2] }));
          break;
        case "skewX": t = { a: 1, b: 0, c: Math.tan((n[0] || 0) * Math.PI / 180), d: 1, e: 0, f: 0 }; break;
        case "skewY": t = { a: 1, b: Math.tan((n[0] || 0) * Math.PI / 180), c: 0, d: 1, e: 0, f: 0 }; break;
      }
      m = mul(m, t);
    }
    return m;
  }

  // ---- path data: tokenize + normalize to absolute M/L/C/Q/A/Z ----------

  function parsePath(d) {
    var toks = d.match(/[a-df-zA-DF-Z]|[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/g) || [];
    var i = 0;
    function num() { return parseFloat(toks[i++]); }
    var cmds = [], cur = [0, 0], start = [0, 0], prevCtrl = null, prevCmd = "";
    var cmd = "";
    while (i < toks.length) {
      if (/[a-zA-Z]/.test(toks[i])) { cmd = toks[i++]; }
      else if (cmd === "M") { cmd = "L"; }         // implicit lineto after moveto
      else if (cmd === "m") { cmd = "l"; }
      var abs = cmd === cmd.toUpperCase();
      var C = cmd.toUpperCase();
      var x, y, x1, y1, x2, y2;
      switch (C) {
        case "M":
          x = num(); y = num();
          if (!abs) { x += cur[0]; y += cur[1]; }
          cur = [x, y]; start = [x, y];
          cmds.push(["M", x, y]); prevCtrl = null; break;
        case "L":
          x = num(); y = num();
          if (!abs) { x += cur[0]; y += cur[1]; }
          cur = [x, y]; cmds.push(["L", x, y]); prevCtrl = null; break;
        case "H":
          x = num(); if (!abs) x += cur[0];
          cur = [x, cur[1]]; cmds.push(["L", cur[0], cur[1]]); prevCtrl = null; break;
        case "V":
          y = num(); if (!abs) y += cur[1];
          cur = [cur[0], y]; cmds.push(["L", cur[0], cur[1]]); prevCtrl = null; break;
        case "C":
          x1 = num(); y1 = num(); x2 = num(); y2 = num(); x = num(); y = num();
          if (!abs) { x1 += cur[0]; y1 += cur[1]; x2 += cur[0]; y2 += cur[1]; x += cur[0]; y += cur[1]; }
          cmds.push(["C", x1, y1, x2, y2, x, y]); prevCtrl = [x2, y2]; cur = [x, y]; break;
        case "S":
          x2 = num(); y2 = num(); x = num(); y = num();
          if (!abs) { x2 += cur[0]; y2 += cur[1]; x += cur[0]; y += cur[1]; }
          var rc = (prevCmd === "C" || prevCmd === "S") && prevCtrl
            ? [2 * cur[0] - prevCtrl[0], 2 * cur[1] - prevCtrl[1]] : [cur[0], cur[1]];
          cmds.push(["C", rc[0], rc[1], x2, y2, x, y]); prevCtrl = [x2, y2]; cur = [x, y]; break;
        case "Q":
          x1 = num(); y1 = num(); x = num(); y = num();
          if (!abs) { x1 += cur[0]; y1 += cur[1]; x += cur[0]; y += cur[1]; }
          cmds.push(["Q", x1, y1, x, y]); prevCtrl = [x1, y1]; cur = [x, y]; break;
        case "T":
          x = num(); y = num();
          if (!abs) { x += cur[0]; y += cur[1]; }
          var rq = (prevCmd === "Q" || prevCmd === "T") && prevCtrl
            ? [2 * cur[0] - prevCtrl[0], 2 * cur[1] - prevCtrl[1]] : [cur[0], cur[1]];
          cmds.push(["Q", rq[0], rq[1], x, y]); prevCtrl = rq; cur = [x, y]; break;
        case "A":
          var rx = num(), ry = num(), rot = num(), laf = num(), sf = num();
          x = num(); y = num();
          if (!abs) { x += cur[0]; y += cur[1]; }
          cmds.push(["A", rx, ry, rot, laf, sf, x, y]); prevCtrl = null; cur = [x, y]; break;
        case "Z":
          cmds.push(["Z"]); cur = [start[0], start[1]]; prevCtrl = null; break;
        default:
          i++; continue;
      }
      prevCmd = C;
    }
    return cmds;
  }

  // Transform an elliptical arc by the linear part of a matrix (2x2 SVD).
  function transformArc(rx, ry, rot, m) {
    var phi = rot * Math.PI / 180, co = Math.cos(phi), si = Math.sin(phi);
    // ellipse basis E = R(phi) * diag(rx,ry)
    var e00 = rx * co, e01 = -ry * si, e10 = rx * si, e11 = ry * co;
    // linear part L = [[a,c],[b,d]]; E' = L * E
    var a00 = m.a * e00 + m.c * e10, a01 = m.a * e01 + m.c * e11;
    var a10 = m.b * e00 + m.d * e10, a11 = m.b * e01 + m.d * e11;
    // closed-form 2x2 SVD -> semi-axes + rotation
    var E = (a00 + a11) / 2, F = (a00 - a11) / 2, G = (a10 + a01) / 2, H = (a10 - a01) / 2;
    var Q = Math.hypot(E, H), R = Math.hypot(F, G);
    var sx = Q + R, sy = Q - R;
    var a1 = Math.atan2(G, F), a2 = Math.atan2(H, E);
    var theta = (a2 + a1) / 2; // rotation of the ellipse
    var newRx = Math.abs(sx), newRy = Math.abs(sy);
    var newRot = theta * 180 / Math.PI;
    var sweepFlip = (m.a * m.d - m.b * m.c) < 0; // reflection flips sweep
    return { rx: newRx, ry: newRy, rot: newRot, flip: sweepFlip };
  }

  function bake(cmds, m) {
    if (isIdentity(m)) return cmds;
    var out = [];
    for (var k = 0; k < cmds.length; k++) {
      var c = cmds[k], p;
      switch (c[0]) {
        case "M": case "L":
          p = apply(m, c[1], c[2]); out.push([c[0], p[0], p[1]]); break;
        case "C":
          var c1 = apply(m, c[1], c[2]), c2 = apply(m, c[3], c[4]), e = apply(m, c[5], c[6]);
          out.push(["C", c1[0], c1[1], c2[0], c2[1], e[0], e[1]]); break;
        case "Q":
          var q1 = apply(m, c[1], c[2]), qe = apply(m, c[3], c[4]);
          out.push(["Q", q1[0], q1[1], qe[0], qe[1]]); break;
        case "A":
          var t = transformArc(c[1], c[2], c[3], m), ep = apply(m, c[6], c[7]);
          out.push(["A", t.rx, t.ry, t.rot, c[4], t.flip ? 1 - c[5] : c[5], ep[0], ep[1]]); break;
        case "Z":
          out.push(["Z"]); break;
      }
    }
    return out;
  }

  // Serialize normalized commands to XAML mini-language, grouping repeats.
  function serialize(cmds) {
    var s = "", prev = "";
    for (var k = 0; k < cmds.length; k++) {
      var c = cmds[k], letter = c[0], body;
      switch (letter) {
        case "M": body = pt(c[1], c[2]); break;
        case "L": body = pt(c[1], c[2]); break;
        case "C": body = pt(c[1], c[2]) + "," + pt(c[3], c[4]) + "," + pt(c[5], c[6]); break;
        case "Q": body = pt(c[1], c[2]) + "," + pt(c[3], c[4]); break;
        case "A":
          body = fmt(c[1]) + "," + fmt(c[2]) + "," + fmt(c[3]) + "," +
                 (c[4] ? 1 : 0) + "," + (c[5] ? 1 : 0) + "," + pt(c[6], c[7]); break;
        case "Z": s += "z"; prev = "Z"; continue;
      }
      if (letter === prev && letter !== "M") s += " " + body;   // implicit repeat
      else { s += letter + body; prev = letter; }
    }
    return s;
  }

  // ---- shapes -> normalized path commands --------------------------------

  function attr(el, name, def) {
    var v = el.getAttribute(name);
    return v == null || v === "" ? def : v;
  }
  function numAttr(el, name, def) {
    var v = parseFloat(attr(el, name, def));
    return isNaN(v) ? def : v;
  }

  function shapeToCommands(el) {
    var tag = el.tagName.toLowerCase();
    switch (tag) {
      case "path":
        var d = attr(el, "d", "");
        return d ? parsePath(d) : null;
      case "rect": {
        var x = numAttr(el, "x", 0), y = numAttr(el, "y", 0),
          w = numAttr(el, "width", 0), h = numAttr(el, "height", 0),
          rx = el.hasAttribute("rx") ? numAttr(el, "rx", 0) : NaN,
          ry = el.hasAttribute("ry") ? numAttr(el, "ry", 0) : NaN;
        if (w <= 0 || h <= 0) return null;
        if (isNaN(rx) && isNaN(ry)) { rx = ry = 0; }
        else { if (isNaN(rx)) rx = ry; if (isNaN(ry)) ry = rx; }
        rx = Math.min(rx, w / 2); ry = Math.min(ry, h / 2);
        if (rx === 0 && ry === 0) {
          return [["M", x, y], ["L", x + w, y], ["L", x + w, y + h], ["L", x, y + h], ["Z"]];
        }
        return [
          ["M", x + rx, y],
          ["L", x + w - rx, y], ["A", rx, ry, 0, 0, 1, x + w, y + ry],
          ["L", x + w, y + h - ry], ["A", rx, ry, 0, 0, 1, x + w - rx, y + h],
          ["L", x + rx, y + h], ["A", rx, ry, 0, 0, 1, x, y + h - ry],
          ["L", x, y + ry], ["A", rx, ry, 0, 0, 1, x + rx, y], ["Z"]
        ];
      }
      case "circle": {
        var cx = numAttr(el, "cx", 0), cy = numAttr(el, "cy", 0), r = numAttr(el, "r", 0);
        if (r <= 0) return null;
        return ellipseCmds(cx, cy, r, r);
      }
      case "ellipse": {
        var ecx = numAttr(el, "cx", 0), ecy = numAttr(el, "cy", 0),
          erx = numAttr(el, "rx", 0), ery = numAttr(el, "ry", 0);
        if (erx <= 0 || ery <= 0) return null;
        return ellipseCmds(ecx, ecy, erx, ery);
      }
      case "line":
        return [["M", numAttr(el, "x1", 0), numAttr(el, "y1", 0)],
                ["L", numAttr(el, "x2", 0), numAttr(el, "y2", 0)]];
      case "polyline":
      case "polygon": {
        var pts = (attr(el, "points", "").match(/[-+]?[0-9.eE]+/g) || []).map(parseFloat);
        if (pts.length < 4) return null;
        var cmds = [["M", pts[0], pts[1]]];
        for (var i = 2; i + 1 < pts.length; i += 2) cmds.push(["L", pts[i], pts[i + 1]]);
        if (tag === "polygon") cmds.push(["Z"]);
        return cmds;
      }
    }
    return null;
  }
  function ellipseCmds(cx, cy, rx, ry) {
    return [
      ["M", cx - rx, cy],
      ["A", rx, ry, 0, 0, 1, cx + rx, cy],
      ["A", rx, ry, 0, 0, 1, cx - rx, cy],
      ["Z"]
    ];
  }

  // ---- style resolution --------------------------------------------------

  var INHERIT = ["fill", "stroke", "stroke-width", "fill-opacity", "stroke-opacity",
    "opacity", "fill-rule", "stroke-linecap", "stroke-linejoin", "stroke-miterlimit", "color"];

  function readStyle(el, parent) {
    var s = {};
    for (var k in parent) s[k] = parent[k];
    s.opacity = 1; // opacity is NOT inherited; it applies per element/group
    // presentation attributes
    INHERIT.forEach(function (name) {
      if (el.hasAttribute && el.hasAttribute(name)) s[name] = el.getAttribute(name).trim();
    });
    // inline style="" wins
    var style = el.getAttribute && el.getAttribute("style");
    if (style) {
      style.split(";").forEach(function (decl) {
        var idx = decl.indexOf(":");
        if (idx < 0) return;
        var key = decl.slice(0, idx).trim(), val = decl.slice(idx + 1).trim();
        if (INHERIT.indexOf(key) >= 0) s[key] = val;
      });
    }
    return s;
  }

  // ---- gradients ---------------------------------------------------------

  function collectDefs(svg) {
    var map = {};
    var grads = svg.querySelectorAll("linearGradient, radialGradient");
    for (var i = 0; i < grads.length; i++) {
      var g = grads[i], id = g.getAttribute("id");
      if (id) map[id] = g;
    }
    return map;
  }
  function href(el) {
    return el.getAttribute("xlink:href") || el.getAttribute("href");
  }
  function gradStops(g, defs) {
    var stops = g.querySelectorAll("stop");
    if (!stops.length) {
      var h = href(g);
      if (h && defs[h.replace("#", "")]) return gradStops(defs[h.replace("#", "")], defs);
    }
    var out = [];
    for (var i = 0; i < stops.length; i++) {
      var st = stops[i];
      var off = st.getAttribute("offset") || "0";
      off = off.indexOf("%") >= 0 ? parseFloat(off) / 100 : parseFloat(off);
      var scAttr = st.getAttribute("stop-color");
      var soAttr = st.getAttribute("stop-opacity");
      var stStyle = st.getAttribute("style") || "";
      var mSc = stStyle.match(/stop-color\s*:\s*([^;]+)/);
      var mSo = stStyle.match(/stop-opacity\s*:\s*([^;]+)/);
      var col = parseColor((mSc ? mSc[1] : scAttr) || "black") || { hex6: "000000", a: 1 };
      var so = mSo ? parseFloat(mSo[1]) : (soAttr != null ? parseFloat(soAttr) : 1);
      out.push({ offset: isNaN(off) ? 0 : off, color: col, opacity: isNaN(so) ? 1 : so });
    }
    return out;
  }
  function gattr(g, defs, name) {
    if (g.hasAttribute(name)) return g.getAttribute(name);
    var h = href(g);
    if (h && defs[h.replace("#", "")]) return gattr(defs[h.replace("#", "")], defs, name);
    return null;
  }

  // ---- brush emission (returns arrays of un-indented lines, or null) ------

  function refId(val) {
    var m = /url\(\s*#([^)\s]+)\s*\)/.exec(val || "");
    return m ? m[1] : null;
  }

  function paintBrush(paint, opacity, defs, target, warnings, bbox) {
    if (!paint || paint === "none") return null;
    var id = refId(paint);
    if (id && defs[id]) return gradientBrush(defs[id], opacity, defs, target, warnings, bbox);
    var col = parseColor(paint);
    if (!col) return null;
    return ['<SolidColorBrush Color="' + argb(col, opacity) + '" />'];
  }

  function spread(g, defs) {
    var s = gattr(g, defs, "spreadMethod");
    return s === "reflect" ? "Reflect" : s === "repeat" ? "Repeat" : "Pad";
  }

  function num(v, def) { var n = parseFloat(v); return isNaN(n) ? def : n; }
  function frac(v, def) {
    if (v == null) return def;
    return v.indexOf("%") >= 0 ? parseFloat(v) / 100 : num(v, def);
  }
  function rel(v, min, size) { return size ? (v - min) / size : 0; }

  function gradientBrush(g, opacity, defs, target, warnings, bbox) {
    var tag = g.tagName.toLowerCase();
    var units = gattr(g, defs, "gradientUnits") || "objectBoundingBox";
    var absolute = units === "userSpaceOnUse";
    // WPF can map absolute coords directly; Avalonia has no MappingMode, so we
    // convert userSpaceOnUse coords into bounding-box-relative fractions.
    var toRelative = absolute && target === "avalonia";
    if (toRelative && (!bbox || bbox.w === 0 || bbox.h === 0))
      warnings.push("Avalonia: could not map an absolute gradient to bounds; result may be off.");
    var stops = gradStops(g, defs);
    if (gattr(g, defs, "gradientTransform"))
      warnings.push("gradientTransform on '" + (g.getAttribute("id") || "?") + "' is not applied.");
    var stopLines = stops.map(function (s) {
      return '  <GradientStop Color="' + argb(s.color, opacity * s.opacity) + '" Offset="' + round(s.offset) + '" />';
    });

    var mapAbs = absolute && !toRelative;               // WPF absolute
    var opAttr = target === "avalonia" ? "" : ' Opacity="1"';
    var mmAttr = mapAbs ? ' MappingMode="Absolute"' : '';

    if (tag === "lineargradient") {
      var x1 = absolute ? num(gattr(g, defs, "x1"), 0) : frac(gattr(g, defs, "x1"), 0);
      var y1 = absolute ? num(gattr(g, defs, "y1"), 0) : frac(gattr(g, defs, "y1"), 0);
      var x2 = absolute ? num(gattr(g, defs, "x2"), 0) : frac(gattr(g, defs, "x2"), 1);
      var y2 = absolute ? num(gattr(g, defs, "y2"), 0) : frac(gattr(g, defs, "y2"), 0);
      if (toRelative) { x1 = rel(x1, bbox.minX, bbox.w); y1 = rel(y1, bbox.minY, bbox.h); x2 = rel(x2, bbox.minX, bbox.w); y2 = rel(y2, bbox.minY, bbox.h); }
      return ['<LinearGradientBrush StartPoint="' + pt(x1, y1) + '" EndPoint="' + pt(x2, y2) + '"' + mmAttr + ' SpreadMethod="' + spread(g, defs) + '"' + opAttr + '>']
        .concat(stopLines, ['</LinearGradientBrush>']);
    } else {
      var cx = absolute ? num(gattr(g, defs, "cx"), 0) : frac(gattr(g, defs, "cx"), 0.5);
      var cy = absolute ? num(gattr(g, defs, "cy"), 0) : frac(gattr(g, defs, "cy"), 0.5);
      var r = absolute ? num(gattr(g, defs, "r"), 0) : frac(gattr(g, defs, "r"), 0.5);
      var fx = gattr(g, defs, "fx"), fy = gattr(g, defs, "fy");
      var ox = fx != null ? (absolute ? num(fx, cx) : frac(fx, cx)) : cx;
      var oy = fy != null ? (absolute ? num(fy, cy) : frac(fy, cy)) : cy;
      var rr = r;
      if (toRelative) {
        cx = rel(cx, bbox.minX, bbox.w); cy = rel(cy, bbox.minY, bbox.h);
        ox = rel(ox, bbox.minX, bbox.w); oy = rel(oy, bbox.minY, bbox.h);
        rr = bbox.w ? r / bbox.w : 0.5;
      }
      if (target === "avalonia") {
        return ['<RadialGradientBrush Center="' + pt(cx, cy) + '" GradientOrigin="' + pt(ox, oy) + '" Radius="' + fmt(rr) + '" SpreadMethod="' + spread(g, defs) + '">']
          .concat(stopLines, ['</RadialGradientBrush>']);
      }
      return ['<RadialGradientBrush Center="' + pt(cx, cy) + '" GradientOrigin="' + pt(ox, oy) + '" RadiusX="' + fmt(rr) + '" RadiusY="' + fmt(rr) + '"' + mmAttr + ' SpreadMethod="' + spread(g, defs) + '" Opacity="1">']
        .concat(stopLines, ['</RadialGradientBrush>']);
    }
  }

  // Approximate fill bounding box from baked commands (control points included).
  function boundsOf(cmds) {
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    function add(x, y) { if (x < minX) minX = x; if (y < minY) minY = y; if (x > maxX) maxX = x; if (y > maxY) maxY = y; }
    cmds.forEach(function (c) {
      switch (c[0]) {
        case "M": case "L": add(c[1], c[2]); break;
        case "C": add(c[1], c[2]); add(c[3], c[4]); add(c[5], c[6]); break;
        case "Q": add(c[1], c[2]); add(c[3], c[4]); break;
        case "A": add(c[6], c[7]); break;
      }
    });
    if (!isFinite(minX)) return { minX: 0, minY: 0, w: 0, h: 0 };
    return { minX: minX, minY: minY, w: maxX - minX, h: maxY - minY };
  }

  // ---- traversal ---------------------------------------------------------

  function walk(el, ctm, pstyle, defs, out) {
    for (var i = 0; i < el.children.length; i++) {
      var child = el.children[i];
      var tag = child.tagName.toLowerCase();
      if (tag === "defs" || tag === "lineargradient" || tag === "radialgradient" ||
          tag === "clippath" || tag === "mask" || tag === "symbol" || tag === "metadata" ||
          tag === "title" || tag === "desc" || tag === "style") continue;
      var m = mul(ctm, parseTransform(child.getAttribute("transform")));
      var style = readStyle(child, pstyle);
      if (tag === "g" || tag === "svg" || tag === "a") {
        walk(child, m, style, defs, out);
        continue;
      }
      if (tag === "use") { continue; } // <use> not resolved in v1
      var cmds = shapeToCommands(child);
      if (!cmds) continue;
      cmds = bake(cmds, m);
      out.push({ cmds: cmds, style: style });
    }
  }

  // ---- geometry string with optional bounds anchor -----------------------

  function fillRulePrefix(style) {
    return (style["fill-rule"] === "evenodd") ? "F0 " : "F1 ";
  }
  function boundsAnchor(vb) {
    if (!vb) return "";
    return "M" + pt(vb.maxX, vb.maxY) + "z M" + pt(vb.minX, vb.minY) + "z ";
  }

  // ---- public convert ----------------------------------------------------

  function convert(svgText, opts) {
    opts = opts || {};
    var target = opts.target === "avalonia" ? "avalonia" : "wpf";
    var mode = opts.mode || "auto";
    var anchor = opts.anchorBounds !== false;
    var key = opts.key || "Icon";
    var warnings = [];

    var doc = new DOMParser().parseFromString(svgText, "image/svg+xml");
    var perr = doc.querySelector("parsererror");
    if (perr) return { error: "SVG parse error: " + perr.textContent.replace(/\s+/g, " ").trim() };
    var svg = doc.documentElement;
    if (!svg || svg.tagName.toLowerCase() !== "svg")
      return { error: "Root element is not <svg>." };

    // viewBox
    var vb = null, vbAttr = svg.getAttribute("viewBox");
    if (vbAttr) {
      var p = vbAttr.split(/[\s,]+/).map(parseFloat);
      if (p.length === 4) vb = { minX: p[0], minY: p[1], w: p[2], h: p[3], maxX: p[0] + p[2], maxY: p[1] + p[3] };
    }
    if (!vb) {
      var w = parseFloat(svg.getAttribute("width")), h = parseFloat(svg.getAttribute("height"));
      if (!isNaN(w) && !isNaN(h)) vb = { minX: 0, minY: 0, w: w, h: h, maxX: w, maxY: h };
    }

    var defs = collectDefs(svg);
    // Root <svg> presentation attributes (e.g. fill="none") are inherited.
    var rootStyle = readStyle(svg, { fill: "black", opacity: 1 });
    var prims = [];
    walk(svg, I, rootStyle, defs, prims);
    if (!prims.length) return { error: "No drawable shapes found." };

    // decide mode
    var colored = prims.some(function (pr) {
      var f = pr.style.fill, s = pr.style.stroke;
      var hasStroke = s && s !== "none";
      var fillIsColor = f && f !== "none";
      return hasStroke || refId(f) || (fillIsColor && (parseColor(f) && parseColor(f).hex6 !== "000000"));
    });
    var distinctFills = {};
    prims.forEach(function (pr) { if (pr.style.fill) distinctFills[pr.style.fill] = 1; });
    var effectiveMode = mode;
    if (mode === "auto") {
      var anyStroke = prims.some(function (pr) { return pr.style.stroke && pr.style.stroke !== "none"; });
      effectiveMode = (!anyStroke && Object.keys(distinctFills).length <= 1) ? "geometry" : "drawingimage";
    }

    if (effectiveMode === "geometry") {
      return { xaml: emitGeometry(prims, vb, anchor, key, target), mode: "geometry", warnings: warnings, viewBox: vb };
    }
    return { xaml: emitDrawingImage(prims, vb, anchor, key, target, defs, warnings), mode: "drawingimage", warnings: warnings, viewBox: vb };
  }

  function emitGeometry(prims, vb, anchor, key, target) {
    // Merge all figures into one geometry string (fill rule from first).
    var rule = fillRulePrefix(prims[0].style);
    var body = prims.map(function (pr) { return serialize(pr.cmds); }).join(" ");
    var data = rule + (anchor ? boundsAnchor(vb) : "") + body;
    var xmlns = target === "avalonia"
      ? 'xmlns="https://github.com/avaloniaui"'
      : 'xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"';
    // A resource-friendly StreamGeometry-as-Geometry via x:Key on PathGeometry string.
    return '<!-- ' + target.toUpperCase() + ' : single Geometry (colorless) -->\n' +
      '<Geometry x:Key="' + key + '"\n          ' +
      xmlns + '\n          xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml">' +
      '\n  ' + data + '\n</Geometry>';
  }

  function emitDrawingImage(prims, vb, anchor, key, target, defs, warnings) {
    var lines = [];
    var clip = vb ? ('M' + pt(vb.minX, vb.minY) + ' V' + fmt(vb.maxY) + ' H' + fmt(vb.maxX) + ' V' + fmt(vb.minY) + ' H' + fmt(vb.minX) + ' Z') : null;
    lines.push('<DrawingImage x:Key="' + key + '">');
    lines.push('  <DrawingImage.Drawing>');
    lines.push('    <DrawingGroup' + (clip ? ' ClipGeometry="' + clip + '"' : '') + '>');

    function push(pad, arr) { arr.forEach(function (l) { lines.push(pad + l); }); }

    prims.forEach(function (pr) {
      var st = pr.style;
      var bbox = boundsOf(pr.cmds);
      var fillOpacity = mulOpacity(st.opacity, st["fill-opacity"]);
      var strokeOpacity = mulOpacity(st.opacity, st["stroke-opacity"]);
      var geo = fillRulePrefix(st) + (anchor ? boundsAnchor(vb) : "") + serialize(pr.cmds);
      // fill defaults to black only when never specified anywhere up the tree.
      var fillPaint = st.fill == null ? "black" : st.fill;
      var fillBrush = paintBrush(fillPaint, fillOpacity, defs, target, warnings, bbox);
      var strokePaint = (st.stroke && st.stroke !== "none") ? st.stroke : null;

      lines.push('      <GeometryDrawing Geometry="' + geo + '">');
      if (fillBrush) {
        lines.push('        <GeometryDrawing.Brush>');
        push('          ', fillBrush);
        lines.push('        </GeometryDrawing.Brush>');
      }
      if (strokePaint) {
        var sw = st["stroke-width"] != null ? parseFloat(st["stroke-width"]) : 1;
        if (isNaN(sw)) sw = 1;
        var cap = capName(st["stroke-linecap"]);
        var join = joinName(st["stroke-linejoin"]);
        var sbrush = paintBrush(strokePaint, strokeOpacity, defs, target, warnings, bbox);
        lines.push('        <GeometryDrawing.Pen>');
        lines.push('          <Pen Thickness="' + round(sw) + '" LineCap="' + cap + '" LineJoin="' + join + '">');
        lines.push('            <Pen.Brush>');
        push('              ', sbrush);
        lines.push('            </Pen.Brush>');
        lines.push('          </Pen>');
        lines.push('        </GeometryDrawing.Pen>');
      }
      lines.push('      </GeometryDrawing>');
    });

    lines.push('    </DrawingGroup>');
    lines.push('  </DrawingImage.Drawing>');
    lines.push('</DrawingImage>');
    var header = '<!-- ' + target.toUpperCase() + ' : DrawingImage (full colour) -->\n';
    return header + lines.join("\n");
  }

  function mulOpacity(op, sub) {
    var a = op == null ? 1 : parseFloat(op);
    var b = sub == null ? 1 : parseFloat(sub);
    if (isNaN(a)) a = 1; if (isNaN(b)) b = 1;
    return a * b;
  }
  function capName(v) {
    return v === "round" ? "Round" : v === "square" ? "Square" : "Flat";
  }
  function joinName(v) {
    return v === "round" ? "Round" : v === "bevel" ? "Bevel" : "Miter";
  }

  global.Svg2Xaml = { convert: convert, parseColor: parseColor };

  // Test hook (Node only; no effect in the browser).
  if (typeof module !== "undefined" && module.exports) {
    module.exports = {
      convert: convert, parseColor: parseColor,
      _internal: { parsePath: parsePath, serialize: serialize, bake: bake,
        parseTransform: parseTransform, shapeToCommands: shapeToCommands,
        transformArc: transformArc, mul: mul, apply: apply }
    };
  }
})(typeof window !== "undefined" ? window : globalThis);
