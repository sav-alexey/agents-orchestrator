// ---------------------------------------------------------------------------
// Minimal Markdown renderer for assistant messages.
//
// Scope is deliberately "what an agent actually emits": fenced and inline code,
// headings, bold/italic/strikethrough, links, bullet and numbered lists (nested),
// blockquotes, pipe tables, horizontal rules. No dependency, no build step.
//
// Safety: every piece of message text goes through escapeHtml() before any tag
// is produced, so a message can never inject markup into the chat. Only links
// with an http(s)/mailto scheme become <a>; anything else stays literal text.
//
// It also has to cope with *incomplete* input, since messages are rendered on
// every streaming delta — an unterminated code fence just runs to the end.
// ---------------------------------------------------------------------------

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => HTML_ESCAPES[c]);
}

const LIST_ITEM_RE = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const FENCE_RE = /^\s*(?:```|~~~)(\S*)\s*$/;
const FENCE_END_RE = /^\s*(?:```|~~~)\s*$/;
const HEADING_RE = /^(#{1,6})\s+(.*?)\s*#*$/;
const RULE_RE = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;
const TABLE_DIVIDER_RE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/;

// --- inline ----------------------------------------------------------------

// Code spans are pulled out first (placeholders) so their contents are never
// re-read as markup, then everything is escaped, then the rest is marked up.
function renderInline(text) {
  const codes = [];
  // NUL delimits the placeholders, so drop any that came in with the text.
  let s = String(text).replace(/\u0000/g, '').replace(/`([^`\n]+)`/g, (_, code) => {
    codes.push(code);
    return `\u0000${codes.length - 1}\u0000`;
  });

  s = escapeHtml(s);

  s = s.replace(/\[([^\]\n]*)\]\(([^)\s]+)\)/g, (whole, label, url) =>
    /^(https?:|mailto:)/i.test(url)
      ? `<a href="${url}" target="_blank" rel="noreferrer noopener">${label || url}</a>`
      : whole
  );
  s = s.replace(/(^|[\s(])((?:https?:\/\/)[^\s<)]+[^\s<).,;:!?])/g, '$1<a href="$2" target="_blank" rel="noreferrer noopener">$2</a>');

  // The `[^\s…]` edges are what keep "5 * 3 * 2" from turning into italics:
  // a marker only opens when followed by non-space and closes when preceded by one.
  s = s.replace(/\*\*(\S|\S[^\n]*?\S)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|\W)__(\S|\S[^\n]*?\S)__(?=\W|$)/g, '$1<strong>$2</strong>');
  s = s.replace(/(^|[^*\w])\*([^\s*]|[^\s*][^*\n]*?[^\s*])\*(?!\w)/g, '$1<em>$2</em>');
  s = s.replace(/(^|[^_\w])_([^\s_]|[^\s_][^_\n]*?[^\s_])_(?!\w)/g, '$1<em>$2</em>');
  s = s.replace(/~~(\S|\S[^\n]*?\S)~~/g, '<del>$1</del>');

  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${escapeHtml(codes[Number(i)])}</code>`);
}

// --- blocks ----------------------------------------------------------------

function isBlank(line) {
  return !line || !line.trim();
}

function startsBlock(line) {
  return (
    FENCE_RE.test(line) ||
    HEADING_RE.test(line) ||
    RULE_RE.test(line) ||
    LIST_ITEM_RE.test(line) ||
    /^\s*>/.test(line)
  );
}

// Drops `count` leading spaces (or fewer, if the line is shallower).
function dedent(line, count) {
  let i = 0;
  while (i < count && line[i] === ' ') i++;
  return line.slice(i);
}

