// Fast CommonMark 0.31.2 + GFM 0.29 renderer, byte-compatible with marked 18.1.3
// (default options). Written from scratch as a single-pass block + inline
// parser; no dependencies, no regexes on hot paths, minimal allocations.
//
// Layout of the implementation:
//   * helpers: escaping / entity handling / URL cleaning
//   * inline parser: phase 1 scans the source into a flat doubly-linked list
//     of nodes (text, code, html, breaks, delimiters, links); links are
//     resolved as their closing bracket is seen. Phase 2 runs the delimiter
//     stack algorithm (emphasis, strong, strikethrough) over that list.
//   * block parser: line-based recursive descent over an array of lines.
//     Containers (blockquote / list item) strip their markers and recurse.
//   * parse(src): normalize line endings, split into lines, parse blocks.

const AMP = 38, LT = 60, GT = 62, QUOT = 34, APOS = 39, BACKSLASH = 92;
// Placeholder for a backslash-escaped '&' in inline text: it must render
// as &amp; (not start an entity reference) in HTML, but as a plain '&' in
// plain-text renderings (alt text, link labels).
const ESC_AMP = '';
const STAR = 42, UNDER = 95, TILDE = 126, TICK = 96, LSQ = 91, RSQ = 93;
const SPACE = 32, TAB = 9, NL = 10;

function isSpaceCode(c) { return c === SPACE || c === TAB; }
function isDigitCode(c) { return c >= 48 && c <= 57; }
function isAlphaNumCode(c) {
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
}
// ASCII punctuation per CommonMark: ! " # $ % & ' ( ) * + , - . / : ; < = > ? @ [ \ ] ^ _ ` { | } ~
function isAsciiPunctCode(c) {
  return (c >= 33 && c <= 47) || (c >= 58 && c <= 64) ||
    (c >= 91 && c <= 96) || (c >= 123 && c <= 126);
}
function isUnicodeSpace(c) {
  return c === 32 || c === 9 || c === 10 || c === 11 || c === 12 || c === 13 ||
    c === 0x85 || c === 0xa0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) ||
    c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000;
}

// Decode one numeric character reference body (after "&#" or "&#x").
// Returns the code point, or -1 when it must stay literal (out of range or
// empty). 0 maps to U+FFFD, surrogates map to U+FFFD (marked behaviour).
function numericRefValue(body, hex) {
  if (!body.length) return -1;
  let v = 0;
  for (let i = 0; i < body.length; i++) {
    const c = body.charCodeAt(i);
    let d;
    if (hex) {
      if (c >= 48 && c <= 57) d = c - 48;
      else if (c >= 97 && c <= 102) d = c - 87;
      else if (c >= 65 && c <= 70) d = c - 55;
      else return -1;
    } else {
      if (c < 48 || c > 57) return -1;
      d = c - 48;
    }
    v = v * (hex ? 16 : 10) + d;
    if (v > 0x10ffff) return -1;
  }
  if (v === 0) return 0xfffd;
  if (v >= 0xd800 && v <= 0xdfff) return 0xfffd;
  return v;
}

// Escape text the way marked renders ordinary text: & < > " ' are escaped,
// except that a well-formed entity reference (&name; or a valid numeric
// reference) is left verbatim. Valid numeric references are decoded to the
// character first when `decodeNumeric` is true (text nodes); in hrefs and
// titles marked leaves them verbatim, so callers pass false there.
function escSmart(s, decodeNumeric) {
  if (s.indexOf('&') < 0 && s.indexOf('<') < 0 && s.indexOf('>') < 0 &&
      s.indexOf('"') < 0 && s.indexOf("'") < 0 && s.indexOf(ESC_AMP) < 0) return s;
  let out = '';
  let i = 0, n = s.length, start = 0;
  while (i < n) {
    const c = s.charCodeAt(i);
    if (c === 0xE000) { // escaped '&' placeholder
      out += s.slice(start, i) + '&amp;';
      i++; start = i; continue;
    }
    if (c === AMP) {
      // Try to read &name; / &#123; / &#x1f; up to the ';'.
      let j = i + 1, ok = false, hex = false, isNum = false;
      if (j < n && s.charCodeAt(j) === 35) { // '#'
        isNum = true; j++;
        if (j < n && (s.charCodeAt(j) === 120 || s.charCodeAt(j) === 88)) { hex = true; j++; }
      }
      const nameStart = j;
      if (isNum) {
        while (j < n) {
          const d = s.charCodeAt(j);
          if ((hex && ((d >= 48 && d <= 57) || (d >= 97 && d <= 102) || (d >= 65 && d <= 70))) ||
              (!hex && d >= 48 && d <= 57)) j++;
          else break;
        }
        if (j > nameStart && j < n && s.charCodeAt(j) === 59) {
          const v = numericRefValue(s.slice(nameStart, j), hex);
          if (v >= 0) {
            ok = true;
            out += s.slice(start, i);
            if (decodeNumeric) {
              const ch = String.fromCodePoint(v);
              out += ch === '"' ? '&quot;' : ch === "'" ? '&#39;' : ch === '<' ? '&lt;' :
                     ch === '>' ? '&gt;' : ch === '&' ? '&amp;' : ch;
            } else {
              out += s.slice(i, j + 1);
            }
            i = j + 1; start = i; continue;
          }
        }
      } else {
        while (j < n) {
          const d = s.charCodeAt(j);
          if ((d >= 48 && d <= 57) || (d >= 65 && d <= 90) || (d >= 97 && d <= 122)) j++;
          else break;
        }
        if (j > nameStart && j < n && s.charCodeAt(j) === 59) {
          ok = true;
          out += s.slice(start, j + 1);
          i = j + 1; start = i; continue;
        }
      }
      if (!ok) {
        out += s.slice(start, i) + '&amp;';
        i++; start = i; continue;
      }
    } else if (c === LT) { out += s.slice(start, i) + '&lt;'; i++; start = i; continue; }
    else if (c === GT) { out += s.slice(start, i) + '&gt;'; i++; start = i; continue; }
    else if (c === QUOT) { out += s.slice(start, i) + '&quot;'; i++; start = i; continue; }
    else if (c === APOS) { out += s.slice(start, i) + '&#39;'; i++; start = i; continue; }
    i++;
  }
  return start === 0 ? s : out + s.slice(start);
}

// Escape code content: every & < > " ' is escaped, entities included.
function escAll(s) {
  if (s.indexOf('&') < 0 && s.indexOf('<') < 0 && s.indexOf('>') < 0 &&
      s.indexOf('"') < 0 && s.indexOf("'") < 0) return s;
  let out = '', i = 0, n = s.length, start = 0;
  while (i < n) {
    const c = s.charCodeAt(i);
    let rep = null;
    if (c === AMP) rep = '&amp;';
    else if (c === LT) rep = '&lt;';
    else if (c === GT) rep = '&gt;';
    else if (c === QUOT) rep = '&quot;';
    else if (c === APOS) rep = '&#39;';
    if (rep !== null) { out += s.slice(start, i) + rep; i++; start = i; continue; }
    i++;
  }
  return out + s.slice(start);
}

// marked's cleanUrl: encodeURI, with %25 folded back to % (so a literal %
// or an already-encoded %20 survives unchanged).
function cleanUrl(href) {
  try { return encodeURI(href).replace(/%25/g, '%'); } catch { return href; }
}

// Normalise a link label for reference lookup: collapse whitespace runs to
// one space, trim, lowercase.
function normalizeLabel(s) {
  // Link labels match case-insensitively (Unicode case folding) with
  // whitespace runs collapsed. Backslash escapes are NOT resolved for
  // matching: `foo\!` and `foo!` are different labels. Case folding maps
  // ß/ẞ to "ss" (ẞ lowercases to ß first).
  let out = '', lastSpace = true;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 32 || c === 9 || c === 10 || c === 13) {
      if (!lastSpace) { out += ' '; lastSpace = true; }
    } else { out += s[i].toLowerCase(); lastSpace = false; }
  }
  if (lastSpace && out.length) out = out.slice(0, -1);
  return out.indexOf('ß') >= 0 ? out.split('ß').join('ss') : out;
}

// ---------------------------------------------------------------------------
// Inline parsing
// ---------------------------------------------------------------------------
// Nodes form a flat doubly-linked list while parsing. Kinds:
//   text  {s}            raw source text (entities resolved at render time)
//   code  {s}            code span content (already space-stripped)
//   html  {s}            raw inline HTML, verbatim
//   br                   hard break -> <br />
//   soft                 soft break -> \n
//   delim {ch, len, canOpen, canClose, active}   emphasis / strikethrough run
//   link  {href, title, img, children}  children: array of nodes (extracted)
//   em / strong / del {children}
// Delimiters are also kept in a document-order array `delims` for phase 2.
// Bracket openers live on `brackets` (a stack) while scanning.

const EMAIL_LOCAL = "!#$%&'*+/=?^_`{|}~-";
function isEmailLocalChar(c) {
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) ||
    c === 46 || EMAIL_LOCAL.indexOf(String.fromCharCode(c)) >= 0;
}
function isEmailDomainChar(c) {
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 45 || c === 95;
}

// Word / punctuation classification for flanking (CommonMark):
// whitespace = Unicode whitespace; punctuation = ASCII punctuation or any
// Unicode punctuation/general category P or S.
const UNICODE_PUNCT_RE = /[\p{P}\p{S}]/u;
function isPunctCode(c) {
  if (c < 128) return isAsciiPunctCode(c);
  return UNICODE_PUNCT_RE.test(String.fromCharCode(c));
}

function nodeTextPlain(nodes) {
  // Plain-text rendering of inline nodes (used for image alt text).
  let out = '';
  for (const nd of nodes) {
    if (nd.kind === 'text') out += nd.s;
    else if (nd.kind === 'code') out += nd.s;
    else if (nd.kind === 'html') out += nd.s;
    else if (nd.kind === 'br' || nd.kind === 'soft') out += '\n';
    else if (nd.kind === 'delim') out += nd.ch.repeat(nd.len);
    else if (nd.kind === 'link') out += nodeTextPlain(nd.children);
    else if (nd.kind === 'em' || nd.kind === 'strong' || nd.kind === 'del') out += nodeTextPlain(nd.children);
  }
  return out.indexOf(ESC_AMP) >= 0 ? out.split(ESC_AMP).join('&') : out;
}

// Does a node list contain a "real" link (explicit `[...](...)` /
// `[...][...]`)? Extended autolinks (`ext`) and `<...>` autolinks (`auto`)
// do not count — an extended autolink inside link text is suppressed to
// plain text, and a `<...>` autolink is allowed as a nested link. Images
// do not count either.
function hasRealLink(nodes) {
  for (const nd of nodes) {
    if (nd.kind === 'link' && !nd.img && !nd.ext && !nd.auto) return true;
    if (nd.children && hasRealLink(nd.children)) return true;
  }
  return false;
}

// Convert extended autolinks in a node list (recursively) back to plain
// text nodes, so they render as literal URL text inside a link.
function unwrapExtAutolinks(nodes) {
  for (const nd of nodes) {
    if (nd.kind === 'link' && nd.ext) {
      nd.kind = 'text';
      nd.s = nd.children && nd.children.length ? nd.children[0].s : '';
      nd.children = null;
    } else if (nd.children) unwrapExtAutolinks(nd.children);
  }
}

// Scan a link label starting at src[i] === '['. Returns {label, end} where
// end is the index just past the matching ']' (label is the raw inner text),
// or null. This is marked's `le` pattern (used for reference definitions
// and for the second bracket of a full reference link): no nested brackets,
// escaped chars allowed, and a newline is allowed only if it is not followed
// by a blank line.
function scanLabel(src, i) {
  const n = src.length;
  let j = i + 1;
  while (j < n) {
    const c = src.charCodeAt(j);
    if (c === BACKSLASH) { j += 2; continue; }
    if (c === LSQ) return null; // nested '[' not allowed in `le`
    if (c === RSQ) return { label: src.slice(i + 1, j), end: j + 1 };
    if (c === NL) {
      // newline allowed only if not followed by a blank line
      let m = j + 1;
      while (m < n && (src.charCodeAt(m) === SPACE || src.charCodeAt(m) === TAB)) m++;
      if (m >= n || src.charCodeAt(m) === NL) return null;
      j++;
      continue;
    }
    j++;
  }
  return null;
}

