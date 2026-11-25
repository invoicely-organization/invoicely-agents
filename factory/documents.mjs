// The Linear documents a task links, for the agents, which do not see Linear (INV-71). The runner reads them at the
// start of every new session and gives their full text to test-author and the implementer in the prompt, and to the
// reviewer in the PR description. A task without acceptance criteria ("Как проверявам") starts no session.

// https://linear.app/<workspace>/document/<slug>; the slugId is the part after the slug's last dash.
const DOCUMENT_URL = /https:\/\/linear\.app\/[^/\s)>\]]+\/document\/([A-Za-z0-9-]+)/g;

// The slugIds of the documents linked in the text, in order of first appearance, without duplicates.
export function documentLinks(text) {
  const slugs = [];
  for (const match of String(text ?? '').matchAll(DOCUMENT_URL)) {
    const slugId = match[1].split('-').filter(Boolean).pop();
    if (slugId && !slugs.includes(slugId)) slugs.push(slugId);
  }
  return slugs;
}

const CHECKS_HEADING = /^\s*(?:#{1,6}\s*|\*\*)Как проверявам(?:\*\*)?\s*:?\s*$/u;
const SECTION_END = /^\s*(?:#{1,6}\s|\+\+\+)/;

// The text of the "Как проверявам" section, or null when the task has none.
export function checksSection(text) {
  const lines = String(text ?? '').split('\n');
  const at = lines.findIndex((line) => CHECKS_HEADING.test(line));
  if (at === -1) return null;
  const body = [];
  for (const line of lines.slice(at + 1)) {
    if (SECTION_END.test(line)) break;
    body.push(line);
  }
  return body.join('\n').trim();
}

// Whether a session may start: 'ask' when the criteria are missing or empty, or a linked document cannot be read.
export function sessionGate({ text, unreadable = [] }) {
  const checks = checksSection(text);
  if (checks === null) {
    return { action: 'ask', what: 'задачата няма раздел "Как проверявам", а без критерии за приемане runner-ът не пуска сесия.' };
  }
  if (checks === '') {
    return { action: 'ask', what: 'разделът "Как проверявам" на задачата е празен, а без критерии за приемане runner-ът не пуска сесия.' };
  }
  if (unreadable.length) {
    return { action: 'ask', what: `runner-ът не може да прочете ${unreadable.length === 1 ? 'документа' : 'документите'} от Linear, ${unreadable.length === 1 ? 'който задачата посочва' : 'които задачата посочва'}: ${unreadable.join(', ')} (изтрит или без достъп).` };
  }
  return { action: 'run' };
}

const DOCUMENT_QUERY = 'query($id:String!){document(id:$id){id title content url}}';

// One document by its id or slugId with the runner's Linear client; null when Linear cannot give it.
export async function linearDocument(linear, slugId) {
  try {
    const doc = (await linear(DOCUMENT_QUERY, { id: slugId }))?.document;
    return doc ? { id: doc.id, title: doc.title, content: doc.content ?? '', url: doc.url } : null;
  } catch {
    return null;
  }
}

// The "Речник" document of the project "Архитектура", or null when there is none.
export async function linearGlossary(linear) {
  const data = await linear('query{projects(first:5,filter:{name:{eq:"Архитектура"}}){nodes{documents(first:100){nodes{id title content url}}}}}', {});
  const doc = (data?.projects?.nodes ?? []).flatMap((p) => p.documents?.nodes ?? []).find((d) => d.title?.trim() === 'Речник');
  return doc ? { id: doc.id, title: doc.title, content: doc.content ?? '', url: doc.url } : null;
}

// The documents of a task: the linked ones in order, then the glossary for invoicely tasks. unreadable: the slugIds
// getDocument could not give.
export async function taskDocuments({ text, repo, getDocument, findGlossary }) {
  const docs = [];
  const unreadable = [];
  for (const slugId of documentLinks(text)) {
    let doc = null;
    try {
      doc = await getDocument(slugId);
    } catch {
      doc = null;
    }
    if (doc) docs.push(doc);
    else unreadable.push(slugId);
  }
  if (repo === 'invoicely') {
    const glossary = await findGlossary();
    if (glossary && !docs.some((d) => d.id === glossary.id)) docs.push(glossary);
  }
  return { docs, unreadable };
}

const attr = (value) => String(value ?? '').replace(/"/g, '&quot;');

// The {DOCUMENTS} text of the session prompts: a block per document, headed by its title.
export function documentsBlock(docs) {
  if (!docs?.length) return '';
  return [
    'The Linear documents the task links (and the glossary, for the invoicely repo), read from Linear at the start of this session. They are sources of truth with the task:',
    '',
    ...docs.map((d) => `<document title="${attr(d.title)}" url="${attr(d.url)}">\n# ${d.title}\n\n${String(d.content ?? '').trim()}\n</document>\n`),
  ].join('\n').trim();
}

// The collapsed "Документи" section of the PR description, at most `limit` characters: longer documents go in from
// their start, with a note that they are cut.
export function prDocumentsSection(docs, limit = 65000) {
  if (!docs?.length) return '';
  const open = `<details>\n<summary>Документи (${docs.length})</summary>\n\n`;
  const close = '\n\n</details>';
  const body = docs.map((d) => `### ${d.title}\n\n${d.url ?? ''}\n\n${String(d.content ?? '').trim()}`).join('\n\n---\n\n');
  if (open.length + body.length + close.length <= limit) return `${open}${body}${close}`;
  const note = '> Документите са съкратени: тук е само началото им, пълният текст е в Linear.\n\n';
  const cutMark = '\n\n[...]';
  const room = limit - open.length - note.length - cutMark.length - close.length;
  if (room <= 0) return '';
  return `${open}${note}${body.slice(0, room)}${cutMark}${close}`;
}
