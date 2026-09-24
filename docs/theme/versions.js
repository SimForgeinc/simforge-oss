// Version picker: reads /versions.json written by scripts/docs/build-site.sh.
(function () {
  fetch("/versions.json").then(function (r) { return r.ok ? r.json() : null; }).then(function (v) {
    if (!v || !v.versions) return;
    var bar = document.querySelector(".right-buttons");
    if (!bar) return;
    var here = location.pathname.split("/")[1] || "";
    var sel = document.createElement("select");
    sel.setAttribute("aria-label", "Documentation version");
    sel.style.marginLeft = "8px";
    [{ label: "latest (" + v.latest + ")", path: "" }, { label: "dev (main)", path: "dev" }]
      .concat(v.versions.map(function (t) { return { label: t, path: t }; }))
      .forEach(function (o) {
        var opt = document.createElement("option");
        opt.value = o.path; opt.textContent = o.label;
        if (o.path === here || (o.path === "" && !/^(dev|v\d)/.test(here))) opt.selected = true;
        sel.appendChild(opt);
      });
    sel.onchange = function () { location.href = "/" + (sel.value ? sel.value + "/" : ""); };
    bar.appendChild(sel);
  }).catch(function () {});
})();