// Does src[start..end] match marked's `re` label pattern (the label of an
// inline link / full reference)? A label is a sequence of: bracket groups
// (which may contain at most one level of nested brackets), escaped chars,
// code spans, and single chars that are not '[', ']', '\' or '`'.
function labelValid(src, start, end) {
  let i = start, depth = 0;
  while (i < end) {
    const c = src.charCodeAt(i);
    if (c === BACKSLASH) { i += 2; continue; }
    if (c === TICK) {
      // code span: find the next backtick run after this one
      let j = i;
      while (j < end && src.charCodeAt(j) === TICK) j++;
      const run = j - i;
      let k = j, close = -1;
      while (k < end) {
        if (src.charCodeAt(k) === TICK) {
          let m = k;
          while (m < end && src.charCodeAt(m) === TICK) m++;
          close = k; k = m; break;
        }
        k++;
      }
      if (close >= 0) { i = close; while (i < end && src.charCodeAt(i) === TICK) i++; continue; }
      // no closing run: a run of 2+ backticks at the very end of the label
      // is allowed by the `` ``+(?=\]) `` alternative
      if (run >= 2 && j === end) return depth === 0;
      return false;
    }
    if (c === LSQ) {
      depth++;
      if (depth > 2) return false;
      i++; continue;
    }
    if (c === RSQ) {
      depth--;
      if (depth < 0) return false;
      i++; continue;
    }
    i++;
  }
  return depth === 0;
}

// Parse a link destination starting at src[i] (after optional spaces).
// Returns {dest, end} or null. Handles <...> and bare destinations.
function parseDest(src, i) {
  const n = src.length;
  if (i >= n) return null;
  if (src.charCodeAt(i) === LT) {
    let j = i + 1, out = '';
    while (j < n) {
      const c = src.charCodeAt(j);
      if (c === GT) return { dest: out, end: j + 1 };
      if (c === NL || c === LT) return null;
      if (c === BACKSLASH && j + 1 < n && isAsciiPunctCode(src.charCodeAt(j + 1))) {
        out += src[j + 1]; j += 2; continue;
      }
      out += src[j]; j++;
    }
    return null;
  }
  // Bare destination: no spaces/control chars; parens must balance.
  let j = i, out = '', depth = 0;
  while (j < n) {
    const c = src.charCodeAt(j);
    if (c === SPACE || c === TAB || c === NL || c < 32) break;
    if (c === BACKSLASH && j + 1 < n && isAsciiPunctCode(src.charCodeAt(j + 1))) {
      out += src[j + 1]; j += 2; continue;
    }
    if (c === 40) { // '('
      depth++;
      out += src[j]; j++; continue;
    }
    if (c === 41) { // ')'
      if (depth === 0) break;
      depth--;
      out += src[j]; j++; continue;
    }
    out += src[j]; j++;
  }
  if (depth !== 0) return null;
  return { dest: out, end: j };
}

// Parse a link title starting at src[i] (after optional spaces/newlines).
// Returns {title, end} or null. Titles are "..." / '...' / (...).
// Marked's title patterns differ per quote: "..." and (...) may span any
// newlines; '...' may span a newline only if it is not followed by a
// newline (i.e. it cannot span a blank line).
function parseTitle(src, i) {
  const n = src.length;
  if (i >= n) return null;
  const q = src.charCodeAt(i);
  let close, allowParen = false, single = false;
  if (q === QUOT || q === APOS) { close = q; single = q === APOS; }
  else if (q === 40) { close = 41; allowParen = true; }
  else return null;
  let j = i + 1, out = '';
  while (j < n) {
    const c = src.charCodeAt(j);
    if (c === close) return { title: out, end: j + 1 };
    if (c === BACKSLASH && j + 1 < n && isAsciiPunctCode(src.charCodeAt(j + 1))) {
      out += src[j + 1]; j += 2; continue;
    }
    if (allowParen && c === 40) return null; // unescaped '(' not allowed in (...)
    if (single && c === NL && j + 1 < n && src.charCodeAt(j + 1) === NL) return null;
    out += src[j]; j++;
  }
  return null;
}

// Skip spaces/tabs/newlines starting at i; returns new index.
function skipInlineWs(src, i) {
  const n = src.length;
  while (i < n) {
    const c = src.charCodeAt(i);
    if (c === SPACE || c === TAB || c === NL) i++;
    else break;
  }
  return i;
}

// Try to parse the tail of an inline link after ']' at position i (the char
// after ']'). Returns {href, title, end} or null. Handles (dest "title").
function parseInlineLinkTail(src, i) {
  const n = src.length;
  if (i >= n || src.charCodeAt(i) !== 40) return null; // must be '('
  let j = skipInlineWs(src, i + 1);
  if (j < n && src.charCodeAt(j) === 41) return { href: '', title: null, end: j + 1 };
  const d = parseDest(src, j);
  if (!d) return null;
  j = d.end;
  // After the destination: spaces/newlines, then optional title, then ')'.
  // A title requires at least one space/tab/newline after the destination.
  const afterDest = skipInlineWs(src, j);
  if (afterDest < n && src.charCodeAt(afterDest) === 41) {
    return { href: d.dest, title: null, end: afterDest + 1 };
  }
  if (afterDest === j) return null;
  const t = parseTitle(src, afterDest);
  if (!t) return null;
  const afterTitle = skipInlineWs(src, t.end);
  if (afterTitle < n && src.charCodeAt(afterTitle) === 41) {
    return { href: d.dest, title: t.title, end: afterTitle + 1 };
  }
  return null;
}

// Try to match an autolink <...> starting at src[i] === '<'.
// Returns {href, text, end} or null.
function scanAutolink(src, i) {
  const n = src.length;
  // Scheme: [a-zA-Z][a-zA-Z0-9+.-]{1,31} : [^\s\x00-\x1f<>]*
  let j = i + 1;
  if (j >= n || !((src.charCodeAt(j) >= 65 && src.charCodeAt(j) <= 90) ||
      (src.charCodeAt(j) >= 97 && src.charCodeAt(j) <= 122))) return null;
  let k = j + 1;
  while (k < n) {
    const c = src.charCodeAt(k);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) ||
        c === 43 || c === 45 || c === 46) k++;
    else break;
  }
  if (k - j >= 2 && k - j <= 32 && k < n && src.charCodeAt(k) === 58) {
    // scheme found; body until '>' with no space/control/'<'
    let m = k + 1;
    while (m < n) {
      const c = src.charCodeAt(m);
      if (c === GT) {
        const text = src.slice(i + 1, m);
        return { href: text, text, end: m + 1 };
      }
      if (c <= 32 || c === LT) return null;
      m++;
    }
    return null;
  }
  // Email: local@domain(.domain)+
  const em = scanEmail(src, i + 1, true);
  if (em && em.end < n && src.charCodeAt(em.end) === GT) {
    const text = src.slice(i + 1, em.end);
    return { href: 'mailto:' + text, text, end: em.end + 1 };
  }
  return null;
}

// Scan an email address starting at src[i]. Returns {end} (index just past
// the address) or null. When `bracketed` is true the address is inside <...>
// and the domain rules are the autolink ones; otherwise the extended
// autolink rules apply (same shape, but the caller trims trailing chars).
function scanEmail(src, i, bracketed, delims) {
  const n = src.length;
  let j = i;
  while (j < n && isEmailLocalChar(src.charCodeAt(j))) j++;
  if (j === i || j >= n || src.charCodeAt(j) !== 64) return null; // '@'
  const at = j;
  j++;
  // Domain: label(.label)+ ; each label starts alnum, may contain - (and _
  // for the extended form), ends alnum; TLD-ish last label ends alnum.
  let labels = 0, lastEnd = -1;
  while (true) {
    const ls = j;
    if (j >= n || !isAlphaNumCode(src.charCodeAt(j))) return null;
    j++;
    // Label chars: alnum, or -/_ only when followed by alnum (so a
    // trailing -/_ run is NOT consumed — e.g. the `__` emphasis closer
    // after `b@c.d` stays out of the email).
    while (j < n) {
      const c = src.charCodeAt(j);
      if (isAlphaNumCode(c)) { j++; continue; }
      if ((c === 45 || c === 95) && j + 1 < n && isAlphaNumCode(src.charCodeAt(j + 1))) { j++; continue; }
      break;
    }
    labels++;
    lastEnd = j;
    if (j < n && src.charCodeAt(j) === 46) { // '.'
      // a dot must be followed by a label start
      if (j + 1 < n && isAlphaNumCode(src.charCodeAt(j + 1))) { j++; continue; }
      break;
    }
    break;
  }
  if (labels < 2) return null;
  // Trailing -/_ after the domain: for the bracketed form it kills the
  // autolink; for a bare email it also kills it — EXCEPT when the trailing
  // run is `_`s that close an emphasis opened earlier (e.g. `__a b@c.d__`,
  // where the `__` is the strong closer). A `-` always kills it.
  if (lastEnd < n) {
    const c = src.charCodeAt(lastEnd);
    if (c === 45) return null;
    if (c === 95) {
      if (bracketed) return null;
      // Is there an active `_` opener earlier that this run could close?
      let hasOpener = false;
      if (delims) for (const d of delims) {
        if (d.active && d.ch === '_' && d.canOpen) { hasOpener = true; break; }
      }
      if (!hasOpener) return null;
    }
  }
  return { end: lastEnd, at };
}

// ASCII case-insensitive prefix match (scheme autolinks are case-insensitive).
function startsWithCI(src, i, pat) {
  for (let k = 0; k < pat.length; k++) {
    let c = src.charCodeAt(i + k);
    if (c >= 65 && c <= 90) c += 32;
    if (c !== pat.charCodeAt(k)) return false;
  }
  return true;
}

// Scan a bare URL for the extended autolink (www. / scheme://) starting at i.
// The caller has already established the start. Returns {text, end} with
// trailing punctuation backpedalled, or null. `brackets` is the open
// bracket stack (for the link-tail truncation check).
function scanBareUrl(src, i, brackets) {
  const n = src.length;
  let j = i;
  while (j < n) {
    const c = src.charCodeAt(j);
    if (c === SPACE || c === TAB || c === NL || c === LT) break;
    j++;
  }
  let end = j;
  // Inside link text, a `](` or `][` ends the URL — but only when the `]`
  // closes a label whose link WILL form. If the label contains a nested
  // link, the outer link is rejected (linkEmitted) and the URL consumes
  // the `](...)` as ordinary text (doc-12). Without brackets the `]` is
  // part of the URL (e.g. `[foo www.example.com]` autolinks the `]` too).
  if (brackets && brackets.length > 0) {
    const br = brackets[brackets.length - 1];
    const ls = br.pos + (br.img ? 2 : 1);
    for (let k = i; k + 1 < end; k++) {
      if (src.charCodeAt(k) === 93 && (src.charCodeAt(k + 1) === 40 || src.charCodeAt(k + 1) === 91)) {
        // Does the label up to this `]` contain a nested inline link?
        // (a `[` ... `](` inside the label rejects the outer link)
        let nested = false;
        for (let m = ls; m < k; m++) {
          if (src.charCodeAt(m) === 91) {
            let d = m + 1;
            while (d < k && src.charCodeAt(d) !== 93) d++;
            if (d < k && src.charCodeAt(d + 1) === 40) { nested = true; break; }
            m = d;
          }
        }
        if (!nested && labelValid(src, ls, k)) { end = k; break; }
      }
    }
  }
  // Backpedal: trim trailing punctuation, unbalanced ')'.
  const TRIM = '?!.,:;*_~\'"';
  let open = 0, close = 0;
  for (let k = i; k < end; k++) {
    if (src.charCodeAt(k) === 40) open++;
    else if (src.charCodeAt(k) === 41) close++;
  }
  while (end > i) {
    const c = src.charCodeAt(end - 1);
    if (TRIM.indexOf(src[end - 1]) >= 0) { end--; continue; }
    if (c === 41 && close > open) { end--; close--; continue; }
    if (c === 93) { end--; continue; } // trailing ']'
    break;
  }
  // A trailing ';' that was trimmed may belong to an entity-like '&xxx;':
  // trim the '&xxx' as well (e.g. ...&hl; is not part of the link).
  if (end < j && end > i && src.charCodeAt(end) === 59) {
    let k = end - 1;
    while (k >= i && isAlphaNumCode(src.charCodeAt(k))) k--;
    if (k >= i && src.charCodeAt(k) === 38) end = k;
  }
  if (end === i) return null;
  // A URL must contain a '.' after the scheme/www prefix (domain with dot),
  // except for the scheme form which needs :// plus something.
  return { text: src.slice(i, end), end };
}

