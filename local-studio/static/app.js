"use strict";
const el = id => document.getElementById(id);
const tabs = Array.from(document.querySelectorAll("nav [data-tab]"));
function selectTab(id) {
  for (const button of tabs) {
    const active = button.dataset.tab === id;
    const panel = el(button.dataset.tab);
    if (panel) panel.hidden = !active;
    if (active) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  }
  window.dispatchEvent(new Event("resize"));
}
tabs.forEach(button => button.addEventListener("click", () => selectTab(button.dataset.tab)));
selectTab("chat");
async function api(path, data) {
  const response = await fetch(path, data === undefined ? {} : {
    method: "POST", headers: {"Content-Type":"application/json"}, body: JSON.stringify(data)
  });
  const result = await response.json();
  if (!response.ok) throw Error(result.error || "अनुरोध विफल रहा।");
  return result;
}
function element(tag, text, className) {
  const node = document.createElement(tag);
  node.textContent = text;
  if (className) node.className = className;
  return node;
}
let revision;
const noteTool = (name, args) => api("/api/mcp/call", {name, arguments:args});
async function setup() {
  const area = el("providers");
  try {
    const status = await api("/api/status");
    area.replaceChildren();
    for (const model of status.models) {
      const web = model.provider.endsWith(" Web");
      const row = element("div", "", "person");
      row.append(element("strong", web ? model.model : model.provider + " · " + model.model));
      if (web) {
        const login = element("button", "लॉगिन खोलें");
        login.addEventListener("click", async () => {
          login.disabled = true;
          try {
            const result = await api("/api/login", {provider:model.provider});
            el("login-message").textContent = result.message;
          } catch (error) { el("login-message").textContent = error.message; }
          finally { login.disabled = false; }
        });
        row.append(login);
      }
      area.append(row);
    }
    const hint = element("p", status.models.some(m => m.provider.endsWith(" Web")) ?
      "हर खाते में एक बार लॉगिन करके उसकी विंडो बंद करें। फिर अपना सवाल भेजें।" : "");
    hint.id = "login-message";
    hint.setAttribute("role","status");
    area.append(hint);
    if (!status.models.length) hint.textContent = "मॉडल जोड़ने के लिए सर्वर की सेटिंग जाँचें।";
    if (status.built_in_notes) {
      const response = await noteTool("note.read", {});
      if (response.isError) throw Error(response.content[0].text);
      el("memo").value = response.structuredContent.text;
      revision = response.structuredContent.revision;
      el("save-note").hidden = false;
    }
  } catch (error) {
    area.append(element("p", error.message, "problem"));
  }
}
el("save-note").addEventListener("click", async () => {
  const button = el("save-note");
  button.disabled = true;
  try {
    const res = await noteTool("note.write", {text:el("memo").value, revision});
    if (res.isError) throw Error(res.content[0].text);
    revision = res.structuredContent.revision;
    el("note-status").textContent = " सहेजा गया";
  } catch (error) { el("note-status").textContent = error.message; }
  finally { button.disabled = false; }
});
function showAnswer(result) {
  const area = el("answers");
  if (result.synthesis) {
    area.append(element("h3", "साझा उत्तर"), element("p", result.synthesis, "reply"),
      element("small", result.synthesis_by));
  }
  for (const reply of result.answers) {
    const details = document.createElement("details");
    details.open = !result.synthesis;
    details.append(element("summary", reply.provider + " · " + reply.model),
      element("p", reply.text, "reply"));
    area.append(details);
  }
  showSources(area, result.sources);
  for (const err of result.errors) area.append(element("p", err.provider + " · " + err.message, "problem"));
}
function showSources(area, sources) {
  if (sources?.length) {
    area.append(element("h3", "पढ़े गए स्रोत"));
    for (const [i, source] of sources.entries()) {
      const details = document.createElement("details");
      details.append(element("summary", "[" + (i + 1) + "] " + source.title),
        element("p", source.text, "reply"));
      if (/^https?:\/\//i.test(source.url)) {
        const link = element("a","मूल पृष्ठ खोलें");
        link.href = source.url;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        details.append(link);
      }
      area.append(details);
    }
  }
}
let previous = sessionStorage.getItem("rea:last-answer");
async function followJob(id) {
  el("result-panel").hidden = false;
  el("answers").replaceChildren();
  let showedSources = false;
  for (;;) {
    const item = await api("/api/answer/" + encodeURIComponent(id));
    el("activity").textContent = item.events.join("\n");
    if (item.state === "failed") throw Error(item.error);
    if (item.state === "done") {
      el("answers").replaceChildren(element("h3", item.prompt));
      showAnswer(item.result);
      return;
    }
    if (!showedSources && item.sources?.length) {
      showSources(el("answers"), item.sources);
      showedSources = true;
    }
    await new Promise(resolve => setTimeout(resolve, 900));
  }
}
el("chat-form").addEventListener("submit", async event => {
  event.preventDefault();
  const prompt = el("question").value.trim();
  if (!prompt) return;
  const note = el("include-memo").checked ? el("memo").value : "";
  el("ask").disabled = true;
  try {
    if (await runStudioRequest(prompt)) return;
    el("result-panel").hidden = false;
    el("activity").textContent = "सवाल भेजा जा रहा है…";
    const job = await api("/api/answer", {prompt,note,previous});
    previous = job.id;
    sessionStorage.setItem("rea:last-answer", job.id);
    el("question").value = "";
    await followJob(job.id);
  } catch (error) { el("answers").append(element("p",error.message,"problem")); }
  finally { el("ask").disabled = false; }
});
if (previous) {
  el("ask").disabled = true;
  followJob(previous).catch(() => {
    sessionStorage.removeItem("rea:last-answer");
    previous = null;
    el("result-panel").hidden = true;
  }).finally(() => { el("ask").disabled = false; });
}
let tools = [];
function showTool() {
  const tool = tools.find(item => item.name === el("tool-name").value);
  if (!tool) return;
  el("tool-description").textContent = tool.description || "";
  el("schema").textContent = JSON.stringify(tool.inputSchema,null,2);
  el("tool-args").value = "{}";
}
el("tool-name").addEventListener("change", showTool);
el("load-tools").addEventListener("click", async () => {
  const button = el("load-tools");
  button.disabled = true;
  el("tool-form").hidden = true;
  try {
    tools = (await api("/api/mcp/list",{})).tools;
    el("tool-name").replaceChildren(...tools.map(tool => new Option(tool.name, tool.name)));
    el("tool-form").hidden = !tools.length;
    el("tool-status").textContent = tools.length + " टूल उपलब्ध";
    showTool();
  } catch (error) { el("tool-status").textContent = error.message; }
  finally { button.disabled = false; }
});
el("tool-form").addEventListener("submit", async event => {
  event.preventDefault();
  const button = event.target.querySelector("button[type=submit]");
  button.disabled = true;
  try {
    const res = await noteTool(el("tool-name").value, JSON.parse(el("tool-args").value));
    el("tool-result").textContent = JSON.stringify(res, null, 2);
  } catch (error) { el("tool-result").textContent = error.message; }
  finally { button.disabled = false; }
});
setup();
