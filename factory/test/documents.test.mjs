// INV-71: a task runs only with acceptance criteria, and the agents get the Linear documents the task links.
// Contract (proposed by test-author; the task gives none, and only factory/ may change): a new module factory/documents.mjs
//   documentLinks(text) -> string[]
//     the slugIds of the Linear documents linked in the task text, in order of first appearance, without duplicates.
//   sessionGate({ text, unreadable = [] }) -> { action: 'run' } | { action: 'ask', what: string }
//     'ask' (no session) when "Как проверявам" is missing or empty, or when a linked document cannot be read;
//     `what` is the Bulgarian text for Yoan saying what is missing.
//   linearDocument(linear, slugId) -> Promise<{ id, title, content, url } | null>
//     reads one document with the runner's Linear client (`linear(query, vars)`), null when Linear cannot give it.
//   taskDocuments({ text, repo, getDocument, findGlossary }) -> Promise<{ docs, unreadable }>
//     getDocument(slugId) -> doc | null (may throw); findGlossary() -> the "Речник" doc of project "Архитектура" | null.
//     docs: the linked documents in order, then the glossary for repo 'invoicely' (not for 'invoicely-agents').
//     unreadable: the slugIds that getDocument could not give.
//   documentsBlock(docs) -> string   the text for the {DOCUMENTS} placeholder of both session prompts.
//   prDocumentsSection(docs, limit = 65000) -> string   the collapsed "Документи" section of the PR description.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { fillTemplate } from '../lib.mjs';

const FACTORY = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const docs = await import('../documents.mjs').catch((e) => ({ loadError: e }));
const fn = (name) => {
  assert.ok(!docs.loadError, `factory/documents.mjs must load (INV-71): ${docs.loadError?.message}`);
  assert.equal(typeof docs[name], 'function', `factory/documents.mjs must export ${name} (INV-71)`);
  return docs[name];
};

// A task text as taskText() gives it to the agents (the shape of INV-71 itself).
const taskWith = (checks, notes = '* Само `factory/`.') =>
  `# INV-88: Фактура с ДДС 20%\n\n## Какво\n\nФактура към "Техномаркет България" ЕАД (ЕИК 131234568).\n\n${checks}\n\n+++ Agent notes\n\n${notes}\n\n+++`;
const PROCESS_LINK = '[Процесът](<https://linear.app/invoicely-project/document/procesut-5d5d487726d0>)'; // Agent notes example
const PROCESS = { id: 'b6f1c2d3-4e5f-4a6b-8c7d-9e0f1a2b3c4d', title: 'Процесът', url: 'https://linear.app/invoicely-project/document/procesut-5d5d487726d0',
  content: '# Процесът\n\n1. Йоан пише задача по шаблона "Таск".\n2. test-author пише тестовете.\n3. implementer пише кода.' };
const ADR = { id: 'c7a2d3e4-5f60-4b7c-9d8e-0f1a2b3c4d5e', title: 'ADR-007: Парите в евроценти', url: 'https://linear.app/invoicely-project/document/adr-007-parite-v-evrocenti-0f9e8d7c6b5a',
  content: 'Сумите са цели числа в евроцентове: 12550 е 125,50 EUR. Лева няма.' };
const GLOSSARY = { id: 'd8b3e4f5-6071-4c8d-8e9f-1a2b3c4d5e6f', title: 'Речник', url: 'https://linear.app/invoicely-project/document/rechnik-1a2b3c4d5e6f',
  content: 'ЕИК: единен идентификационен код, 9 цифри.\nДДС номер: BG и ЕИК.' };
const BY_SLUG = { '5d5d487726d0': PROCESS, '0f9e8d7c6b5a': ADR, '1a2b3c4d5e6f': GLOSSARY };

// --- check 6a / check 2: finding the document links in the task text ---

test('check 6: a markdown link to a Linear document gives the slugId after the last dash', () => {
  assert.deepEqual(fn('documentLinks')(`Виж ${PROCESS_LINK} за стъпките.`), ['5d5d487726d0']); // Agent notes: procesut-5d5d487726d0 -> 5d5d487726d0
});

test('check 6: plain document URLs count too, slugs with many dashes keep only the last part, duplicates come once, in order', () => {
  const text = taskWith(`## Как проверявам\n\n* По https://linear.app/invoicely-project/document/adr-007-parite-v-evrocenti-0f9e8d7c6b5a и ${PROCESS_LINK}.\n* Пак ${PROCESS_LINK}.`);
  assert.deepEqual(fn('documentLinks')(text), ['0f9e8d7c6b5a', '5d5d487726d0']); // check 2: https://linear.app/<workspace>/document/<slug>
});

test('check 6: issue and project links, and text without links, give no documents', () => {
  const text = 'Виж https://linear.app/invoicely-project/issue/INV-42/fakturi и https://linear.app/invoicely-project/project/arhitektura-9a8b7c6d5e4f.';
  assert.deepEqual(fn('documentLinks')(text), []); // check 2: only /document/ links
  assert.deepEqual(fn('documentLinks')(taskWith('## Как проверявам\n\n* Сумата е 24000.')), []);
});