// ---------------------------------------------------------------------------
// Inline phase 1: scan source into a flat node list; resolve links on ']'
// ---------------------------------------------------------------------------

function mkNode(kind) { return { kind, prev: null, next: null }; }

// Compute flanking for a delimiter run at src[i..i+len) with the preceding
// char `prevC` (-1 for start) and following char `nextC` (-1 for end).
function flanking(prevC, nextC) {
  const prevWs = prevC < 0 || isUnicodeSpace(prevC);
  const nextWs = nextC < 0 || isUnicodeSpace(nextC);
  const prevPunct = prevC >= 0 && isPunctCode(prevC);
  const nextPunct = nextC >= 0 && isPunctCode(nextC);
  const left = !nextWs && (!nextPunct || prevWs || prevPunct);
  const right = !prevWs && (!prevPunct || nextWs || nextPunct);
  return { left, right };
}

function scanHtmlTag(src, i) {
  const n = src.length;
  if (src.charCodeAt(i) !== LT || i + 1 >= n) return null;
  const c1 = src.charCodeAt(i + 1);
  // Comment
  if (c1 === 33) { // '!'
    if (src.startsWith('-->', i + 2)) return { end: i + 5 };
    if (src.startsWith('--->', i + 2)) return { end: i + 6 };
    if (src.startsWith('<!--', i)) {
      // A comment runs to the first '-->' (a '--' inside is allowed).
      const k = src.indexOf('-->', i + 4);
      return k < 0 ? null : { end: k + 3 };
    }
    if (src.startsWith('<![CDATA[', i)) {
      const k = src.indexOf(']]>', i + 9);
      return k < 0 ? null : { end: k + 3 };
    }
    // Declaration <!A ...> : '!' followed by a letter
    if ((c1 === 33) && i + 2 < n) {
      const c2 = src.charCodeAt(i + 2);
      if ((c2 >= 65 && c2 <= 90) || (c2 >= 97 && c2 <= 122)) {
        const k = src.indexOf('>', i + 2);
        return k < 0 ? null : { end: k + 1 };
      }
    }
    return null;
  }
  // Processing instruction <? ... ?>
  if (c1 === 63) {
    const k = src.indexOf('?>', i + 2);
    return k < 0 ? null : { end: k + 2 };
  }
  // Closing tag </name ...>
  let j = i + 1, closing = false;
  if (c1 === 47) { closing = true; j = i + 2; }
  if (j >= n) return null;
  const nc = src.charCodeAt(j);
  if (!((nc >= 65 && nc <= 90) || (nc >= 97 && nc <= 122))) return null;
  j++;
  while (j < n) {
    const c = src.charCodeAt(j);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45) j++;
    else break;
  }
  if (closing) {
    while (j < n && isSpaceCode(src.charCodeAt(j))) j++;
    return (j < n && src.charCodeAt(j) === GT) ? { end: j + 1 } : null;
  }
  // Open tag: each attribute must be preceded by whitespace; a name or
  // value directly abutting the tag name or a previous value is not a tag.
  // `sawWs` carries over the separator skipped after an attribute name.
  let sawWs = false;
  while (j < n) {
    while (j < n && (isSpaceCode(src.charCodeAt(j)) || src.charCodeAt(j) === NL)) { j++; sawWs = true; }
    if (j >= n) return null;
    const c = src.charCodeAt(j);
    if (c === GT) return { end: j + 1 };
    if (c === 47) { // '/'
      if (j + 1 < n && src.charCodeAt(j + 1) === GT) return { end: j + 2 };
      return null;
    }
    if (!sawWs) return null;
    sawWs = false;
    // attribute name
    if (!((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 58)) return null;
    j++;
    while (j < n) {
      const d = src.charCodeAt(j);
      if ((d >= 65 && d <= 90) || (d >= 97 && d <= 122) || (d >= 48 && d <= 57) ||
          d === 95 || d === 58 || d === 46 || d === 45) j++;
      else break;
    }
    while (j < n && (isSpaceCode(src.charCodeAt(j)) || src.charCodeAt(j) === NL)) { j++; sawWs = true; }
    if (j < n && src.charCodeAt(j) === 61) { // '='
      j++;
      while (j < n && (isSpaceCode(src.charCodeAt(j)) || src.charCodeAt(j) === NL)) j++;
      if (j >= n) return null;
      const q = src.charCodeAt(j);
      if (q === QUOT || q === APOS) {
        j++;
        while (j < n && src.charCodeAt(j) !== q) j++;
        if (j >= n) return null;
        j++;
      } else {
        // unquoted value: no space, ", ', =, <, >, `
        let any = false;
        while (j < n) {
          const d = src.charCodeAt(j);
          if (isSpaceCode(d) || d === NL || d === QUOT || d === APOS || d === 61 ||
              d === LT || d === GT || d === TICK) break;
          any = true; j++;
        }
        if (!any) return null;
      }
      sawWs = false;
    }
  }
  return null;
}

