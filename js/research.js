// Public-source research for chats without a model and for the website team.
import { runTool, toolSettings } from './tools.js';

const lookup = /\b(search|research|sources?|citations?|evidence|look up|find out|fact.check|online)\b|खोज|शोध|इंटरनेट|संदर्भ|स्रोत|ऑनलाइन|ढूंढ|ढूँढ/i;
const factual = /\b(what|when|where|who|why|which|how|explain|compare|history|science|books?|facts?|capital|population|news|latest|weather|author|mathematics|art)\b|क्या|कौन|कब|कहाँ|कहां|कैसे|कितन|क्यों|गणित|विज्ञान|किताब|पुस्तक|लेखक|कला|समझाइए|इतिहास|जानकारी|बताओ|बताइए/i;
const privateTask = /\b(my|mine|password|personal|secret|this (file|code|text)|rewrite|summari[sz]e|translate|draft|create|write|animate|draw|debug|fix|your name|are you)\b|मेरी|मेरा|मेरे|मुझे .*लिख|अपना नाम|आप कौन|कैसे हो|पासवर्ड|निजी|अनुवाद|सारांश|बनाओ|बनाइए|बनाकर|बना दो|ठीक कर|लिखो|सुधार/i;
const sensitive = /\S+@\S+\.\S+|```|-----BEGIN .*KEY-----|\b(?:sk-|ghp_|github_pat_)[\w-]{12,}|\b(?:password|token|api.?key)\s*[:=]/i;

export function publicSourceUrl(raw) {
  try {
    const url = new URL(raw);
    const host = url.hostname;
    if (!['http:', 'https:'].includes(url.protocol) || !host.includes('.') || url.username || url.password || url.port ||
        /^(?:\d+\.)+\d+$/.test(host) || host.startsWith('[') ||
        /(?:^|\.)(?:local|localhost|test|internal|invalid|onion|home\.arpa)\.?$/i.test(host)) return '';
    if ([...url.searchParams.keys()].some(k => /token|password|secret|signature|api.?key|credential|^code$|^sig$|^auth$/i.test(k))) return '';
    url.hash = '';
    return url.href;
  } catch { return ''; }
}

export function planResearch(text, settings, attachments = []) {
  const config = toolSettings(settings);
  if (!config.enabled || attachments.length || typeof text !== 'string' || text.length > 1000 || sensitive.test(text)) return null;
  const rawLinks = text.match(/https?:\/\/[^\s<>"'`।]+/gi) || [];
  if (rawLinks.length) {
    if (!config.read) return null;
    const links = rawLinks.map(s => publicSourceUrl(s.replace(/[.,!?;]+$/, '').replace(/\)$/, m => s.includes('(') ? m : '')));
    if (links.some(url => !url)) return null;
    return { type: 'links', urls: [...new Set(links)].slice(0, 3) };
  }
  // Only the current public question can become a search. Conversation history,
  // local project files and attachments are never included in the query.
  if (!config.search || !config.read || privateTask.test(text) || !(factual.test(text) || lookup.test(text))) return null;
  const stripped = text.replace(/^(?:please\s+)?(?:what (?:is|are)|who (?:was|is)|tell me about|search (?:for )?|explain)\s+/i, '')
    .replace(/(?:के बारे में (?:बताओ|बताइए)|क्या (?:है|हैं)|कौन (?:था|थी|थे|है|हैं))[?।\s]*$/u, '')
    .replace(/[?।.]+$/, '').trim();
  return { type: 'topic', query: (stripped || text).trim().slice(0, 300) };
}

