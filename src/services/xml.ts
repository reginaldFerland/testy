/** A deliberately small, strict XML reader for machine-generated reports (Cobertura).
 *
 * It is a non-recursive, single-pass tokenizer built on `indexOf` scanning, so hostile input
 * cannot cause regex backtracking or stack growth beyond the open-element stack. Supported:
 * elements, quoted attributes, self-closing tags, comments, processing instructions (including
 * the XML declaration, skipped), CDATA, the five predefined entities and numeric character
 * references. Everything else is rejected: DOCTYPE and ENTITY declarations, unknown entities,
 * duplicate attributes, mismatched or unclosed tags, multiple roots and text outside the root. */

export const invalidXmlMessage = 'The coverage report is not valid, safe XML.';

export class XmlSyntaxError extends Error {
    constructor() {
        super(invalidXmlMessage);
        this.name = 'XmlSyntaxError';
    }
}

export interface XmlHandler {
    /** `attributes` is a fresh map per element, so it may be retained. */
    open(name: string, attributes: ReadonlyMap<string, string>): void;
    close(name: string): void;
    /** Decoded character data and CDATA, possibly delivered in several pieces. */
    text(value: string): void;
}

const entities: ReadonlyMap<string, string> = new Map([['lt', '<'], ['gt', '>'], ['amp', '&'], ['quot', '"'], ['apos', "'"]]);
const fail = (): never => { throw new XmlSyntaxError(); };

const isSpace = (code: number): boolean => code === 0x20 || code === 0x09 || code === 0x0A || code === 0x0D;
const isNameStart = (code: number): boolean => (code >= 0x61 && code <= 0x7A) || (code >= 0x41 && code <= 0x5A) || code === 0x5F || code === 0x3A || code >= 0x80;
const isNameChar = (code: number): boolean => isNameStart(code) || (code >= 0x30 && code <= 0x39) || code === 0x2D || code === 0x2E;
const isXmlChar = (code: number): boolean => code === 0x9 || code === 0xA || code === 0xD || (code >= 0x20 && code <= 0xD7FF) || (code >= 0xE000 && code <= 0xFFFD) || (code >= 0x10000 && code <= 0x10FFFF);

function decode(value: string): string {
    let amp = value.indexOf('&');
    if (amp < 0) {return value;}
    let result = '', from = 0;
    while (amp >= 0) {
        const semicolon = value.indexOf(';', amp + 1);
        // The longest reference is `&#x10FFFF;`; a farther `;` belongs to something else.
        if (semicolon < 0 || semicolon - amp > 10) {return fail();}
        const body = value.slice(amp + 1, semicolon);
        let replacement: string | undefined;
        if (body.charCodeAt(0) === 0x23) {
            const hex = body.charCodeAt(1) === 0x78, digits = body.slice(hex ? 2 : 1);
            if (!(hex ? /^[0-9a-fA-F]+$/ : /^[0-9]+$/).test(digits)) {return fail();}
            const code = Number.parseInt(digits, hex ? 16 : 10);
            if (!isXmlChar(code)) {return fail();}
            replacement = String.fromCodePoint(code);
        } else {
            replacement = entities.get(body);
        }
        if (replacement === undefined) {return fail();}
        result += value.slice(from, amp) + replacement;
        from = semicolon + 1;
        amp = value.indexOf('&', from);
    }
    return result + value.slice(from);
}

/** Reads `xml`, calling `handler` in document order. Throws `XmlSyntaxError` on any violation. */
export function readXml(xml: string, handler: XmlHandler): void {
    const names: string[] = [], length = xml.length;
    let position = xml.charCodeAt(0) === 0xFEFF ? 1 : 0, rooted = false;
    const whitespaceOnly = (from: number, to: number): boolean => {
        for (let i = from; i < to; i++) {if (!isSpace(xml.charCodeAt(i))) {return false;}}
        return true;
    };
    while (position < length) {
        const start = xml.indexOf('<', position);
        const stop = start < 0 ? length : start;
        if (stop > position) {
            if (names.length) {handler.text(decode(xml.slice(position, stop)));}
            else if (!whitespaceOnly(position, stop)) {fail();}
        }
        if (start < 0) {break;}
        const next = xml.charCodeAt(start + 1);
        if (next === 0x21) { // <!
            if (xml.startsWith('<!--', start)) {
                const end = xml.indexOf('-->', start + 4);
                if (end < 0) {fail();}
                position = end + 3;
            } else if (names.length && xml.startsWith('<![CDATA[', start)) {
                const end = xml.indexOf(']]>', start + 9);
                if (end < 0) {fail();}
                handler.text(xml.slice(start + 9, end));
                position = end + 3;
            } else {
                fail();
            }
        } else if (next === 0x3F) { // <?
            const end = xml.indexOf('?>', start + 2);
            if (end < 0) {fail();}
            position = end + 2;
        } else if (next === 0x2F) { // </
            const end = xml.indexOf('>', start + 2);
            if (end < 0 || !names.length) {fail();}
            let last = end;
            while (last > start + 2 && isSpace(xml.charCodeAt(last - 1))) {last--;}
            const name = xml.slice(start + 2, last);
            if (name !== names[names.length - 1]) {fail();}
            names.pop();
            handler.close(name);
            position = end + 1;
        } else {
            if (!names.length && rooted) {fail();}
            let i = start + 1;
            if (!isNameStart(next)) {fail();}
            while (i < length && isNameChar(xml.charCodeAt(i))) {i++;}
            const name = xml.slice(start + 1, i), attributes = new Map<string, string>();
            let selfClosing = false;
            for (;;) {
                const before = i;
                while (i < length && isSpace(xml.charCodeAt(i))) {i++;}
                const code = xml.charCodeAt(i);
                if (code === 0x3E) {i++; break;}
                if (code === 0x2F) {
                    if (xml.charCodeAt(i + 1) !== 0x3E) {fail();}
                    selfClosing = true; i += 2; break;
                }
                if (i === before || !isNameStart(code)) {fail();}
                const nameStart = i;
                while (i < length && isNameChar(xml.charCodeAt(i))) {i++;}
                const attribute = xml.slice(nameStart, i);
                while (i < length && isSpace(xml.charCodeAt(i))) {i++;}
                if (xml.charCodeAt(i++) !== 0x3D) {fail();}
                while (i < length && isSpace(xml.charCodeAt(i))) {i++;}
                const quote = xml.charCodeAt(i);
                if (quote !== 0x22 && quote !== 0x27) {fail();}
                const end = xml.indexOf(quote === 0x22 ? '"' : "'", i + 1);
                if (end < 0) {fail();}
                const raw = xml.slice(i + 1, end);
                if (raw.includes('<') || attributes.has(attribute)) {fail();}
                attributes.set(attribute, decode(raw));
                i = end + 1;
            }
            rooted = true;
            handler.open(name, attributes);
            if (selfClosing) {handler.close(name);} else {names.push(name);}
            position = i;
        }
    }
    if (names.length || !rooted) {fail();}
}
