// Small, safe Markdown renderer for model replies. All text is HTML-escaped
// before any markup is added, and links are only created for http(s) URLs,
// so a reply can never inject script or HTML into the page.

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function inline(text) {
  const codes = [];
  let s = text.replace(/`([^`\n]+)`/g, (_, c) => {
    codes.push(c);
    return `\u0000${codes.length - 1}\u0000`;
  });
  s = escapeHtml(s);
  s = s.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g,
    (_, t, u) => `<a href="${u}" target="_blank" rel="noopener noreferrer">${t}</a>`);
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/__([^_\n]+)__/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*\w])\*([^*\n]+)\*(?![*\w])/g, '$1<em>$2</em>');
  s = s.replace(/~~([^~\n]+)~~/g, '<del>$1</del>');
  s = s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${escapeHtml(codes[Number(i)])}</code>`);
  return s;
}

function codeBlock(code, lang) {
  return `<div class="code"><div class="code-head"><span>${escapeHtml(lang || 'code')}</span>` +
    `<button type="button" class="copy-code">कॉपी</button></div><pre><code>${escapeHtml(code)}</code></pre></div>`;
}

const LIST_RE = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const TABLE_SEP_RE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

function splitRow(row) {
  return row.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());
}

export function renderMarkdown(src) {
  const lines = String(src).replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let para = [];
  const flush = () => {
    if (para.length) out.push(`<p>${para.map(inline).join('<br>')}</p>`);
    para = [];
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    const fence = line.match(/^\s*(`{3,}|~{3,})\s*([\w+#.-]*)\s*$/);
    if (fence) {
      flush();
      const marker = fence[1][0].repeat(3);
      const buf = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(marker)) buf.push(lines[i++]);
      i++;
      out.push(codeBlock(buf.join('\n'), fence[2]));
      continue;
    }

    if (!line.trim()) { flush(); i++; continue; }

    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      flush();
      const n = h[1].length;
      out.push(`<h${n}>${inline(h[2])}</h${n}>`);
      i++;
      continue;
    }

    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { flush(); out.push('<hr>'); i++; continue; }

    if (/^\s*>/.test(line)) {
      flush();
      const buf = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) buf.push(lines[i++].replace(/^\s*>\s?/, ''));
      out.push(`<blockquote>${renderMarkdown(buf.join('\n'))}</blockquote>`);
      continue;
    }

    if (line.includes('|') && i + 1 < lines.length && TABLE_SEP_RE.test(lines[i + 1])) {
      flush();
      const head = splitRow(line);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) rows.push(splitRow(lines[i++]));
      out.push('<div class="table-wrap"><table><thead><tr>' +
        head.map(c => `<th>${inline(c)}</th>`).join('') + '</tr></thead><tbody>' +
        rows.map(r => '<tr>' + r.map(c => `<td>${inline(c)}</td>`).join('') + '</tr>').join('') +
        '</tbody></table></div>');
      continue;
    }

    const li = line.match(LIST_RE);
    if (li) {
      flush();
      const ordered = /\d/.test(li[2]);
      const start = ordered ? parseInt(li[2], 10) : 1;
      const items = [];
      while (i < lines.length) {
        const m = lines[i].match(LIST_RE);
        if (m && /\d/.test(m[2]) === ordered) { items.push(m[3]); i++; }
        else if (items.length && /^\s{2,}\S/.test(lines[i])) { items[items.length - 1] += '\n' + lines[i].trim(); i++; }
        else break;
      }
      const tag = ordered ? 'ol' : 'ul';
      const startAttr = ordered && start !== 1 ? ` start="${start}"` : '';
      out.push(`<${tag}${startAttr}>` + items.map(t => `<li>${t.split('\n').map(inline).join('<br>')}</li>`).join('') + `</${tag}>`);
      continue;
    }

    para.push(line);
    i++;
  }
  flush();
  return out.join('');
}