async function json(url, signal) {
  const resp = await fetch(url, { signal, credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error' });
  if (!resp.ok) throw new Error('स्रोत उपलब्ध नहीं है।');
  return resp.json();
}

async function wikipedia(query, signal, direct = null) {
  const lang = direct ? direct.hostname.split('.')[0] : /[\u0900-\u097f]/.test(query) ? 'hi' : 'en';
  const base = `https://${lang}.wikipedia.org`;
  const params = new URLSearchParams({ origin: '*', format: 'json', action: 'query', prop: 'extracts',
    exintro: '1', explaintext: '1', exchars: '1300', exlimit: '3', redirects: '1' });
  if (direct) params.set('titles', decodeURIComponent(direct.pathname.slice(6)).replace(/_/g, ' '));
  else { params.set('generator', 'search'); params.set('gsrsearch', query); params.set('gsrlimit', '3'); }
  const data = await json(base + '/w/api.php?' + params, signal);
  return Object.values(data?.query?.pages || {}).sort((a,b) => (a.index || 0) - (b.index || 0))
    .filter(p => typeof p.extract === 'string' && p.extract.trim() && p.title && p.missing === undefined)
    .map(p => ({ title: p.title, text: p.extract.trim(), url: base + '/wiki/' + encodeURIComponent(p.title.replace(/ /g, '_')) }));
}

async function crossref(query, signal) {
  const params = new URLSearchParams({ 'query.bibliographic': query, rows: '2', filter: 'has-abstract:true', select: 'title,abstract,DOI' });
  const data = await json('https://api.crossref.org/works?' + params, signal);
  return (data.message?.items || []).filter(p => p.title?.[0] && p.abstract && /^10\./.test(p.DOI))
    .map(p => ({ title: p.title[0], text: p.abstract.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(),
      url: 'https://doi.org/' + encodeURI(p.DOI) }));
}

async function books(query, signal) {
  const params = new URLSearchParams({ q: query, fields: 'key,title,author_name,first_publish_year', limit: '2' });
  const data = await json('https://openlibrary.org/search.json?' + params, signal);
  return (data.docs || []).filter(b => b.title && /^\/works\/OL\d+W$/.test(b.key) && (b.author_name?.length || b.first_publish_year))
    .map(b => ({ title: b.title, text: [b.title, b.author_name?.join(', '), b.first_publish_year].filter(Boolean).join(' · '),
      url: 'https://openlibrary.org' + b.key }));
}

async function readLink(raw, settings, signal) {
  const url = new URL(raw);
  if (/^[a-z]{2,3}\.wikipedia\.org$/.test(url.hostname) && url.pathname.startsWith('/wiki/')) {
    const pages = await wikipedia('', signal, url);
    return pages[0];
  }
  const result = await runTool('read_webpage', { url: raw }, settings, signal);
  if (!result.ok || !result.text.trim()) return null;
  const title = result.text.match(/^Title:[ \t]*(.+)$/mi)?.[1] || url.hostname;
  const body = (result.text.split(/\nMarkdown Content:\s*\n/i)[1] || result.text).trim();
  if (body.length < 30 || /(?:Warning: Target URL returned error|captcha verification|Just a moment\.\.\.)/i.test(result.text.slice(0, 600))) return null;
  return { title, url: raw, text: body };
}

export async function research(plan, settings, parentSignal, progress = () => {}) {
  if (!plan) return [];
  parentSignal?.throwIfAborted();
  const controller = new AbortController();
  const abort = () => controller.abort(parentSignal.reason);
  parentSignal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => controller.abort(), 18000);
  const signal = controller.signal;
  const optional = async task => {
    try { return await task; } catch { parentSignal?.throwIfAborted(); return []; }
  };
  try {
    let sources = [];
    if (plan.type === 'links') {
      progress('दिए गए पन्ने पढ़े जा रहे हैं…');
      sources = await Promise.all(plan.urls.map(url => optional(readLink(url, settings, signal))));
    } else {
      progress('प्रकाशित स्रोत खोजे और पढ़े जा रहे हैं…');
      const config = toolSettings(settings);
      if (config.tavilyKey || config.jinaKey) {
        const result = await runTool('web_search', { query: plan.query }, settings, signal);
        if (result.ok) {
          const urls = (result.text.match(/^https?:\/\/\S+$/gm) || []).map(publicSourceUrl).filter(Boolean);
          sources = await Promise.all([...new Set(urls)].slice(0, 3).map(url => optional(readLink(url, settings, signal))));
        }
      }
      if (!sources.some(s => s?.text)) {
        const requests = [wikipedia(plan.query, signal)];
        if (/research|science|papers?|studies|study|शोध|विज्ञान|अध्ययन/i.test(plan.query)) requests.unshift(crossref(plan.query, signal));
        if (/books?|authors?|novels?|पुस्तक|किताब|लेखक/i.test(plan.query)) requests.unshift(books(plan.query, signal));
        sources = (await Promise.all(requests.map(optional))).flat();
      }
    }
    parentSignal?.throwIfAborted();
    const seen = new Set();
    return sources.filter(source => {
      if (!source?.text || !publicSourceUrl(source.url) || seen.has(source.url)) return false;
      seen.add(source.url);
      return true;
    }).slice(0, 3).map(s => ({ title: String(s.title).slice(0, 180), url: s.url, text: String(s.text).slice(0, 1400) }));
  } finally {
    clearTimeout(timer);
    parentSignal?.removeEventListener('abort', abort);
  }
}
