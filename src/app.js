"use strict";
// App shell. Private data never comes from this file or this site: it is read
// from GitHub at run time and kept in memory only (later slices).

(function () {
  const root = document.documentElement;

  // Refuse to run inside a frame: a meta CSP cannot set frame-ancestors.
  if (window.top !== window.self) {
    root.classList.remove("pending");
    root.classList.add("framed");
    document.getElementById("state").textContent = "This page cannot be shown inside another site.";
    return;
  }
  root.classList.remove("pending");

  const projectsEl = document.getElementById("projects");

  // Text only: data is never parsed as HTML.
  function el(tag, text, className) {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = String(text);
    if (className) node.className = className;
    return node;
  }

  function renderProject(project) {
    const li = el("li");
    li.append(el("strong", project.name));
    const pct = Math.max(0, Math.min(100, Number(project.progress) || 0));
    li.append(el("div", pct + "% of baseline hours", "note"));
    const bar = el("div", undefined, "bar");
    const fill = el("span");
    fill.style.width = pct + "%";
    bar.append(fill);
    li.append(bar);
    const tasks = el("ul");
    for (const task of project.tasks || []) {
      tasks.append(el("li", task.id + " " + task.title + " (" + task.status + ")"));
    }
    li.append(tasks);
    return li;
  }

  document.getElementById("show-demo").addEventListener("click", function () {
    const demo = window.SANDBOARD_DEMO || { projects: [] };
    projectsEl.replaceChildren(...demo.projects.map(renderProject));
    document.getElementById("signed-out").hidden = true;
    document.getElementById("demo").hidden = false;
    document.getElementById("state").textContent = "Demo (synthetic data)";
  });
})();
