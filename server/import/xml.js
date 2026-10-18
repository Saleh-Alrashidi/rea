/**
 * The small XML event reader of the workbook reader (`xlsx.js`), for
 * SpreadsheetML parts: namespace prefixes are dropped, only the five XML
 * entities and character references are decoded, and a DOCTYPE is
 * refused, so nothing can declare entities. Malformed XML is an
 * INVALID_XLSX ImportError.
 */
import { ImportError } from "./engine.js";
import { drain } from "./slices.js";

const TAG =
  /<(\/?)([A-Za-z_][\w.:-]*)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/y;
const ATTRIBUTE = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
const ENTITY = /&(?:#(\d{1,7})|#x([\da-f]{1,6})|(lt|gt|amp|quot|apos));/gi;
const NAMED = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };
// Tags read between the walk's yields (`slices.js`).
const TAGS_PER_STEP = 4096;

const invalid = (message) => new ImportError("INVALID_XLSX", message);

export const local = (name) => name.slice(name.indexOf(":") + 1);

function charOf(code) {
  const valid = code <= 0x10ffff && (code < 0xd800 || code > 0xdfff);
  return valid ? String.fromCodePoint(code) : "�";
}

const decodeEntities = (text) =>
  text.includes("&")
    ? text.replace(ENTITY, (_, dec, hex, name) =>
        name
          ? NAMED[name.toLowerCase()]
          : charOf(Number.parseInt(dec ?? hex, dec ? 10 : 16)),
      )
    : text;

function attributesOf(source) {
  const attrs = {};
  if (source === "") return attrs;
  ATTRIBUTE.lastIndex = 0;
  for (let match; (match = ATTRIBUTE.exec(source));)
    attrs[local(match[1])] = decodeEntities(match[2] ?? match[3]);
  return attrs;
}

function skipTo(xml, at, close) {
  const end = xml.indexOf(close, at);
  if (end === -1) throw invalid("A workbook part is not well-formed XML");
  return end + close.length;
}

/**
 * Walks `xml`, calling `open(name, attrs)` (returning false stops the
 * walk), `close(name)` and `text(decoded)` with local names; a generator
 * that yields every TAGS_PER_STEP tags (`walkXml` runs it to its end).
 */
export function* walkXmlSteps(
  xml,
  { open = () => {}, close = () => {}, text = () => {} },
) {
  let at = 0;
  let tags = 0;
  while (at < xml.length) {
    const lt = xml.indexOf("<", at);
    const end = lt === -1 ? xml.length : lt;
    if (end > at) text(decodeEntities(xml.slice(at, end)));
    if (lt === -1) return;
    if (xml.startsWith("<?", lt)) at = skipTo(xml, lt, "?>");
    else if (xml.startsWith("<!--", lt)) at = skipTo(xml, lt, "-->");
    else if (xml.startsWith("<![CDATA[", lt)) {
      at = skipTo(xml, lt, "]]>");
      text(xml.slice(lt + 9, at - 3));
    } else if (xml.startsWith("<!", lt)) {
      throw invalid("Workbooks with a DOCTYPE are not supported");
    } else {
      if ((tags += 1) % TAGS_PER_STEP === 0) yield;
      TAG.lastIndex = lt;
      const match = TAG.exec(xml);
      if (!match) throw invalid("A workbook part is not well-formed XML");
      at = TAG.lastIndex;
      const name = local(match[2]);
      if (match[1]) close(name);
      else if (open(name, attributesOf(match[3])) === false) return;
      else if (match[4]) close(name);
    }
  }
}

export const walkXml = (xml, handlers) => drain(walkXmlSteps(xml, handlers));
