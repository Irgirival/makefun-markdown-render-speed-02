// Fast CommonMark 0.31.2 + GFM 0.29 renderer, byte-compatible with marked
// 18.1.3 (default options: gfm on, breaks off). parse(markdown) returns
// exactly the HTML marked renders, for every input.
//
// My layout (written in this session, from the marked 18.1.3 behaviour):
//   1. character codes + character-class helpers
//   2. text escaping, entity decoding, URL cleaning, label normalising
//   3. small scanners shared by the block layer (reference labels, link
//      titles, inline HTML tags)
//   4. the inline engine: a direct-render port of marked's inline
//      tokenizer. It renders HTML while tokenizing, with no token tree
//      in between, and dispatches each tokenizer on the first character.
//   5. the block layer: line-based recursive descent over an array of
//      lines (paragraphs, ATX/setext headings, fences, lists,
//      blockquotes, tables, HTML blocks, reference definitions).
//   6. parse(): normalise line endings, collect reference definitions
//      document-wide, then render the blocks.
//
// No dependencies. No per-case state survives a parse() call: the inline
// `<a>` flag and the other module flags are reset on every call.

// Character codes used across the parser.
const C_AMP = 38, C_LT = 60, C_GT = 62, C_QUOT = 34, C_APOS = 39;
const C_BSLASH = 92, C_STAR = 42, C_UNDER = 95, C_TILDE = 126;
const C_TICK = 96, C_LBRK = 91, C_RBRK = 93;
const C_SP = 32, C_TAB = 9, C_LF = 10;

// Placeholder for a backslash-escaped '&' in inline text: it must render
// as &amp; (not start an entity reference) in HTML, but as a plain '&' in
// plain-text renderings (alt text, link labels). U+E000, a private-use code
// point that never appears in real input.
const ESC_AMP = '';

function isSpace(c) { return c === C_SP || c === C_TAB; }
function isAlnum(c) {
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
}
// ASCII punctuation per CommonMark:
// ! " # $ % & ' ( ) * + , - . / : ; < = > ? @ [ \ ] ^ _ ` { | } ~
function isAsciiPunct(c) {
  return (c >= 33 && c <= 47) || (c >= 58 && c <= 64) ||
    (c >= 91 && c <= 96) || (c >= 123 && c <= 126);
}
function isUniSpace(c) {
  return c === 32 || c === 9 || c === 10 || c === 11 || c === 12 || c === 13 ||
    c === 0x85 || c === 0xa0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) ||
    c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000;
}

// Decode one numeric character-reference body (the text after "&#" or
// "&#x"). Returns the code point, or -1 when it must stay literal (out of
// range or empty). 0 maps to U+FFFD, as do surrogates (marked behaviour).
function numericRef(body, hex) {
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
function escapeText(s, decodeNumeric) {
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
    if (c === C_AMP) {
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
          const v = numericRef(s.slice(nameStart, j), hex);
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
    } else if (c === C_LT) { out += s.slice(start, i) + '&lt;'; i++; start = i; continue; }
    else if (c === C_GT) { out += s.slice(start, i) + '&gt;'; i++; start = i; continue; }
    else if (c === C_QUOT) { out += s.slice(start, i) + '&quot;'; i++; start = i; continue; }
    else if (c === C_APOS) { out += s.slice(start, i) + '&#39;'; i++; start = i; continue; }
    i++;
  }
  return start === 0 ? s : out + s.slice(start);
}

// Escape code content: every & < > " ' is escaped, entities included.
function escapeCode(s) {
  if (s.indexOf('&') < 0 && s.indexOf('<') < 0 && s.indexOf('>') < 0 &&
      s.indexOf('"') < 0 && s.indexOf("'") < 0) return s;
  let out = '', i = 0, n = s.length, start = 0;
  while (i < n) {
    const c = s.charCodeAt(i);
    let rep = null;
    if (c === C_AMP) rep = '&amp;';
    else if (c === C_LT) rep = '&lt;';
    else if (c === C_GT) rep = '&gt;';
    else if (c === C_QUOT) rep = '&quot;';
    else if (c === C_APOS) rep = '&#39;';
    if (rep !== null) { out += s.slice(start, i) + rep; i++; start = i; continue; }
    i++;
  }
  return out + s.slice(start);
}

// marked's cleanUrl: encodeURI, with %25 folded back to % (so a literal %
// or an already-encoded %20 survives unchanged).
function cleanHref(href) {
  try { return encodeURI(href).replace(/%25/g, '%'); } catch { return href; }
}