// --- check 1 / check 6b: a task without criteria does not start ---

test('check 1: a task without a "Как проверявам" section starts no session and asks Yoan what is missing', () => {
  const gate = fn('sessionGate')({ text: '# INV-88: Фактура\n\n## Какво\n\nФактура към "Техномаркет България" ЕАД.\n\n+++ Agent notes\n\n* x\n\n+++' });
  assert.equal(gate.action, 'ask'); // check 1: no session
  assert.match(gate.what, /Как проверявам/); // check 1: the comment says what is missing
});

test('check 1: an empty "Как проверявам" section (only blank lines before Agent notes, or before the next heading, or at the end) starts no session', () => {
  const gate = fn('sessionGate');
  for (const text of [
    taskWith('## Как проверявам\n\n   \n'),
    '# INV-88: Фактура\n\n## Какво\n\nx\n\n## Как проверявам\n\n## Бележки\n\ny',
    '# INV-88: Фактура\n\n## Какво\n\nx\n\n## Как проверявам\n\n',
  ]) {
    const result = gate({ text });
    assert.equal(result.action, 'ask', text); // check 1: empty section
    assert.match(result.what, /Как проверявам/, text); // check 1
  }
});

test('check 1: once Yoan adds criteria the same task runs normally', () => {
  const result = fn('sessionGate')({ text: taskWith('## Как проверявам\n\n* Фактура 0000000417 има ДДС 4000 и общо 24000 евроцента.') });
  assert.deepEqual(result, { action: 'run' }); // check 1: "тя тръгва нормално"
  assert.deepEqual(fn('sessionGate')({ text: taskWith('## Как проверявам\n\n* x'), unreadable: [] }), { action: 'run' });
});

// --- check 4: a document that cannot be read stops the task with a question ---

test('check 4: a linked document that cannot be read starts no session and the question names it', () => {
  const result = fn('sessionGate')({ text: taskWith(`## Как проверявам\n\n* По ${PROCESS_LINK}.`), unreadable: ['5d5d487726d0'] });
  assert.equal(result.action, 'ask'); // check 4: no session
  assert.match(result.what, /5d5d487726d0/); // check 4: Yoan sees which document
});

