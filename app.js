(function () {
  "use strict";
  var $ = function (id) { return document.getElementById(id); };
  var input = $("input"), output = $("output"), preview = $("preview"), status = $("status");
  var target = $("target"), mode = $("mode"), key = $("key"), anchor = $("anchor"), flatten = $("flatten");

  var SAMPLE = [
    '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">',
    '  <rect x="2" y="2" width="20" height="20" rx="4" fill="#335CFF"/>',
    '  <path d="M12 4.5C12.2761 4.5 12.5 4.7239 12.5 5C12.5 6.5327 12.7285 8.5938 13.5684 10.4512C14.5406 11.1134 16.3218 11.4461 19 11.5C19.2761 11.5 19.5 11.7239 19.5 12C19.5 12.2761 19.2761 12.5 19 12.5C16.3238 12.5576 14.5444 12.8985 13.5703 13.5703C12.8986 14.5445 12.5359 16.9198 12.5 19C12.5 19.2761 12.2761 19.5 12 19.5C11.7239 19.5 11.5 19.2761 11.5 19C11.4416 16.3237 11.0985 14.5448 10.4248 13.5703C9.44898 12.8985 7.67096 12.5575 5 12.5C4.72386 12.5 4.5 12.2761 4.5 12C4.5 11.7239 4.7239 11.5 5 11.5C7.67687 11.4663 9.4519 11.1134 10.4268 10.4502C11.0985 9.483 11.4416 7.6989 11.5 5C11.5 4.7239 11.7239 4.5 12 4.5Z" fill="white"/>',
    '</svg>'
  ].join("\n");

  function run() {
    var svg = input.value.trim();
    // live SVG preview
    try { preview.innerHTML = svg && /<svg[\s>]/i.test(svg) ? svg : ""; }
    catch (e) { preview.innerHTML = ""; }

    if (!svg) { output.value = ""; setStatus("", ""); return; }
    var res;
    try {
      res = Svg2Xaml.convert(svg, {
        target: target.value, mode: mode.value,
        key: key.value.trim() || "Icon", anchorBounds: anchor.checked,
        flatten: flatten.checked
      });
    } catch (e) {
      output.value = ""; setStatus("err", "Conversion failed: " + e.message); return;
    }
    if (res.error) { output.value = ""; setStatus("err", res.error); return; }
    output.value = res.xaml;
    var msg = "Mode: " + res.mode + (res.viewBox ? "  ·  viewBox " + res.viewBox.w + "×" + res.viewBox.h : "");
    if (res.warnings && res.warnings.length) {
      setStatus("warn", msg + "  ·  ⚠ " + res.warnings.join("  ⚠ "));
    } else {
      setStatus("ok", msg);
    }
  }

  function setStatus(cls, text) {
    status.className = "status" + (cls ? " " + cls : "");
    status.textContent = text;
  }

  // events
  [input, target, mode, key, anchor, flatten].forEach(function (el) {
    el.addEventListener("input", run);
    el.addEventListener("change", run);
  });

  $("sample").addEventListener("click", function () { input.value = SAMPLE; run(); });

  $("copy").addEventListener("click", function () {
    if (!output.value) return;
    navigator.clipboard.writeText(output.value).then(function () {
      var b = $("copy"), t = b.textContent; b.textContent = "Copied!";
      setTimeout(function () { b.textContent = t; }, 1200);
    });
  });

  $("download").addEventListener("click", function () {
    if (!output.value) return;
    var blob = new Blob([output.value], { type: "application/xml" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = (key.value.trim() || "Icon") + ".xaml";
    a.click();
    URL.revokeObjectURL(a.href);
  });

  function readFile(file) {
    if (!file) return;
    var r = new FileReader();
    r.onload = function () { input.value = r.result; run(); };
    r.readAsText(file);
  }
  $("file").addEventListener("change", function (e) { readFile(e.target.files[0]); });

  // drag & drop anywhere
  window.addEventListener("dragover", function (e) { e.preventDefault(); document.body.classList.add("dragover"); });
  window.addEventListener("dragleave", function (e) { if (e.target === document || e.relatedTarget == null) document.body.classList.remove("dragover"); });
  window.addEventListener("drop", function (e) {
    e.preventDefault(); document.body.classList.remove("dragover");
    var f = e.dataTransfer.files[0];
    if (f) readFile(f);
  });

  run();
})();