// The inline scanner. Returns {head, delims}: the node list head and the
// document-order delimiter array.
function scanInline(src, refs) {
  const n = src.length;
  let head = null, tail = null;
  const delims = [];
  const brackets = []; // {node, img}
  let buf = ''; // pending plain text

  function pushNode(nd) {
    if (tail) { tail.next = nd; nd.prev = tail; tail = nd; }
    else { head = tail = nd; }
  }
  function flushText() {
    if (buf.length) {
      const nd = mkNode('text'); nd.s = buf; buf = '';
      pushNode(nd);
    }
  }
  // Non-mutating version of extractAfter: the nodes after `openNode`.
  function nodesAfter(openNode) {
    const kids = [];
    let cur = openNode.next;
    while (cur) { kids.push(cur); cur = cur.next; }
    return kids;
  }
  // Extract the nodes after `openNode` up to the current tail into an array,
  // unlinking them from the flat list. Returns the array.
  function extractAfter(openNode) {
    const kids = [];
    let cur = openNode.next;
    while (cur) {
      const nx = cur.next;
      cur.prev = null; cur.next = null;
      kids.push(cur);
      cur = nx;
    }
    openNode.next = null;
    tail = openNode;
    return kids;
  }
  function removeNode(nd) {
    if (nd.prev) nd.prev.next = nd.next; else head = nd.next;
    if (nd.next) nd.next.prev = nd.prev; else tail = nd.prev;
    nd.prev = null; nd.next = null;
  }

  let i = 0;
  while (i < n) {
    const c = src.charCodeAt(i);
    // --- backslash escape / hard break via backslash ---
    if (c === BACKSLASH) {
      if (i + 1 < n) {
        const d = src.charCodeAt(i + 1);
        if (d === NL) {
          flushText(); const nd = mkNode('br'); pushNode(nd); i += 2;
          // After a hard break, leading spaces/tabs on the next line are stripped.
          while (i < n && (src.charCodeAt(i) === SPACE || src.charCodeAt(i) === TAB)) i++;
          continue;
        }
        if (isAsciiPunctCode(d)) { buf += d === AMP ? ESC_AMP : src[i + 1]; i += 2; continue; }
      }
      buf += '\\'; i++; continue;
    }
    // --- code span ---
    if (c === TICK) {
      let j = i;
      while (j < n && src.charCodeAt(j) === TICK) j++;
      const run = j - i;
      // find a closing run of exactly `run` backticks
      let k = j, close = -1;
      while (k < n) {
        // A code span opened inside a link label cannot extend past the
        // `]` that closes a VALID label (a `]` followed by `(` or `[`).
        // If the label up to this `]` is valid, the link forms and the
        // span must not swallow its tail (doc-09). If the label is
        // invalid, the span may cross the `]` as content (cm-525).
        if (brackets.length > 0 && src.charCodeAt(k) === 93 &&
            (src.charCodeAt(k + 1) === 40 || src.charCodeAt(k + 1) === 91)) {
          const br = brackets[brackets.length - 1];
          const ls = br.pos + (br.img ? 2 : 1);
          if (labelValid(src, ls, k)) break;
        }
        if (src.charCodeAt(k) === TICK) {
          let m = k;
          while (m < n && src.charCodeAt(m) === TICK) m++;
          if (m - k === run) { close = k; break; }
          k = m;
        } else k++;
      }
      if (close >= 0) {
        let content = src.slice(j, close);
        content = content.replace(/\n/g, ' ');
        if (content.length >= 2 && content.charCodeAt(0) === SPACE &&
            content.charCodeAt(content.length - 1) === SPACE && content.trim().length > 0) {
          content = content.slice(1, -1);
        }
        flushText();
        const nd = mkNode('code'); nd.s = content; pushNode(nd);
        i = close + run; continue;
      }
      buf += src.slice(i, j); i = j; continue;
    }
    // --- emphasis / strikethrough delimiter runs ---
    if (c === STAR || c === UNDER || c === TILDE) {
      let j = i;
      while (j < n && src.charCodeAt(j) === c) j++;
      const run = j - i;
      if (c === TILDE && run > 2) { buf += src.slice(i, j); i = j; continue; }
      const prevC = i === 0 ? -1 : src.charCodeAt(i - 1);
      const nextC = j >= n ? -1 : src.charCodeAt(j);
      const fl = flanking(prevC, nextC);
      let canOpen, canClose;
      if (c === UNDER) {
        canOpen = fl.left && (!fl.right || isPunctCode(prevC));
        canClose = fl.right && (!fl.left || isPunctCode(nextC));
      } else {
        canOpen = fl.left; canClose = fl.right;
      }
      flushText();
      const nd = mkNode('delim');
      nd.ch = String.fromCharCode(c); nd.len = run; nd.origLen = run;
      nd.canOpen = canOpen; nd.canClose = canClose; nd.active = true;
      // Whether the char right after this run is alphanumeric (used by
      // the marked emphasis quirk: an inner `*` closer followed by an
      // alphanumeric blocks an outer `*` match when lengths sum to 3).
      nd.afterAlnum = (nextC >= 48 && nextC <= 57) || (nextC >= 65 && nextC <= 90) ||
        (nextC >= 97 && nextC <= 122);
      pushNode(nd);
      delims.push(nd);
      i = j; continue;
    }
    // --- '[' / '![' bracket openers ---
    if (c === LSQ || (c === 33 && i + 1 < n && src.charCodeAt(i + 1) === LSQ)) {
      const img = c === 33;
      flushText();
      const nd = mkNode('text'); nd.s = img ? '![' : '['; pushNode(nd);
      brackets.push({ node: nd, img, pos: i });
      i += img ? 2 : 1; continue;
    }
    // --- ']' : try to form a link / image ---
    // Try openers from most recent to oldest. The label between an opener
    // and this ']' must be a valid `re` label; the first opener whose label
    // is valid and whose tail/reference resolves wins. A link whose text
    // contains a link is rejected (marked's linkEmitted rule) — images are
    // exempt, and a link nested inside an image's children does not count.
    if (c === RSQ) {
      if (brackets.length) {
        flushText();
        let done = false;
        for (let bi = brackets.length - 1; bi >= 0; bi--) {
          const opener = brackets[bi];
          const labelStart = opener.pos + (opener.img ? 2 : 1);
          if (!labelValid(src, labelStart, i)) continue;
          const kids = nodesAfter(opener.node);
          let link = null;
          // (1) inline link
          const tailRes = parseInlineLinkTail(src, i + 1);
          if (tailRes) {
            link = { href: tailRes.href, title: tailRes.title, end: tailRes.end };
          } else if (i + 1 < n && src.charCodeAt(i + 1) === LSQ) {
            // (2) full / collapsed reference. If a second bracket label is
            // present but its reference is not defined, this is NOT a link
            // and the shortcut reference is NOT retried: '[foo]' stays
            // literal and parsing continues at the second bracket.
            const lab = scanLabel(src, i + 1);
            if (lab) {
              // Full/collapsed ref labels are the RAW text (backslashes and
              // formatting preserved); an empty second bracket means the
              // first bracket's raw text is the label.
              const labelText = lab.label.length ? lab.label : src.slice(labelStart, i);
              const ref = refs.get(normalizeLabel(labelText));
              if (ref) link = { href: ref.href, title: ref.title, end: lab.end };
              else link = false; // marker: full ref attempted, do not retry shortcut
            }
          }
          if (!link && link !== false) {
            // (3) shortcut reference: the label is the raw text between
            // the brackets (backslashes and formatting preserved), not
            // the resolved plain text — `foo\!` does not match `foo!`.
            const ref = refs.get(normalizeLabel(src.slice(labelStart, i)));
            if (ref) link = { href: ref.href, title: ref.title, end: i + 1 };
          }
          if (!link) continue; // try an older opener
          if (!opener.img && hasRealLink(kids)) {
            // Link text contains a link: reject; this '[' is literal text.
            brackets.splice(bi, 1);
            buf += ']'; i++; done = true; break;
          }
          // Extended autolinks inside the link text become plain text.
          unwrapExtAutolinks(kids);
          const kidsArr = extractAfter(opener.node);
          removeNode(opener.node);
          const nd = mkNode('link');
          nd.href = link.href; nd.title = link.title; nd.img = opener.img;
          nd.children = kidsArr;
          // children now belong to the link: record parent for phase 2
          for (const k of kidsArr) k.parent = nd;
          pushNode(nd);
          brackets.length = bi; // discard this opener and any newer ones
          i = link.end; done = true; break;
        }
        if (!done) { buf += ']'; i++; }
        continue;
      }
      buf += ']'; i++; continue;
    }
    // --- '<' : autolink or inline HTML ---
    if (c === LT) {
      const au = scanAutolink(src, i);
      if (au) {
        flushText();
        const nd = mkNode('link');
        nd.href = au.href; nd.title = null; nd.img = false; nd.auto = true;
        const tnd = mkNode('text'); tnd.s = au.text; tnd.parent = nd;
        nd.children = [tnd];
        pushNode(nd);
        i = au.end; continue;
      }
      const tag = scanHtmlTag(src, i);
      if (tag) {
        // marked's inLink: `<a ` opens it, `</a>` closes it (both
        // case-insensitive); it persists across blocks until closed.
        const c1 = src.charCodeAt(i + 1);
        if ((c1 === 97 || c1 === 65) && src.charCodeAt(i + 2) === SPACE) inLinkState = true;
        else if (c1 === 47 && (src.charCodeAt(i + 2) === 97 || src.charCodeAt(i + 2) === 65) &&
            src.charCodeAt(i + 3) === GT) inLinkState = false;
        flushText();
        const nd = mkNode('html'); nd.s = src.slice(i, tag.end); pushNode(nd);
        i = tag.end; continue;
      }
      buf += '<'; i++; continue;
    }
    // --- newline: hard or soft break ---
    if (c === NL) {
      // count trailing spaces in the pending text buffer
      let sp = 0;
      while (sp < buf.length && buf.charCodeAt(buf.length - 1 - sp) === SPACE) sp++;
      if (sp >= 2) buf = buf.slice(0, buf.length - sp);
      flushText();
      const nd = mkNode(sp >= 2 ? 'br' : 'soft');
      pushNode(nd);
      i++;
      // After a hard break, leading spaces/tabs on the next line are stripped.
      if (sp >= 2) while (i < n && (src.charCodeAt(i) === SPACE || src.charCodeAt(i) === TAB)) i++;
      continue;
    }
    // --- extended autolinks: www. / scheme:// / mailto: / xmpp: / email ---
    // (suppressed while inside an `<a>` tag: marked's persistent inLink)
    if (!inLinkState && c === 119 && src.startsWith('www.', i)) { // 'w'
      const prevC = i === 0 ? -1 : src.charCodeAt(i - 1);
      if (i === 0 || isUnicodeSpace(prevC) || prevC === STAR || prevC === UNDER ||
          prevC === TILDE || prevC === 40) {
        const u = scanBareUrl(src, i, brackets);
        if (u && u.text.length > 4 && isAlphaNumCode(u.text.charCodeAt(4))) {
          flushText();
          const nd = mkNode('link');
          nd.href = 'http://' + u.text; nd.title = null; nd.img = false; nd.ext = true;
          const tnd = mkNode('text'); tnd.s = u.text; tnd.parent = nd;
          nd.children = [tnd];
          pushNode(nd);
          i = u.end; continue;
        }
      }
    }
    if (!inLinkState && (c === 104 || c === 72) && (startsWithCI(src, i, 'https://') || startsWithCI(src, i, 'http://'))) {
      const u = scanBareUrl(src, i, brackets);
      if (u) {
        flushText();
        const nd = mkNode('link');
        nd.href = u.text; nd.title = null; nd.img = false; nd.ext = true;
        const tnd = mkNode('text'); tnd.s = u.text; tnd.parent = nd;
        nd.children = [tnd];
        pushNode(nd);
        i = u.end; continue;
      }
    }
    if (!inLinkState && (c === 102 || c === 70) && startsWithCI(src, i, 'ftp://')) {
      const u = scanBareUrl(src, i, brackets);
      if (u) {
        flushText();
        const nd = mkNode('link');
        nd.href = u.text; nd.title = null; nd.img = false; nd.ext = true;
        const tnd = mkNode('text'); tnd.s = u.text; tnd.parent = nd;
        nd.children = [tnd];
        pushNode(nd);
        i = u.end; continue;
      }
    }
    if (!inLinkState && c === 109 && src.startsWith('mailto:', i)) {
      const em = scanEmail(src, i + 7, false);
      if (em) {
        const text = src.slice(i, em.end);
        flushText();
        const nd = mkNode('link');
        nd.href = text; nd.title = null; nd.img = false; nd.ext = true;
        const tnd = mkNode('text'); tnd.s = text; tnd.parent = nd;
        nd.children = [tnd];
        pushNode(nd);
        i = em.end; continue;
      }
    }
    if (!inLinkState && c === 120 && src.startsWith('xmpp:', i)) {
      const em = scanEmail(src, i + 5, false);
      if (em) {
        let end = em.end;
        // optional /resource: a single path segment (no further '/')
        if (end < n && src.charCodeAt(end) === 47) {
          let k = end + 1;
          while (k < n) {
            const d = src.charCodeAt(k);
            if (isSpaceCode(d) || d === NL || d === LT || d === 47) break;
            k++;
          }
          end = k;
        }
        const text = src.slice(i, end);
        flushText();
        const nd = mkNode('link');
        nd.href = text; nd.title = null; nd.img = false; nd.ext = true;
        const tnd = mkNode('text'); tnd.s = text; tnd.parent = nd;
        nd.children = [tnd];
        pushNode(nd);
        i = end; continue;
      }
    }
    // bare email: starts a run of email-local chars
    if (!inLinkState && isEmailLocalChar(c)) {
      const prevC = i === 0 ? -1 : src.charCodeAt(i - 1);
      if (i === 0 || !isEmailLocalChar(prevC)) {
        const em = scanEmail(src, i, false, delims);
        if (em) {
          const text = src.slice(i, em.end);
          flushText();
          const nd = mkNode('link');
          nd.href = 'mailto:' + text; nd.title = null; nd.img = false; nd.ext = true;
          const tnd = mkNode('text'); tnd.s = text; tnd.parent = nd;
          nd.children = [tnd];
          pushNode(nd);
          i = em.end; continue;
        }
      }
    }
    // --- ordinary char ---
    buf += src[i]; i++;
  }
  flushText();
  return { head, delims };
}

// ---------------------------------------------------------------------------
// Inline phase 2: delimiter-stack emphasis / strong / strikethrough
// ---------------------------------------------------------------------------

// Group delimiters by their owning list (top level, or a link's children).
// Returns the top-level node array, with emphasis wrappers spliced in.
function processEmphasis(head, delims) {
  const topList = [];
  let cur = head;
  while (cur) { topList.push(cur); cur = cur.next; }
  if (!delims.length) return topList;
  // Bucket delimiters by parent node (null = top level).
  const groups = new Map(); // parent -> delim array (document order)
  for (const d of delims) {
    const p = d.parent || null;
    let g = groups.get(p);
    if (!g) { g = []; groups.set(p, g); }
    g.push(d);
  }
  for (const [parent, group] of groups) {
    const list = parent ? parent.children : topList;
    processEmphasisInList(list, group);
  }
  return topList;
}

function processEmphasisInList(list, group) {
  // Index of a node in the list (linear scan; lists are short).
  function indexOf(nd) {
    for (let i = 0; i < list.length; i++) if (list[i] === nd) return i;
    return -1;
  }
  // openers_bottom[char][len%3]: delimiters at or below this index in `group`
  // cannot match a later closer of that char with the same len%3.
  const bottom = { '*': [0, 0, 0], '_': [0, 0, 0], '~': [0, 0, 0] };
  // Walk the group's delimiters in document order; each is a potential closer.
  for (let ci = 0; ci < group.length; ci++) {
    const closer = group[ci];
    if (!closer.active || closer.len === 0 || !closer.canClose) continue;
    const ch = closer.ch;
    const origLen = closer.len;
    const closerCanBoth = closer.canOpen && closer.canClose;
    let usedEm = false; // did this closer match with use===1 (an <em>)?
    // Keep trying while this closer still has length left.
    while (closer.active && closer.len > 0 && closer.canClose) {
      const closerLen = closer.len;
      const bot = bottom[ch][closerLen % 3];
      let opener = null;
      // Look back for the nearest matching opener above `bot`.
      for (let oi = ci - 1; oi >= bot; oi--) {
        const cand = group[oi];
        if (!cand.active || cand.len === 0 || cand.ch !== ch || !cand.canOpen) continue;
        // Rule of 3 (applies when at least one delimiter can both open
        // and close): if the sum of the lengths is divisible by 3 and the
        // lengths are not both divisible by 3, this opener cannot match.
        const bothCan = (cand.canOpen && cand.canClose) || (closer.canOpen && closer.canClose);
        const sum = cand.len + closerLen;
        if (bothCan && sum % 3 === 0 && !(cand.len % 3 === 0 && closerLen % 3 === 0)) continue;
        // The candidate must still be a direct child of this list; one
        // trapped inside an emphasis element formed earlier cannot match
        // (skip it and keep looking, do not give up).
        if (indexOf(cand) < 0) continue;
        // Prefer strong: a len-1 closer must not steal a len-2 opener
        // when a later len>=2 closer of the same char could form a strong
        // with it (doc-11: `**...*...**` — the `*` closer must not take
        // the `**` opener from the final `**` closer). Only for a len-2
        // opener: a len-3 opener (cm-430 `***foo* bar**`) can give 1 to
        // the em and still have 2 left for the strong.
        if (cand.len === 2 && closerLen === 1) {
          let laterStrong = false;
          for (let li = ci + 1; li < group.length; li++) {
            const ld = group[li];
            if (ld.active && ld.ch === ch && ld.canClose && ld.len >= 2) { laterStrong = true; break; }
          }
          if (laterStrong) continue;
        }
        // Marked quirk (`*` only): an inner `*` emphasis whose closer is
        // immediately followed by an alphanumeric blocks this outer match
        // when (openerLen + innerCloserLen) % 3 === 0. The inner element
        // sits between the candidate and the closer in the node list.
        if (ch === '*') {
          const oiP = indexOf(cand), ciP = indexOf(closer);
          let blocked = false;
          if (oiP >= 0 && ciP > oiP) {
            for (let k = oiP + 1; k < ciP; k++) {
              const nd = list[k];
              if (nd.blockCh === '*' && nd.blockAfterAlnum && !nd.blockOpenerCanClose &&
                  (cand.len + nd.blockLen) % 3 === 0) {
                // A closer-only `*` delimiter between the inner emphasis
                // and the outer closer cancels the block (doc-01's lone
                // `*` after `other`, followed by a space).
                let saved = false;
                for (let m = k + 1; m < ciP; m++) {
                  const d2 = list[m];
                  if (d2.kind === 'delim' && d2.ch === '*' && d2.active &&
                      d2.canClose && !d2.canOpen) { saved = true; break; }
                }
                if (!saved) { blocked = true; break; }
              }
            }
          }
          if (blocked) continue;
        }
        opener = cand; break;
      }
      if (!opener) {
        bottom[ch][closerLen % 3] = ci;
        break;
      }
      const use = (opener.len >= 2 && closerLen >= 2) ? 2 : 1;
      if (use === 1) usedEm = true;
      const oiPos = indexOf(opener), ciPos = indexOf(closer);
      if (oiPos < 0 || ciPos < 0 || ciPos <= oiPos) break; // should not happen
      const tag = ch === '~' ? 'del' : (use === 2 ? 'strong' : 'em');
      const kids = list.slice(oiPos + 1, ciPos);
      const wrap = mkNode(tag);
      wrap.children = kids;
      // Record the inner-closer info for the marked `*` blocking quirk.
      wrap.blockCh = ch; wrap.blockLen = closerLen; wrap.blockAfterAlnum = closer.afterAlnum;
      wrap.blockOpenerCanClose = opener.canClose;
      for (const k of kids) k.parent = wrap;
      opener.len -= use;
      closer.len -= use;
      if (opener.len === 0) { opener.active = false; list.splice(oiPos, 1); }
      if (closer.len === 0) { closer.active = false; }
      // Wrapper goes where the opener was (opener spent) or right after the
      // opener (opener has length left).
      const insertAt = opener.len === 0 ? oiPos : oiPos + 1;
      const kidsStart = opener.len === 0 ? oiPos : oiPos + 1;
      list.splice(kidsStart, kids.length);
      // Now the closer is at kidsStart (if it follows the kids).
      const cPos = indexOf(closer);
      if (closer.len === 0) {
        if (cPos >= 0) list.splice(cPos, 1);
        list.splice(insertAt, 0, wrap);
      } else {
        // closer remains: wrapper goes right before it.
        list.splice(cPos, 0, wrap);
      }
      // The closer (if it still has length) is re-examined by the while loop.
      // The opener (if it still has length) stays available for later closers.
    }
    // (The `use===1` openers_bottom rule was tried here and reverted: it
    // blocks legitimate outer matches such as `*state many *types*updates*`
    // in doc-06, where the outer em must still form.)
  }
}