test('check 4: linearDocument reads by slugId with document(id: ...) and gives null when Linear cannot give it', async () => {
  const calls = [];
  const linear = async (query, vars) => {
    calls.push({ query, vars });
    const slug = Object.values(vars ?? {})[0];
    if (slug === 'deadbeef0000') throw new Error('Entity not found: Document');
    if (slug === 'feedface0000') return { document: null };
    return { document: BY_SLUG[slug] };
  };
  const read = fn('linearDocument');
  const doc = await read(linear, '5d5d487726d0');
  assert.equal(doc.title, 'Процесът'); // check 2: the document's title
  assert.equal(doc.content, PROCESS.content); // check 2: the full text
  assert.match(calls[0].query, /document\s*\(\s*id\s*:/); // Agent notes: document(id: ...) takes the slugId
  assert.ok(Object.values(calls[0].vars ?? {}).includes('5d5d487726d0'), 'the slugId is sent as a variable'); // Agent notes
  assert.equal(await read(linear, 'deadbeef0000'), null); // check 4: deleted
  assert.equal(await read(linear, 'feedface0000'), null); // check 4: no access
});

test('check 4: taskDocuments lists the documents it could not read, whether getDocument gives null or throws', async () => {
  const text = taskWith(`## Как проверявам\n\n* ${PROCESS_LINK}, https://linear.app/invoicely-project/document/iztrit-deadbeef0000 и https://linear.app/invoicely-project/document/skrit-feedface0000`);
  const getDocument = async (slug) => { if (slug === 'deadbeef0000') return null; if (slug === 'feedface0000') throw new Error('Forbidden'); return BY_SLUG[slug]; };
  const { docs: got, unreadable } = await fn('taskDocuments')({ text, repo: 'invoicely-agents', getDocument, findGlossary: async () => null });
  assert.deepEqual(unreadable, ['deadbeef0000', 'feedface0000']); // check 4
  assert.deepEqual(got.map((d) => d.title), ['Процесът']); // check 2: the readable one is still there
});

// --- check 5: the glossary for invoicely tasks ---

test('check 5: an invoicely task gets the "Речник" document after its own documents, without linking it', async () => {
  let asked = 0;
  const findGlossary = async () => { asked += 1; return GLOSSARY; };
  const text = taskWith(`## Как проверявам\n\n* По ${PROCESS_LINK}.`);
  const { docs: got, unreadable } = await fn('taskDocuments')({ text, repo: 'invoicely', getDocument: async (s) => BY_SLUG[s], findGlossary });
  assert.deepEqual(got.map((d) => d.title), ['Процесът', 'Речник']); // check 5
  assert.deepEqual(unreadable, []);
  assert.equal(asked, 1);
});

test('check 5: an invoicely-agents task does not get the glossary; a missing glossary is not an error; a linked glossary comes once', async () => {
  const td = fn('taskDocuments');
  const text = taskWith('## Как проверявам\n\n* x');
  let asked = 0;
  const agents = await td({ text, repo: 'invoicely-agents', getDocument: async (s) => BY_SLUG[s], findGlossary: async () => { asked += 1; return GLOSSARY; } });
  assert.deepEqual(agents.docs, []); // check 5: only without the invoicely-agents label
  assert.equal(asked, 0);
  const none = await td({ text, repo: 'invoicely', getDocument: async (s) => BY_SLUG[s], findGlossary: async () => null });
  assert.deepEqual([none.docs, none.unreadable], [[], []]); // check 5: "ако такъв съществува"
  const linked = await td({ text: taskWith(`## Как проверявам\n\n* ${GLOSSARY.url}`), repo: 'invoicely', getDocument: async (s) => BY_SLUG[s], findGlossary: async () => GLOSSARY });
  assert.deepEqual(linked.docs.map((d) => d.title), ['Речник']);
});

// --- check 2 / check 6c: the prompt with the documents ---

test('check 2: the documents block has a block per document with its title and its full text, in order', () => {
  const block = fn('documentsBlock')([PROCESS, ADR]);
  assert.ok(block.includes(PROCESS.content) && block.includes(ADR.content), 'the full text of each document'); // check 2
  const at = (s) => block.indexOf(s);
  assert.ok(at('Процесът') > -1 && at('Процесът') < at(PROCESS.content), 'the title heads its block'); // check 2
  assert.ok(at(PROCESS.content) < at('ADR-007: Парите в евроценти') && at('ADR-007: Парите в евроценти') < at(ADR.content), 'one block after the other'); // check 2
  assert.equal(fn('documentsBlock')([]), ''); // no documents, nothing in the prompt
});

for (const role of ['test-author', 'implementer']) {
  test(`check 2: the ${role} prompt has {DOCUMENTS} and, filled, carries the documents`, () => {
    const template = fs.readFileSync(path.join(FACTORY, 'prompts', `${role}.md`), 'utf8');
    assert.match(template, /\{DOCUMENTS\}/); // check 2: test-author and implementer
    const prompt = fillTemplate(template, { ISSUE: 'INV-88', TASK: taskWith('## Как проверявам\n\n* x'), DOCUMENTS: fn('documentsBlock')([PROCESS, GLOSSARY]) });
    assert.ok(prompt.includes(PROCESS.content) && prompt.includes(GLOSSARY.content)); // check 2
    assert.ok(!prompt.includes('{DOCUMENTS}'));
  });
}

// --- check 3 / check 6c: the PR description ---

test('check 3: the PR gets a collapsed "Документи" section with the same documents', () => {
  const section = fn('prDocumentsSection')([PROCESS, ADR]);
  assert.match(section, /<details>[\s\S]*<summary>[^<]*Документи[^<]*<\/summary>[\s\S]*<\/details>/); // check 3: свит раздел "Документи"
  for (const d of [PROCESS, ADR]) {
    assert.ok(section.includes(d.title) && section.includes(d.content), d.title); // check 3: the same documents
  }
  assert.doesNotMatch(section, /съкрат/i); // short documents are not cut
  assert.equal(fn('prDocumentsSection')([]), ''); // no documents, no section
});

test('check 3: documents longer than the 65 000 character limit go in from their start, with a note that they are cut', () => {
  const long = { ...ADR, content: `Начало на ADR-007.\n${'Сумите са в евроцентове. '.repeat(4000)}` }; // about 100 000 characters
  const section = fn('prDocumentsSection')([PROCESS, long]);
  assert.ok(section.length <= 65000, `section is ${section.length} characters`); // Agent notes: ~65 000 limit
  assert.ok(section.includes(PROCESS.content), 'the start goes in'); // Agent notes: "влиза началото им"
  assert.ok(section.includes('Начало на ADR-007.'), 'the start of the long one goes in too'); // Agent notes
  assert.match(section, /съкрат/i); // Agent notes: "бележка, че са съкратени"
  assert.match(section, /<\/details>\s*$/); // still a closed section
  const smaller = fn('prDocumentsSection')([PROCESS, long], 20000);
  assert.ok(smaller.length <= 20000 && /съкрат/i.test(smaller)); // the limit is a parameter
});

// --- the runner uses all of it ---

test('checks 1-5: factory.mjs takes the gate, the documents, the prompt block and the PR section from ./documents.mjs', () => {
  const src = fs.readFileSync(path.join(FACTORY, 'factory.mjs'), 'utf8');
  for (const name of ['sessionGate', 'taskDocuments', 'linearDocument', 'documentsBlock', 'prDocumentsSection']) {
    assert.ok(new RegExp(`import\\s*\\{[^}]*\\b${name}\\b[^}]*\\}\\s*from\\s*['"]\\./documents\\.mjs['"]`).test(src), `factory.mjs imports ${name} from ./documents.mjs`);
    assert.ok(new RegExp(`\\b${name}\\s*\\(`).test(src), `factory.mjs calls ${name}`);
  }
  assert.match(src, /DOCUMENTS\s*:/); // check 2: the prompts' {DOCUMENTS} is filled
});
