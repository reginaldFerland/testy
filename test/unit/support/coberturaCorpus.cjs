// Deterministic generator of varied Cobertura documents for the differential parser test.
// Each document lists the class files (relative to the working directory) that are allowed.
const files = ['A.cs', 'B.cs', 'src/C.cs', 'Déjà & 中文.cs', "it's.cs", 'x"y.cs'];
const escapes = [[/&/g, '&amp;'], [/</g, '&lt;'], [/>/g, '&gt;']];

function random(seed) {
    let state = seed >>> 0;
    return () => {
        state = (state + 0x6D2B79F5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function generate(seed) {
    const next = random(seed), int = n => Math.floor(next() * n), pick = list => list[int(list.length)], chance = p => next() < p;
    const escape = (value, quote) => {
        let text = escapes.reduce((s, [pattern, entity]) => s.replace(pattern, entity), value);
        text = text.replace(quote === '"' ? /"/g : /'/g, quote === '"' ? '&quot;' : '&apos;');
        return text;
    };
    const attribute = (name, value) => {
        const quote = chance(0.3) ? "'" : '"', gap = chance(0.2) ? ' \n\t' : ' ', equals = chance(0.1) ? ' = ' : '=';
        return `${gap}${name}${equals}${quote}${escape(String(value), quote)}${quote}`;
    };
    const line = (number, hits) => `<line${attribute('number', number)}${attribute('hits', hits)}${chance(0.5) ? attribute('branch', 'False') : ''}${chance(0.5) ? '/>' : '></line>'}`;
    const lineSet = () => Array.from({ length: int(6) }, () => line(1 + int(30), chance(0.3) ? 0 : int(9))).join(chance(0.2) ? '\n  ' : '');
    const method = (name, signature) => {
        const body = `<lines>${lineSet()}</lines>`;
        const open = `<method${attribute('name', name)}${chance(0.9) ? attribute('signature', signature) : ''}${chance(0.3) ? attribute('is_constructor', 'False') : ''}`;
        return chance(0.1) ? `${open}/>` : `${open}>${chance(0.1) ? '<!-- </methods> -->' : ''}${body}${chance(0.1) ? '<![CDATA[</method><line number="99" hits="1"/>]]>' : ''}</method>`;
    };
    const names = ['Calc', 'Calc.<Run>d__3', 'Calc.<>c', 'Outer+Inner', 'Calc.<Lambda>d__2'];
    const methodNames = ['Add', 'MoveNext', '<Local>g__F|1_0', '.ctor', 'Get_X', '', 'MoveNext'];
    const klass = () => {
        const name = pick(names);
        const methods = chance(0.15) ? '<methods/>' : `<methods>${Array.from({ length: int(4) }, () => method(pick(methodNames), pick(['()', '(int, string)', '(System.Collections.Generic.List<int>)']))).join('')}</methods>`;
        const odd = chance(0.1) ? `<custom><lines>${lineSet()}</lines></custom>` : '';
        const badLine = chance(0.015) ? line(pick([0, -1, 'x', '1.5']), 1) : chance(0.015) ? line(3, pick([-1, 'many'])) : '';
        const filename = chance(0.05) ? '' : `${attribute('filename', pick(files))}`;
        return `<class${attribute('name', name)}${filename}${chance(0.5) ? attribute('line-rate', '0.5') : ''}>${methods}${odd}<lines>${lineSet()}${badLine}</lines></class>`;
    };
    const packages = Array.from({ length: chance(0.05) ? 0 : 1 + int(3) }, () => `<package${attribute('name', 'p' + int(9))}><classes>${Array.from({ length: int(5) }, klass).join('')}</classes></package>`).join('');
    const sources = chance(0.4) ? `<sources>${Array.from({ length: int(3) }, () => `<source${chance(0.2) ? attribute('kind', 'x') : ''}>${escape(pick(['src', '/nonexistent', '  padded  ', '']), '"')}</source>`).join('')}</sources>` : '';
    const body = chance(0.5) ? sources + `<packages>${packages}</packages>` : `<packages>${packages}</packages>` + sources;
    let xml = `${chance(0.6) ? '<?xml version="1.0" encoding="utf-8"?>\n' : ''}${chance(0.2) ? '<!-- generated -->\n' : ''}<coverage${attribute('line-rate', '0.5')}${chance(0.2) ? attribute('xmlns', 'urn:cobertura') : ''}>${body}</coverage>${chance(0.2) ? '\n' : ''}`;
    // Corruptions: structure damage, hostile declarations and wrong roots.
    const kind = int(40);
    if (kind === 0) {xml = xml.slice(0, int(xml.length));}
    else if (kind === 1) {xml = xml.replace('</lines>', '</line>');}
    else if (kind === 2) {xml = '<!DOCTYPE coverage [<!ENTITY x "y">]>' + xml;}
    else if (kind === 3) {xml = xml.replace('<coverage', '<report').replace('</coverage>', '</report>');}
    else if (kind === 4) {xml = xml.replace(/<packages>[\s\S]*<\/packages>/, '<packages/>');}
    else if (kind === 5) {xml = xml.replace('<lines>', '<lines><!-- <!doctype x> -->');}
    else if (kind === 6) {xml = xml.replace(/<class /, '<class unterminated="x ');}
    return { xml, allowed: files.filter(() => chance(0.8)) };
}

module.exports = { generate, files };