// Render one inline node list to an output array of strings.
function renderInlineList(list, out) {
  for (const nd of list) {
    switch (nd.kind) {
      case 'text': out.push(escSmart(nd.s, true)); break;
      case 'code': out.push('<code>', escAll(nd.s), '</code>'); break;
      case 'html': out.push(nd.s); break;
      case 'br': out.push('<br>'); break;
      case 'soft': out.push('\n'); break;
      case 'delim': out.push(nd.ch.repeat(nd.len)); break;
      case 'em': out.push('<em>'); renderInlineList(nd.children, out); out.push('</em>'); break;
      case 'strong': out.push('<strong>'); renderInlineList(nd.children, out); out.push('</strong>'); break;
      case 'del': out.push('<del>'); renderInlineList(nd.children, out); out.push('</del>'); break;
      case 'link': {
        if (nd.img) {
          const alt = escSmart(nodeTextPlain(nd.children), true);
          const src = escSmart(cleanUrl(nd.href), false);
          out.push('<img src="', src, '" alt="', alt, '"');
          if (nd.title != null) out.push(' title="', escSmart(nd.title, false), '"');
          out.push('>');
        } else {
          const href = escSmart(cleanUrl(nd.href), false);
          out.push('<a href="', href, '"');
          if (nd.title != null) out.push(' title="', escSmart(nd.title, false), '"');
          out.push('>');
          renderInlineList(nd.children, out);
          out.push('</a>');
        }
        break;
      }
    }
  }
}

// Full inline render of a source string (paragraph / heading / table cell).
function inlineToHtml(src, refs) {
  if (!src) return '';
  const { head, delims } = scanInline(src, refs);
  if (!head) return '';
  const list = processEmphasis(head, delims);
  const out = [];
  renderInlineList(list, out);
  return out.join('');
}

// ---------------------------------------------------------------------------
// Block parsing: line utilities (tab aware, columns advance to multiples of 4)
// ---------------------------------------------------------------------------

function lineIndent(line) {
  let cols = 0, i = 0;
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if (c === SPACE) { cols++; i++; }
    else if (c === TAB) { cols += 4 - (cols % 4); i++; }
    else break;
  }
  return { cols, idx: i };
}

// Fence content dedent (marked's Dt): remove up to `n` leading
// whitespace CHARACTERS (a tab counts as 1 char, not 4 columns). This is
// different from stripCols (column-based, used for list/blockquote
// dedent): a tab-indented fence line loses the whole tab, not just the
// fence indent's worth of columns.
function stripFenceIndent(line, n) {
  let i = 0;
  while (i < line.length && i < n) {
    const c = line.charCodeAt(i);
    if (c === SPACE || c === TAB) i++;
    else break;
  }
  return line.slice(i);
}

function stripCols(line, n) {
  let cols = 0, i = 0;
  while (i < line.length && cols < n) {
    const c = line.charCodeAt(i);
    if (c === SPACE) { cols++; i++; }
    else if (c === TAB) {
      const adv = 4 - (cols % 4);
      if (cols + adv > n) return ' '.repeat(cols + adv - n) + line.slice(i + 1);
      cols += adv; i++;
    } else break;
  }
  return line.slice(i);
}

// Slice a line at a column position, counting every character as one
// column (tabs advance to the next multiple of 4). A tab straddling the
// boundary becomes spaces. Used for a list item's first line, where the
// prefix holds the marker text, not just whitespace.
function sliceAtCol(line, col) {
  let cols = 0, i = 0;
  while (i < line.length && cols < col) {
    const c = line.charCodeAt(i);
    if (c === TAB) {
      const adv = 4 - (cols % 4);
      if (cols + adv > col) return ' '.repeat(cols + adv - col) + line.slice(i + 1);
      cols += adv; i++;
    } else { cols++; i++; }
  }
  return line.slice(i);
}

// Like sliceAtCol, but any tab that remains in the leading whitespace of
// the result is expanded to spaces using its width in the ORIGINAL line.
// Use this when the result will be column-stripped again (list item and
// blockquote content): a raw tab would be re-measured from its new,
// narrower position and lose columns. Code content uses sliceAtCol /
// stripCols instead, which preserve tabs verbatim.
function sliceAtColExpand(line, col) {
  let cols = 0, i = 0, out = '';
  while (i < line.length && cols < col) {
    const c = line.charCodeAt(i);
    if (c === TAB) {
      const adv = 4 - (cols % 4);
      if (cols + adv > col) {
        out += ' '.repeat(cols + adv - col);
        cols += adv; i++;
        break;
      }
      cols += adv; i++;
    } else { cols++; i++; }
  }
  // Expand remaining leading tabs to spaces (original column widths).
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if (c === SPACE) { out += ' '; cols++; i++; }
    else if (c === TAB) {
      const adv = 4 - (cols % 4);
      out += ' '.repeat(adv);
      cols += adv; i++;
    } else break;
  }
  return out + line.slice(i);
}

function isBlank(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== SPACE && c !== TAB) return false;
  }
  return true;
}

// Does `line` (already known non-blank) start a fenced code block?
// Returns {ch, len, info} or null. ch is '`' or '~', len the run length.
function matchFence(line) {
  const { cols, idx } = lineIndent(line);
  if (cols > 3) return null;
  const c = line.charCodeAt(idx);
  if (c !== TICK && c !== TILDE) return null;
  let j = idx;
  while (j < line.length && line.charCodeAt(j) === c) j++;
  const len = j - idx;
  if (len < 3) return null;
  const info = line.slice(j);
  if (c === TICK && info.indexOf('`') >= 0) return null;
  return { ch: String.fromCharCode(c), len, info, indentCols: cols, indentChars: idx };
}

function matchATX(line) {
  const { cols, idx } = lineIndent(line);
  if (cols > 3) return null;
  let j = idx, level = 0;
  while (j < line.length && line.charCodeAt(j) === 35 && level < 7) { level++; j++; }
  if (level === 0 || level > 6) return null;
  if (j < line.length) {
    const c = line.charCodeAt(j);
    if (c !== SPACE && c !== TAB) return null;
  }
  let text = line.slice(j);
  // strip leading/trailing spaces, then a closing hash run preceded by space
  let a = 0, b = text.length;
  while (a < b && (text.charCodeAt(a) === SPACE || text.charCodeAt(a) === TAB)) a++;
  while (b > a && (text.charCodeAt(b - 1) === SPACE || text.charCodeAt(b - 1) === TAB)) b--;
  let e = b;
  while (e > a && text.charCodeAt(e - 1) === 35) e--;
  if (e < b && e >= a && (e === a || text.charCodeAt(e - 1) === SPACE || text.charCodeAt(e - 1) === TAB)) {
    b = e;
    while (b > a && (text.charCodeAt(b - 1) === SPACE || text.charCodeAt(b - 1) === TAB)) b--;
  }
  return { level, text: text.slice(a, b) };
}

function matchHR(line) {
  const { cols, idx } = lineIndent(line);
  if (cols > 3) return null;
  let j = idx;
  const c = line.charCodeAt(j);
  if (c !== 45 && c !== 95 && c !== 42) return null; // - _ *
  let count = 0;
  while (j < line.length) {
    const d = line.charCodeAt(j);
    if (d === c) { count++; j++; }
    else if (d === SPACE || d === TAB) j++;
    else return null;
  }
  return count >= 3 ? true : null;
}

// Setext underline: returns 1 for '=', 2 for '-', or 0.
function matchSetext(line) {
  const { cols, idx } = lineIndent(line);
  if (cols > 3) return 0;
  let j = idx;
  const c = line.charCodeAt(j);
  if (c !== 61 && c !== 45) return 0; // = -
  while (j < line.length && line.charCodeAt(j) === c) j++;
  while (j < line.length && (line.charCodeAt(j) === SPACE || line.charCodeAt(j) === TAB)) j++;
  return j === line.length ? (c === 61 ? 1 : 2) : 0;
}

// Block-level tag names for HTML block type 6 (CommonMark list).
const BLOCK_TAGS = new Set(('address article aside base basefont blockquote body caption center col colgroup dd details dialog dir div dl dt fieldset figcaption figure footer form frame frameset h1 h2 h3 h4 h5 h6 head header hr html iframe legend li link main menu menuitem meta nav noframes ol optgroup option p param search section summary table tbody td tfoot th thead title tr track ul').split(' '));

