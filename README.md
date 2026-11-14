# Rea Studio

अपनी API key से किसी भी AI provider के मॉडल चलाने वाला स्वतंत्र चैट ऐप। इसे फ़ोन पर ऐप की तरह install किया जा सकता है, और इसमें कई काम एक साथ चलते हैं।

यह कोई मुफ्त AI सेवा नहीं है। ऐप सिर्फ आपकी डाली हुई key से उसी provider को request भेजता है। खर्च और लिमिट उसी provider के हिसाब से होते हैं।

## क्या-क्या कर सकता है

- **कोई भी API:** Anthropic (Claude), OpenAI, OpenRouter, Google Gemini, Groq, DeepSeek, Mistral, xAI, Together, Coarena, या कोई भी OpenAI-जैसा या Anthropic-जैसा API (अपना Base URL डालकर)।
- **कई चैट एक साथ:** एक चैट का जवाब आ रहा हो, तब भी दूसरी चैट खोलकर नया सवाल भेज सकते हैं।
- **⚡ एक साथ कई काम:** हर लाइन में एक काम लिखें। सब अलग-अलग चैट में एक साथ चलते हैं, एक बार में 50 तक। हर API की "एक साथ कितनी requests" सीमा से ज़्यादा काम कतार में रुककर अपनी बारी पर चलते हैं।
- **मॉडलों की तुलना:** एक ही काम को कई मॉडलों या कई providers पर एक साथ चला सकते हैं।
- **🛠 टूल्स (Claude जैसी क्षमताएँ):** मॉडल जवाब देते समय खुद ये टूल इस्तेमाल कर सकता है:
  - 🔎 **वेब खोज:** बिना key के Wikipedia में खोजता है। Tavily या Jina की मुफ्त key डालने पर पूरे इंटरनेट में खोजता है।
  - 📄 **वेब पेज पढ़ना:** किसी भी link का मुख्य text पढ़ता है (r.jina.ai के ज़रिए)।
  - ▶ **JavaScript** और 🐍 **Python** चलाना: Python (Pyodide) पहली बार लगभग 10 MB download करता है। कोड फ़ोन में ही एक अलग worker में चलता है, जहाँ से API keys नहीं पढ़ी जा सकतीं।
  - हर टूल का कदम चैट में दिखता है, और उसे दबाने पर कोड और नतीजा खुल जाता है। सेटिंग्स में हर टूल को अलग से बंद किया जा सकता है।
  - जिस मॉडल या provider में टूल्स नहीं चलते, वहाँ ऐप अपने आप बिना टूल्स के जवाब ले लेता है।
- **📎 फ़ोटो और फ़ाइलें:** संदेश लिखने की जगह के बगल वाला ＋ दबाकर फ़ोटो, PDF, text/CSV/code फ़ाइल, MP3 या वीडियो जोड़ें (हर फ़ाइल 50 MB तक)।
  - फ़ोटो सीधे मॉडल को जाती है, ताकि वह उसे देख सके (Claude जैसे vision मॉडल के लिए)।
  - text वाली फ़ाइलों का content मॉडल पढ़ता है।
  - PDF Anthropic-जैसे API में सीधे जाती है।
  - MP3, वीडियो और बाकी फ़ाइलें Python टूल को `/home/pyodide/uploads/` में मिलती हैं।
  - फ़ाइलें फ़ोन के ब्राउज़र storage (IndexedDB) में रहती हैं, और चैट हटाने पर वे भी हट जाती हैं।
- **फ़ोन पर install:** होम स्क्रीन पर ऐप की तरह लगता है, और बिना इंटरनेट के भी खुल जाता है (जवाब के लिए इंटरनेट चाहिए)।
- **Keys आपके फ़ोन में:** keys सिर्फ इसी फ़ोन के ब्राउज़र में सेव रहती हैं। कोई बीच का server नहीं है।

## चालू कैसे करें (एक बार, फ़ोन से)

1. फ़ोन के ब्राउज़र में यह खोलें: `https://github.com/na87666555-lgtm/rea-studio/settings/pages`
2. **Build and deployment** में **Source** को **Deploy from a branch** करें।
3. **Branch** में `claude/cloud-proxy-setup-xlw3k9` और folder में `/ (root)` चुनकर **Save** दबाएँ।
4. 1–2 मिनट बाद ऐप यहाँ खुलेगा: `https://na87666555-lgtm.github.io/rea-studio/`