function renderTable(header, rows) {
  const cells = (row) =>
    row
      .trim()
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split('|')
      .map((c) => renderInline(c.trim()));

  const head = cells(header).map((c) => `<th>${c}</th>`).join('');
  const body = rows
    .map((r) => `<tr>${cells(r).map((c) => `<td>${c}</td>`).join('')}</tr>`)
    .join('');
  return `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

// Turns one run of list lines into <ul>/<ol>. Items keep their own nested
// content (sub-lists, code blocks, extra paragraphs), which is rendered by
// recursing into renderBlocks().
function renderList(lines) {
  const items = [];
  let ordered = false;
  let baseIndent = null;
  let current = null;

  for (const line of lines) {
    const m = line.match(LIST_ITEM_RE);
    if (m && (baseIndent === null || m[1].length <= baseIndent)) {
      if (baseIndent === null) {
        baseIndent = m[1].length;
        ordered = /^\d/.test(m[2]);
      }
      current = [m[3]];
      items.push(current);
    } else if (current) {
      current.push(dedent(line, baseIndent + 2));
    }
  }

  const tag = ordered ? 'ol' : 'ul';
  const body = items.map((item) => `<li>${unwrapParagraph(renderBlocks(item))}</li>`).join('');
  return `<${tag}>${body}</${tag}>`;
}

// A list item's own text shouldn't become a block paragraph inside <li> — only
// whatever follows it (a nested list, a code block) stays a block.
function unwrapParagraph(html) {
  return html.replace(/^<p>([\s\S]*?)<\/p>/, '$1');
}

function renderBlocks(lines) {
  let html = '';
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (isBlank(line)) {
      i++;
      continue;
    }

    const fence = line.match(FENCE_RE);
    if (fence) {
      const lang = fence[1];
      const body = [];
      i++;
      while (i < lines.length && !FENCE_END_RE.test(lines[i])) body.push(lines[i++]);
      i++; // closing fence — absent while the block is still streaming in
      const cls = lang ? ` class="lang-${escapeHtml(lang)}"` : '';
      html += `<pre><code${cls}>${escapeHtml(body.join('\n'))}</code></pre>`;
      continue;
    }

    const heading = line.match(HEADING_RE);
    if (heading) {
      const level = heading[1].length;
      html += `<h${level}>${renderInline(heading[2])}</h${level}>`;
      i++;
      continue;
    }

    if (RULE_RE.test(line)) {
      html += '<hr />';
      i++;
      continue;
    }

    if (/^\s*>/.test(line)) {
      const quoted = [];
      while (i < lines.length && (/^\s*>/.test(lines[i]) || (!isBlank(lines[i]) && quoted.length))) {
        quoted.push(lines[i].replace(/^\s*>\s?/, ''));
        i++;
      }
      html += `<blockquote>${renderBlocks(quoted)}</blockquote>`;
      continue;
    }

    // Table: a header row plus a |---|---| divider underneath.
    if (line.includes('|') && i + 1 < lines.length && TABLE_DIVIDER_RE.test(lines[i + 1])) {
      const header = line;
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes('|') && !isBlank(lines[i])) rows.push(lines[i++]);
      html += renderTable(header, rows);
      continue;
    }

    const listStart = line.match(LIST_ITEM_RE);
    if (listStart) {
      const baseIndent = listStart[1].length;
      const ordered = /^\d/.test(listStart[2]);
      const block = [];

      while (i < lines.length) {
        const l = lines[i];
        if (isBlank(l)) {
          const next = lines[i + 1];
          // A blank line only stays inside the list if the list continues after it.
          if (next && (LIST_ITEM_RE.test(next) || /^\s{2,}\S/.test(next))) {
            block.push('');
            i++;
            continue;
          }
          break;
        }
        const m = l.match(LIST_ITEM_RE);
        // A bullet list right after a numbered one (or vice versa) is a new list.
        if (m && block.length && m[1].length <= baseIndent && /^\d/.test(m[2]) !== ordered) break;
        if (!m && !/^\s{2,}\S/.test(l) && block.length) break;
        block.push(l);
        i++;
      }

      html += renderList(block);
      continue;
    }

    // Paragraph: run of plain lines. Single newlines are kept as <br> — in a
    // chat the author meant them, unlike in a document.
    const para = [];
    while (i < lines.length && !isBlank(lines[i]) && !(para.length && startsBlock(lines[i]))) {
      para.push(lines[i]);
      i++;
    }
    html += `<p>${para.map(renderInline).join('<br />')}</p>`;
  }

  return html;
}

function renderMarkdown(text) {
  return renderBlocks(String(text ?? '').replace(/\r\n?/g, '\n').split('\n'));
}

if (typeof module !== 'undefined') module.exports = { renderMarkdown };