// HTML block start at `line`. Returns {type, endMarker} or null.
// type 1: script/pre/style/textarea (ends at blank line)
// type 2: <!-- (ends at a line containing -->)
// type 3: <? (ends at ?>)   type 4: <!letter (ends at >)
// type 5: <![CDATA[ (ends at ]]>)   type 6: block tag (ends at blank line)
// type 7: single open/closing tag alone on the line (ends at blank line)
function matchHtmlBlockStart(line) {
  const { cols, idx } = lineIndent(line);
  if (cols > 3 || idx >= line.length || line.charCodeAt(idx) !== LT) return null;
  const rest = line.slice(idx);
  const lower = rest.toLowerCase();
  // type 1
  for (const tag of ['script', 'pre', 'style', 'textarea']) {
    if (lower.startsWith('<' + tag)) {
      const after = tag.length + 1 >= rest.length ? -1 : rest.charCodeAt(tag.length + 1);
      if (after === -1 || after === SPACE || after === TAB || after === GT) return { type: 1, endMarker: '</' + tag + '>', tag };
    }
  }
  if (rest.startsWith('<!--')) return { type: 2, endMarker: '-->' };
  if (rest.startsWith('<?')) return { type: 3, endMarker: '?>' };
  if (rest.startsWith('<![CDATA[')) return { type: 5, endMarker: ']]>' };
  if (rest.startsWith('<!') && rest.length > 2) {
    const c2 = rest.charCodeAt(2);
    if ((c2 >= 65 && c2 <= 90) || (c2 >= 97 && c2 <= 122)) return { type: 4, endMarker: '>' };
  }
  // type 6: <tag ...> where tag is a block tag
  if (rest.charCodeAt(1) === 47) { // '</'
    let j = 2;
    while (j < rest.length && ((rest.charCodeAt(j) >= 97 && rest.charCodeAt(j) <= 122) ||
        (rest.charCodeAt(j) >= 65 && rest.charCodeAt(j) <= 90) ||
        (rest.charCodeAt(j) >= 48 && rest.charCodeAt(j) <= 57) || rest.charCodeAt(j) === 45)) j++;
    const name = rest.slice(2, j).toLowerCase();
    if (BLOCK_TAGS.has(name)) {
      const after = j >= rest.length ? -1 : rest.charCodeAt(j);
      if (after === -1 || after === SPACE || after === TAB || after === GT || after === 47) return { type: 6, endMarker: null };
    }
    // type 7: closing tag alone on the line
    let k = j;
    while (k < rest.length && (rest.charCodeAt(k) === SPACE || rest.charCodeAt(k) === TAB)) k++;
    if (k < rest.length && rest.charCodeAt(k) === GT) {
      k++;
      while (k < rest.length && (rest.charCodeAt(k) === SPACE || rest.charCodeAt(k) === TAB)) k++;
      if (k === rest.length) return { type: 7, endMarker: null };
    }
    return null;
  }
  // open tag: <name ...>
  let j = 1;
  const nc = rest.charCodeAt(1);
  if (!((nc >= 65 && nc <= 90) || (nc >= 97 && nc <= 122))) return null;
  while (j < rest.length && ((rest.charCodeAt(j) >= 97 && rest.charCodeAt(j) <= 122) ||
      (rest.charCodeAt(j) >= 65 && rest.charCodeAt(j) <= 90) ||
      (rest.charCodeAt(j) >= 48 && rest.charCodeAt(j) <= 57) || rest.charCodeAt(j) === 45)) j++;
  const name = rest.slice(1, j).toLowerCase();
  if (BLOCK_TAGS.has(name)) {
    const after = j >= rest.length ? -1 : rest.charCodeAt(j);
    if (after === -1 || after === SPACE || after === TAB || after === GT || after === 47) return { type: 6, endMarker: null };
  }
  // type 7: a complete open tag alone on the line
  const tag = scanHtmlTag(rest, 0);
  if (tag) {
    let k = tag.end;
    while (k < rest.length && (rest.charCodeAt(k) === SPACE || rest.charCodeAt(k) === TAB)) k++;
    if (k === rest.length) return { type: 7, endMarker: null };
  }
  return null;
}

// List marker match. Returns null or:
// {ordered, start, delim, markerCols, contentCols, first}
function matchListMarker(line) {
  const { cols, idx } = lineIndent(line);
  if (cols > 3) return null;
  const c = line.charCodeAt(idx);
  let ordered = false, start = 0, markerLen = 0, delim = '';
  if (c === 45 || c === 43 || c === 42) { // - + *
    markerLen = 1; delim = line[idx];
  } else if (c >= 48 && c <= 57) {
    let k = idx, num = 0, digits = 0;
    while (k < line.length && line.charCodeAt(k) >= 48 && line.charCodeAt(k) <= 57) {
      if (digits === 9) return null;
      num = num * 10 + (line.charCodeAt(k) - 48); k++; digits++;
    }
    if (digits === 0) return null;
    const d = line.charCodeAt(k);
    if (d !== 46 && d !== 41) return null;
    ordered = true; start = num; markerLen = digits + 1; delim = line[k];
  } else return null;
  const base = cols + markerLen;
  let m = idx + markerLen;
  if (m >= line.length) {
    return { ordered, start, delim, markerCols: base, contentCols: base + 1, first: '' };
  }
  const mc = line.charCodeAt(m);
  if (mc !== SPACE && mc !== TAB) return null;
  let cc = base, p = m;
  while (p < line.length) {
    const d = line.charCodeAt(p);
    if (d === SPACE) { cc++; p++; }
    else if (d === TAB) { cc += 4 - (cc % 4); p++; }
    else break;
  }
  if (p >= line.length) {
    return { ordered, start, delim, markerCols: base, contentCols: base + 1, first: '' };
  }
  const contentCols = (cc - base >= 5) ? base + 1 : cc;
  return { ordered, start, delim, markerCols: base, contentCols, first: sliceAtColExpand(line, contentCols) };
}

// Split a table row/header line into cells (marked's `de`): split on
// unescaped '|', drop a leading/trailing empty cell, trim, and (for rows)
// truncate or pad to `expected` cells.
function splitTableCells(text, expected) {
  const cells = [];
  let cur = '', i = 0;
  while (i < text.length) {
    const c = text.charCodeAt(i);
    if (c === 124) { // '|'
      // escaped if preceded by an odd run of backslashes; the escaping
      // backslash is dropped (the cell then holds a literal '|').
      let bs = 0, k = i - 1;
      while (k >= 0 && text.charCodeAt(k) === BACKSLASH) { bs++; k--; }
      if (bs % 2 === 1) { cur = cur.slice(0, cur.length - 1) + '|'; i++; continue; }
      cells.push(cur); cur = ''; i++; continue;
    }
    cur += text[i]; i++;
  }
  cells.push(cur);
  if (cells.length && cells[0].trim() === '') cells.shift();
  if (cells.length && cells[cells.length - 1].trim() === '') cells.pop();
  if (expected !== undefined) {
    if (cells.length > expected) cells.length = expected;
    else while (cells.length < expected) cells.push('');
  }
  for (let s = 0; s < cells.length; s++) cells[s] = cells[s].trim();
  return cells;
}

// Parse the delimiter row of a table. Returns the alignment array or null.
function parseTableDelimiter(line) {
  const { cols, idx } = lineIndent(line);
  if (cols > 3) return null;
  const raw = line.slice(idx).trim();
  let t = raw;
  if (t.startsWith('|')) t = t.slice(1);
  if (t.endsWith('|')) t = t.slice(0, -1);
  if (!t) return null;
  // A delimiter row of bare dashes (no ':' and no '|') is a setext
  // underline, not a table delimiter (marked's table rule requires a
  // colon or a pipe in the delimiter row).
  if (raw.indexOf('|') < 0 && raw.indexOf(':') < 0) return null;
  const parts = t.split('|');
  const align = [];
  for (const part of parts) {
    const cell = part.trim();
    let left = false, right = false, dashes = 0;
    let k = 0;
    if (cell.charCodeAt(0) === 58) { left = true; k = 1; }
    while (k < cell.length && cell.charCodeAt(k) === 45) { dashes++; k++; }
    if (k < cell.length && cell.charCodeAt(k) === 58) { right = true; k++; }
    if (dashes === 0 || k !== cell.length) return null;
    align.push(left && right ? 'center' : left ? 'left' : right ? 'right' : null);
  }
  return align;
}

// Does lines[j] start a table (header + valid delimiter on the next line)?
// Returns the alignment array or null.
function isTableStart(lines, j, end) {
  if (j + 1 >= end) return null;
  const header = lines[j];
  if (isBlank(header)) return null;
  const { cols } = lineIndent(header);
  if (cols > 3) return null;
  // header must start with a non-space char after the indent
  const h = header.slice(lineIndent(header).idx);
  if (!h) return null;
  const align = parseTableDelimiter(lines[j + 1]);
  if (!align) return null;
  const headerCells = splitTableCells(h);
  if (headerCells.length !== align.length) return null;
  return align;
}

// ---------------------------------------------------------------------------
// Link reference definitions
// ---------------------------------------------------------------------------

// Try to parse a link reference definition starting at lines[i].
// Returns {label, href, title, linesUsed} or null. The definition may span
// up to three lines (label line, destination, title).
function tryParseRefDef(lines, i, end) {
  const avail = Math.min(12, end - i);
  let src = '';
  for (let k = 0; k < avail; k++) {
    if (k > 0) src += '\n';
    src += lines[i + k];
  }
  const n = src.length;
  // indent: at most 3 columns
  let pos = 0, cols = 0;
  while (pos < n) {
    const c = src.charCodeAt(pos);
    if (c === SPACE) { cols++; pos++; }
    else if (c === TAB) { cols += 4 - (cols % 4); pos++; }
    else break;
  }
  if (cols > 3 || pos >= n || src.charCodeAt(pos) !== LSQ) return null;
  const lab = scanLabel(src, pos);
  if (!lab) return null;
  const rawLabel = lab.label;
  // label must be non-empty after trimming, and must not span a blank line
  if (!rawLabel.trim()) return null;
  for (let k = 0; k < rawLabel.length; k++) {
    if (rawLabel.charCodeAt(k) === NL) {
      let m = k + 1;
      while (m < rawLabel.length && (rawLabel.charCodeAt(m) === SPACE || rawLabel.charCodeAt(m) === TAB)) m++;
      // a newline followed by another newline is a blank line; a newline
      // at the very end of the label is fine (it is followed by ']')
      if (m < rawLabel.length && rawLabel.charCodeAt(m) === NL) return null;
    }
  }
  pos = lab.end;
  if (pos >= n || src.charCodeAt(pos) !== 58) return null; // ':'
  pos++;
  // spaces/tabs, then at most one newline + spaces/tabs, then the destination
  while (pos < n && (src.charCodeAt(pos) === SPACE || src.charCodeAt(pos) === TAB)) pos++;
  if (pos < n && src.charCodeAt(pos) === NL) {
    pos++;
    while (pos < n && (src.charCodeAt(pos) === SPACE || src.charCodeAt(pos) === TAB)) pos++;
  }
  if (pos >= n) return null;
  let href = '';
  if (src.charCodeAt(pos) === LT) {
    let j = pos + 1;
    while (j < n) {
      const c = src.charCodeAt(j);
      if (c === GT) break;
      if (c === NL || c === LT) return null;
      if (c === BACKSLASH && j + 1 < n && isAsciiPunctCode(src.charCodeAt(j + 1))) { href += src[j + 1]; j += 2; continue; }
      href += src[j]; j++;
    }
    if (j >= n) return null;
    pos = j + 1;
  } else {
    // bare destination: maximal run of non-space, non-control chars
    let j = pos, depth = 0, raw = '';
    while (j < n) {
      const c = src.charCodeAt(j);
      if (c === SPACE || c === TAB || c === NL || c < 32) break;
      if (c === BACKSLASH && j + 1 < n && isAsciiPunctCode(src.charCodeAt(j + 1))) { raw += src[j + 1]; j += 2; continue; }
      if (c === 40) depth++;
      if (c === 41) { if (depth === 0) break; depth--; }
      raw += src[j]; j++;
    }
    if (!raw || depth !== 0) return null;
    href = raw;
    pos = j;
  }
  // After the destination: spaces/tabs, then either EOL, a title on this
  // line, or a newline + spaces + a title on the next line. A title on the
  // same line requires at least one space before it; extra text on the same
  // line fails the whole definition.
  let title = null;
  let p = pos;
  const destEnd = p;
  while (p < n && (src.charCodeAt(p) === SPACE || src.charCodeAt(p) === TAB)) p++;
  if (p < n && src.charCodeAt(p) !== NL) {
    // title must start here on this line, and only after a space
    if (p === destEnd) return null;
    const t = parseTitle(src, p);
    if (!t) return null;
    title = t.title;
    p = t.end;
    while (p < n && (src.charCodeAt(p) === SPACE || src.charCodeAt(p) === TAB)) p++;
    if (p < n && src.charCodeAt(p) !== NL) return null;
  } else if (p < n && src.charCodeAt(p) === NL) {
    // maybe a title on the next line; if it does not parse cleanly to EOL,
    // the definition still stands without a title (the line is separate)
    let q = p + 1;
    while (q < n && (src.charCodeAt(q) === SPACE || src.charCodeAt(q) === TAB)) q++;
    if (q < n && (src.charCodeAt(q) === QUOT || src.charCodeAt(q) === APOS || src.charCodeAt(q) === 40)) {
      const t = parseTitle(src, q);
      if (t) {
        let r = t.end;
        while (r < n && (src.charCodeAt(r) === SPACE || src.charCodeAt(r) === TAB)) r++;
        if (r >= n || src.charCodeAt(r) === NL) {
          title = t.title;
          p = t.end;
        }
        // else: trailing text after the title -> keep the title-less def
      }
    }
    // otherwise the definition ends here, without a title
  }
  // lines used: newlines strictly before the end position + 1
  let linesUsed = 1;
  for (let k = 0; k < p && k < n; k++) if (src.charCodeAt(k) === NL) linesUsed++;
  return { label: normalizeLabel(rawLabel), href, title, linesUsed };
}

