(() => {
  "use strict";
  const el = id => document.getElementById("studio-" + id);
  const form = el("form");
  if (!form) return;
  const starters = {
    python: `# मानक Python से एक रंगीन चित्र बनाएँ
import struct, zlib
from pathlib import Path

def chunk(tag, data):
    span = tag + data
    return struct.pack(">I", len(data)) + span + struct.pack(">I", zlib.crc32(span))

width = height = 256
rows = bytearray()
for y in range(height):
    rows.append(0)
    for x in range(width):
        radius = ((x - 128)**2 + (y - 128)**2)**0.5
        band = int(radius / 18) % 2
        rows.extend((72 + x//2, 48 + 100*band, 165 + y//3))

header = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
png = b"\\x89PNG\\r\\n\\x1a\\n" + chunk(b"IHDR", header)
Path("output.png").write_bytes(png + chunk(b"IDAT", zlib.compress(rows)) + chunk(b"IEND", b""))
print("चित्र तैयार है।")`,
    blender: `# आरंभिक Blender दृश्य के कैमरे से रंगीन घन रेंडर करें
import bpy
from pathlib import Path

scene = bpy.context.scene
cube = bpy.data.objects["Cube"]
material = bpy.data.materials.new(name="Indigo")
material.diffuse_color = (0.24, 0.13, 0.85, 1)
cube.data.materials.clear()
cube.data.materials.append(material)

scene.render.engine = "CYCLES"
scene.cycles.samples = 6
scene.cycles.use_denoising = False
scene.render.resolution_x = 320
scene.render.resolution_y = 320
scene.render.resolution_percentage = 100
scene.render.image_settings.file_format = "PNG"
scene.render.filepath = str(Path("output.png").resolve())
bpy.ops.render.render(write_still=True)
print("रेंडर तैयार है।")`
  };
  const scripts = {...starters};
  let engine = el("engine").value;
  let caps = {};
  let busy = false;
  let jobId = "";
  let timer;
  el("script").value = scripts[engine];

  function updateControls() {
    const available = Boolean(caps[engine]);
    el("run").disabled = busy || !available;
    el("install").disabled = busy;
    el("install-details").hidden = engine !== "blender" || available || !caps.can_install_blender;
    if (engine === "blender" && !available && caps.python) {
      el("availability").textContent = caps.can_install_blender
        ? "Blender इस डिवाइस पर इंस्टॉल करें।"
        : "सर्वर पर Blender उपलब्ध होने पर यहाँ रेंडर चला सकेंगे।";
    } else {
      el("availability").textContent = "";
    }
  }

  async function request(path, payload) {
    const response = await fetch("/api/studio" + path, payload === undefined ? {} : {
      method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify(payload)
    });
    if (!(response.headers.get("content-type") || "").includes("application/json")) {
      throw new Error("स्क्रिप्ट चलाने के लिए स्थानीय Rea सर्वर खोलें।");
    }
    const data = await response.json();
    if (!response.ok) {
      if (response.status === 404 && path.startsWith("/jobs/")) {
        try { sessionStorage.removeItem("rea.studio.job"); } catch {}
      }
      throw new Error(data.error || "स्थानीय सर्वर से जवाब नहीं मिला।");
    }
    return data;
  }

  async function check() {
    try {
      caps = await request("");
    } catch (error) {
      el("state").textContent = error.message;
    }
    updateControls();
  }

  function showFiles(names) {
    const container = el("results");
    container.replaceChildren();
    for (const name of names) {
      const url = "/api/studio/jobs/" + encodeURIComponent(jobId) + "/" + encodeURIComponent(name);
      const figure = document.createElement("figure");
      const view = document.createElement(name.endsWith(".png") ? "img" : "video");
      if (view.tagName === "IMG") view.alt = "स्क्रिप्ट से बना चित्र";
      else view.controls = true;
      view.style.maxWidth = "100%";
      view.src = url;
      const caption = document.createElement("figcaption");
      const download = document.createElement("a");
      download.href = url + "?download=1";
      download.download = name;
      download.textContent = name + " डाउनलोड करें";
      caption.append(download);
      figure.append(view, caption);
      container.append(figure);
    }
  }

  async function poll() {
    try {
      const job = await request("/jobs/" + encodeURIComponent(jobId));
      el("log").hidden = !job.log;
      el("log").textContent = job.log;
      const terminal = job.state === "done" || job.state === "failed";
      el("state").textContent = ({queued: "बारी की प्रतीक्षा है…", running: "काम जारी है…",
        done: "काम पूरा हुआ।", failed: "काम पूरा नहीं हो सका। लॉग देखें।"})[job.state];
      if (!terminal) {
        timer = setTimeout(poll, 900);
        return;
      }
      busy = false;
      showFiles(job.artifacts || []);
      await check();
    } catch (error) {
      el("state").textContent = error.message;
      busy = false;
      updateControls();
    }
  }

  async function launch(path, data) {
    if (busy) return;
    clearTimeout(timer);
    busy = true;
    updateControls();
    el("results").replaceChildren();
    el("log").hidden = true;
    el("state").textContent = "शुरू हो रहा है…";
    try {
      const job = await request(path, data);
      jobId = job.id;
      try { sessionStorage.setItem("rea.studio.job", jobId); } catch {}
      await poll();
    } catch (error) {
      el("state").textContent = error.message;
      busy = false;
      updateControls();
    }
  }

  el("engine").addEventListener("change", () => {
    scripts[engine] = el("script").value;
    engine = el("engine").value;
    el("script").value = scripts[engine];
    updateControls();
  });
  window.runReaStarter = async name => {
    if (!Object.hasOwn(starters, name)) return;
    el("engine").value = name;
    el("engine").dispatchEvent(new Event("change"));
    if (busy) {
      el("availability").textContent = "अभी एक काम चल रहा है।";
      return;
    }
    await check();
    if (!caps[name]) return;
    await launch("/jobs", {engine: name, script: starters[name]});
  };

  form.addEventListener("submit", event => {
    event.preventDefault();
    launch("/jobs", {engine, script: el("script").value});
  });
  el("install").addEventListener("click", () => launch("/install", {}));
  try { jobId = sessionStorage.getItem("rea.studio.job") || ""; } catch {}
  busy = Boolean(jobId);
  updateControls();
  check().then(() => { if (jobId) poll(); });
})();