## फ़ोन पर install करें

- **Android (Chrome):** ऐप का लिंक खोलें → ऊपर ⋮ मेनू → **Install app** या **होम स्क्रीन में जोड़ें**।
- **iPhone (Safari):** Share बटन → **Add to Home Screen**।

## इस्तेमाल

1. ☰ मेनू → **⚙ API और सेटिंग्स** → **+ नया API जोड़ें**।
2. Provider चुनें, अपनी API key डालें, **↻ मॉडल लिस्ट लाओ** दबाकर मॉडल चुनें, फिर **✓ टेस्ट करें** और **सेव**।
3. वापस आकर संदेश लिखें। ऊपर दाईं ओर मॉडल का नाम दबाकर किसी भी चैट का मॉडल बदल सकते हैं।
4. कई काम एक साथ चलाने हों तो ☰ → **⚡ एक साथ कई काम**।

## ChatGPT + Gemini + Claude — एक ही चैट में

1. ☰ → **✦ तीन AI · एक चैट** खोलें। होम स्क्रीन पर भी यही विकल्प है।
2. प्रोजेक्ट का नाम लिखें। तीनों भूमिकाओं के लिए API कनेक्शन और मॉडल नाम चुनें। कनेक्शन का पता स्क्रीन पर दिखता है। **API से मॉडल सूची लाओ** से provider के बताए मॉडल नाम देख सकते हैं और **API से मॉडल जाँचें** से उस नाम पर एक छोटा अनुरोध भेज सकते हैं। पुराने सेटअप में पहले से भरे हुए नाम हो सकते हैं; किसी सूची या अनुरोध से स्वतंत्र रूप से मॉडल की असली पहचान साबित नहीं होती। API कनेक्शन इसी संवाद से जोड़ सकते हैं; ऐसा एक API भी चल सकता है जिसमें तीनों के मॉडल उपलब्ध हों।
3. प्रोजेक्ट के साझा निर्देश लिखें, साझा जवाब तैयार करने वाला सदस्य चुनें, और **टीम सेव करें** दबाएँ।
4. इसी चैट में अपना काम लिखें या फ़ाइल जोड़ें। तीनों को वही बातचीत, साझा निर्देश और उनके API में समर्थित फ़ाइल सामग्री मिलती है। ChatGPT योजना बनाता है, Gemini योजना और प्रोजेक्ट फ़ाइलें देखकर काम करता है, फिर Claude उसे जाँचता और सुधार सकता है। इसके बाद चुना हुआ सदस्य एक अंतिम जवाब देता है। हर मॉडल पिछले सदस्य का योगदान देखता है।
5. **तीनों का योगदान देखें** खोलकर प्रत्येक मॉडल का जवाब और टूल के नतीजे देखें। अगला सवाल इसी बातचीत को आगे बढ़ाता है। ऊपर **तीन AI · साथ** से टीम बदल सकते हैं। **⌘ कोड** से साझा प्रोजेक्ट की फ़ाइलें देखें, बदलें और डाउनलोड करें।

### साझा कोड प्रोजेक्ट

हर टीम चैट का अपना टेक्स्ट फ़ाइल कार्यक्षेत्र है। `project_list` और `project_read` से तीनों मॉडल फ़ाइलें देख सकते हैं; निर्माण और जाँच वाले सदस्य `project_write` से फ़ाइलें सेव कर सकते हैं। इसके लिए चुने हुए API और मॉडल में tool calling का समर्थन होना चाहिए। API tool calling अस्वीकार करे तो ऐप स्पष्ट सूचना देकर बिना टूल के जवाब लेता है; ऐसे में मॉडल फ़ाइल स्वयं नहीं बदल सकता।

