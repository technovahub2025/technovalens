import JSZip from 'jszip';
import { SaxesParser } from 'saxes';

const MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const escape = value => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/\r/g, '&#13;').replace(/\n/g, '&#10;').replace(/\t/g, '&#9;');

// ExcelJS matches literal tag names, so valid prefixed OOXML needs canonical
// names. Parse namespaces rather than stripping prefixes with a regex: extension
// namespaces and text containing markup must retain their meaning.
export async function prepareXlsx(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  if (!zip.file('xl/workbook.xml')) throw new Error('Invalid XLSX: xl/workbook.xml is missing.');
  const normalizedParts = [], sheetNames = [];
  for (const entry of Object.values(zip.files)) {
    if (!/^xl\/(workbook\.xml|styles\.xml|sharedStrings\.xml|worksheets\/[^/]+\.xml)$/.test(entry.name)) continue;
    const xml = await entry.async('string');
    if (entry.name !== 'xl/workbook.xml' && !/xmlns:(?!r=)[\w.-]+\s*=\s*["']http:\/\/schemas\.openxmlformats\.org\/(spreadsheetml\/2006\/main|officeDocument\/2006\/relationships)["']/.test(xml)) continue;
    const parser = new SaxesParser({ xmlns: true });
    const output = [], stack = [];
    let needsNormalization = false, rootSeen = false;
    parser.on('doctype', () => { throw new Error('DOCTYPE is not supported in XLSX XML.'); });
    parser.on('opentag', node => {
      if (!rootSeen) {
        rootSeen = true;
        if (entry.name === 'xl/workbook.xml' && (node.local !== 'workbook' || node.uri !== MAIN)) {
          throw new Error('Unsupported XLSX workbook XML namespace or root.');
        }
      }
      const name = node.uri === MAIN ? node.local : node.name;
      if (name !== node.name) needsNormalization = true;
      const parent = stack[stack.length - 1];
      let defaultNamespace = node.attributes.xmlns?.value ?? parent?.defaultNamespace ?? '';
      let relationshipNamespace = node.attributes['xmlns:r']?.value ?? parent?.relationshipNamespace ?? '';
      const attrs = Object.values(node.attributes);
      // Bind names only when their inherited scope changes, not on every cell.
      const desiredDefault = name.includes(':') ? defaultNamespace : node.uri;
      const bindDefault = desiredDefault !== defaultNamespace;
      const bindRelationship = attrs.some(attr => attr.uri === REL) && relationshipNamespace !== REL;
      const attributes = attrs.filter(attr => !(bindDefault && attr.name === 'xmlns') && !(bindRelationship && attr.name === 'xmlns:r')).map(attr => {
        const key = attr.uri === REL ? `r:${attr.local}` : attr.name;
        if (key !== attr.name) needsNormalization = true;
        return `${key}="${escape(attr.value)}"`;
      });
      if (bindDefault) { defaultNamespace = desiredDefault; attributes.push(`xmlns="${escape(defaultNamespace)}"`); }
      if (bindRelationship) { relationshipNamespace = REL; attributes.push(`xmlns:r="${REL}"`); }
      stack.push({ name, defaultNamespace, relationshipNamespace });
      output.push(`<${name}${attributes.length ? ` ${attributes.join(' ')}` : ''}>`);
      if (entry.name === 'xl/workbook.xml' && node.uri === MAIN && node.local === 'sheet') {
        sheetNames.push(node.attributes.name?.value);
      }
    });
    parser.on('closetag', () => output.push(`</${stack.pop().name}>`));
    parser.on('text', value => output.push(stack.length ? escape(value) : value));
    parser.on('cdata', value => output.push(escape(value)));
    parser.on('error', error => { throw error; });
    try { parser.write(xml).close(); }
    catch (error) { throw new Error(`Invalid XLSX XML in ${entry.name}: ${error.message}`); }
    if (needsNormalization) { zip.file(entry.name, output.join('')); normalizedParts.push(entry.name); }
  }
  if (!sheetNames.length || sheetNames.some(name => typeof name !== 'string' || !name)) throw new Error('No valid worksheets declared in this workbook.');
  if (sheetNames.length > 32) throw new Error('Workbook exceeds the 32 worksheet limit.');
  return { buffer: normalizedParts.length ? await zip.generateAsync({ type: 'nodebuffer' }) : buffer, sheetNames, normalizedParts };
}