// ---------------------------------------------------------------------------
// Block parsing
// ---------------------------------------------------------------------------

// Is `line` the start of a block that can interrupt a paragraph?
// (ATX heading, fence, thematic break, HTML block types 1-6, blockquote,
//  or a list that can interrupt a paragraph: bullet with content, or
//  ordered starting with 1 with content.)
function isInterruptBlockStart(line, anyOrdered) {
  if (matchATX(line) || matchFence(line) || matchHR(line)) return true;
  const h = matchHtmlBlockStart(line);
  if (h && h.type !== 7) return true;
  const { cols, idx } = lineIndent(line);
  if (cols <= 3 && idx < line.length && line.charCodeAt(idx) === GT) return true;
  const m = matchListMarker(line);
  // Inside a list item any ordered marker can interrupt a paragraph (a
  // nested list is a child block); elsewhere only `1.` may.
  if (m && m.first !== '' && (!m.ordered || m.start === 1 || anyOrdered)) return true;
  return false;
}

// Render a table starting at lines[i]. `align` is from isTableStart.
// Returns {html, next}. In collect mode the rows are scanned (to find the
// table's end) but no cell HTML is rendered.
function renderTable(lines, i, end, refs, align, collect) {
  const headerCells = splitTableCells(lines[i].slice(lineIndent(lines[i]).idx));
  let j = i + 2;
  const rows = [];
  while (j < end) {
    const line = lines[j];
    if (line === '') break;
    // A spaces-only line ends the table, but a whitespace-only line that
    // contains a tab is a row of empty cells (marked's table regex treats
    // a tab as row content, not as blank).
    if (isBlank(line)) {
      if (line.indexOf('\t') < 0) break;
      rows.push(line); j++; continue;
    }
    // A row ends at indented code, or any line the table regex's row
    // lookahead excludes: ATX / fence / hr / blockquote / HTML 1-6 /
    // a bullet or ordered-1 list marker followed by a space.
    const { cols, idx } = lineIndent(line);
    if (cols >= 4) break;
    if (isInterruptBlockStart(line)) break;
    const cc = line.charCodeAt(idx);
    if ((cc === 45 || cc === 43 || cc === 42) &&
        (line.charCodeAt(idx + 1) === SPACE || line.charCodeAt(idx + 1) === TAB)) break;
    if (cc === 49 && (line.charCodeAt(idx + 1) === 46 || line.charCodeAt(idx + 1) === 41) &&
        (line.charCodeAt(idx + 2) === SPACE || line.charCodeAt(idx + 2) === TAB)) break;
    rows.push(line);
    j++;
  }
  if (collect) return { html: '', next: j };
  let out = '<table>\n<thead>\n<tr>\n';
  for (let c = 0; c < headerCells.length; c++) {
    out += '<th' + (align[c] ? ' align="' + align[c] + '"' : '') + '>' +
      inlineToHtml(headerCells[c], refs) + '</th>\n';
  }
  out += '</tr>\n</thead>\n';
  if (rows.length) {
    out += '<tbody>';
    for (const row of rows) {
      const cells = splitTableCells(row, headerCells.length);
      out += '<tr>\n';
      for (let c = 0; c < cells.length; c++) {
        out += '<td' + (align[c] ? ' align="' + align[c] + '"' : '') + '>' +
          inlineToHtml(cells[c], refs) + '</td>\n';
      }
      out += '</tr>\n';
    }
    out += '</tbody>';
  }
  out += '</table>\n';
  return { html: out, next: j };
}

// Collect blockquote lines starting at lines[i]. Returns {lines, next, lazy}.
// Lines are stripped of the '>' marker (and one following space); lazy
// paragraph continuation lines are included raw. `lazy` is a Set of indices
// into `lines` that are lazy continuations (already indent-stripped); the
// inner parse must treat them as paragraph text, never as a block start.
function collectBlockquote(lines, i, end) {
  const out = [];
  const lazy = new Set();
  let j = i;
  let inPara = false;
  // A fenced code block cannot be lazily continued: a line with no '>'
  // marker ends the blockquote while a fence is open (the fence is left
  // unclosed). Track the fence on the stripped inner lines.
  let fenceCh = '', fenceLen = 0;
  while (j < end) {
    const line = lines[j];
    if (isBlank(line)) {
      // A truly blank line (no '>' marker) ends the blockquote; a later
      // '>' line starts a new blockquote.
      break;
    }
    const { cols, idx } = lineIndent(line);
    if (cols <= 3 && idx < line.length && line.charCodeAt(idx) === GT) {
      // The marker '>' plus one column of following whitespace is
      // consumed; a tab there is only partly consumed (one column), the
      // rest becoming spaces (sliceAtColExpand handles the expansion).
      let contentCol = cols + 1;
      const after = line.charCodeAt(idx + 1);
      if (after === SPACE || after === TAB) contentCol = cols + 2;
      const stripped = sliceAtColExpand(line, contentCol);
      out.push(stripped);
      if (fenceCh) {
        // Fence content (or its closer): not a paragraph.
        inPara = false;
        const ind = lineIndent(stripped);
        if (ind.cols <= 3) {
          let p = ind.idx;
          const c = stripped.charCodeAt(p);
          if (c === fenceCh.charCodeAt(0)) {
            let run = 0;
            while (p < stripped.length && stripped.charCodeAt(p) === c) { run++; p++; }
            if (run >= fenceLen) {
              let rest = true;
              while (p < stripped.length) {
                if (stripped.charCodeAt(p) !== SPACE && stripped.charCodeAt(p) !== TAB) { rest = false; break; }
                p++;
              }
              if (rest) { fenceCh = ''; fenceLen = 0; }
            }
          }
        }
      } else {
        const f = matchFence(stripped);
        if (f) { fenceCh = f.ch; fenceLen = f.len; inPara = false; }
        else inPara = bqLineHasPara(stripped);
      }
      j++;
      continue;
    }
    // A line with no '>' marker cannot continue a fenced code block.
    if (fenceCh) break;
    // Lazy continuation: only a paragraph line may continue lazily. A
    // setext underline cannot be a lazy continuation: indent it by 4 spaces
    // so it stays paragraph text (marked's blockquoteSetextReplace).
    if (inPara && !isInterruptBlockStart(line) && !isTableStart(lines, j, end)) {
      if (matchSetext(line)) out.push('    ' + line.replace(/^[ \t]+/, ''));
      else out.push(lazyBqLine(line));
      lazy.add(out.length - 1);
      j++;
      continue;
    }
    break;
  }
  return { lines: out, next: j, lazy };
}

// Does a stripped blockquote line leave an open paragraph that a lazy
// continuation line can continue? A nested blockquote line counts as
// possibly containing one (resolved by the inner parse); a list marker
// line counts if its content does; an indented code line does not open
// a paragraph.
function bqLineHasPara(s) {
  if (s === '' || isBlank(s)) return false;
  const { cols, idx } = lineIndent(s);
  if (cols <= 3 && idx < s.length && s.charCodeAt(idx) === GT) return true;
  const mm = matchListMarker(s);
  if (mm) return mm.first !== '' ? bqLineHasPara(mm.first) : false;
  if (isInterruptBlockStart(s)) return false;
  if (lineIndent(s).cols >= 4) return false;
  return true;
}

// A lazy continuation line has up to 4 columns of leading whitespace
// stripped (only when it has 4 or more columns of indent).
function lazyBqLine(line) {
  let cols = 0, k = 0;
  while (k < line.length) {
    const c = line.charCodeAt(k);
    if (c === SPACE) { cols++; k++; }
    else if (c === TAB) { cols += 4 - (cols % 4); k++; }
    else break;
  }
  if (cols < 4) return line;
  return stripCols(line, 4);
}

// Does `out` (a list item's content lines, trailing blanks trimmed)
// contain a blank line that separates two blocks at the item's own level?
// A blank inside a fenced code block or inside a nested list item does not
// count; a blank before an indented code block or a new top-level block
// does. We track open fences and nested-list boundaries while scanning.
// A line continues a nested list if it is a list marker at or beyond the
// list's marker column, or non-marker content indented to its content
// column.
function computeInnerBlank(out) {
  let fenceCh = '', fenceLen = 0;
  const listStack = []; // {m: marker column, c: content column}
  function continues(line, entry) {
    const ind = lineIndent(line);
    if (matchListMarker(line)) return ind.cols >= entry.m;
    return ind.cols >= entry.c;
  }
  for (let k = 0; k < out.length; k++) {
    const line = out[k];
    if (line === '') {
      if (fenceCh) continue; // inside a fenced code block
      let b = k + 1;
      while (b < out.length && out[b] === '') b++;
      if (b >= out.length) continue; // trailing blank
      let a = k - 1;
      while (a >= 0 && out[a] === '') a--;
      if (a < 0) continue; // leading blank
      // Is the next non-blank line a continuation of an open nested list?
      // Pop lists the line is not part of; if any list remains, the blank
      // is nested inside it.
      let depth = listStack.length;
      while (depth > 0 && !continues(out[b], listStack[depth - 1])) depth--;
      if (depth > 0) continue;
      return true;
    }
    const ind = lineIndent(line);
    if (fenceCh) {
      // Look for the closing fence.
      if (ind.cols <= 3) {
        let p = ind.idx;
        const c = line.charCodeAt(p);
        if (c === fenceCh.charCodeAt(0)) {
          let run = 0;
          while (p < line.length && line.charCodeAt(p) === c) { run++; p++; }
          if (run >= fenceLen) {
            let rest = true;
            while (p < line.length) {
              if (line.charCodeAt(p) !== SPACE && line.charCodeAt(p) !== TAB) { rest = false; break; }
              p++;
            }
            if (rest) { fenceCh = ''; fenceLen = 0; }
          }
        }
      }
      continue;
    }
    // Pop nested lists this line is outside of.
    while (listStack.length && !continues(line, listStack[listStack.length - 1])) listStack.pop();
    const f = matchFence(line);
    if (f) { fenceCh = f.ch; fenceLen = f.len; continue; }
    const mm = matchListMarker(line);
    if (mm) listStack.push({ m: ind.cols, c: mm.contentCols });
  }
  return false;
}

// Collect one list item's lines starting at lines[i] (a marker line `m`).
// Returns {lines, next, hasInnerBlank, hasTrailingBlank, lazy} — lines are
// content-stripped; `lazy` holds indices of lazy paragraph continuations.
function collectListItem(lines, i, end, m) {
  const out = [];
  const lazy = new Set();
  let inPara = false;
  let hasContent = false;
  if (m.first !== '') {
    out.push(m.first);
    hasContent = true;
    inPara = bqLineHasPara(m.first);
  }
  let j = i + 1;
  const contentCols = m.contentCols;
  while (j < end) {
    const line = lines[j];
    if (isBlank(line)) {
      // An empty item followed by a blank line is closed: the blank line
      // ends the item and the next line is a new block outside the list.
      if (!hasContent) break;
      out.push('');
      inPara = false;
      j++;
      continue;
    }
    const ind = lineIndent(line);
    if (ind.cols >= contentCols) {
      const stripped = sliceAtColExpand(line, contentCols);
      out.push(stripped);
      hasContent = true;
      inPara = bqLineHasPara(stripped);
      j++;
      continue;
    }
    // Less indented: any list marker ends the item (a new list starts at
    // the outer level, same list or a different delimiter); a block that
    // can interrupt a paragraph ends it; otherwise a lazy paragraph
    // continuation (up to 4 columns stripped, stays paragraph text).
    const mm = matchListMarker(line);
    if (mm) break;
    if (isInterruptBlockStart(line)) break;
    if (inPara && !isTableStart(lines, j, end)) {
      // A setext underline cannot be a lazy continuation: indent it by 4
      // spaces so it stays paragraph text.
      if (matchSetext(line)) out.push('    ' + line.replace(/^[ \t]+/, ''));
      else out.push(lazyBqLine(line));
      lazy.add(out.length - 1);
      j++;
      continue;
    }
    break;
  }
  // Trim trailing blank lines; record whether any blank remains inside.
  let trailing = 0;
  while (out.length && out[out.length - 1] === '') { out.pop(); trailing++; }
  return { lines: out, next: j, hasInnerBlank: computeInnerBlank(out), hasTrailingBlank: trailing > 0, lazy };
}