⌘ कोड में फ़ाइल चुनें, संपादित करें और **फ़ाइल सेव करें** दबाएँ। `index.html` के साथ `style.css` और `script.js` हों तो **प्रीव्यू चलाएँ** से सेव किया वेब कोड देख सकते हैं। प्रीव्यू अलग sandbox में चलता है, उसके लिए नेटवर्क और बाहरी स्क्रिप्ट बंद हैं। Python/Node server और मोबाइल का फाइल सिस्टम इस प्रीव्यू में नहीं चलते। एक फ़ाइल अधिकतम 100,000 अक्षर, कुल 600,000 अक्षर और 30 फ़ाइलें हैं; ब्राउज़र की उपलब्ध storage कम हो तो उससे पहले सीमा आ सकती है। प्रोजेक्ट फ़ाइलें इस ब्राउज़र में उसी चैट के साथ रहती हैं, अपने आप GitHub या इंटरनेट पर प्रकाशित नहीं होतीं।

### असली वेबसाइट खाते (प्रायोगिक)

वेबसाइट मोड के लिए अलग, निजी Chromium सेवा चाहिए: [browser-bridge/README.md](browser-bridge/README.md)। वह सेवा शुरू और कॉन्फ़िगर किए बिना यह विकल्प काम नहीं करेगा। फोन से ऐप के भीतर उस ब्राउज़र की स्क्रीन देखें और खुद ChatGPT, Gemini और Claude में लॉगिन करें। तीनों में “मैंने इस वेबसाइट में लॉगिन पूरा किया” दबाने के बाद वेबसाइट टीम प्रोजेक्ट बना सकते हैं। ऐप सेवाओं के UI से जवाब लेने की कोशिश करता है; यह मॉडल API या Coarena से वेबसाइट का जवाब बदलकर नहीं दिखाता।

प्रदाता UI या लॉगिन रोकने पर स्पष्ट त्रुटि दिखाई देगी। असली लॉगिन खातों के साथ अभी यह पूरा प्रवाह सत्यापित नहीं है। सेवा का संचालक उस ब्राउज़र में आपके लॉगिन और स्क्रीन तक पहुँच सकता है; केवल भरोसेमंद, पासकोड-सुरक्षित HTTPS सेवा उपयोग करें। सत्र निष्क्रियता, होस्ट के रुकने, रीस्टार्ट या डेप्लॉय पर मिट सकता है। वेबसाइट मोड में साझा टेक्स्ट प्रोजेक्ट और टेक्स्ट/कोड अटैचमेंट (प्रत्येक 50,000 अक्षर तक) समर्थित हैं; फोटो, PDF, ऑडियो और वीडियो अटैचमेंट अभी नहीं।

हर सवाल पर आम तौर पर चार model requests होती हैं: तीन योगदान और एक अंतिम जवाब। टूल्स इस्तेमाल होने पर अतिरिक्त requests होती हैं। API की अपनी concurrency सीमा लागू रहती है। किसी सदस्य के विफल होने पर उसकी त्रुटि और पूरे हुए योगदानों की संख्या दिखाई देती है; बाकी योगदानों से साझा जवाब बनता है। अंतिम जवाब बनाने वाला सदस्य विफल हो तो तैयार योगदान दिखाई देते रहते हैं। **रोकें** पूरी टीम को रोकता है। ब्राउज़र बंद होने पर काम जारी नहीं रहता, लेकिन सहेजे गए योगदान उसी चैट में रहते हैं।

यह मौजूदा API कनेक्शन इस्तेमाल करता है; ChatGPT/Gemini/Claude की वेबसाइटों पर लॉगिन करना इन API कनेक्शनों की जगह नहीं लेता। उन वेबसाइटों के लॉगिन अभी इस ऐप में जुड़े नहीं हैं। Coarena चुनने पर तीनों भूमिकाओं के अनुरोध Coarena को जाते हैं, चुने गए मॉडल नाम के साथ। तीनों का साझा अंतिम जवाब आगे के सवालों में तीनों providers को भेजा जाता है। टीम और प्रोजेक्ट फ़ोन के इसी ब्राउज़र में सहेजे जाते हैं।

### विकास और जाँच

ऐप के लिए build या server dependency आवश्यक नहीं है। static server से root folder चलाएँ। Node.js 20+ पर:

```sh
npm ci
npm test
npx playwright install chromium
npm run test:browser
```

Browser test अपने आप एक स्थानीय static server शुरू और बंद करता है। यह तीनों API formats के नियंत्रित जवाबों से टीम सेटअप, streaming, साझा फ़ाइलें और पिछली बातचीत, त्रुटि, रोकना, reload, offline shell और सामान्य चैट जाँचता है। यह असली paid models की गुणवत्ता या provider CORS की जाँच नहीं करता। `PLAYWRIGHT_CHROMIUM_EXECUTABLE` से अपना Chromium binary चुन सकते हैं।