// Normalise a link label for reference lookup: collapse whitespace runs to
// one space, trim, lowercase. Backslash escapes are NOT resolved for
// matching: `foo\!` and `foo!` are different labels. Case folding maps
// ß/ẞ to "ss" (ẞ lowercases to ß first).
function normalizeRef(s) {
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
// Small scanners shared by the block layer
// ---------------------------------------------------------------------------

// Scan a link label starting at src[i] === '['. Returns {label, end} where
// end is the index just past the matching ']' (label is the raw inner text),
// or null. This is marked's `le` pattern (used for reference definitions
// and for the second bracket of a full reference link): no nested brackets,
// escaped chars allowed, and a newline is allowed only if it is not followed
// by a blank line.
function scanRefLabel(src, i) {
  const n = src.length;
  let j = i + 1;
  while (j < n) {
    const c = src.charCodeAt(j);
    if (c === C_BSLASH) { j += 2; continue; }
    if (c === C_LBRK) return null; // nested '[' not allowed in `le`
    if (c === C_RBRK) return { label: src.slice(i + 1, j), end: j + 1 };
    if (c === C_LF) {
      // newline allowed only if not followed by a blank line
      let m = j + 1;
      while (m < n && (src.charCodeAt(m) === C_SP || src.charCodeAt(m) === C_TAB)) m++;
      if (m >= n || src.charCodeAt(m) === C_LF) return null;
      j++;
      continue;
    }
    j++;
  }
  return null;
}

// Parse a link title starting at src[i] (after optional spaces/newlines).
// Returns {title, end} or null. Titles are "..." / '...' / (...).
// Marked's title patterns differ per quote: "..." and (...) may span any
// newlines; '...' may span a newline only if it is not followed by a
// newline (i.e. it cannot span a blank line).
function parseLinkTitle(src, i) {
  const n = src.length;
  if (i >= n) return null;
  const q = src.charCodeAt(i);
  let close, allowParen = false, single = false;
  if (q === C_QUOT || q === C_APOS) { close = q; single = q === C_APOS; }
  else if (q === 40) { close = 41; allowParen = true; }
  else return null;
  let j = i + 1, out = '';
  while (j < n) {
    const c = src.charCodeAt(j);
    if (c === close) return { title: out, end: j + 1 };
    if (c === C_BSLASH && j + 1 < n && isAsciiPunct(src.charCodeAt(j + 1))) {
      out += src[j + 1]; j += 2; continue;
    }
    if (allowParen && c === 40) return null; // unescaped '(' not allowed in (...)
    if (single && c === C_LF && j + 1 < n && src.charCodeAt(j + 1) === C_LF) return null;
    out += src[j]; j++;
  }
  return null;
}

// Scan one inline HTML tag starting at src[i] === '<'. Returns {end} (the
// index just past the tag) or null when the text is not a tag. Covers
// comments, CDATA, processing instructions, declarations, open tags and
// closing tags, following marked's `tag` rule.
function scanTag(src, i) {
  const n = src.length;
  if (src.charCodeAt(i) !== C_LT || i + 1 >= n) return null;
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
    if (i + 2 < n) {
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
    while (j < n && isSpace(src.charCodeAt(j))) j++;
    return (j < n && src.charCodeAt(j) === C_GT) ? { end: j + 1 } : null;
  }
  // Open tag: each attribute must be preceded by whitespace; a name or
  // value directly abutting the tag name or a previous value is not a tag.
  // `sawWs` carries over the separator skipped after an attribute name.
  let sawWs = false;
  while (j < n) {
    while (j < n && (isSpace(src.charCodeAt(j)) || src.charCodeAt(j) === C_LF)) { j++; sawWs = true; }
    if (j >= n) return null;
    const c = src.charCodeAt(j);
    if (c === C_GT) return { end: j + 1 };
    if (c === 47) { // '/'
      if (j + 1 < n && src.charCodeAt(j + 1) === C_GT) return { end: j + 2 };
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
    while (j < n && (isSpace(src.charCodeAt(j)) || src.charCodeAt(j) === C_LF)) { j++; sawWs = true; }
    if (j < n && src.charCodeAt(j) === 61) { // '='
      j++;
      while (j < n && (isSpace(src.charCodeAt(j)) || src.charCodeAt(j) === C_LF)) j++;
      if (j >= n) return null;
      const q = src.charCodeAt(j);
      if (q === C_QUOT || q === C_APOS) {
        j++;
        while (j < n && src.charCodeAt(j) !== q) j++;
        if (j >= n) return null;
        j++;
      } else {
        // unquoted value: no space, ", ', =, <, >, `
        let any = false;
        while (j < n) {
          const d = src.charCodeAt(j);
          if (isSpace(d) || d === C_LF || d === C_QUOT || d === C_APOS || d === 61 ||
              d === C_LT || d === C_GT || d === C_TICK) break;
          any = true; j++;
        }
        if (!any) return null;
      }
      sawWs = false;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Inline engine — direct-render port of marked 18.1.3's inline pipeline
// (Lexer.inlineTokens + Tokenizer + Renderer + TextRenderer, GFM rules).
// It renders HTML directly while tokenizing (no token tree), which keeps it
// faster than marked's build-then-render pass. The regexes below are
// marked 18.1.3's inline.gfm rules, taken from the vendored oracle in the
// kit (baselines/vendor/marked/marked.esm.js).
// ---------------------------------------------------------------------------

const RX_ESCAPE = /^\\([!"#$%&'()*+,\-.\/:;<=>?@\[\]\\^_`{|}~])/;
const RX_CODE = /^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/;
const RX_BR = /^( {2,}|\\)\n(?!\s*$)[ \t]*/;
const RX_TEXT = /^(?:[^a-zA-Z0-9](?=(?:mailto|xmpp):)|(`+|~+|[^`~])(?:(?=[`~])|(?= {2,}\n)|(?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@)|[\s\S]*?(?:(?=[\\<!\[`*~_]|\b_|[hH][tT][tT][pP][sS]?|[fF][tT][pP]:\/\/|(?<![^\s*_~(])www\.|$)|[^ ](?= {2,}\n)|[^a-zA-Z0-9](?=(?:mailto|xmpp):)|[^a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-](?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@))))/;
const RX_PUNCT = /^((?![*_])[\s\p{P}\p{S}])/u;
const RX_BLOCKSKIP = /\[(?:[^\[\]`]|(?<a>`+)[^`]+\k<a>(?!`))*?\]\((?:\\[\s\S]|[^\\\(\)]|\((?:\\[\s\S]|[^\\\(\)])*\))*\)|(?<!`)()(?<b>`+)[^`]+\k<b>(?!`)|<(?! )[^<>]*?>/g;
const RX_AUTOLINK = /^<([a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^\s\x00-\x1f<>]*|[a-zA-Z0-9.!#$%&'*+\/=?_`{|}~-]+(@)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_]))>/;
const RX_TAG = /^<!--(?:-?>|[\s\S]*?-->)|^<\/[a-zA-Z][a-zA-Z0-9-]*\s*>|^<[a-zA-Z][a-zA-Z0-9-]*(?:\s+[a-zA-Z:_][\w.:-]*(?:\s*=\s*"[^"]*"|\s*=\s*'[^']*'|\s*=\s*[^\s"'=<>`]+)?)*?\s*\/?>|^<\?[\s\S]*?\?>|^<![a-zA-Z]+\s[\s\S]*?>|^<!\[CDATA\[[\s\S]*?\]\]>/;
const RX_LINK = /^!?\[((?:\[(?:\[(?:\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\])|[^\[\]\\`])*?)\]\([ \t\n]*(<(?:\\.|[^\n<>\\])+>|[^ \t\n\x00-\x1f]+|(?=\)))(?:(?:[ \t]+(?:\n[ \t]*)?|\n[ \t]*)("(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|\((?:\\[\s\S]|[^)\\])*\)))?[ \t\n]*\)/;
const RX_REFLINK = /^!?\[((?:\[(?:\[(?:\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\])|[^\[\]\\`])*?)\]\[((?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+)\]/;
const RX_NOLINK = /^!?\[((?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+)\](?:\[\])?/;
const RX_REFLINKSEARCH = /!?\[((?:[^\[\]\\`]*(?:\[(?:\[(?:\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\]))){0,999}?[^\[\]\\`]*?)\]\[((?!\s*\])(?:\\[\s\S]|[^\[\]\\]){1,999})\]|!?\[((?!\s*\])(?:\\[\s\S]|[^\[\]\\]){1,999})\](?:\[\])?(?!\()/g;
const RX_URL = /^(?:mailto:[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])|xmpp:[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])(?:\/[A-Za-z0-9@.]+)?)|^((?:[hH][tT][tT][pP][sS]?|[fF][tT][pP]):\/\/|www\.)(?:[a-zA-Z0-9\-]+\.?)+[^\s<]*|^[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/;
const RX_BACKPEDAL = /(?:[^?!.,:;*_'"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'"~)]+(?!$))+/;
const RX_DEL_LDELIM = /^~~?(?:((?!~)[\p{P}\p{S}])|[^\s~])/u;
const RX_DEL_RDELIM = /^[^~]+(?=[^~])|(?!~)[\p{P}\p{S}](~~?)(?=[\s]|$)|[^\s\p{P}\p{S}](~~?)(?!~)(?=[\s\p{P}\p{S}]|$)|(?!~)[\s\p{P}\p{S}](~~?)(?=[^\s\p{P}\p{S}])|[\s](~~?)(?!~)(?=[\p{P}\p{S}])|(?!~)[\p{P}\p{S}](~~?)(?!~)(?=[\p{P}\p{S}])|[^\s\p{P}\p{S}](~~?)(?=[^\s\p{P}\p{S}])/gu;
const RX_EM_LDELIM = /^(?:\*+(?:((?!\*)(?!~)[\p{P}\p{S}])|([^\s*]))?)|^_+(?:((?!_)(?!~)[\p{P}\p{S}])|([^\s_]))?/u;
const RX_EM_RDELIM_AST = /^[^_*]*?__[^_*]*?\*[^_*]*?(?=__)|[^*]+(?=[^*])|(?!\*)(?!~)[\p{P}\p{S}](\*+)(?=[\s]|$)|(?:[^\s\p{P}\p{S}]|~)(\*+)(?!\*)(?=(?!~)[\s\p{P}\p{S}]|$)|(?!\*)(?!~)[\s\p{P}\p{S}](\*+)(?=(?:[^\s\p{P}\p{S}]|~))|[\s](\*+)(?!\*)(?=(?!~)[\p{P}\p{S}])|(?!\*)(?!~)[\p{P}\p{S}](\*+)(?!\*)(?=(?!~)[\p{P}\p{S}])|(?:[^\s\p{P}\p{S}]|~)(\*+)(?=(?:[^\s\p{P}\p{S}]|~))/gu;
const RX_EM_RDELIM_UND = /^[^_*]*?\*\*[^_*]*?_[^_*]*?(?=\*\*)|[^_]+(?=[^_])|(?!_)[\p{P}\p{S}](_+)(?=[\s]|$)|[^\s\p{P}\p{S}](_+)(?!_)(?=[\s\p{P}\p{S}]|$)|(?!_)[\s\p{P}\p{S}](_+)(?=[^\s\p{P}\p{S}])|[\s](_+)(?!_)(?=[\p{P}\p{S}])|(?!_)[\p{P}\p{S}](_+)(?!_)(?=[\p{P}\p{S}])/gu;
const RX_ANY_PUNCT = /\\([\p{P}\p{S}])/gu;
const RX_ANY_PUNCT_OUTSIDE_CODE = /(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)|`+|\\([\p{P}\p{S}])/gu;
const RX_OUTPUT_LINK_REPLACE = /\\([\[\]])/g;
const RX_UNICODE_ALNUM = /[\p{L}\p{N}]/u;
const RX_START_A = /^<a /i;
const RX_END_A = /^<\/a>/i;
const RX_START_PRE = /^<(pre|code|kbd|script)(\s|>)/i;
const RX_END_PRE = /^<\/(pre|code|kbd|script)(\s|>)/i;
const RX_START_ANGLE = /^</;
const RX_END_ANGLE = />$/;
const RX_NUM_REF_TEST = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));/;
const RX_NUM_REF_OR_AMP = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;
const RX_NEWLINE = /\n/g;
const RX_NON_SPACE = /[^ ]/;

// marked's escape: encode=true escapes &<>"'; encode=false escapes
// <>"' and a bare & not starting a valid reference.
const RX_ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const RX_ESC_TEST = /[&<>"']/;
const RX_ESC_REPLACE = /[&<>"']/g;
const RX_ESC_NOENC_TEST = /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/;
const RX_ESC_NOENC_REPLACE = /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;
function escHtml(a, encode) {
  if (encode) {
    if (RX_ESC_TEST.test(a)) return a.replace(RX_ESC_REPLACE, c => RX_ESC_MAP[c]);
  } else if (RX_ESC_NOENC_TEST.test(a)) {
    return a.replace(RX_ESC_NOENC_REPLACE, c => RX_ESC_MAP[c]);
  }
  return a;
}

// marked's entity decoder for text: decode numeric character references
// only (named entities stay verbatim); a bare & not starting a valid
// reference becomes &amp;.
function decodeNumRefs(a) {
  if (!RX_NUM_REF_TEST.test(a)) return a;
  return a.replace(RX_NUM_REF_OR_AMP, (e, t, n) => {
    if (t === void 0 && n === void 0) return '&amp;';
    const s = t === void 0 ? Number.parseInt(n, 16) : Number.parseInt(t, 10);
    return s === 0 || s > 1114111 || (s >= 55296 && s <= 57343) ? '\uFFFD' :
      s === 38 ? '&amp;' : String.fromCodePoint(s);
  });
}

// Per-parse inline state (marked's Lexer.state). gInLink is the shared
// module flag (persists across blocks, like marked); the rest reset per
// parse() call, and gInRaw resets at the start of each top-level
// inlineHtml call (marked resets it per inlineQueue entry).
let gRefs = null;
let gInRaw = false;
let gLinkEmitted = false;
let gParenPossible = true;

// marked's "find last closer": for a masked source, the last possible
// closer indices for a delimiter run whose preceding char is not
// whitespace.
function lastClosers(a) {
  const e = { '*': -1, '_': -1 };
  let t = -1;
  const n = a.length;
  for (let s = 0; s < n; s++) {
    const r = a[s];
    if (r !== '*' && r !== '_' && r !== '~') continue;
    const o = s === 0 ? '\n' : a[s - 1];
    let i = s + 1;
    for (; i < n && a[i] === r; ) i++;
    if (o !== ' ' && o !== '\t' && o !== '\n' && o !== '\r' && o !== '\f') {
      if (r === '~') t = s; else e[r] = s;
    }
    s = i - 1;
  }
  return { maskedSrc: a, lastPossibleEmStrongCloserIndex: e, lastPossibleDelCloserIndex: t };
}

// marked's linkInText: does `e` contain a (non-image) link to a defined ref
// whose label does not itself contain a link? The first loop catches INLINE
// links: a blockSkip match that the link regex accepts, not preceded by '!'.
function textHasLink(e) {
  if (!e.includes('[')) return false;
  for (const n of e.matchAll(RX_BLOCKSKIP)) {
    if (RX_LINK.test(n[0]) && e.charAt(n.index - 1) !== '!') return true;
  }
  for (const n of e.matchAll(RX_REFLINKSEARCH)) {
    const s = n[0], r = s.lastIndexOf('[');
    if (!(s.charAt(0) === '!' || !gRefs.has(normalizeRef(s.slice(r + 1, -1)))) &&
        !(r > 1 && textHasLink(s.slice(1, r - 1)))) return true;
  }
  return false;
}

// marked's emStrong mask. Length-preserving: reflink matches and
// blockSkip matches (links/code/html) become [aaa...], escaped punctuation
// becomes +, backticks inside code spans become +.
function buildMask(src) {
  let t = src;
  if (gRefs && gRefs.size > 0 && src.includes('[')) {
    const n = RX_REFLINKSEARCH;
    const s = r => {
      const o = r.lastIndexOf('[');
      if (!gRefs.has(normalizeRef(r.slice(o + 1, -1)))) return r;
      if (o > 1 && r.charAt(0) !== '!') {
        const i = r.slice(1, o - 1);
        if (textHasLink(i)) return '[' + i.replace(n, s) + '][' + 'a'.repeat(r.length - o - 2) + ']';
      }
      return '[' + 'a'.repeat(r.length - 2) + ']';
    };
    t = t.replace(n, s);
  }
  t = t.replace(RX_ANY_PUNCT_OUTSIDE_CODE, (n, s, r) =>
    r ? '+'.repeat(n.length) : s ? s + n.slice(s.length, -s.length).replace(/`/g, '+') + s : n);
  t = t.replace(RX_BLOCKSKIP, (n, s, r) => {
    const o = r ? r.length : 0;
    return n.slice(0, o) + '[' + 'a'.repeat(n.length - o - 2) + ']';
  });
  return t;
}

// marked's "strip trailing backslashes" helper (its `t` argument is never
// passed by marked, so this takes one argument).
function stripTrailingBs(a) {
  const n = a.length;
  let s = 0;
  for (; s < n; ) {
    const r = a.charAt(n - s - 1);
    if (r === '\\') s++;
    else break;
  }
  return a.slice(0, n - s);
}

// marked's paren-balance check for a bare destination. -1 = no parens,
// -2 = unclosed '(', otherwise the index of the ')' closing the outermost '('.
function parenBalance(a) {
  if (a.indexOf('(') === -1 && a.indexOf(')') === -1) return -1;
  let t = 0;
  for (let n = 0; n < a.length; n++) {
    if (a[n] === '\\') n++;
    else if (a[n] === '(') t++;
    else if (a[n] === ')' && (t--, t < 0)) return n;
  }
  return t > 0 ? -2 : -1;
}

// marked's "tag extends past the label" check: does the link label contain
// a <tag/autolink that extends past the label end? `a` is the remaining
// source, `e` the label text, `t` the index of the label's first char in `a`.
function tagOverrunsLabel(a, e, t) {
  if (!e.includes('<')) return false;
  for (let s = 0; s < e.length; s++) {
    if (e[s] === '\\') { s++; continue; }
    if (e[s] === '`') {
      const i = RX_CODE.exec(e.slice(s));
      if (i) { s += i[0].length - 1; continue; }
    }
    if (e[s] !== '<') continue;
    const r = a.slice(t + s);
    const o = RX_TAG.exec(r) || RX_AUTOLINK.exec(r);
    if (o) {
      if (o[0].length > e.length - s) return true;
      s += o[0].length - 1;
    }
  }
  return false;
}

// marked's link formation + Renderer.link/image, direct-rendered.
// Renders the label with renderInline: plain text for images (the alt is
// always text-rendered), otherwise in the current mode (a link inside an
// image alt renders its label as plain text). Returns the HTML string, or
// null when the link is rejected (label contains a link).
function makeLink(match, href, title, isImage, textOnly) {
  const labelText = match[1].replace(RX_OUTPUT_LINK_REPLACE, '$1');
  const savedInLink = gInLink, savedLinkEmitted = gLinkEmitted, savedInRaw = gInRaw;
  gInLink = true;
  gLinkEmitted = false;
  const labelHtml = renderInline(labelText, isImage ? true : textOnly);
  const k = gLinkEmitted;
  gLinkEmitted = savedLinkEmitted;
  gInLink = savedInLink;
  if (!isImage) {
    if (k) { gInRaw = savedInRaw; return null; }
    gLinkEmitted = true;
  }
  if (textOnly) return labelHtml;
  if (isImage) {
    let out = '<img src="' + escHtml(cleanHref(href), false) + '" alt="' + escHtml(labelHtml, false) + '"';
    if (title) out += ' title="' + escHtml(title, false) + '"';
    return out + '>';
  }
  let out = '<a href="' + escHtml(cleanHref(href), false) + '"';
  if (title) out += ' title="' + escHtml(title, false) + '"';
  return out + '>' + labelHtml + '</a>';
}

// Tokenizers. Each returns {raw, html} (and isText for tokText), or null.
// The first-char dispatch in renderInline preserves marked's tokenizer
// order: each regex is anchored and can only match a string starting with
// its own first char, so tokenizers that cannot match are skipped entirely.

function tokEscape(e, textOnly) {
  const t = RX_ESCAPE.exec(e);
  if (!t) return null;
  return { raw: t[0], html: textOnly ? t[1] : escHtml(t[1], false) };
}

function tokTag(e) {
  const t = RX_TAG.exec(e);
  if (!t) return null;
  if (!gInLink && RX_START_A.test(t[0])) gInLink = true;
  else if (gInLink && RX_END_A.test(t[0])) gInLink = false;
  if (!gInRaw && RX_START_PRE.test(t[0])) gInRaw = true;
  else if (gInRaw && RX_END_PRE.test(t[0])) gInRaw = false;
  return { raw: t[0], html: t[0] };
}

function tokLink(e, textOnly) {
  if (gParenPossible === false) return null;
  const t = RX_LINK.exec(e);
  if (!t) return null;
  const n = t[0].charAt(0) === '!' ? 2 : 1;
  if (tagOverrunsLabel(e, t[1], n)) return null;
  const s = t[2].trim();
  if (RX_START_ANGLE.test(s)) {
    if (!RX_END_ANGLE.test(s)) return null;
    const l = stripTrailingBs(s.slice(0, -1));
    if ((s.length - l.length) % 2 === 0) return null;
  } else {
    const l = parenBalance(t[2]);
    if (l === -2) return null;
    if (l > -1) {
      const h = (t[0].indexOf('!') === 0 ? 5 : 4) + t[1].length + l;
      t[2] = t[2].substring(0, l);
      t[0] = t[0].substring(0, h).trim();
      t[3] = '';
    }
  }
  const r = stripTrailingBs(t[0].slice(0, -1));
  if ((t[0].length - r.length) % 2 === 0) return null;
  let o = t[2];
  let i = t[3] ? t[3].slice(1, -1) : '';
  o = o.trim();
  if (RX_START_ANGLE.test(o)) o = o.slice(1, -1);
  const html = makeLink(t, o && o.replace(RX_ANY_PUNCT, '$1'), i && i.replace(RX_ANY_PUNCT, '$1'), t[0].charAt(0) === '!', textOnly);
  if (html === null) return null;
  return { raw: t[0], html };
}

function tokReflink(e, textOnly) {
  let n = RX_REFLINK.exec(e) || RX_NOLINK.exec(e);
  if (!n) return null;
  const s = n[0].charAt(0) === '!' ? 2 : 1;
  if (tagOverrunsLabel(e, n[1], s)) return null;
  const r = gRefs.get(normalizeRef(n[2] || n[1]));
  if (!r) {
    // marked returns a bare text token of just the first char ('!' or '[');
    // it does not count as a text token for the emStrong prev-char rule.
    const o = n[0].charAt(0);
    return { raw: o, html: o };
  }
  const html = makeLink(n, r.href, r.title, n[0].charAt(0) === '!', textOnly);
  if (html === null) return null;
  return { raw: n[0], html };
}

function tokAutolink(e, textOnly) {
  const t = RX_AUTOLINK.exec(e);
  if (!t) return null;
  let n, s;
  if (t[2] === '@') { n = t[1]; s = 'mailto:' + n; }
  else { n = t[1]; s = n; }
  if (textOnly) return { raw: t[0], html: n };
  return { raw: t[0], html: '<a href="' + escHtml(cleanHref(s), true) + '">' + escHtml(n, true) + '</a>' };
}

function tokUrl(e, textOnly) {
  const t = RX_URL.exec(e);
  if (!t) return null;
  let n, s;
  if (t[2] === '@') { n = t[0]; s = 'mailto:' + n; }
  else {
    let r;
    do {
      r = t[0];
      t[0] = RX_BACKPEDAL.exec(t[0])?.[0] ?? '';
    } while (r !== t[0]);
    n = t[0];
    s = t[1] === 'www.' ? 'http://' + t[0] : t[0];
  }
  if (!n) return null;
  if (textOnly) return { raw: t[0], html: n };
  return { raw: t[0], html: '<a href="' + escHtml(cleanHref(s), true) + '">' + escHtml(n, true) + '</a>' };
}

function tokCodespan(e, textOnly) {
  const t = RX_CODE.exec(e);
  if (!t) return null;
  let n = t[2].replace(RX_NEWLINE, ' ');
  if (RX_NON_SPACE.test(n) && n.charCodeAt(0) === 32 && n.charCodeAt(n.length - 1) === 32) {
    n = n.substring(1, n.length - 1);
  }
  return { raw: t[0], html: textOnly ? n : '<code>' + escHtml(n, true) + '</code>' };
}

function tokBr(e, textOnly) {
  const t = RX_BR.exec(e);
  if (!t) return null;
  return { raw: t[0], html: textOnly ? '' : '<br>' };
}

function tokText(e, textOnly) {
  const t = RX_TEXT.exec(e);
  if (!t) return null;
  const raw = t[0];
  let html;
  if (textOnly) html = gInRaw ? raw : decodeNumRefs(raw);
  else html = gInRaw ? raw : escHtml(decodeNumRefs(raw), false);
  return { raw, html, isText: true };
}

// marked's Tokenizer.emStrong, direct-rendered. `e` is the remaining
// source, `mask` the full emStrong mask, `n` the previous char ('' unless
// the immediately preceding token was text), `closers` the lastClosers()
// result for the mask.
function tokEmStrong(e, mask, n, closers, textOnly) {
  let s = RX_EM_LDELIM.exec(e);
  if (!s || (!s[1] && !s[2] && !s[3] && !s[4])) return null;
  const r = s[0][0];
  const o = n === r;
  const i = mask.length - e.length;
  let l = i;
  for (; l > 0 && mask[l - 1] === r; ) l--;
  const p = [...mask.slice(Math.max(0, l - 2), l)].at(-1) ?? '';
  const h = p === '*' || p === '_' || !!RX_PUNCT.exec(p);
  if (l < i) n = p;
  const u = l < i ? h : !!RX_PUNCT.exec(n);
  if (s[4] && n.match(RX_UNICODE_ALNUM)) return null;
  const d = s[1] || s[3] || '';
  if (!d || !n || u) {
    const k = [...s[0]].length - 1;
    let g, b, m = k, f = 0;
    const y = i - l + k;
    const R = !!p.trim() && (!!d || (r === '*' && !h));
    if (r !== '*' && r !== '_') return null;
    const A = r === '*' ? RX_EM_RDELIM_AST : RX_EM_RDELIM_UND;
    const v = closers.lastPossibleEmStrongCloserIndex[r];
    const Q = mask.length - e.length + k;
    if (v < Q) return null;
    const mm = mask.slice(-1 * e.length + k);
    const ee = v - Q;
    for (A.lastIndex = 0; (s = A.exec(mm)) !== null && !(s.index > ee); ) {
      if (g = s[1] || s[2] || s[3] || s[4] || s[5] || s[6], !g) continue;
      if (b = [...g].length, s[3] || s[4]) { m += b; continue; }
      else if (s[5] || s[6] || R) {
        if (o && (s[5] || s[6])) break;
        if (y % 3 && !((y + b) % 3)) { f += b; continue; }
      }
      if (m -= b, m > 0) continue;
      b = Math.min(b, b + m + f);
      const te = [...s[0]][0].length;
      const M = e.slice(0, k + s.index + te + b);
      if (Math.min(k, b) % 2) {
        const U = M.slice(1, -1);
        return { raw: M, html: textOnly ? renderInline(U, true) : '<em>' + renderInline(U, textOnly) + '</em>' };
      }
      const ne = M.slice(2, -2);
      return { raw: M, html: textOnly ? renderInline(ne, true) : '<strong>' + renderInline(ne, textOnly) + '</strong>' };
    }
  }
  return null;
}

// marked's Tokenizer.del, direct-rendered.
function tokDel(e, mask, n, closers, textOnly) {
  let s = RX_DEL_LDELIM.exec(e);
  if (!s) return null;
  if (!(s[1] || '') || !n || RX_PUNCT.exec(n)) {
    const o = [...s[0]].length - 1;
    let i, l, p = o;
    const h = RX_DEL_RDELIM;
    const u = closers.lastPossibleDelCloserIndex;
    const d = mask.length - e.length + o;
    if (u < d) return null;
    const mm = mask.slice(-1 * e.length + o);
    const k = u - d;
    for (h.lastIndex = 0; (s = h.exec(mm)) !== null && !(s.index > k); ) {
      if (i = s[1] || s[2] || s[3] || s[4] || s[5] || s[6], !i || (l = [...i].length, l !== o)) continue;
      if (s[3] || s[4]) { p += l; continue; }
      if (p -= l, p > 0) continue;
      l = Math.min(l, l + p);
      const g = [...s[0]][0].length;
      const b = e.slice(0, o + s.index + g + l);
      const m = b.slice(o, -o);
      return { raw: b, html: textOnly ? renderInline(m, true) : '<del>' + renderInline(m, textOnly) + '</del>' };
    }
  }
  return null;
}

// marked's Lexer inlineTokens loop, direct-rendered. The mask and the
// lastClosers() result are computed once per call (only when the text
// contains *, _ or ~). Tokenizers are dispatched on the first character:
// every tokenizer's regex is anchored and can only match a string starting
// with its own first char, so the dispatch preserves marked's order
// exactly while skipping the regexes that cannot match.
function renderInline(src, textOnly) {
  if (!src) return '';
  const hasDelim = src.includes('*') || src.includes('_') || src.includes('~');
  const mask = hasDelim ? buildMask(src) : src;
  const closers = hasDelim ? lastClosers(mask) : null;
  const savedLPP = gParenPossible;
  gParenPossible = savedLPP && src.includes(')');
  let out = '';
  let e = src;
  let prevText = false, prevLast = '';
  let guard = Infinity;
  while (e) {
    if (e.length < guard) guard = e.length;
    else throw new Error('Infinite loop on byte: ' + e.charCodeAt(0));
    if (!prevText) prevLast = '';
    prevText = false;
    let tok = null;
    const c0 = e.charCodeAt(0);
    if (c0 === 92) { // backslash: escape, backslash hard break, or text
      tok = tokEscape(e, textOnly) || tokBr(e, textOnly) || tokText(e, textOnly);
    } else if (c0 === 60) { // <: tag, autolink, or text
      tok = tokTag(e) || tokAutolink(e, textOnly) || tokText(e, textOnly);
    } else if (c0 === 91 || c0 === 33) { // [ or !: link, reflink, or text
      tok = tokLink(e, textOnly) || tokReflink(e, textOnly) || tokText(e, textOnly);
    } else if (c0 === 42 || c0 === 95) { // * or _: emStrong or text
      tok = tokEmStrong(e, mask, prevLast, closers, textOnly) || tokText(e, textOnly);
    } else if (c0 === 96) { // `: codespan or text
      tok = tokCodespan(e, textOnly) || tokText(e, textOnly);
    } else if (c0 === 126) { // ~: del or text
      tok = tokDel(e, mask, prevLast, closers, textOnly) || tokText(e, textOnly);
    } else if (c0 === 32) { // space: br (two spaces + newline) or text
      tok = tokBr(e, textOnly) || tokText(e, textOnly);
    } else { // anything else: bare URL/email (unless inside a link), or text
      tok = (!gInLink && tokUrl(e, textOnly)) || tokText(e, textOnly);
    }
    if (!tok) throw new Error('Infinite loop on byte: ' + e.charCodeAt(0));
    out += tok.html;
    e = e.slice(tok.raw.length);
    if (tok.isText) {
      if (tok.raw.charCodeAt(tok.raw.length - 1) !== 95) prevLast = tok.raw.slice(-1);
      prevText = true;
    }
  }
  gParenPossible = savedLPP;
  return out;
}

// Full inline render of a source string (paragraph / heading / table cell).
function inlineHtml(src, refs) {
  if (!src) return '';
  gRefs = refs;
  gInRaw = false;
  return renderInline(src, false);
}

// ---------------------------------------------------------------------------
// Block layer: line utilities (tab aware, columns advance to multiples of 4)
// ---------------------------------------------------------------------------

// Leading indent of a line: {cols, idx} — cols counts columns (a tab
// advances to the next multiple of 4), idx is the first non-space char.
function indentOf(line) {
  let cols = 0, i = 0;
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if (c === C_SP) { cols++; i++; }
    else if (c === C_TAB) { cols += 4 - (cols % 4); i++; }
    else break;
  }
  return { cols, idx: i };
}

// Fence content dedent (marked's Dt): remove up to `n` leading
// whitespace CHARACTERS (a tab counts as 1 char, not 4 columns). This is
// different from stripColumns (column-based, used for list/blockquote
// dedent): a tab-indented fence line loses the whole tab, not just the
// fence indent's worth of columns.
function stripFence(line, n) {
  let i = 0;
  while (i < line.length && i < n) {
    const c = line.charCodeAt(i);
    if (c === C_SP || c === C_TAB) i++;
    else break;
  }
  return line.slice(i);
}

function stripColumns(line, n) {
  let cols = 0, i = 0;
  while (i < line.length && cols < n) {
    const c = line.charCodeAt(i);
    if (c === C_SP) { cols++; i++; }
    else if (c === C_TAB) {
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
function sliceColumn(line, col) {
  let cols = 0, i = 0;
  while (i < line.length && cols < col) {
    const c = line.charCodeAt(i);
    if (c === C_TAB) {
      const adv = 4 - (cols % 4);
      if (cols + adv > col) return ' '.repeat(cols + adv - col) + line.slice(i + 1);
      cols += adv; i++;
    } else { cols++; i++; }
  }
  return line.slice(i);
}

// Like sliceColumn, but any tab that remains in the leading whitespace of
// the result is expanded to spaces using its width in the ORIGINAL line.
// Use this when the result will be column-stripped again (list item and
// blockquote content): a raw tab would be re-measured from its new,
// narrower position and lose columns. Code content uses sliceColumn /
// stripColumns instead, which preserve tabs verbatim.
function sliceColumnExpand(line, col) {
  let cols = 0, i = 0, out = '';
  while (i < line.length && cols < col) {
    const c = line.charCodeAt(i);
    if (c === C_TAB) {
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
    if (c === C_SP) { out += ' '; cols++; i++; }
    else if (c === C_TAB) {
      const adv = 4 - (cols % 4);
      out += ' '.repeat(adv);
      cols += adv; i++;
    } else break;
  }
  return out + line.slice(i);
}

function isBlankLine(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== C_SP && c !== C_TAB) return false;
  }
  return true;
}

// Does `line` (already known non-blank) start a fenced code block?
// Returns {ch, len, info} or null. ch is '`' or '~', len the run length.
function fenceStart(line) {
  const { cols, idx } = indentOf(line);
  if (cols > 3) return null;
  const c = line.charCodeAt(idx);
  if (c !== C_TICK && c !== C_TILDE) return null;
  let j = idx;
  while (j < line.length && line.charCodeAt(j) === c) j++;
  const len = j - idx;
  if (len < 3) return null;
  const info = line.slice(j);
  if (c === C_TICK && info.indexOf('`') >= 0) return null;
  return { ch: String.fromCharCode(c), len, info, indentCols: cols, indentChars: idx };
}

function atxStart(line) {
  const { cols, idx } = indentOf(line);
  if (cols > 3) return null;
  let j = idx, level = 0;
  while (j < line.length && line.charCodeAt(j) === 35 && level < 7) { level++; j++; }
  if (level === 0 || level > 6) return null;
  if (j < line.length) {
    const c = line.charCodeAt(j);
    if (c !== C_SP && c !== C_TAB) return null;
  }
  let text = line.slice(j);
  // strip leading/trailing spaces, then a closing hash run preceded by space
  let a = 0, b = text.length;
  while (a < b && (text.charCodeAt(a) === C_SP || text.charCodeAt(a) === C_TAB)) a++;
  while (b > a && (text.charCodeAt(b - 1) === C_SP || text.charCodeAt(b - 1) === C_TAB)) b--;
  let e = b;
  while (e > a && text.charCodeAt(e - 1) === 35) e--;
  if (e < b && e >= a && (e === a || text.charCodeAt(e - 1) === C_SP || text.charCodeAt(e - 1) === C_TAB)) {
    b = e;
    while (b > a && (text.charCodeAt(b - 1) === C_SP || text.charCodeAt(b - 1) === C_TAB)) b--;
  }
  return { level, text: text.slice(a, b) };
}

function hrLine(line) {
  const { cols, idx } = indentOf(line);
  if (cols > 3) return null;
  let j = idx;
  const c = line.charCodeAt(j);
  if (c !== 45 && c !== 95 && c !== 42) return null; // - _ *
  let count = 0;
  while (j < line.length) {
    const d = line.charCodeAt(j);
    if (d === c) { count++; j++; }
    else if (d === C_SP || d === C_TAB) j++;
    else return null;
  }
  return count >= 3 ? true : null;
}

// Setext underline: returns 1 for '=', 2 for '-', or 0.
function setextLevel(line) {
  const { cols, idx } = indentOf(line);
  if (cols > 3) return 0;
  let j = idx;
  const c = line.charCodeAt(j);
  if (c !== 61 && c !== 45) return 0; // = -
  while (j < line.length && line.charCodeAt(j) === c) j++;
  while (j < line.length && (line.charCodeAt(j) === C_SP || line.charCodeAt(j) === C_TAB)) j++;
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
function htmlBlockStart(line) {
  const { cols, idx } = indentOf(line);
  if (cols > 3 || idx >= line.length || line.charCodeAt(idx) !== C_LT) return null;
  const rest = line.slice(idx);
  const lower = rest.toLowerCase();
  // type 1
  for (const tag of ['script', 'pre', 'style', 'textarea']) {
    if (lower.startsWith('<' + tag)) {
      const after = tag.length + 1 >= rest.length ? -1 : rest.charCodeAt(tag.length + 1);
      if (after === -1 || after === C_SP || after === C_TAB || after === C_GT) return { type: 1, endMarker: '</' + tag + '>', tag };
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
      if (after === -1 || after === C_SP || after === C_TAB || after === C_GT || after === 47) return { type: 6, endMarker: null };
    }
    // type 7: closing tag alone on the line
    let k = j;
    while (k < rest.length && (rest.charCodeAt(k) === C_SP || rest.charCodeAt(k) === C_TAB)) k++;
    if (k < rest.length && rest.charCodeAt(k) === C_GT) {
      k++;
      while (k < rest.length && (rest.charCodeAt(k) === C_SP || rest.charCodeAt(k) === C_TAB)) k++;
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
    if (after === -1 || after === C_SP || after === C_TAB || after === C_GT || after === 47) return { type: 6, endMarker: null };
  }
  // type 7: a complete open tag alone on the line
  const tag = scanTag(rest, 0);
  if (tag) {
    let k = tag.end;
    while (k < rest.length && (rest.charCodeAt(k) === C_SP || rest.charCodeAt(k) === C_TAB)) k++;
    if (k === rest.length) return { type: 7, endMarker: null };
  }
  return null;
}

// List marker match. Returns null or:
// {ordered, start, delim, markerCols, contentCols, first}
function listMarker(line) {
  const { cols, idx } = indentOf(line);
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
  if (mc !== C_SP && mc !== C_TAB) return null;
  let cc = base, p = m;
  while (p < line.length) {
    const d = line.charCodeAt(p);
    if (d === C_SP) { cc++; p++; }
    else if (d === C_TAB) { cc += 4 - (cc % 4); p++; }
    else break;
  }
  if (p >= line.length) {
    return { ordered, start, delim, markerCols: base, contentCols: base + 1, first: '' };
  }
  const contentCols = (cc - base >= 5) ? base + 1 : cc;
  return { ordered, start, delim, markerCols: base, contentCols, first: sliceColumnExpand(line, contentCols) };
}

// Split a table row/header line into cells (marked's `de`): split on
// unescaped '|', drop a leading/trailing empty cell, trim, and (for rows)
// truncate or pad to `expected` cells.
function splitRowCells(text, expected) {
  const cells = [];
  let cur = '', i = 0;
  while (i < text.length) {
    const c = text.charCodeAt(i);
    if (c === 124) { // '|'
      // escaped if preceded by an odd run of backslashes; the escaping
      // backslash is dropped (the cell then holds a literal '|').
      let bs = 0, k = i - 1;
      while (k >= 0 && text.charCodeAt(k) === C_BSLASH) { bs++; k--; }
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
function tableAlign(line) {
  const { cols, idx } = indentOf(line);
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
function tableStart(lines, j, end) {
  if (j + 1 >= end) return null;
  const header = lines[j];
  if (isBlankLine(header)) return null;
  const { cols } = indentOf(header);
  if (cols > 3) return null;
  // header must start with a non-space char after the indent
  const h = header.slice(indentOf(header).idx);
  if (!h) return null;
  const align = tableAlign(lines[j + 1]);
  if (!align) return null;
  const headerCells = splitRowCells(h);
  if (headerCells.length !== align.length) return null;
  return align;
}

// ---------------------------------------------------------------------------
// Link reference definitions
// ---------------------------------------------------------------------------

// Try to parse a link reference definition starting at lines[i].
// Returns {label, href, title, linesUsed} or null. The definition may span
// up to three lines (label line, destination, title).
function tryRefDef(lines, i, end) {
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
    if (c === C_SP) { cols++; pos++; }
    else if (c === C_TAB) { cols += 4 - (cols % 4); pos++; }
    else break;
  }
  if (cols > 3 || pos >= n || src.charCodeAt(pos) !== C_LBRK) return null;
  const lab = scanRefLabel(src, pos);
  if (!lab) return null;
  const rawLabel = lab.label;
  // label must be non-empty after trimming, and must not span a blank line
  if (!rawLabel.trim()) return null;
  for (let k = 0; k < rawLabel.length; k++) {
    if (rawLabel.charCodeAt(k) === C_LF) {
      let m = k + 1;
      while (m < rawLabel.length && (rawLabel.charCodeAt(m) === C_SP || rawLabel.charCodeAt(m) === C_TAB)) m++;
      // a newline followed by another newline is a blank line; a newline
      // at the very end of the label is fine (it is followed by ']')
      if (m < rawLabel.length && rawLabel.charCodeAt(m) === C_LF) return null;
    }
  }
  pos = lab.end;
  if (pos >= n || src.charCodeAt(pos) !== 58) return null; // ':'
  pos++;
  // spaces/tabs, then at most one newline + spaces/tabs, then the destination
  while (pos < n && (src.charCodeAt(pos) === C_SP || src.charCodeAt(pos) === C_TAB)) pos++;
  if (pos < n && src.charCodeAt(pos) === C_LF) {
    pos++;
    while (pos < n && (src.charCodeAt(pos) === C_SP || src.charCodeAt(pos) === C_TAB)) pos++;
  }
  if (pos >= n) return null;
  let href = '';
  if (src.charCodeAt(pos) === C_LT) {
    let j = pos + 1;
    while (j < n) {
      const c = src.charCodeAt(j);
      if (c === C_GT) break;
      if (c === C_LF || c === C_LT) return null;
      if (c === C_BSLASH && j + 1 < n && isAsciiPunct(src.charCodeAt(j + 1))) { href += src[j + 1]; j += 2; continue; }
      href += src[j]; j++;
    }
    if (j >= n) return null;
    pos = j + 1;
  } else {
    // bare destination: maximal run of non-space, non-control chars
    let j = pos, depth = 0, raw = '';
    while (j < n) {
      const c = src.charCodeAt(j);
      if (c === C_SP || c === C_TAB || c === C_LF || c < 32) break;
      if (c === C_BSLASH && j + 1 < n && isAsciiPunct(src.charCodeAt(j + 1))) { raw += src[j + 1]; j += 2; continue; }
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
  while (p < n && (src.charCodeAt(p) === C_SP || src.charCodeAt(p) === C_TAB)) p++;
  if (p < n && src.charCodeAt(p) !== C_LF) {
    // title must start here on this line, and only after a space
    if (p === destEnd) return null;
    const t = parseLinkTitle(src, p);
    if (!t) return null;
    title = t.title;
    p = t.end;
    while (p < n && (src.charCodeAt(p) === C_SP || src.charCodeAt(p) === C_TAB)) p++;
    if (p < n && src.charCodeAt(p) !== C_LF) return null;
  } else if (p < n && src.charCodeAt(p) === C_LF) {
    // maybe a title on the next line; if it does not parse cleanly to EOL,
    // the definition still stands without a title (the line is separate)
    let q = p + 1;
    while (q < n && (src.charCodeAt(q) === C_SP || src.charCodeAt(q) === C_TAB)) q++;
    if (q < n && (src.charCodeAt(q) === C_QUOT || src.charCodeAt(q) === C_APOS || src.charCodeAt(q) === 40)) {
      const t = parseLinkTitle(src, q);
      if (t) {
        let r = t.end;
        while (r < n && (src.charCodeAt(r) === C_SP || src.charCodeAt(r) === C_TAB)) r++;
        if (r >= n || src.charCodeAt(r) === C_LF) {
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
  for (let k = 0; k < p && k < n; k++) if (src.charCodeAt(k) === C_LF) linesUsed++;
  return { label: normalizeRef(rawLabel), href, title, linesUsed };
}

// ---------------------------------------------------------------------------
// Block parsing
// ---------------------------------------------------------------------------

// Is `line` the start of a block that can interrupt a paragraph?
// (ATX heading, fence, thematic break, HTML block types 1-6, blockquote,
//  or a list that can interrupt a paragraph: bullet with content, or
//  ordered starting with 1 with content.)
function interruptsPara(line, anyOrdered) {
  if (atxStart(line) || fenceStart(line) || hrLine(line)) return true;
  const h = htmlBlockStart(line);
  if (h && h.type !== 7) return true;
  const { cols, idx } = indentOf(line);
  if (cols <= 3 && idx < line.length && line.charCodeAt(idx) === C_GT) return true;
  const m = listMarker(line);
  // Inside a list item any ordered marker can interrupt a paragraph (a
  // nested list is a child block); elsewhere only `1.` may.
  if (m && m.first !== '' && (!m.ordered || m.start === 1 || anyOrdered)) return true;
  return false;
}

// Render a table starting at lines[i]. `align` is from tableStart.
// Returns {html, next}. In collect mode the rows are scanned (to find the
// table's end) but no cell HTML is rendered.
function tableHtml(lines, i, end, refs, align, collect) {
  const headerCells = splitRowCells(lines[i].slice(indentOf(lines[i]).idx));
  let j = i + 2;
  const rows = [];
  while (j < end) {
    const line = lines[j];
    if (line === '') break;
    // A spaces-only line ends the table, but a whitespace-only line that
    // contains a tab is a row of empty cells (marked's table regex treats
    // a tab as row content, not as blank).
    if (isBlankLine(line)) {
      if (line.indexOf('\t') < 0) break;
      rows.push(line); j++; continue;
    }
    // A row ends at indented code, or any line the table regex's row
    // lookahead excludes: ATX / fence / hr / blockquote / HTML 1-6 /
    // a bullet or ordered-1 list marker followed by a space.
    const { cols, idx } = indentOf(line);
    if (cols >= 4) break;
    if (interruptsPara(line)) break;
    const cc = line.charCodeAt(idx);
    if ((cc === 45 || cc === 43 || cc === 42) &&
        (line.charCodeAt(idx + 1) === C_SP || line.charCodeAt(idx + 1) === C_TAB)) break;
    if (cc === 49 && (line.charCodeAt(idx + 1) === 46 || line.charCodeAt(idx + 1) === 41) &&
        (line.charCodeAt(idx + 2) === C_SP || line.charCodeAt(idx + 2) === C_TAB)) break;
    rows.push(line);
    j++;
  }
  if (collect) return { html: '', next: j };
  let out = '<table>\n<thead>\n<tr>\n';
  for (let c = 0; c < headerCells.length; c++) {
    out += '<th' + (align[c] ? ' align="' + align[c] + '"' : '') + '>' +
      inlineHtml(headerCells[c], refs) + '</th>\n';
  }
  out += '</tr>\n</thead>\n';
  if (rows.length) {
    out += '<tbody>';
    for (const row of rows) {
      const cells = splitRowCells(row, headerCells.length);
      out += '<tr>\n';
      for (let c = 0; c < cells.length; c++) {
        out += '<td' + (align[c] ? ' align="' + align[c] + '"' : '') + '>' +
          inlineHtml(cells[c], refs) + '</td>\n';
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
function collectQuote(lines, i, end) {
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
    if (isBlankLine(line)) {
      // A truly blank line (no '>' marker) ends the blockquote; a later
      // '>' line starts a new blockquote.
      break;
    }
    const { cols, idx } = indentOf(line);
    if (cols <= 3 && idx < line.length && line.charCodeAt(idx) === C_GT) {
      // The marker '>' plus one column of following whitespace is
      // consumed; a tab there is only partly consumed (one column), the
      // rest becoming spaces (sliceColumnExpand handles the expansion).
      let contentCol = cols + 1;
      const after = line.charCodeAt(idx + 1);
      if (after === C_SP || after === C_TAB) contentCol = cols + 2;
      const stripped = sliceColumnExpand(line, contentCol);
      out.push(stripped);
      if (fenceCh) {
        // Fence content (or its closer): not a paragraph.
        inPara = false;
        const ind = indentOf(stripped);
        if (ind.cols <= 3) {
          let p = ind.idx;
          const c = stripped.charCodeAt(p);
          if (c === fenceCh.charCodeAt(0)) {
            let run = 0;
            while (p < stripped.length && stripped.charCodeAt(p) === c) { run++; p++; }
            if (run >= fenceLen) {
              let rest = true;
              while (p < stripped.length) {
                if (stripped.charCodeAt(p) !== C_SP && stripped.charCodeAt(p) !== C_TAB) { rest = false; break; }
                p++;
              }
              if (rest) { fenceCh = ''; fenceLen = 0; }
            }
          }
        }
      } else {
        const f = fenceStart(stripped);
        if (f) { fenceCh = f.ch; fenceLen = f.len; inPara = false; }
        else inPara = quoteLineHasPara(stripped);
      }
      j++;
      continue;
    }
    // A line with no '>' marker cannot continue a fenced code block.
    if (fenceCh) break;
    // Lazy continuation: only a paragraph line may continue lazily. A
    // setext underline cannot be a lazy continuation: indent it by 4 spaces
    // so it stays paragraph text (marked's blockquoteSetextReplace).
    if (inPara && !interruptsPara(line) && !tableStart(lines, j, end)) {
      if (setextLevel(line)) out.push('    ' + line.replace(/^[ \t]+/, ''));
      else out.push(lazyLine(line));
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
function quoteLineHasPara(s) {
  if (s === '' || isBlankLine(s)) return false;
  const { cols, idx } = indentOf(s);
  if (cols <= 3 && idx < s.length && s.charCodeAt(idx) === C_GT) return true;
  const mm = listMarker(s);
  if (mm) return mm.first !== '' ? quoteLineHasPara(mm.first) : false;
  if (interruptsPara(s)) return false;
  if (indentOf(s).cols >= 4) return false;
  return true;
}

// A lazy continuation line has up to 4 columns of leading whitespace
// stripped (only when it has 4 or more columns of indent).
function lazyLine(line) {
  let cols = 0, k = 0;
  while (k < line.length) {
    const c = line.charCodeAt(k);
    if (c === C_SP) { cols++; k++; }
    else if (c === C_TAB) { cols += 4 - (cols % 4); k++; }
    else break;
  }
  if (cols < 4) return line;
  return stripColumns(line, 4);
}

// Does `out` (a list item's content lines, trailing blanks trimmed)
// contain a blank line that separates two blocks at the item's own level?
// A blank inside a fenced code block or inside a nested list item does not
// count; a blank before an indented code block or a new top-level block
// does. We track open fences and nested-list boundaries while scanning.
// A line continues a nested list if it is a list marker at or beyond the
// list's marker column, or non-marker content indented to its content
// column.
function innerBlank(out) {
  let fenceCh = '', fenceLen = 0;
  const listStack = []; // {m: marker column, c: content column}
  function continues(line, entry) {
    const ind = indentOf(line);
    if (listMarker(line)) return ind.cols >= entry.m;
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
    const ind = indentOf(line);
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
              if (line.charCodeAt(p) !== C_SP && line.charCodeAt(p) !== C_TAB) { rest = false; break; }
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
    const f = fenceStart(line);
    if (f) { fenceCh = f.ch; fenceLen = f.len; continue; }
    const mm = listMarker(line);
    if (mm) listStack.push({ m: ind.cols, c: mm.contentCols });
  }
  return false;
}

// Collect one list item's lines starting at lines[i] (a marker line `m`).
// Returns {lines, next, hasInnerBlank, hasTrailingBlank, lazy} — lines are
// content-stripped; `lazy` holds indices of lazy paragraph continuations.
function collectItem(lines, i, end, m) {
  const out = [];
  const lazy = new Set();
  let inPara = false;
  let hasContent = false;
  if (m.first !== '') {
    out.push(m.first);
    hasContent = true;
    inPara = quoteLineHasPara(m.first);
  }
  let j = i + 1;
  const contentCols = m.contentCols;
  while (j < end) {
    const line = lines[j];
    if (isBlankLine(line)) {
      // An empty item followed by a blank line is closed: the blank line
      // ends the item and the next line is a new block outside the list.
      if (!hasContent) break;
      out.push('');
      inPara = false;
      j++;
      continue;
    }
    const ind = indentOf(line);
    if (ind.cols >= contentCols) {
      const stripped = sliceColumnExpand(line, contentCols);
      out.push(stripped);
      hasContent = true;
      inPara = quoteLineHasPara(stripped);
      j++;
      continue;
    }
    // Less indented: any list marker ends the item (a new list starts at
    // the outer level, same list or a different delimiter); a block that
    // can interrupt a paragraph ends it; otherwise a lazy paragraph
    // continuation (up to 4 columns stripped, stays paragraph text).
    const mm = listMarker(line);
    if (mm) break;
    if (interruptsPara(line)) break;
    if (inPara && !tableStart(lines, j, end)) {
      // A setext underline cannot be a lazy continuation: indent it by 4
      // spaces so it stays paragraph text.
      if (setextLevel(line)) out.push('    ' + line.replace(/^[ \t]+/, ''));
      else out.push(lazyLine(line));
      lazy.add(out.length - 1);
      j++;
      continue;
    }
    break;
  }
  // Trim trailing blank lines; record whether any blank remains inside.
  let trailing = 0;
  while (out.length && out[out.length - 1] === '') { out.pop(); trailing++; }
  return { lines: out, next: j, hasInnerBlank: innerBlank(out), hasTrailingBlank: trailing > 0, lazy };
}

// The block parser over lines[start..end). `tight` suppresses <p> wrappers
// (paragraphs inside tight list items). `endsWithNL` says whether the
// document's last line was newline-terminated (HTML block trailing newline).
// When `collect` is true, only link reference definitions are collected
// (no inline rendering, no HTML output) — a cheap pre-pass so definitions
// that appear after their first use are still available when rendering.
// `lazySet` (optional) holds indices into `lines` that are lazy blockquote
// continuations, which never start a new block.
function renderBlocks(lines, start, end, refs, tight, endsWithNL, collect, lazySet, inListItem) {
  let out = '';
  let i = start;
  while (i < end) {
    const line = lines[i];
    if (isBlankLine(line)) { i++; continue; }
    // Link reference definitions (only at block starts).
    const def = tryRefDef(lines, i, end);
    if (def) {
      if (!refs.has(def.label)) refs.set(def.label, { href: def.href, title: def.title });
      i += def.linesUsed;
      continue;
    }
    const { cols, idx } = indentOf(line);
    // Indented code
    if (cols >= 4) {
      const codeLines = [];
      let j = i;
      while (j < end) {
        const l = lines[j];
        // A whitespace-only line inside the block keeps its content after
        // stripping 4 columns (e.g. 6 spaces -> 2 spaces); a truly empty
        // line contributes ''.
        if (isBlankLine(l)) { codeLines.push(stripColumns(l, 4)); j++; continue; }
        if (indentOf(l).cols >= 4) { codeLines.push(stripColumns(l, 4)); j++; continue; }
        break;
      }
      while (codeLines.length && isBlankLine(codeLines[codeLines.length - 1])) codeLines.pop();
      if (!collect) out += '<pre><code>' + escapeCode(codeLines.join('\n') + (codeLines.length ? '\n' : '')) + '</code></pre>\n';
      i = j;
      continue;
    }
    // Fenced code
    const fence = fenceStart(line);
    if (fence) {
      const content = [];
      let j = i + 1;
      let closed = false;
      while (j < end) {
        const l = lines[j];
        const li = indentOf(l);
        if (li.cols <= 3) {
          let k = li.idx;
          const c = l.charCodeAt(k);
          if (c === fence.ch.charCodeAt(0)) {
            let run = 0;
            while (k < l.length && l.charCodeAt(k) === c) { run++; k++; }
            if (run >= fence.len) {
              let rest = true;
              while (k < l.length) {
                if (l.charCodeAt(k) !== C_SP && l.charCodeAt(k) !== C_TAB) { rest = false; break; }
                k++;
              }
              if (rest) { closed = true; j++; break; }
            }
          }
        }
        // marked's Dt (indentCodeCompensation) only strips the fence indent
        // for backtick fences: /^(\s+)(?:```)/ never matches a ~~~ fence,
        // so a tilde fence's content keeps its indentation (doc-22/29).
        content.push(fence.ch === '`' ? stripFence(l, fence.indentChars) : l);
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
      if (!collect) out += '<pre><code' + (lang ? ' class="language-' + escapeText(lang, false) + '"' : '') + '>' +
        escapeCode(content.join('\n') + (content.length ? '\n' : '')) + '</code></pre>\n';
      i = j;
      continue;
    }
    // ATX heading
    const atx = atxStart(line);
    if (atx) {
      if (!collect) out += '<h' + atx.level + '>' + inlineHtml(atx.text, refs) + '</h' + atx.level + '>\n';
      i++;
      continue;
    }
    // Thematic break
    if (hrLine(line)) {
      if (!collect) out += '<hr>\n';
      i++;
      continue;
    }
    // HTML block (types 1-6 here; type 7 also starts a block at block start)
    const hb = htmlBlockStart(line);
    if (hb) {
      let j = i;
      if (hb.type === 6 || hb.type === 7) {
        j = i + 1;
        while (j < end && !isBlankLine(lines[j])) j++;
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
            while (q < ll.length && (ll.charCodeAt(q) === C_SP || ll.charCodeAt(q) === C_TAB)) q++;
            if (q < ll.length && ll.charCodeAt(q) === C_GT) { j++; break; }
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
        ? (j < end && isBlankLine(lines[j]))
        : (j < end && lines[j] === '');
      if (!collect) out += blockLines.join('\n') + (lastHasNL && !nextBlank ? '\n' : '');
      i = j;
      continue;
    }
    // Blockquote
    if (cols <= 3 && idx < line.length && line.charCodeAt(idx) === C_GT) {
      const bq = collectQuote(lines, i, end);
      // The stripped content is a synthetic document with no trailing
      // newline, so endsWithNL is false here (an HTML block at the end of
      // the content gets no trailing newline).
      if (!collect) out += '<blockquote>\n' + renderBlocks(bq.lines, 0, bq.lines.length, refs, false, false, collect, bq.lazy, false) + '</blockquote>\n';
      else renderBlocks(bq.lines, 0, bq.lines.length, refs, false, false, collect, bq.lazy, false);
      i = bq.next;
      continue;
    }
    // List
    const marker = listMarker(line);
    if (marker) {
      const ordered = marker.ordered, delim = marker.delim;
      const items = [];
      let j = i;
      let loose = false;
      let firstStart = marker.start;
      while (j < end) {
        let blanks = 0;
        while (j < end && isBlankLine(lines[j])) { blanks++; j++; }
        if (j >= end) break;
        // A thematic break ends the list even when it looks like a list
        // item (e.g. `* * *`).
        if (hrLine(lines[j])) break;
        const m = listMarker(lines[j]);
        if (!m || m.ordered !== ordered || m.delim !== delim) break;
        if (blanks > 0 && items.length > 0) loose = true;
        const item = collectItem(lines, j, end, m);
        if (item.hasInnerBlank) loose = true;
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
          if (tl.length >= 4 && tl.charCodeAt(0) === C_LBRK &&
              (tl.charCodeAt(1) === C_SP || tl.charCodeAt(1) === 120 || tl.charCodeAt(1) === 88) &&
              tl.charCodeAt(2) === C_RBRK &&
              (tl.charCodeAt(3) === C_SP || tl.charCodeAt(3) === C_TAB)) {
            let e = 3;
            while (e < tl.length && (tl.charCodeAt(e) === C_SP || tl.charCodeAt(e) === C_TAB)) e++;
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
        const inner = renderBlocks(itemLines, 0, itemLines.length, refs, !loose, false, collect, item.lazy, true);
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
    const align = tableStart(lines, i, end);
    if (align) {
      const t = tableHtml(lines, i, end, refs, align, collect);
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
      if (isBlankLine(l) && !(j === end - 1 && l.length > 0 && !endsWithNL)) break;
      if (paraLines.length > 0 && !(lazySet && lazySet.has(j))) {
        const su = setextLevel(l);
        if (su) {
          if (tableStart(lines, j, end)) break;
          setext = su;
          j++;
          break;
        }
        if (tableStart(lines, j, end)) break;
        if (interruptsPara(l, inListItem)) break;
      }
      paraLines.push(l);
      j++;
    }
    if (setext) {
      if (!collect) {
        // Setext heading text is the paragraph text with leading/trailing
        // spaces and tabs stripped (unlike a paragraph, which keeps them).
        const text = paraLines.join('\n').replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
        out += '<h' + setext + '>' + inlineHtml(text, refs) + '</h' + setext + '>\n';
      }
    } else if (paraLines.length) {
      if (!collect) {
        const text = inlineHtml(paraLines.join('\n'), refs);
        out += tight ? text : '<p>' + text + '</p>\n';
      }
    }
    i = j;
    continue;
  }
  return out;
}

// Persistent lexer state (marked quirk): an opening inline `<a ...>` tag
// sets gInLink, which suppresses bare-URL/email autolinks until a closing
// `</a>` tag clears it. The flag lives on the lexer, so it persists across
// blocks and paragraphs for the whole document (an unclosed `<a>` silences
// every later bare autolink). Reset per parse() call.
let gInLink = false;

export function parse(markdown) {
  gInLink = false;
  gRefs = null;
  gInRaw = false;
  gLinkEmitted = false;
  gParenPossible = true;
  const src = String(markdown).replace(/\r\n?/g, '\n');
  const refs = new Map();
  const endsWithNL = src.endsWith('\n');
  const lines = src.split('\n');
  if (endsWithNL) lines.pop();
  // Collect link reference definitions document-wide first (marked gathers
  // them while tokenizing blocks, before any inline rendering), so a
  // definition that appears after its first use still resolves.
  renderBlocks(lines, 0, lines.length, refs, false, endsWithNL, true);
  return renderBlocks(lines, 0, lines.length, refs, false, endsWithNL, false);
}
