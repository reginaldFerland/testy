const test=require('node:test'),assert=require('node:assert/strict');
const {readXml,XmlSyntaxError}=require('../../out/services/xml');

/** @param {string} xml */
const events=xml=>{
 /** @type {any[]} */ const result=[];
 readXml(xml,{open:(name,attributes)=>result.push(['open',name,Object.fromEntries(attributes)]),close:name=>result.push(['close',name]),text:value=>result.push(['text',value])});
 return result;
};
/** @param {string} xml */
const rejects=xml=>assert.throws(()=>events(xml),error=>error instanceof XmlSyntaxError&&error.message==='The coverage report is not valid, safe XML.',xml.slice(0,60));

test('elements, both quote styles, self-closing tags and whitespace inside tags',()=>{
 assert.deepEqual(events('<a x="1" y=\'2"3\'  z = "4"\n><b/><c  /></a >'),[
  ['open','a',{x:'1',y:'2"3',z:'4'}],['open','b',{}],['close','b'],['open','c',{}],['close','c'],['close','a']]);
});

test('predefined entities and numeric references decode in attributes and text',()=>{
 assert.deepEqual(events('<a v="&lt;&gt;&amp;&quot;&apos; &#65;&#x42;&#x1F600;">x&amp;y</a>'),[
  ['open','a',{v:'<>&"\' AB\u{1F600}'}],['text','x&y'],['close','a']]);
 assert.equal(events('<a v="&amp;lt;"/>')[0][2].v,'&lt;','references are decoded exactly once');
});

test('unknown, malformed and invalid entities are rejected',()=>{
 for(const value of ['&nbsp;','&','&amp','&;','&#;','&#x;','&#xZ;','&#0;','&#xD800;','&#x110000;','&#1234567890123;','&lt&gt;','& amp;'])
  {rejects(`<a v="${value}"/>`);rejects(`<a>${value}</a>`);}
});

test('comments, processing instructions, the XML declaration and a byte order mark are skipped',()=>{
 assert.deepEqual(events('﻿<?xml version="1.0" encoding="utf-8"?>\n<!-- a > b <x> --><a><!-- <b/> --><?pi data?></a><!-- end -->\n'),[['open','a',{}],['close','a']]);
 for(const xml of ['<a><!-- open</a>','<a><? open</a>','<!-- x --','<a/><!--'])rejects(xml);
});

test('CDATA is delivered as text and cannot hide markup',()=>{
 assert.deepEqual(events('<a><![CDATA[</a><b>&nope;]]></a>'),[['open','a',{}],['text','</a><b>&nope;'],['close','a']]);
 for(const xml of ['<a><![CDATA[x</a>','<![CDATA[x]]><a/>'])rejects(xml);
});

test('DOCTYPE and entity declarations are rejected, however spelled',()=>{
 for(const xml of ['<!DOCTYPE a><a/>','<!doctype a [<!ENTITY x "y">]><a/>','<a><!ENTITY x "y"></a>','<a/><!DOCTYPE a>'])rejects(xml);
});

test('unbalanced, mismatched, truncated and multi-root documents are rejected',()=>{
 for(const xml of ['','   ','<a>','<a></b>','<a><b></a></b>','</a>','<a></a></a>','<a/><b/>','<a/>text','text<a/>','<a><b></a>','<a','<a x','<a x=','<a x="1','<a x="1"','<a x="1"/',"<a x='1\"/>",
  '<a x=1/>','<a x/>','<a x="1"y="2"/>','<a x="1" x="2"/>','<a x="<"/>','< a/>','<1a/>','<a b="1"></ a>','<a></a x>','<a>&</a>','<a/ >','<>','<a><</a>'])rejects(xml);
});

test('attribute bags are not prototype-bearing objects',()=>{
 const [[,,attributes]]=[(()=>{let first;readXml('<a __proto__="1" constructor="2" toString="3"/>',{open:(name,bag)=>{first??=['open',name,bag];},close(){},text(){}});return /** @type {any} */ (first);})()];
 assert.ok(attributes instanceof Map);
 assert.deepEqual([...attributes],[['__proto__','1'],['constructor','2'],['toString','3']]);
 assert.equal(/** @type {any} */ ({}).polluted,undefined);
});

test('huge values, long documents and deep nesting are handled without regex backtracking or recursion',()=>{
 const big='x'.repeat(5_000_000);
 assert.equal(events(`<a v="${big}"/>`)[0][2].v.length,big.length);
 assert.equal(events(`<a v="${'&amp;'.repeat(500_000)}"/>`)[0][2].v.length,500_000);
 assert.throws(()=>events(`<a v="${big}`),XmlSyntaxError);
 assert.throws(()=>events('<a '+'x'.repeat(2_000_000)),XmlSyntaxError);
 assert.throws(()=>events('<a>'+'<!-'.repeat(1_000_000)),XmlSyntaxError);
 const depth=200_000;
 assert.equal(events('<a>'.repeat(depth)+'</a>'.repeat(depth)).length,depth*2);
 assert.throws(()=>events('<a>'.repeat(depth)),XmlSyntaxError);
 const started=performance.now();
 assert.throws(()=>events('<a v="'+'&a'.repeat(1_000_000)+'"/>'),XmlSyntaxError);
 assert.throws(()=>events('<a '+'b="1" '.repeat(300_000)+'b="2"/>'),XmlSyntaxError);
 assert.ok(performance.now()-started<2000,'adversarial inputs fail fast');
});