// The block parser over lines[start..end). `tight` suppresses <p> wrappers
// (paragraphs inside tight list items). `endsWithNL` says whether the
// document's last line was newline-terminated (HTML block trailing newline).
// When `collect` is true, only link reference definitions are collected
// (no inline rendering, no HTML output) — a cheap pre-pass so definitions
// that appear after their first use are still available when rendering.
// `lazySet` (optional) holds indices into `lines` that are lazy blockquote
// continuations, which never start a new block.
function parseBlocks(lines, start, end, refs, tight, endsWithNL, collect, lazySet, inListItem) {
  let out = '';
  let i = start;
  while (i < end) {
    const line = lines[i];
    if (isBlank(line)) { i++; continue; }
    // Link reference definitions (only at block starts).
    const def = tryParseRefDef(lines, i, end);
    if (def) {
      if (!refs.has(def.label)) refs.set(def.label, { href: def.href, title: def.title });
      i += def.linesUsed;
      continue;
    }
    const { cols, idx } = lineIndent(line);
    // Indented code
    if (cols >= 4) {
      const codeLines = [];
      let j = i;
      while (j < end) {
        const l = lines[j];
        // A whitespace-only line inside the block keeps its content after
        // stripping 4 columns (e.g. 6 spaces -> 2 spaces); a truly empty
        // line contributes ''.
        if (isBlank(l)) { codeLines.push(stripCols(l, 4)); j++; continue; }
        if (lineIndent(l).cols >= 4) { codeLines.push(stripCols(l, 4)); j++; continue; }
        break;
      }
      while (codeLines.length && isBlank(codeLines[codeLines.length - 1])) codeLines.pop();
      if (!collect) out += '<pre><code>' + escAll(codeLines.join('\n') + (codeLines.length ? '\n' : '')) + '</code></pre>\n';
      i = j;
      continue;
    }
    // Fenced code
    const fence = matchFence(line);
    if (fence) {
      const content = [];
      let j = i + 1;
      let closed = false;
      while (j < end) {
        const l = lines[j];
        const li = lineIndent(l);
        if (li.cols <= 3) {
          let k = li.idx;
          const c = l.charCodeAt(k);
          if (c === fence.ch.charCodeAt(0)) {
            let run = 0;
            while (k < l.length && l.charCodeAt(k) === c) { run++; k++; }
            if (run >= fence.len) {
              let rest = true;
              while (k < l.length) {
                if (l.charCodeAt(k) !== SPACE && l.charCodeAt(k) !== TAB) { rest = false; break; }
                k++;
              }
              if (rest) { closed = true; j++; break; }
            }
          }
        }
        content.push(stripFenceIndent(l, fence.indentChars));
        j++;
      }
      const info = fence.info.trim();
      let lang = '';
      if (info) {
        const sp = info.search(/[ \t]/);
        lang = sp < 0 ? info : info.slice(0, sp);
        // Backslash escapes in the info string are removed (e.g. \+ -> +).
        if (lang.indexOf('\\') >= 0) lang = lang.replace(/\\([!"#$%&'()*+,\-.\/:;<=>?@\[\\\]^_`{|}~])/g, '$1');
      }
      // marked's fence regex captures the content without the newline that
      // precedes the closing fence, so one trailing blank line is dropped
      // when the fence is closed.
      if (closed && content.length && content[content.length - 1] === '') content.pop();
      if (!collect) out += '<pre><code' + (lang ? ' class="language-' + escSmart(lang, false) + '"' : '') + '>' +
        escAll(content.join('\n') + (content.length ? '\n' : '')) + '</code></pre>\n';
      i = j;
      continue;
    }
    // ATX heading
    const atx = matchATX(line);
    if (atx) {
      if (!collect) out += '<h' + atx.level + '>' + inlineToHtml(atx.text, refs) + '</h' + atx.level + '>\n';
      i++;
      continue;
    }
    // Thematic break
    if (matchHR(line)) {
      if (!collect) out += '<hr>\n';
      i++;
      continue;
    }
    // HTML block (types 1-6 here; type 7 also starts a block at block start)
    const hb = matchHtmlBlockStart(line);
    if (hb) {
      let j = i;
      if (hb.type === 6 || hb.type === 7) {
        j = i + 1;
        while (j < end && !isBlank(lines[j])) j++;
      } else if (hb.type === 1) {
        // type 1 ends at a line containing the matching end tag
        // (case-insensitive, optional spaces before '>')
        const tag = hb.tag;
        j = i;
        while (j < end) {
          const ll = lines[j].toLowerCase();
          const p = ll.indexOf('</' + tag);
          if (p >= 0) {
            let q = p + 2 + tag.length;
            while (q < ll.length && (ll.charCodeAt(q) === SPACE || ll.charCodeAt(q) === TAB)) q++;
            if (q < ll.length && ll.charCodeAt(q) === GT) { j++; break; }
          }
          j++;
        }
      } else {
        // types 2-5: end at the first line containing the end marker
        j = i;
        while (j < end) {
          if (lines[j].indexOf(hb.endMarker) >= 0) { j++; break; }
          j++;
        }
      }
      const blockLines = lines.slice(i, j);
      // Trailing newline: kept iff the last line was newline-terminated and
      // the following line is not blank. Types 1-5 end at an end marker, so
      // only a truly EMPTY line ("") suppresses it — a whitespace-only
      // line does not (doc-15 comment + tab line keeps it). Types 6-7 end
      // at a blank line, so any whitespace-only line suppresses it
      // (doc-03 div + tab line drops it).
      const lastHasNL = (j - 1 < end - 1) || endsWithNL;
      const nextBlank = hb.type === 6 || hb.type === 7
        ? (j < end && isBlank(lines[j]))
        : (j < end && lines[j] === '');
      if (!collect) out += blockLines.join('\n') + (lastHasNL && !nextBlank ? '\n' : '');
      i = j;
      continue;
    }
    // Blockquote
    if (cols <= 3 && idx < line.length && line.charCodeAt(idx) === GT) {
      const bq = collectBlockquote(lines, i, end);
      // The stripped content is a synthetic document with no trailing
      // newline, so endsWithNL is false here (an HTML block at the end of
      // the content gets no trailing newline).
      if (!collect) out += '<blockquote>\n' + parseBlocks(bq.lines, 0, bq.lines.length, refs, false, false, collect, bq.lazy, false) + '</blockquote>\n';
      else parseBlocks(bq.lines, 0, bq.lines.length, refs, false, false, collect, bq.lazy, false);
      i = bq.next;
      continue;
    }
    // List
    const marker = matchListMarker(line);
    if (marker) {
      const ordered = marker.ordered, delim = marker.delim;
      const items = [];
      let j = i;
      let loose = false;
      let firstStart = marker.start;
      while (j < end) {
        let blanks = 0;
        while (j < end && isBlank(lines[j])) { blanks++; j++; }
        if (j >= end) break;
        // A thematic break ends the list even when it looks like a list
        // item (e.g. `* * *`).
        if (matchHR(lines[j])) break;
        const m = matchListMarker(lines[j]);
        if (!m || m.ordered !== ordered || m.delim !== delim) break;
        if (blanks > 0 && items.length > 0) loose = true;
        const item = collectListItem(lines, j, end, m);
        if (item.hasInnerBlank) loose = true;
        if (item.hasTrailingBlank && false) loose = true; // trailing blanks are counted via `blanks` above
        items.push(item);
        j = item.next;
      }
      if (items.some((it) => it.hasTrailingBlank)) {
        // a trailing blank inside an item that is followed by another item
        for (let k = 0; k < items.length - 1; k++) if (items[k].hasTrailingBlank) loose = true;
      }
      const tag = ordered ? 'ol' : 'ul';
      if (!collect) out += '<' + tag + (ordered && firstStart !== 1 ? ' start="' + firstStart + '"' : '') + '>\n';
      for (const item of items) {
        let itemLines = item.lines;
        let checkbox = null;
        if (!collect) {
        // Task list: first non-blank line starts with [ ] / [x] / [X]
        for (let k = 0; k < itemLines.length; k++) {
          if (itemLines[k] === '') continue;
          const tl = itemLines[k];
          if (tl.length >= 4 && tl.charCodeAt(0) === LSQ &&
              (tl.charCodeAt(1) === SPACE || tl.charCodeAt(1) === 120 || tl.charCodeAt(1) === 88) &&
              tl.charCodeAt(2) === RSQ &&
              (tl.charCodeAt(3) === SPACE || tl.charCodeAt(3) === TAB)) {
            let e = 3;
            while (e < tl.length && (tl.charCodeAt(e) === SPACE || tl.charCodeAt(e) === TAB)) e++;
            if (e < tl.length) {
              const checked = tl.charCodeAt(1) === 120 || tl.charCodeAt(1) === 88;
              checkbox = checked
                ? '<input checked="" disabled="" type="checkbox"> '
                : '<input disabled="" type="checkbox"> ';
              itemLines = itemLines.slice();
              itemLines[k] = tl.slice(e);
              break;
            }
          }
          break; // only the first non-blank line can be a task marker
        }
        }
        const inner = parseBlocks(itemLines, 0, itemLines.length, refs, !loose, false, collect, item.lazy, true);
        if (collect) continue;
        let body = inner;
        if (checkbox) {
          body = body.startsWith('<p>') ? '<p>' + checkbox + body.slice(3) : checkbox + body;
        }
        out += '<li>' + body + '</li>\n';
      }
      if (!collect) out += '</' + tag + '>\n';
      i = j;
      continue;
    }
    // Table
    const align = isTableStart(lines, i, end);
    if (align) {
      const t = renderTable(lines, i, end, refs, align, collect);
      if (!collect) out += t.html;
      i = t.next;
      continue;
    }
    // Paragraph (with a possible setext heading)
    const paraLines = [];
    let j = i;
    let setext = 0;
    while (j < end) {
      const l = lines[j];
      // A blank line ends the paragraph — except a whitespace-only line
      // that is the last line of the (sub)document and is not followed by
      // a newline: marked's paragraph pattern treats it as a continuation
      // (its `[ \t]+\n` lookahead only matches whitespace followed by a
      // newline).
      if (isBlank(l) && !(j === end - 1 && l.length > 0 && !endsWithNL)) break;
      if (paraLines.length > 0 && !(lazySet && lazySet.has(j))) {
        const su = matchSetext(l);
        if (su) {
          if (isTableStart(lines, j, end)) break;
          setext = su;
          j++;
          break;
        }
        if (isTableStart(lines, j, end)) break;
        if (isInterruptBlockStart(l, inListItem)) break;
      }
      paraLines.push(l);
      j++;
    }
    if (setext) {
      if (!collect) {
        // Setext heading text is the paragraph text with leading/trailing
        // spaces and tabs stripped (unlike a paragraph, which keeps them).
        const text = paraLines.join('\n').replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
        out += '<h' + setext + '>' + inlineToHtml(text, refs) + '</h' + setext + '>\n';
      }
    } else if (paraLines.length) {
      if (!collect) {
        const text = inlineToHtml(paraLines.join('\n'), refs);
        out += tight ? text : '<p>' + text + '</p>\n';
      }
    }
    i = j;
    continue;
  }
  return out;
}

// Persistent lexer state (marked quirk): an opening inline `<a ...>` tag
// sets inLink, which suppresses bare-URL/email autolinks until a closing
// `</a>` tag clears it. The flag lives on the lexer, so it persists across
// blocks and paragraphs for the whole document (an unclosed `<a>` silences
// every later bare autolink). Reset per parse() call.
let inLinkState = false;

export function parse(markdown) {
  inLinkState = false;
  const src = String(markdown).replace(/\r\n?/g, '\n');
  const refs = new Map();
  const endsWithNL = src.endsWith('\n');
  const lines = src.split('\n');
  if (endsWithNL) lines.pop();
  // Collect link reference definitions document-wide first (marked gathers
  // them while tokenizing blocks, before any inline rendering), so a
  // definition that appears after its first use still resolves.
  parseBlocks(lines, 0, lines.length, refs, false, endsWithNL, true);
  return parseBlocks(lines, 0, lines.length, refs, false, endsWithNL, false);
}