## ध्यान रखें

- कुछ providers ब्राउज़र से सीधी request (CORS) स्वीकार नहीं करते। तब "नेटवर्क त्रुटि" दिखेगी, और ऐसा provider इस ऐप में नहीं चलेगा।
- फ़ोन पर ऐप बंद करने या लंबे समय तक background में रखने पर चल रहे जवाब बीच में रुक सकते हैं।
- टूल्स इस्तेमाल होने पर खोज के शब्द Wikipedia, Tavily या Jina को जाते हैं, पढ़े जाने वाले link r.jina.ai को जाते हैं, और Python jsDelivr से download होता है।
- Keys फ़ोन के ब्राउज़र storage में रहती हैं, इसलिए फ़ोन सुरक्षित रखें। सेटिंग्स में **सब कुछ हटाएँ** दबाने से सारी keys और चैट मिट जाती हैं।
- Base URL में सिर्फ `https://` वाले पते मान्य हैं (अपने फ़ोन पर चल रहे `localhost` को छोड़कर)।

## फ़ाइलें

| फ़ाइल | काम |
| --- | --- |
| `index.html` | ऐप का ढाँचा |
| `css/app.css` | डिज़ाइन (dark/light दोनों) |
| `js/app.js` | चैट, सेटिंग्स, एक साथ कई काम |
| `js/team.js` | ChatGPT की योजना, Gemini का निर्माण, Claude की जाँच और साझा अंतिम जवाब |
| `js/project.js`, `project-preview.html`, `js/project-preview.js` | टीम प्रोजेक्ट की फ़ाइलें और sandbox में वेब कोड का प्रीव्यू |
| `js/providers.js` | OpenAI-जैसे और Anthropic-जैसे API से streaming बातचीत |
| `js/tools.js`, `js/run-worker.js`, `js/py-worker.js` | वेब खोज, पेज पढ़ना, JavaScript और Python चलाना |
| `js/files.js` | फ़ोटो और फ़ाइलें जोड़ना और सेव करना |
| `js/queue.js` | हर API के लिए एक साथ चलने वाली requests की सीमा |
| `js/markdown.js` | जवाबों का सुरक्षित Markdown रूप (HTML/script नहीं चलने देता) |
| `js/store.js` | फ़ोन के ब्राउज़र में सेव करना |
| `sw.js`, `manifest.webmanifest`, `icons/` | install और offline सपोर्ट |

## अपडेट

ऐप खुला रहते हुए हर कुछ मिनट में `version.json` जाँचता है। नया version मिलने पर, जब कोई जवाब न चल रहा हो और message box खाली हो, तो ऐप खुद को नए version में reload कर लेता है।

नया बदलाव publish करते समय `version.json` और `js/app.js` का `APP_VERSION`, दोनों एक साथ बदलें। `sw.js` का `CACHE` सिर्फ तब बदलें जब `sw.js` का अपना code बदले।

## English summary

Rea Studio is a dependency-free, installable web app (PWA) for chatting with any AI provider using your own API key. It speaks both the OpenAI-style `/chat/completions` and the Anthropic-style `/v1/messages` streaming formats, so it works with Anthropic, OpenAI, OpenRouter, Gemini, Groq, DeepSeek, Mistral, xAI, Together, Coarena, or any compatible endpoint. The model can call tools while answering: web search (Wikipedia without a key, or Tavily/Jina with one), reading a web page (via r.jina.ai), and running JavaScript or Python (Pyodide) in sandboxed workers that can't read the stored keys; tool calls stream for both API formats, and providers that reject tools fall back to plain chat. Photos, PDFs, text files, audio and video can be attached: photos go to the model as images (resized JPEG), PDFs as document blocks on Anthropic-style APIs, small text files inline, and everything is available to the Python tool under /home/pyodide/uploads; files are kept in IndexedDB. Many chats can stream at once, and the multi-task screen fans a list of tasks out across one or more models, with a per-connection concurrency limit. Keys stay in the browser's `localStorage` and are sent only to the configured base URL. There is no build step: serve the repository root as static files (for example with GitHub Pages).
