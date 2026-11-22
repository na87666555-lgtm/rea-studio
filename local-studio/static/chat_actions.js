"use strict";

(() => {
  let sceneContext = false;
  const colors = new Map(Object.entries({
    red:"#f04b52", लाल:"#f04b52", blue:"#4984ff", नीला:"#4984ff", नीले:"#4984ff", नीली:"#4984ff",
    green:"#45c181", हरा:"#45c181", हरे:"#45c181", हरी:"#45c181", purple:"#9866ec", बैंगनी:"#9866ec",
    yellow:"#f5ca42", पीला:"#f5ca42", pink:"#ef80ba", गुलाबी:"#ef80ba",
    orange:"#f59a48", नारंगी:"#f59a48", white:"#ffffff", सफेद:"#ffffff", सफ़ेद:"#ffffff"
  }));
  const shapes = new Map(Object.entries({
    cube:"cube", घन:"cube", क्यूब:"cube", sphere:"sphere", ball:"sphere", गोला:"sphere", गेंद:"sphere",
    ring:"torus", torus:"torus", रिंग:"torus", छल्ला:"torus", छल्ले:"torus",
    knot:"knot", गाँठ:"knot", गांठ:"knot", crystal:"icosahedron", क्रिस्टल:"icosahedron"
  }));
  const adjust = /^(make|set|change|turn|करो|करें|कर|रखो|बदलो|बदलें|बदल|बनाओ|बनाएं|बनाएँ)$/u;
  const action = /^(make|set|change|turn|start|run|create|play|animate|render|generate|शुरू|चलाओ|चलाएँ|चलाएं|बनाओ|बनाएँ|बनाएं|बनाइए|बनाइएगा|चलाइए|करो|करें|कर|बनाकर|बना|बदलें|बदल|रखो|बदलो)$/u;
  const sceneWords = new Set(("please a an the of to in on as at is with and new it this its my me for " +
    "3d three.js animation preview scene shape color colour speed spinning rotating faster slower fast slow " +
    "कृपया एक नया नई में का की के को इस इसे इसका इसकी इसके मेरा मेरे लिए और अब से पर जैसा " +
    "3डी थ्रीडी ऐनिमेशन एनिमेशन एनीमेशन प्रीव्यू आकृति आकार रंग गति स्पीड तेज तेज़ धीमा धीमी " +
    "घूमता घूमती घूमते घूमने वाला वाली हुआ हुई हुए कर दे दो दीजिए दें करिए कीजिए करके रेंडर").split(" "));
  const sceneNouns = /^(3d|3डी|थ्रीडी|three\.js|scene|animation|ऐनिमेशन|एनिमेशन|एनीमेशन|प्रीव्यू|preview)$/u;
  const generalWords = new Set(("a an the new please in with for me my using of run start create make " +
    "generate render sample starter example image demo python blender video call room " +
    "एक नई नया कृपया शुरू बनाओ बनाएं बनाएँ बनाइए बना बनाकर करो करें कर करिए कीजिए दो दे दें दीजिए " +
    "चलाओ चलाएँ चलाएं चलाइए खोलो खोलें में से का की के लिए मेरे वीडियो कॉल रूम कमरा उदाहरण नमूना " +
    "पाइथन पाइथॉन पायथन ब्लेंडर रेंडर चित्र तस्वीर इमेज डेमो").split(" "));
  const wordMatch = (words, pattern) => words.find(word => pattern.test(word));
  const speedWord = /^(fast|faster|तेज|तेज़|slow|slower|धीमी|धीमा)$/u;

  function setInput(id, value, event) {
    if (value === undefined) return;
    const input = el(id);
    input.value = value;
    input.dispatchEvent(new Event(event, {bubbles:true}));
  }

  window.runStudioRequest = async prompt => {
    if (typeof prompt !== "string" || prompt.length > 180 || /[?？\n]/u.test(prompt)) return false;
    const words = prompt.normalize("NFC").toLowerCase().replace(/[०-९]/gu, n => String("०१२३४५६७८९".indexOf(n)))
      .replace(/[.!।,]+$/u, "").trim().split(/\s+/u);
    if (!wordMatch(words, action)) return false;
    const norm = words.join(" ");
    if (words.every(w => generalWords.has(w))) {
      if (/\bvideo call\b|वीडियो कॉल/u.test(norm) && !/python|blender|ब्लेंडर|पायथन|पाइथन/u.test(norm)) {
        sceneContext = false;
        selectTab("video-studio");
        const button = el("call-create");
        if (!el("call-setup").hidden && !button.disabled) button.click();
        return true;
      }
      const engine = wordMatch(words, /^(python|blender|पाइथन|पाइथॉन|पायथन|ब्लेंडर)$/u);
      if (engine && wordMatch(words, /^(sample|starter|example|demo|रेंडर|render|उदाहरण|नमूना|डेमो)$/u)) {
        sceneContext = false;
        selectTab("scripts");
        await window.runReaStarter(/^(blender|ब्लेंडर)$/u.test(engine) ? "blender" : "python");
        return true;
      }
    }
    const color = words.find(w => colors.has(w) || /^#[a-f0-9]{6}$/u.test(w));
    const shape = words.find(w => shapes.has(w));
    const tempo = wordMatch(words, speedWord);
    const numeric = words.find(w => /^(?:[0-3](?:\.\d)?)(?:x|×)?$/u.test(w));
    const value = numeric && Number(numeric.replace(/[x×]$/u, ""));
    if (numeric && (value < .2 || value > 3 || !wordMatch(words, /^(speed|गति|स्पीड)$/u))) return false;
    const hasScene = wordMatch(words, sceneNouns) || (shape && wordMatch(words, /^(spinning|rotating|animate|घूमता|घूमते|घूमती|घूमने)$/u));
    const isEdit = sceneContext && wordMatch(words, adjust) && (shape || color || numeric || tempo);
    if (!hasScene && !isEdit) return false;
    if (!words.every(w => action.test(w) || sceneWords.has(w) || shapes.has(w) ||
      colors.has(w) || w === color || w === numeric)) return false;
    sceneContext = true;
    selectTab("animation-studio");
    setInput("scene-shape", shapes.get(shape), "change");
    setInput("scene-color", colors.get(color) || color, "input");
    const speed = numeric ? value : tempo ? (/^(fast|faster|तेज|तेज़)$/u.test(tempo) ? 2 : .5) : undefined;
    setInput("scene-speed", speed, "input");
    const play = el("scene-play");
    if (!play.disabled && play.getAttribute("aria-pressed") !== "true" && play.textContent.includes("चलाएँ")) play.click();
    return true;
  };
})();
