// Where the backend is depends on how this page was opened:
//   * Electron passes it in the URL (it knows ORCHESTRATOR_BACKEND, the page doesn't);
//   * served over HTTP by the `web` container, it is the same host, one port over;
//   * opened as a bare file, it can only be the local one.
const API_PORT = 8756;
const API =
  new URLSearchParams(window.location.search).get('api') ||
  (window.location.protocol.startsWith('http')
    ? `${window.location.protocol}//${window.location.hostname}:${API_PORT}`
    : `http://127.0.0.1:${API_PORT}`);

const groupsEl = document.getElementById('groups');
const chatsListEl = document.getElementById('chats-list');
const chatsTitleEl = document.getElementById('chats-title');
const newChatBtn = document.getElementById('new-chat-btn');
const messagesEl = document.getElementById('messages');
const composerEl = document.getElementById('composer');
const inputEl = document.getElementById('composer-input');
const sendBtn = document.getElementById('composer-send');
const stopBtn = document.getElementById('composer-stop');
const attachBtn = document.getElementById('composer-attach');
const fileInputEl = document.getElementById('composer-file');
const attachmentsEl = document.getElementById('attachments');
const commandMenuEl = document.getElementById('command-menu');
const settingsEl = document.getElementById('chat-settings');
const modelSelect = document.getElementById('model-select');
const effortSelect = document.getElementById('effort-select');
const settingsNoteEl = document.getElementById('settings-note');
const contextGaugeEl = document.getElementById('context-gauge');
const contextGaugeFillEl = document.getElementById('context-gauge-fill');
const contextGaugeLabelEl = document.getElementById('context-gauge-label');

let groups = [];
let chatsCache = [];
let currentGroup = null;
let currentChatId = null;

// Per-chat state that must survive switching away and back while a turn is
// still in progress (or already finished but not yet reflected by a DB
// reload): the ordered trace of bubbles/tool-uses/permission cards for the
// turn currently running in that chat, keyed by chat id.
const chatLiveItems = new Map(); // chatId -> Array<item>
const chatGroupMap = new Map(); // chatId -> groupName
const runningChats = new Set(); // chatId currently streaming a turn
const unreadChats = new Set(); // chatId with activity the user hasn't seen yet

// How full each chat's context window is, last we heard: {tokens, limit, pct}.
// Set from a live `result` event's usage, or fetched once from the CLI's own
// transcript when a chat is opened that hasn't run a turn this session.
const chatContextUsage = new Map(); // chatId -> {tokens, limit, pct} | null

// The composer is one shared textarea, but a half-typed message belongs to the
// chat it was started in. Its text is stashed here on the way out of a chat and
// put back on the way in, so switching chats no longer carries a draft across.
const chatDrafts = new Map(); // chatId -> composer text

// Files staged for the next message, per chat, so they survive switching chats
// the same way a draft does. Each entry: {id, name, size, path|null,
// status: 'uploading'|'ready'|'error', error?}. `path` is filled in once the
// upload lands; that path is what the message embeds for the agent to read.
const chatAttachments = new Map(); // chatId -> Array<attachment>
let attachmentSeq = 0;

function attachmentsFor(chatId) {
  if (!chatAttachments.has(chatId)) chatAttachments.set(chatId, []);
  return chatAttachments.get(chatId);
}

// Moves the current composer text into the leaving chat's draft. Called before
// currentChatId changes, from every place that switches away from a chat.
function stashCurrentDraft() {
  if (currentChatId !== null) chatDrafts.set(currentChatId, inputEl.value);
}

function loadDraft(chatId) {
  inputEl.value = chatDrafts.get(chatId) || '';
  autoGrowInput();
  updateCommandMenu();
  renderAttachments();
}

function formatBytes(n) {
  if (!n && n !== 0) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

// Draws the chips for the current chat's staged files.
function renderAttachments() {
  const items = currentChatId !== null ? attachmentsFor(currentChatId) : [];
  attachmentsEl.innerHTML = '';
  attachmentsEl.hidden = items.length === 0;
  for (const att of items) {
    const chip = document.createElement('div');
    chip.className = 'attachment' + (att.status === 'error' ? ' error' : '');
    chip.title = att.status === 'error' ? att.error || 'Upload failed' : att.name;

    const name = document.createElement('span');
    name.className = 'attachment-name';
    name.textContent = att.name;
    chip.appendChild(name);

    const meta = document.createElement('span');
    if (att.status === 'uploading') {
      meta.className = 'attachment-spinner';
      meta.textContent = '…';
    } else if (att.status === 'error') {
      meta.className = 'attachment-size';
      meta.textContent = 'failed';
    } else {
      meta.className = 'attachment-size';
      meta.textContent = formatBytes(att.size);
    }
    chip.appendChild(meta);

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'attachment-remove';
    remove.textContent = '✕';
    remove.title = 'Remove';
    remove.onclick = () => removeAttachment(att.id);
    chip.appendChild(remove);

    attachmentsEl.appendChild(chip);
  }
  updateComposerState();
}

function removeAttachment(id) {
  if (currentChatId === null) return;
  const items = attachmentsFor(currentChatId);
  const idx = items.findIndex((a) => a.id === id);
  if (idx !== -1) items.splice(idx, 1);
  renderAttachments();
}

// Stages the picked files for the current chat and uploads each one. The chip is
// shown right away in an "uploading" state and updated in place when its POST
// lands, so a big file never blocks the composer.
async function addFiles(fileList) {
  if (currentChatId === null) return;
  const chatId = currentChatId;
  const items = attachmentsFor(chatId);
  const staged = [];
  for (const file of fileList) {
    const att = { id: ++attachmentSeq, name: file.name || 'file', size: file.size, path: null, status: 'uploading' };
    items.push(att);
    staged.push({ att, file });
  }
  if (chatId === currentChatId) renderAttachments();

  await Promise.all(
    staged.map(async ({ att, file }) => {
      try {
        const form = new FormData();
        form.append('file', file, file.name);
        const res = await fetch(`${API}/chats/${chatId}/attachments`, { method: 'POST', body: form });
        if (!res.ok) throw new Error(await res.text());
        const info = await res.json();
        // The user may have removed the chip while it was uploading.
        if (!attachmentsFor(chatId).includes(att)) return;
        att.path = info.path;
        att.name = info.name || att.name;
        att.size = info.size ?? att.size;
        att.status = 'ready';
      } catch (err) {
        att.status = 'error';
        att.error = String(err.message || err);
      }
      if (chatId === currentChatId) renderAttachments();
    })
  );
}

// The trailing block appended to a message so the agent knows what was attached
// and where to read it. Empty when nothing is staged, so a plain message is
// untouched.
function attachmentPromptBlock(items) {
  const ready = items.filter((a) => a.status === 'ready' && a.path);
  if (!ready.length) return '';
  const lines = ready.map((a) => `- ${a.name}: ${a.path}`);
  return `📎 Attached file(s) — read them with the Read tool:\n${lines.join('\n')}`;
}

async function getJSON(path) {
  const res = await fetch(API + path);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

async function postJSON(path, body) {
  const res = await fetch(API + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

async function patchJSON(path, body) {
  const res = await fetch(API + path, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

function unreadCountForGroup(name) {
  let n = 0;
  for (const chatId of unreadChats) {
    if (chatGroupMap.get(chatId) === name) n++;
  }
  return n;
}

function renderGroupsList() {
  groupsEl.innerHTML = '';
  for (const g of groups) {
    const btn = document.createElement('button');
    btn.className = 'group-btn' + (g.name === currentGroup ? ' active' : '');
    btn.textContent = g.name.slice(0, 2).toUpperCase();
    btn.title = g.name;
    btn.onclick = () => selectGroup(g.name);

    const count = unreadCountForGroup(g.name);
    if (count > 0) {
      const badge = document.createElement('span');
      badge.className = 'unread-badge';
      badge.textContent = String(count);
      btn.appendChild(badge);
    }

    groupsEl.appendChild(btn);
  }

  const add = document.createElement('button');
  add.className = 'group-btn group-add';
  add.textContent = '+';
  add.title = 'Add a project folder';
  add.onclick = addGroup;
  groupsEl.appendChild(add);

  const report = document.createElement('button');
  report.className = 'group-btn report-btn';
  report.textContent = '📋';
  report.title = 'Work report';
  report.onclick = openReportPanel;
  groupsEl.appendChild(report);
}

// Adding a project needs a folder off the real filesystem, which a web page has
// no way to browse. In Electron the main process opens the native picker for us;
// in a browser tab that bridge is absent and the path has to be typed.
async function addGroup() {
  let path = null;
  if (window.orchestrator?.pickDirectory) {
    path = await window.orchestrator.pickDirectory();
    if (!path) return; // cancelled
  } else {
    path = prompt('Absolute path to the project folder:');
    if (!path || !path.trim()) return;
    path = path.trim();
  }

  const fullAccess = confirm(
    `Full access for this project?\n\n${path}\n\n` +
      'OK — the agent runs without permission prompts.\n' +
      'Cancel — every tool asks first.'
  );

  try {
    const group = await postJSON('/groups', { path, full_access: fullAccess });
    groups = await getJSON('/groups');
    renderGroupsList();
    await selectGroup(group.name);
  } catch (err) {
    alert(`Could not add the project:\n\n${err.message}`);
  }
}

// Renaming lives in list state rather than in the DOM, because the list is
// rebuilt from scratch on every selection and on every unread update — an input
// held only by a row would be thrown away the moment anything else happened.
// Keyed by chat id, the edit is simply re-rendered along with everything else.
let renamingChatId = null;
let renameDraft = null; // what has been typed so far, so a re-render can't lose it
let renameInputEl = null;

function renderChatsList() {
  // Anything about to be discarded must not commit on its way out: removing a
  // focused input fires blur, and blur is what saves.
  if (renameInputEl) renameInputEl.dataset.stale = '1';
  renameInputEl = null;

  chatsListEl.innerHTML = '';
  for (const c of chatsCache) {
    const div = document.createElement('div');
    div.className = 'chat-item' + (c.id === currentChatId ? ' active' : '');

    if (c.id === renamingChatId) {
      div.appendChild(buildRenameInput(c));
      chatsListEl.appendChild(div);
      continue;
    }

    const label = document.createElement('span');
    label.className = 'chat-item-label';
    label.textContent = c.title;
    div.appendChild(label);

    if (unreadChats.has(c.id)) {
      const dot = document.createElement('span');
      dot.className = 'unread-dot';
      div.appendChild(dot);
    }

    const renameBtn = document.createElement('button');
    renameBtn.className = 'chat-rename-btn';
    renameBtn.title = 'Rename';
    renameBtn.textContent = '✎';
    renameBtn.onclick = (e) => {
      e.stopPropagation(); // the row would otherwise switch chats under us
      beginRename(c.id);
    };
    div.appendChild(renameBtn);

    div.onclick = () => selectChat(c.id);
    div.oncontextmenu = (e) => {
      e.preventDefault();
      beginRename(c.id);
    };
    chatsListEl.appendChild(div);
  }
}

function beginRename(chatId) {
  renamingChatId = chatId;
  renameDraft = null;
  renderChatsList();
}

// The row's label swapped for an input. Enter and clicking away commit, Escape
// abandons; a failed save just leaves the old title standing.
function buildRenameInput(chat) {
  const fresh = renameDraft === null;
  const input = document.createElement('input');
  input.className = 'chat-rename-input';
  input.value = fresh ? chat.title : renameDraft;

  const finish = async (save) => {
    if (input.dataset.stale) return; // superseded by a re-render
    input.dataset.stale = '1';
    const title = input.value.trim();
    renamingChatId = null;
    renameDraft = null;

    if (save && title && title !== chat.title) {
      try {
        const updated = await patchJSON(`/chats/${chat.id}`, { title });
        const entry = chatsCache.find((c) => c.id === chat.id);
        if (entry) entry.title = updated.title;
      } catch (err) {
        console.error('rename failed', err);
        if (chat.id === currentChatId) {
          markBubbleAsError(appendBubble('error', `Rename failed: ${err.message}`));
        }
      }
    }
    renderChatsList();
  };

  input.oninput = () => {
    renameDraft = input.value;
  };
  input.onclick = (e) => e.stopPropagation();
  input.oncontextmenu = (e) => e.stopPropagation();
  input.onblur = () => finish(true);
  input.onkeydown = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      finish(true);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      finish(false);
    }
  };

  renameInputEl = input;
  // Focus only once the input is actually in the document. On a re-render mid-edit
  // the caret goes to the end instead of reselecting everything the user typed.
  setTimeout(() => {
    if (input.dataset.stale) return;
    input.focus();
    if (fresh) input.select();
    else input.setSelectionRange(input.value.length, input.value.length);
  }, 0);
  return input;
}

// ---------------------------------------------------------------------------
// Human-readable tool labels
//
// A streamed tool_use block only carries the tool *name* in content_block_start;
// its arguments arrive afterwards as input_json_delta chunks. So a label is built
// in two passes: first the bare name, then — once the JSON input is complete —
// a description of what the tool is actually doing with it.
// ---------------------------------------------------------------------------

function truncate(value, max = 90) {
  const s = String(value ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

// "/Users/me/proj/src/api/routes.py" -> "…/api/routes.py"
function shortPath(p) {
  if (!p) return '';
  const parts = String(p).split('/').filter(Boolean);
  if (parts.length <= 2) return String(p);
  return '…/' + parts.slice(-2).join('/');
}

const TOOL_ICONS = {
  Read: '📖',
  Write: '📝',
  Edit: '✏️',
  NotebookEdit: '✏️',
  Bash: '⌨️',
  BashOutput: '⌨️',
  KillShell: '⌨️',
  Glob: '🔍',
  Grep: '🔍',
  WebFetch: '🌐',
  WebSearch: '🌐',
  Task: '🤖',
  Agent: '🤖',
  AskUserQuestion: '❓',
  TodoWrite: '☑️',
};

function toolIcon(name) {
  if (name && name.startsWith('mcp__project_memory__')) return '🧠';
  if (name && name.startsWith('mcp__')) return '🔌';
  return TOOL_ICONS[name] || '⚙️';
}

// Turns (tool_name, tool_input) into a one-line "what is it doing" string.
// `input` may be null/partial — every branch has to tolerate missing fields.
function describeTool(name, input) {
  const i = input && typeof input === 'object' ? input : {};

  switch (name) {
    case 'Read': {
      const range = i.offset ? ` from line ${i.offset}` : '';
      return `Reading ${shortPath(i.file_path) || 'a file'}${range}`;
    }
    case 'Write':
      return `Writing ${shortPath(i.file_path) || 'a file'}`;
    case 'Edit':
      return `Editing ${shortPath(i.file_path) || 'a file'}${i.replace_all ? ' (all matches)' : ''}`;
    case 'NotebookEdit':
      return `Editing notebook ${shortPath(i.notebook_path) || ''}`.trim();
    case 'Bash':
      return i.description
        ? `${truncate(i.description, 60)} — \`${truncate(i.command, 60)}\``
        : `Running \`${truncate(i.command, 90) || '…'}\``;
    case 'BashOutput':
      return 'Reading background command output';
    case 'KillShell':
      return 'Stopping a background command';
    case 'Glob':
      return `Finding files matching ${truncate(i.pattern, 60) || '…'}`;
    case 'Grep': {
      const where = i.path ? ` in ${shortPath(i.path)}` : '';
      return `Searching for "${truncate(i.pattern, 60) || '…'}"${where}`;
    }
    case 'WebFetch':
      return `Fetching ${truncate(i.url, 70) || 'a page'}`;
    case 'WebSearch':
      return `Searching the web for "${truncate(i.query, 70) || '…'}"`;
    case 'TodoWrite': {
      const n = Array.isArray(i.todos) ? i.todos.length : 0;
      const active = Array.isArray(i.todos) ? i.todos.find((t) => t.status === 'in_progress') : null;
      if (active) return `Working on: ${truncate(active.activeForm || active.content, 70)}`;
      return n ? `Updating the plan (${n} steps)` : 'Updating the plan';
    }
    case 'Task':
    case 'Agent':
      return `Delegating to a subagent: ${truncate(i.description || i.prompt, 70) || '…'}`;
    case 'AskUserQuestion': {
      const first = Array.isArray(i.questions) ? i.questions[0] : null;
      return first ? `Asking: ${truncate(first.question, 70)}` : 'Asking you a question';
    }
    case 'Skill':
      return `Using skill ${truncate(i.skill, 50) || '…'}`;
    case 'ToolSearch':
      return `Looking up tools: ${truncate(i.query, 60) || '…'}`;
    case 'mcp__project_memory__search_memory':
      return `Recalling from other chats: "${truncate(i.query, 60) || '…'}"`;
    case 'mcp__project_memory__save_memory':
      return `Remembering for later chats: ${truncate(i.text, 70) || '…'}`;
    default:
      break;
  }

  if (name && name.startsWith('mcp__')) {
    const [, server, ...rest] = name.split('__');
    const tool = rest.join('__');
    const arg = firstMeaningfulArg(i);
    return `${server} · ${tool}${arg ? ` — ${arg}` : ''}`;
  }

  const arg = firstMeaningfulArg(i);
  return arg ? `${name} — ${arg}` : name || 'tool';
}

// Best-effort "most descriptive" argument for tools we have no special case for.
function firstMeaningfulArg(input) {
  const keys = ['description', 'prompt', 'query', 'pattern', 'command', 'file_path', 'path', 'url', 'name'];
  for (const k of keys) {
    if (typeof input[k] === 'string' && input[k].trim()) {
      return k.endsWith('path') ? shortPath(input[k]) : truncate(input[k], 70);
    }
  }
  return '';
}

function toolLabel(name, input) {
  return `${toolIcon(name)} ${describeTool(name, input)}`;
}

// Only the agent's prose is rendered as markdown. What the user typed is shown
// back verbatim, and tool/error lines are terse one-liners with no markup.
function setBubbleContent(contentEl, role, text) {
  if (role === 'assistant') {
    contentEl.classList.add('markdown');
    contentEl.innerHTML = renderMarkdown(text);
  } else {
    contentEl.classList.remove('markdown');
    contentEl.textContent = text;
  }
}

function appendBubble(role, text) {
  const wrap = document.createElement('div');
  wrap.className = `bubble ${role}`;
  const roleLabel = document.createElement('div');
  roleLabel.className = 'role';
  roleLabel.textContent = role;
  const content = document.createElement('div');
  content.className = 'content';
  setBubbleContent(content, role, text);
  wrap.appendChild(roleLabel);
  wrap.appendChild(content);
  messagesEl.appendChild(wrap);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return content;
}

function renderMessages(msgs) {
  messagesEl.innerHTML = '';
  for (const m of msgs) appendBubble(m.role, m.content);
}

// Re-creates DOM nodes for a chat's in-progress live trace (text bubbles,
// tool-use markers, permission cards) on top of whatever renderMessages()
// already drew from the DB. Called whenever a chat becomes visible again.
function renderLiveItems(chatId) {
  const items = chatLiveItems.get(chatId);
  if (!items) return;
  for (const item of items) {
    if (item.kind === 'bubble') {
      item.el = appendBubble(item.role, item.text);
      if (item.role === 'error') markBubbleAsError(item.el);
    } else if (item.kind === 'tool') {
      item.el = appendBubble('tool', item.text);
    } else if (item.kind === 'queued') {
      item.el = appendQueuedBubble(item);
    } else if (item.kind === 'activity') {
      item.el = appendActivityPanel(item);
    } else if (item.kind === 'permission') {
      renderPermissionCard(item);
    } else if (item.kind === 'question') {
      renderQuestionCard(item);
    }
  }
}

// What the turn's subagents are doing, while they do it. A turn that spends
// hours inside one Agent call streams nothing of its own, so without this the
// chat is blank until it ends. One panel that rewrites itself rather than a
// bubble per line: a big fan-out produces thousands of them.
const ACTIVITY_LINES = 40; // how much scrollback the panel keeps

function activityLine(evt) {
  const who = evt.agent_type || 'agent';
  const what = evt.kind === 'tool' ? evt.tool || 'tool' : '💬';
  const detail = evt.detail ? ` · ${evt.detail}` : '';
  return `${who} · ${what}${detail}`;
}

function renderActivityPanel(item) {
  if (!item.el) return;
  const head = item.el.querySelector('.activity-head');
  const body = item.el.querySelector('.activity-body');
  const agents = item.agents.size;
  head.textContent =
    `субагенты: ${agents} · событий: ${item.count}` +
    (item.lastAt ? ` · ${item.lastAt}` : '');
  body.textContent = item.lines.join('\n');
  body.scrollTop = body.scrollHeight;
}

function appendActivityPanel(item) {
  const wrap = document.createElement('div');
  wrap.className = 'bubble activity';

  const role = document.createElement('div');
  role.className = 'role activity-head';

  const body = document.createElement('div');
  body.className = 'content activity-body';

  wrap.appendChild(role);
  wrap.appendChild(body);
  messagesEl.appendChild(wrap);
  item.el = wrap;
  renderActivityPanel(item);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return wrap;
}

// A message that has been handed to the agent but whose turn hasn't started yet.
// It can't be taken back — the CLI already has it — so there is no cancel here.
function appendQueuedBubble(item) {
  const wrap = document.createElement('div');
  wrap.className = 'bubble user queued';

  const role = document.createElement('div');
  role.className = 'role';
  role.textContent = 'up next';

  const content = document.createElement('div');
  content.className = 'content';
  content.textContent = item.text;

  wrap.appendChild(role);
  wrap.appendChild(content);
  messagesEl.appendChild(wrap);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return wrap;
}

// The composer stays usable during a run: anything sent is picked up as the next
// turn, and Stop aborts whatever is running right now.
// ---------------------------------------------------------------------------
// Model and effort, per chat
//
// Both are decided when the CLI process starts, so changing either ends the
// session and the next message opens a new one — resuming the same conversation.
// The list comes from the CLI's own handshake, per project: which models exist,
// and which of them take an effort setting, is not ours to hardcode.
// ---------------------------------------------------------------------------

const modelsByGroup = new Map(); // groupName -> Array<{value, label, description, efforts}>

async function loadModels(groupName) {
  if (modelsByGroup.has(groupName)) return modelsByGroup.get(groupName);
  try {
    const models = await getJSON(`/groups/${encodeURIComponent(groupName)}/models`);
    modelsByGroup.set(groupName, models);
  } catch {
    modelsByGroup.set(groupName, []); // no picker rather than a broken one
  }
  if (groupName === currentGroup) renderChatSettings();
  return modelsByGroup.get(groupName);
}

function currentChat() {
  return chatsCache.find((c) => c.id === currentChatId) || null;
}

// Green under half, amber into the danger zone, red once it's genuinely full —
// the same bands a compaction warning would use.
function gaugeColor(pct) {
  if (pct >= 90) return '#ed4245';
  if (pct >= 70) return '#faa61a';
  return '#3ba55d';
}

function renderContextGauge() {
  const usage = currentChatId !== null ? chatContextUsage.get(currentChatId) : null;
  if (!usage || usage.tokens == null) {
    contextGaugeEl.hidden = true;
    return;
  }
  contextGaugeEl.hidden = false;
  const pct = Math.max(0, Math.min(100, usage.pct ?? 0));
  contextGaugeFillEl.style.setProperty('--pct', `${pct}%`);
  contextGaugeFillEl.style.setProperty('--gauge-color', gaugeColor(pct));
  const kify = (n) => (n >= 1000 ? `${(n / 1000).toFixed(0)}K` : String(n));
  contextGaugeLabelEl.textContent =
    `${kify(usage.tokens)}/${kify(usage.limit)} (${pct}%)`;
  contextGaugeEl.title = `Context window: ${usage.tokens.toLocaleString()} / ${usage.limit.toLocaleString()} tokens`;
}

function setContextUsage(chatId, tokens, limit) {
  if (tokens == null || !limit) {
    chatContextUsage.set(chatId, null);
  } else {
    chatContextUsage.set(chatId, { tokens, limit, pct: Math.round((100 * tokens) / limit) });
  }
  if (chatId === currentChatId) renderContextGauge();
}

// A chat that hasn't run a turn since the backend last started has no live
// usage yet — recovered once from its transcript on disk instead.
async function loadContextUsage(chatId) {
  if (chatContextUsage.has(chatId)) return;
  chatContextUsage.set(chatId, null); // claim it so a second selectChat doesn't refetch
  try {
    const data = await getJSON(`/chats/${chatId}/context`);
    setContextUsage(chatId, data.tokens, data.limit);
  } catch {
    // leave it unset — no gauge rather than a broken one
  }
}

function renderChatSettings() {
  const chat = currentChat();
  const groupName = chat ? chatGroupMap.get(chat.id) || currentGroup : currentGroup;
  const models = modelsByGroup.get(groupName);

  if (!chat || !models || !models.length) {
    settingsEl.hidden = true;
    if (chat && groupName && !models) loadModels(groupName);
    return;
  }
  settingsEl.hidden = false;

  const fill = (select, options, selected) => {
    select.innerHTML = '';
    for (const o of options) {
      const opt = document.createElement('option');
      opt.value = o.value ?? '';
      opt.textContent = o.label;
      if (o.title) opt.title = o.title;
      opt.selected = (o.value ?? null) === (selected ?? null);
      select.appendChild(opt);
    }
  };

  // The handshake only lists the models the CLI's own picker offers — it leaves
  // out anything reachable solely by typing a full model ID into `/model`, e.g.
  // a dated snapshot like claude-sonnet-4-6. A chat already pinned to one of
  // those needs to keep showing it rather than silently falling back to
  // "default", so it gets folded into the option list as an extra entry.
  const known = models.some((m) => m.value === chat.model);
  const extra = chat.model && !known ? [{ value: chat.model, label: chat.model }] : [];

  fill(
    modelSelect,
    [{ value: null, label: 'Model: default' }]
      .concat(models.map((m) => ({ value: m.value, label: m.label, title: m.description })))
      .concat(extra)
      .concat([{ value: '__custom__', label: 'Custom model ID…' }]),
    chat.model
  );

  // Effort belongs to the chosen model — Haiku, for one, reports none at all.
  // A custom ID is of unknown provenance, so it gets the effort levels the CLI's
  // own default model takes rather than none at all.
  const picked = models.find((m) => m.value === chat.model);
  const efforts = picked ? picked.efforts : (models.find((m) => m.value === 'default')?.efforts ?? []);
  effortSelect.hidden = !efforts.length;
  if (efforts.length) {
    fill(
      effortSelect,
      [{ value: null, label: 'Effort: default' }].concat(
        efforts.map((e) => ({ value: e, label: e }))
      ),
      chat.effort
    );
  }
  settingsNoteEl.textContent = runningChats.has(chat.id) ? 'stop the turn to switch' : '';
  modelSelect.disabled = effortSelect.disabled = runningChats.has(chat.id);
}

async function applyChatSettings(patch) {
  const chat = currentChat();
  if (!chat) return;
  try {
    const updated = await patchJSON(`/chats/${chat.id}`, patch);
    Object.assign(chat, updated);
  } catch (err) {
    markBubbleAsError(appendBubble('error', `Could not switch: ${err.message}`));
  }
  renderChatSettings();
}

// Chats whose stop has been asked for but whose turn hasn't ended yet. The CLI
// can take a while to unwind — inside a subagent, minutes — and saying so beats
// a button that looks like it did nothing.
const stoppingChats = new Set();

// Chats with a POST to /messages in flight, before the server's own run_state
// confirms it. Without this, Send and Stop appearing is at the mercy of a full
// round trip over the event stream — cold-starting the CLI subprocess alone can
// take a couple of seconds, during which the composer would otherwise look like
// nothing happened.
const sendingChats = new Set();

function updateComposerState() {
  const running =
    currentChatId !== null && (runningChats.has(currentChatId) || sendingChats.has(currentChatId));
  const stopping = currentChatId !== null && stoppingChats.has(currentChatId);

  const uploading =
    currentChatId !== null && attachmentsFor(currentChatId).some((a) => a.status === 'uploading');
  sendBtn.disabled = currentChatId === null || uploading;
  attachBtn.disabled = currentChatId === null;
  stopBtn.hidden = !running;
  stopBtn.disabled = stopping;
  stopBtn.textContent = stopping ? 'Stopping…' : 'Stop';
  inputEl.placeholder = running
    ? 'Add an instruction — it runs next…'
    : 'Message the agent…';

  renderChatSettings(); // the pickers are locked while a turn runs
}

async function loadGroups() {
  groups = await getJSON('/groups');
  renderGroupsList();
  if (groups.length) await selectGroup(groups[0].name);
}

async function selectGroup(name) {
  stashCurrentDraft();
  currentGroup = name;
  currentChatId = null;
  renderGroupsList();
  chatsTitleEl.textContent = name;
  loadCommands(name);
  loadModels(name);
  updateCommandMenu(); // the menu belongs to the group now on screen

  chatsCache = await getJSON(`/groups/${encodeURIComponent(name)}/chats`);
  for (const c of chatsCache) chatGroupMap.set(c.id, name);
  renderChatsList();

  if (chatsCache.length) {
    await selectChat(chatsCache[0].id);
  } else {
    await createChat(); // auto-create the first chat so the composer is usable immediately
  }
}

async function selectChat(id) {
  if (currentChatId !== id) stashCurrentDraft();
  currentChatId = id;
  loadDraft(id);
  unreadChats.delete(id);
  renderChatsList();
  renderGroupsList();
  updateComposerState();
  renderChatSettings();
  renderContextGauge();
  loadContextUsage(id);

  ensureStream(id, chatGroupMap.get(id) || currentGroup);
  pruneStreams();

  const msgs = await getJSON(`/chats/${id}/messages`);
  renderMessages(msgs);
  renderLiveItems(id);
}

async function createChat() {
  if (!currentGroup) return;
  const chat = await postJSON(`/groups/${encodeURIComponent(currentGroup)}/chats`, {});
  chatsCache = await getJSON(`/groups/${encodeURIComponent(currentGroup)}/chats`);
  for (const c of chatsCache) chatGroupMap.set(c.id, currentGroup);
  renderChatsList();
  await selectChat(chat.id);
}

async function refreshChatsList(groupName) {
  if (groupName !== currentGroup) return;
  chatsCache = await getJSON(`/groups/${encodeURIComponent(groupName)}/chats`);
  for (const c of chatsCache) chatGroupMap.set(c.id, groupName);
  renderChatsList();
}

function markBubbleAsError(contentEl) {
  contentEl.parentElement.classList.remove('assistant');
  contentEl.parentElement.classList.add('error');
}

async function respondToPermission(item) {
  item.buttons?.forEach((b) => (b.disabled = true));
  try {
    await postJSON(`/permissions/${item.request_id}/respond`, { decision: item.decidingAs });
  } catch (err) {
    if (item.el) {
      const contentEl = item.el.querySelector('.content');
      if (contentEl) contentEl.textContent += `\n[failed to send decision: ${err.message}]`;
    }
  }
}

// Renders (or re-renders) one permission item's current state into the DOM.
function renderPermissionCard(item) {
  const wrap = document.createElement('div');
  wrap.className = 'bubble permission';

  const label = document.createElement('div');
  label.className = 'role';
  label.textContent = 'permission needed';

  const content = document.createElement('div');
  content.className = 'content';
  const desc = item.description || item.title || describeTool(item.tool_name, item.tool_input);
  content.textContent = `${toolIcon(item.tool_name)} ${desc}`;

  wrap.appendChild(label);
  wrap.appendChild(content);

  if (item.decision) {
    const status = document.createElement('div');
    status.className = 'permission-status';
    status.textContent = item.decision === 'allow' ? '✓ allowed' : '✗ denied';
    wrap.appendChild(status);
  } else {
    const actions = document.createElement('div');
    actions.className = 'permission-actions';
    const allowBtn = document.createElement('button');
    allowBtn.textContent = 'Allow';
    allowBtn.className = 'permission-allow';
    const denyBtn = document.createElement('button');
    denyBtn.textContent = 'Deny';
    denyBtn.className = 'permission-deny';

    item.buttons = [allowBtn, denyBtn];
    allowBtn.onclick = () => {
      item.decidingAs = 'allow';
      respondToPermission(item);
    };
    denyBtn.onclick = () => {
      item.decidingAs = 'deny';
      respondToPermission(item);
    };

    actions.appendChild(allowBtn);
    actions.appendChild(denyBtn);
    wrap.appendChild(actions);
  }

  messagesEl.appendChild(wrap);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  item.el = wrap;
}

function resolvePermissionCard(item, decision) {
  item.decision = decision;
  if (!item.el) return; // chat isn't currently visible; re-render will pick up item.decision later
  const actions = item.el.querySelector('.permission-actions');
  if (actions) actions.remove();
  const status = document.createElement('div');
  status.className = 'permission-status';
  status.textContent = decision === 'allow' ? '✓ allowed' : '✗ denied';
  item.el.appendChild(status);
}

// requestId -> { chatId, item } so a permission_resolved event (which only
// carries a request_id) can find the right chat's live-item list regardless
// of which chat is currently on screen.
const permissionIndex = new Map();

// ---------------------------------------------------------------------------
// AskUserQuestion cards
//
// When the agent calls AskUserQuestion the backend pauses the tool and sends a
// question_request. We render the questions as clickable options; the picks go
// back as the tool's answers, which is what unblocks the agent.
// ---------------------------------------------------------------------------

const questionIndex = new Map(); // requestId -> { chatId, item }

// The answer for one question: the free-text box wins over the clicked options.
function answerFor(item, q) {
  const custom = (item.custom[q.question] || '').trim();
  if (custom) return custom;
  const picked = item.selections[q.question] || [];
  if (!picked.length) return null;
  return q.multiSelect ? picked.slice() : picked[0];
}

function collectAnswers(item) {
  const answers = {};
  for (const q of item.questions) {
    const value = answerFor(item, q);
    if (value !== null) answers[q.question] = value;
  }
  return answers;
}

async function submitQuestion(item, { skipped = false } = {}) {
  if (item.answered) return;
  const answers = skipped ? {} : collectAnswers(item);
  if (!skipped && !Object.keys(answers).length) return;

  item.sending = true;
  item.dom?.actionButtons?.forEach((b) => (b.disabled = true));

  try {
    await postJSON(`/questions/${item.request_id}/respond`, { answers, skipped });
    // The card itself is redrawn by the question_resolved event that follows.
  } catch (err) {
    item.sending = false;
    item.dom?.actionButtons?.forEach((b) => (b.disabled = false));
    if (item.el) {
      const note = document.createElement('div');
      note.className = 'question-status';
      note.textContent = `failed to send answer: ${err.message}`;
      item.el.appendChild(note);
    }
  }
}

function refreshQuestionActions(item) {
  if (!item.dom || !item.dom.sendBtn) return;
  const answered = Object.keys(collectAnswers(item)).length;
  item.dom.sendBtn.disabled = item.sending || answered === 0;
  item.dom.sendBtn.textContent =
    answered && answered < item.questions.length
      ? `Send ${answered}/${item.questions.length}`
      : 'Send';
}

function pickOption(item, q, label) {
  const current = item.selections[q.question] || [];
  if (q.multiSelect) {
    item.selections[q.question] = current.includes(label)
      ? current.filter((l) => l !== label)
      : [...current, label];
  } else {
    // Clicking the selected option again clears it.
    item.selections[q.question] = current[0] === label ? [] : [label];
  }

  const selected = item.selections[q.question];
  for (const btn of item.dom.optionButtons.get(q.question) || []) {
    btn.el.classList.toggle('selected', selected.includes(btn.label));
  }
  refreshQuestionActions(item);

  // One single-select question with nothing typed: a click *is* the answer.
  if (
    item.questions.length === 1 &&
    !q.multiSelect &&
    selected.length === 1 &&
    !(item.custom[q.question] || '').trim()
  ) {
    submitQuestion(item);
  }
}

function buildQuestionCard(item) {
  const wrap = document.createElement('div');
  wrap.className = 'bubble question';

  const role = document.createElement('div');
  role.className = 'role';
  role.textContent = 'question for you';
  wrap.appendChild(role);

  if (item.answered) {
    const status = document.createElement('div');
    status.className = 'question-status';
    if (item.answered.skipped) {
      status.textContent = '⏭ skipped — the agent carried on without an answer';
    } else {
      const lines = item.questions.map((q) => {
        const value = item.answered.answers?.[q.question];
        const shown = Array.isArray(value) ? value.join(', ') : value;
        return `${q.header || q.question} → ${shown || '—'}`;
      });
      if (item.answered.response) lines.push(item.answered.response);
      status.textContent = `✓ ${lines.join('\n')}`;
    }
    wrap.appendChild(status);
    return wrap;
  }

  const optionButtons = new Map();
  item.dom = { optionButtons, actionButtons: [], sendBtn: null };

  for (const q of item.questions) {
    const block = document.createElement('div');
    block.className = 'question-block';

    if (q.header) {
      const chip = document.createElement('span');
      chip.className = 'question-chip';
      chip.textContent = q.header;
      block.appendChild(chip);
    }

    const text = document.createElement('div');
    text.className = 'question-text';
    text.textContent = q.question + (q.multiSelect ? ' (pick any)' : '');
    block.appendChild(text);

    const optionsEl = document.createElement('div');
    optionsEl.className = 'question-options';
    const buttons = [];

    for (const opt of q.options || []) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'question-option';
      if ((item.selections[q.question] || []).includes(opt.label)) btn.classList.add('selected');

      const label = document.createElement('div');
      label.className = 'question-option-label';
      label.textContent = opt.label;
      btn.appendChild(label);

      if (opt.description) {
        const desc = document.createElement('div');
        desc.className = 'question-option-desc';
        desc.textContent = opt.description;
        btn.appendChild(desc);
      }

      btn.onclick = () => pickOption(item, q, opt.label);
      optionsEl.appendChild(btn);
      buttons.push({ label: opt.label, el: btn });
    }

    optionButtons.set(q.question, buttons);
    block.appendChild(optionsEl);

    const other = document.createElement('input');
    other.type = 'text';
    other.className = 'question-other';
    other.placeholder = 'Other — type your own answer…';
    other.value = item.custom[q.question] || '';
    other.oninput = () => {
      item.custom[q.question] = other.value;
      refreshQuestionActions(item);
    };
    other.onkeydown = (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        submitQuestion(item);
      }
    };
    block.appendChild(other);

    wrap.appendChild(block);
  }

  const actions = document.createElement('div');
  actions.className = 'question-actions';

  const sendBtn = document.createElement('button');
  sendBtn.type = 'button';
  sendBtn.className = 'question-send';
  sendBtn.textContent = 'Send';
  sendBtn.onclick = () => submitQuestion(item);

  const skipBtn = document.createElement('button');
  skipBtn.type = 'button';
  skipBtn.className = 'question-skip';
  skipBtn.textContent = 'Skip';
  skipBtn.onclick = () => submitQuestion(item, { skipped: true });

  actions.appendChild(sendBtn);
  actions.appendChild(skipBtn);
  wrap.appendChild(actions);

  item.dom.sendBtn = sendBtn;
  item.dom.actionButtons = [sendBtn, skipBtn];
  refreshQuestionActions(item);

  return wrap;
}

function renderQuestionCard(item) {
  const wrap = buildQuestionCard(item);
  messagesEl.appendChild(wrap);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  item.el = wrap;
}

function resolveQuestionCard(item, evt) {
  item.answered = { answers: evt.answers || {}, response: evt.response, skipped: !!evt.skipped };
  item.sending = false;
  if (!item.el) return; // chat isn't visible; renderLiveItems() will draw the resolved state
  const replacement = buildQuestionCard(item);
  item.el.replaceWith(replacement);
  item.el = replacement;
}

// Marks a chat as having unseen activity — used for any notable event
// (a permission popup, a finished turn) that happens in a chat the user
// isn't currently looking at, the same way a new message would.
function markActivity(chatId) {
  if (chatId === currentChatId) return;
  if (unreadChats.has(chatId)) return;
  unreadChats.add(chatId);
  renderChatsList();
  renderGroupsList();
}

// ---------------------------------------------------------------------------
// Per-chat event streams
//
// A chat's events arrive on a connection that outlives any single turn. That is
// what makes steering visible: a message sent while the agent is busy is taken
// by the CLI as the next turn and reported on this same stream. It also means
// the UI can attach to a run that is already in progress.
// ---------------------------------------------------------------------------

const chatStreams = new Map(); // chatId -> {stop, controller, state}

function freshStreamState() {
  return {
    currentItem: null, // the in-progress {kind:'bubble', ...} item, if any
    activityItem: null, // the subagent-progress panel for this run, once one exists
    // content_block index -> {item, json} for tool_use blocks whose arguments
    // are still streaming in as input_json_delta chunks.
    openToolBlocks: new Map(),
  };
}

function liveItemsFor(chatId) {
  if (!chatLiveItems.has(chatId)) chatLiveItems.set(chatId, []);
  return chatLiveItems.get(chatId);
}

function makeEventHandler(chatId, groupName, entry) {
  const ensureBubbleItem = (role) => {
    if (!entry.state.currentItem) {
      const item = { kind: 'bubble', role, text: '' };
      entry.state.currentItem = item;
      liveItemsFor(chatId).push(item);
      if (chatId === currentChatId) item.el = appendBubble(role, '');
    }
    return entry.state.currentItem;
  };
  const breakBubbleItem = () => {
    entry.state.currentItem = null;
  };
  const updateBubbleDom = (item) => {
    if (chatId === currentChatId && item.el) {
      setBubbleContent(item.el, item.role, item.text);
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }
  };

  // Re-labels a tool bubble once more of its JSON input has arrived.
  const relabelTool = (block) => {
    let parsed = null;
    try {
      parsed = block.json ? JSON.parse(block.json) : null;
    } catch {
      return; // input still incomplete — keep the current label
    }
    block.item.text = toolLabel(block.name, parsed);
    if (chatId === currentChatId && block.item.el) {
      block.item.el.textContent = block.item.text;
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }
  };

  // A queued message's turn just started: move it from "up next" to the bottom
  // of the transcript as a regular sent message.
  const promoteQueued = (text) => {
    const items = liveItemsFor(chatId);
    const idx = items.findIndex((i) => i.kind === 'queued' && i.text === text);
    if (idx === -1) return false;
    const [item] = items.splice(idx, 1);
    item.el?.remove();
    return true;
  };

  // Everything drawn for the finished run is now in the DB in the right order,
  // so the live trace is dropped and the transcript redrawn from storage.
  const finishRun = async () => {
    const openBlocks = entry.state.openToolBlocks;
    entry.state = freshStreamState();
    openBlocks.clear();
    chatLiveItems.delete(chatId);

    if (chatId === currentChatId) {
      const msgs = await getJSON(`/chats/${chatId}/messages`);
      renderMessages(msgs);
      updateComposerState();
    } else {
      markActivity(chatId);
      pruneStreams();
    }
    refreshChatsList(groupName);
  };

  return (evt) => {
    const blocks = entry.state.openToolBlocks;

    if (evt.type === 'run_state') {
      const wasRunning = runningChats.has(chatId);
      if (evt.stopping) stoppingChats.add(chatId);
      else stoppingChats.delete(chatId);
      if (evt.running) {
        runningChats.add(chatId);
        if (chatId === currentChatId) updateComposerState();
      } else if (wasRunning) {
        runningChats.delete(chatId);
        finishRun();
      } else if (chatId === currentChatId) {
        updateComposerState();
      }
    } else if (evt.type === 'turn_start') {
      // Either the first turn of a run, or a queued message whose turn has now
      // begun — in both cases it belongs at the bottom as a sent message.
      breakBubbleItem();
      const items = liveItemsFor(chatId);
      const last = items[items.length - 1];
      if (
        last?.optimistic &&
        last.text === evt.content &&
        ((last.kind === 'bubble' && last.role === 'user') || last.kind === 'queued')
      ) {
        // This chat's own send() already put it on screen — confirm it in
        // place rather than adding a second copy.
        if (last.kind === 'queued') {
          last.el?.remove();
          last.kind = 'bubble';
          last.role = 'user';
          if (chatId === currentChatId) last.el = appendBubble('user', last.text);
        }
        delete last.optimistic;
      } else {
        promoteQueued(evt.content); // someone else's queued message reached its turn
        const item = { kind: 'bubble', role: 'user', text: evt.content };
        items.push(item);
        if (chatId === currentChatId) item.el = appendBubble('user', evt.content);
      }
    } else if (evt.type === 'turn_queued') {
      breakBubbleItem();
      const items = liveItemsFor(chatId);
      const last = items[items.length - 1];
      if (last?.optimistic && last.kind === 'queued' && last.text === evt.content) {
        delete last.optimistic; // already shown as "up next" — just confirm it
      } else {
        const item = { kind: 'queued', text: evt.content };
        items.push(item);
        if (chatId === currentChatId) item.el = appendQueuedBubble(item);
      }
    } else if (evt.type === 'stream_event') {
      const inner = evt.event || {};
      if (inner.type === 'content_block_delta' && inner.delta && inner.delta.type === 'text_delta') {
        const item = ensureBubbleItem('assistant');
        item.text += inner.delta.text;
        updateBubbleDom(item);
      } else if (inner.type === 'content_block_delta' && inner.delta && inner.delta.type === 'input_json_delta') {
        const block = blocks.get(inner.index);
        if (block) {
          block.json += inner.delta.partial_json || '';
          relabelTool(block);
        }
      } else if (inner.type === 'content_block_start' && inner.content_block && inner.content_block.type === 'tool_use') {
        breakBubbleItem();
        const name = inner.content_block.name;
        // AskUserQuestion gets no tool bubble — the question card it triggers
        // already shows the question in full.
        if (name === 'AskUserQuestion') return;
        // Arguments are usually empty here and stream in afterwards, so start
        // with the bare tool name and refine the label as the input arrives.
        const toolItem = { kind: 'tool', text: toolLabel(name, inner.content_block.input) };
        liveItemsFor(chatId).push(toolItem);
        if (chatId === currentChatId) toolItem.el = appendBubble('tool', toolItem.text);
        blocks.set(inner.index, { item: toolItem, name, json: '' });
      } else if (inner.type === 'content_block_stop') {
        const block = blocks.get(inner.index);
        if (block) {
          relabelTool(block);
          blocks.delete(inner.index);
        }
      }
    } else if (evt.type === 'turns_dropped') {
      // Stop threw away everything still waiting; those messages were never sent,
      // so they leave no trace in the transcript either.
      const items = liveItemsFor(chatId);
      for (let i = items.length - 1; i >= 0; i--) {
        if (items[i].kind !== 'queued') continue;
        items[i].el?.remove();
        items.splice(i, 1);
      }
      if (chatId === currentChatId && evt.contents?.length) {
        // Not lost: handed back to the composer so they can be sent again.
        const text = evt.contents.join('\n\n');
        inputEl.value = inputEl.value.trim() ? `${inputEl.value.trim()}\n\n${text}` : text;
        autoGrowInput();
      }
    } else if (evt.type === 'agent_activity') {
      let item = entry.state.activityItem;
      if (!item) {
        item = { kind: 'activity', lines: [], agents: new Set(), count: 0, lastAt: '' };
        entry.state.activityItem = item;
        liveItemsFor(chatId).push(item);
        if (chatId === currentChatId) appendActivityPanel(item);
      }
      item.count += 1;
      item.agents.add(evt.agent_id);
      item.lastAt = new Date().toTimeString().slice(0, 8);
      item.lines.push(activityLine(evt));
      if (item.lines.length > ACTIVITY_LINES) item.lines.shift();
      if (chatId === currentChatId) renderActivityPanel(item);
    } else if (evt.type === 'result') {
      const current = entry.state.currentItem;
      if (evt.result) {
        const item = ensureBubbleItem('assistant');
        item.text = evt.result;
        updateBubbleDom(item);
      }
      if (evt.is_error && current) {
        current.role = 'error';
        if (chatId === currentChatId && current.el) markBubbleAsError(current.el);
      }
      if (evt.usage) {
        const chat = chatsCache.find((c) => c.id === chatId);
        const limit = chat && chat.model && chat.model.toLowerCase().includes('1m') ? 1_000_000 : 200_000;
        const tokens =
          (evt.usage.input_tokens || 0) +
          (evt.usage.cache_creation_input_tokens || 0) +
          (evt.usage.cache_read_input_tokens || 0);
        setContextUsage(chatId, tokens, limit);
      }
      // One turn ended; the next one starts its own bubble.
      breakBubbleItem();
      blocks.clear();
    } else if (evt.type === 'process_error') {
      const item = ensureBubbleItem('error');
      item.role = 'error';
      item.text += `\n[${evt.reason}] ${evt.stderr || ''}`;
      updateBubbleDom(item);
      if (chatId === currentChatId && item.el) markBubbleAsError(item.el);
    } else if (evt.type === 'permission_request') {
      breakBubbleItem();
      const item = {
        kind: 'permission',
        request_id: evt.request_id,
        tool_name: evt.tool_name,
        tool_input: evt.tool_input,
        title: evt.title,
        description: evt.description,
        decision: null,
      };
      liveItemsFor(chatId).push(item);
      permissionIndex.set(evt.request_id, { chatId, item });
      if (chatId === currentChatId) renderPermissionCard(item);
      markActivity(chatId);
    } else if (evt.type === 'permission_resolved') {
      const found = permissionIndex.get(evt.request_id);
      if (found) resolvePermissionCard(found.item, evt.decision);
      permissionIndex.delete(evt.request_id);
    } else if (evt.type === 'question_request') {
      breakBubbleItem();
      const item = {
        kind: 'question',
        request_id: evt.request_id,
        questions: evt.questions || [],
        selections: {}, // question text -> [chosen labels]
        custom: {}, // question text -> free-text answer
        answered: null,
      };
      liveItemsFor(chatId).push(item);
      questionIndex.set(evt.request_id, { chatId, item });
      if (chatId === currentChatId) renderQuestionCard(item);
      markActivity(chatId);
    } else if (evt.type === 'question_resolved') {
      const found = questionIndex.get(evt.request_id);
      if (found) resolveQuestionCard(found.item, evt);
      questionIndex.delete(evt.request_id);
    }
  };
}

// Opens (once) the event stream for a chat and keeps it alive, reconnecting if
// the backend restarts. Cheap on the server: subscribing starts no agent.
function ensureStream(chatId, groupName) {
  if (chatStreams.has(chatId)) return chatStreams.get(chatId);

  // Nothing was listening for this chat, so any live trace left over from an
  // earlier stream is orphaned: it was never reconciled against the DB by
  // finishRun and would be drawn a second time on top of the stored transcript
  // (the "my message shows up twice" duplicate). The fresh connection replays
  // whatever is genuinely still in progress, so storage plus that replay is the
  // whole truth. Cleared synchronously, before selectChat renders live items or
  // sendMessage stages its optimistic one.
  const stale = chatLiveItems.get(chatId);
  if (stale) {
    for (const item of stale) item.el?.remove();
    chatLiveItems.delete(chatId);
  }

  const entry = { stop: false, controller: null, state: freshStreamState() };
  chatStreams.set(chatId, entry);
  pumpStream(chatId, groupName, entry);
  return entry;
}

async function pumpStream(chatId, groupName, entry) {
  const handleEvent = makeEventHandler(chatId, groupName, entry);
  let firstConnect = true;

  while (!entry.stop) {
    try {
      entry.controller = new AbortController();
      const res = await fetch(`${API}/chats/${chatId}/events`, { signal: entry.controller.signal });
      if (!res.ok) throw new Error(await res.text());

      if (!firstConnect && chatId === currentChatId) {
        // Reconnected after a gap — a backend restart, a network drop, the laptop
        // asleep. Whatever finished while disconnected is only in the DB now, not
        // in any buffer this stream can replay, so the transcript is resynced
        // from storage instead of trusting whatever is still on screen. The fresh
        // run_state and replay that follow rebuild the live view, if anything is
        // still in progress.
        entry.state = freshStreamState();
        chatLiveItems.delete(chatId);
        try {
          renderMessages(await getJSON(`/chats/${chatId}/messages`));
        } catch {
          // best-effort — the stream itself is still the source of truth from here
        }
      }
      firstConnect = false;

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n\n')) !== -1) {
          const chunk = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          if (!chunk.startsWith('data: ')) continue; // keepalive comment frames
          try {
            handleEvent(JSON.parse(chunk.slice(6)));
          } catch {
            // ignore malformed line
          }
        }
      }
    } catch {
      // aborted by us, or the backend went away — the retry below covers both
    }

    if (entry.stop) break;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  // Only if it is still ours: closeStream() already dropped it, and switching
  // away and straight back can have registered a newer stream under this id —
  // unregistering that one would leave it running while ensureStream() opens a
  // second, and every delta would arrive twice.
  if (chatStreams.get(chatId) === entry) chatStreams.delete(chatId);
}

function closeStream(chatId) {
  const entry = chatStreams.get(chatId);
  if (!entry) return;
  entry.stop = true;
  entry.controller?.abort();
  chatStreams.delete(chatId);
}

// Keep a stream only for the chat on screen and for any chat still working, so
// background runs keep reporting permissions, questions and unread activity.
function pruneStreams() {
  for (const chatId of [...chatStreams.keys()]) {
    if (chatId !== currentChatId && !runningChats.has(chatId)) closeStream(chatId);
  }
}

async function sendMessage(chatId, groupName, text) {
  ensureStream(chatId, groupName);

  // Shown immediately rather than waiting for the server's own echo of it to
  // come back over the event stream: that round trip — connect, maybe cold-start
  // the CLI subprocess, emit, relay — can take seconds, and a disconnected
  // stream (a backend restart, a network blip) can stall it far longer. The
  // `optimistic` item is reconciled against the real turn_start/turn_queued
  // event in makeEventHandler once it arrives, rather than duplicated.
  const busy = runningChats.has(chatId);
  const item = busy
    ? { kind: 'queued', text, optimistic: true }
    : { kind: 'bubble', role: 'user', text, optimistic: true };
  liveItemsFor(chatId).push(item);
  if (chatId === currentChatId) {
    item.el = busy ? appendQueuedBubble(item) : appendBubble('user', text);
  }
  if (!busy) {
    sendingChats.add(chatId);
    if (chatId === currentChatId) updateComposerState();
  }

  try {
    await postJSON(`/chats/${chatId}/messages`, { content: text });
  } catch (err) {
    // Never actually sent — take back what was only ever a promise on screen.
    const items = liveItemsFor(chatId);
    const idx = items.indexOf(item);
    if (idx !== -1) items.splice(idx, 1);
    item.el?.remove();
    if (chatId === currentChatId) {
      const el = appendBubble('error', `Failed to send: ${err.message}`);
      markBubbleAsError(el);
    }
  } finally {
    sendingChats.delete(chatId);
    if (chatId === currentChatId) updateComposerState();
  }
}

async function stopRun(chatId) {
  try {
    await postJSON(`/chats/${chatId}/interrupt`, {});
  } catch (err) {
    if (chatId === currentChatId) {
      const el = appendBubble('error', `Failed to stop: ${err.message}`);
      markBubbleAsError(el);
    }
  }
}

// ---------------------------------------------------------------------------
// Slash-command picker
//
// The commands come from the CLI running in *this group's* project folder, so
// what the menu offers is exactly what that agent accepts: the project's own
// .claude/commands, the user's, plugin/skill ones and the built-ins. They are
// fetched once per group and cached; the first probe may take a second, and
// until it lands the menu simply says so.
// ---------------------------------------------------------------------------

const commandsByGroup = new Map(); // groupName -> Array<{name, description, argument_hint}>
const commandsLoading = new Set(); // groups with a fetch in flight

// matches: what is on screen now; index: the highlighted row; dismissed: the
// user pressed Escape for this query and doesn't want it back until it changes.
const commandMenu = { open: false, matches: [], index: 0, dismissed: false };

async function loadCommands(groupName) {
  if (commandsByGroup.has(groupName) || commandsLoading.has(groupName)) return;
  commandsLoading.add(groupName);
  try {
    const commands = await getJSON(`/groups/${encodeURIComponent(groupName)}/commands`);
    commandsByGroup.set(groupName, commands);
  } catch {
    commandsByGroup.set(groupName, []); // no picker rather than a broken one
  } finally {
    commandsLoading.delete(groupName);
    if (groupName === currentGroup) updateCommandMenu();
  }
}

// The typed command name, or null when the composer isn't naming a command.
// Only a message that *starts* with "/" and has no space yet is one — after the
// first space the user is writing arguments and the menu gets out of the way.
function commandQuery() {
  const value = inputEl.value;
  if (!value.startsWith('/')) return null;
  const token = value.slice(1);
  if (/\s/.test(token)) return null;
  return token;
}

function matchCommands(query) {
  const commands = commandsByGroup.get(currentGroup) || [];
  if (!query) return commands;
  const q = query.toLowerCase();
  const starts = [];
  const contains = [];
  for (const c of commands) {
    const name = c.name.toLowerCase();
    if (name.startsWith(q)) starts.push(c);
    else if (name.includes(q) || (c.description || '').toLowerCase().includes(q)) contains.push(c);
  }
  return [...starts, ...contains];
}

function closeCommandMenu({ dismissed = false } = {}) {
  commandMenu.open = false;
  commandMenu.matches = [];
  commandMenu.index = 0;
  commandMenu.dismissed = dismissed;
  commandMenuEl.hidden = true;
  commandMenuEl.innerHTML = '';
}

function renderCommandMenu(loading) {
  commandMenuEl.innerHTML = '';
  commandMenuEl.hidden = false;

  if (loading) {
    const hint = document.createElement('div');
    hint.className = 'command-menu-hint';
    hint.textContent = 'Loading commands from the project…';
    commandMenuEl.appendChild(hint);
    return;
  }

  commandMenu.matches.forEach((cmd, i) => {
    const row = document.createElement('div');
    row.className = 'command-item' + (i === commandMenu.index ? ' active' : '');

    const name = document.createElement('div');
    name.className = 'command-item-name';
    name.textContent = `/${cmd.name}`;
    if (cmd.argument_hint) {
      const args = document.createElement('span');
      args.className = 'command-item-args';
      args.textContent = cmd.argument_hint;
      name.appendChild(args);
    }
    row.appendChild(name);

    if (cmd.description) {
      const desc = document.createElement('div');
      desc.className = 'command-item-desc';
      desc.textContent = cmd.description;
      row.appendChild(desc);
    }

    row.onmouseenter = () => {
      commandMenu.index = i;
      renderCommandMenu(false);
    };
    // mousedown, not click: clicking must not blur the composer first.
    row.onmousedown = (e) => {
      e.preventDefault();
      applyCommand(cmd);
    };

    commandMenuEl.appendChild(row);
  });

  const active = commandMenuEl.children[commandMenu.index];
  active?.scrollIntoView({ block: 'nearest' });
}

// Re-reads the composer and shows, updates or hides the menu accordingly.
function updateCommandMenu() {
  const query = commandQuery();
  if (query === null || commandMenu.dismissed) {
    if (commandMenu.open || !commandMenuEl.hidden) closeCommandMenu({ dismissed: commandMenu.dismissed });
    return;
  }

  if (!commandsByGroup.has(currentGroup)) {
    loadCommands(currentGroup);
    commandMenu.open = false;
    commandMenu.matches = [];
    renderCommandMenu(true);
    return;
  }

  const matches = matchCommands(query);
  if (!matches.length) {
    closeCommandMenu();
    return;
  }

  // Keep the highlight on the same command while the list is being narrowed.
  const previous = commandMenu.matches[commandMenu.index];
  commandMenu.matches = matches;
  const kept = previous ? matches.findIndex((c) => c.name === previous.name) : -1;
  commandMenu.index = kept === -1 ? 0 : kept;
  commandMenu.open = true;
  renderCommandMenu(false);
}

// Puts the command in the composer, ready for its arguments — sending stays a
// deliberate second step, exactly as when typing it by hand.
function applyCommand(cmd) {
  inputEl.value = `/${cmd.name} `;
  closeCommandMenu();
  inputEl.focus();
  inputEl.setSelectionRange(inputEl.value.length, inputEl.value.length);
  autoGrowInput();
}

function moveCommandSelection(step) {
  const n = commandMenu.matches.length;
  if (!n) return;
  commandMenu.index = (commandMenu.index + step + n) % n;
  renderCommandMenu(false);
}

// Clicking anywhere outside the composer puts the menu away.
document.addEventListener('mousedown', (e) => {
  if (!commandMenuEl.hidden && !composerEl.contains(e.target)) closeCommandMenu();
});

// Grows the composer with its content up to the CSS max-height, after which it
// scrolls. Height must be reset to 'auto' first so scrollHeight can shrink too.
function autoGrowInput() {
  inputEl.style.height = 'auto';
  inputEl.style.height = inputEl.scrollHeight + 'px';
}

composerEl.addEventListener('submit', (e) => {
  e.preventDefault();
  if (!currentChatId) return;
  const chatId = currentChatId;
  const items = attachmentsFor(chatId);
  if (items.some((a) => a.status === 'uploading')) return; // let the uploads finish first

  const text = inputEl.value.trim();
  const attachBlock = attachmentPromptBlock(items);
  if (!text && !attachBlock) return; // nothing to send

  // The paths of the staged files ride along in the message body, which is what
  // the agent reads and what the transcript shows.
  const message = text && attachBlock ? `${text}\n\n${attachBlock}` : text || attachBlock;

  inputEl.value = '';
  chatDrafts.delete(chatId); // sent — no draft to carry back
  chatAttachments.set(chatId, []); // the staged files went with the message
  renderAttachments();
  closeCommandMenu();
  autoGrowInput();
  // Sends whether or not the agent is busy: a mid-run message becomes the next
  // turn instead of being held back by the UI.
  sendMessage(chatId, currentGroup, message);
});

stopBtn.addEventListener('click', () => {
  if (currentChatId !== null) stopRun(currentChatId);
});

attachBtn.addEventListener('click', () => {
  if (currentChatId !== null) fileInputEl.click();
});
fileInputEl.addEventListener('change', () => {
  if (fileInputEl.files && fileInputEl.files.length) addFiles(fileInputEl.files);
  fileInputEl.value = ''; // let the same file be picked again later
});

// Pasting an image (a screenshot, a copied file) stages it too.
inputEl.addEventListener('paste', (e) => {
  if (currentChatId === null) return;
  const files = [...(e.clipboardData?.items || [])]
    .filter((it) => it.kind === 'file')
    .map((it) => it.getAsFile())
    .filter(Boolean);
  if (files.length) {
    e.preventDefault();
    addFiles(files);
  }
});

inputEl.addEventListener('input', () => {
  autoGrowInput();
  commandMenu.dismissed = false; // a fresh edit re-opens what Escape closed
  updateCommandMenu();
});
autoGrowInput();
updateComposerState();

inputEl.addEventListener('keydown', (e) => {
  // While the picker is up it owns the navigation keys: Enter/Tab pick a
  // command instead of sending, and Escape puts the menu away without
  // touching what has been typed.
  if (commandMenu.open) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      moveCommandSelection(1);
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      moveCommandSelection(-1);
      return;
    }
    if (e.key === 'Enter' || e.key === 'Tab') {
      const cmd = commandMenu.matches[commandMenu.index];
      if (cmd) {
        e.preventDefault();
        applyCommand(cmd);
        return;
      }
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      closeCommandMenu({ dismissed: true });
      return;
    }
  }

  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    composerEl.requestSubmit();
  }
});

newChatBtn.addEventListener('click', createChat);

modelSelect.addEventListener('change', () => {
  if (modelSelect.value === '__custom__') {
    const id = prompt(
      'Full model ID (as accepted by `claude`\'s /model command), e.g. claude-sonnet-4-6:'
    );
    if (id && id.trim()) {
      applyChatSettings({ model: id.trim(), effort: null });
    } else {
      renderChatSettings(); // cancelled — put the dropdown back where it was
    }
    return;
  }
  // Switching model resets effort: the levels a model accepts are its own.
  applyChatSettings({ model: modelSelect.value || null, effort: null });
});
effortSelect.addEventListener('change', () => {
  applyChatSettings({ effort: effortSelect.value || null });
});

loadGroups().catch((err) => {
  messagesEl.textContent = `Failed to load groups: ${err.message}`;
});

// ---------------------------------------------------------------------------
// Project memory
//
// The same Qdrant collection the agent reaches through its search_memory /
// save_memory tools, opened for the user directly: what this project remembers
// across all of its chats, searchable by hand, and writable without asking an
// agent to do it. A hit links back to the chat it came from when that chat is
// still around.
// ---------------------------------------------------------------------------

const memoryOverlayEl = document.getElementById('memory-overlay');
const memoryBtn = document.getElementById('memory-btn');
const memoryCloseBtn = document.getElementById('memory-close');
const memoryGroupEl = document.getElementById('memory-group');
const memoryStatusEl = document.getElementById('memory-status');
const memorySearchFormEl = document.getElementById('memory-search-form');
const memoryQueryEl = document.getElementById('memory-query');
const memoryResultsEl = document.getElementById('memory-results');
const memoryNoteFormEl = document.getElementById('memory-note-form');
const memoryNoteEl = document.getElementById('memory-note');

function setMemoryStatus(text, isError = false) {
  memoryStatusEl.textContent = text;
  memoryStatusEl.classList.toggle('error', isError);
}

function memoryPlaceholder(text) {
  memoryResultsEl.replaceChildren();
  const div = document.createElement('div');
  div.className = 'memory-empty';
  div.textContent = text;
  memoryResultsEl.appendChild(div);
}

function renderMemoryHits(hits) {
  if (!hits.length) {
    memoryPlaceholder('Nothing matches that yet.');
    return;
  }
  memoryResultsEl.replaceChildren();
  for (const hit of hits) {
    const card = document.createElement('div');
    card.className = 'memory-hit';

    const meta = document.createElement('div');
    meta.className = 'memory-hit-meta';

    const kind = document.createElement('span');
    kind.textContent = hit.kind === 'note' ? 'note' : 'turn';
    if (hit.kind === 'note') kind.className = 'kind-note';
    meta.appendChild(kind);

    // Chats are deleted from memory along with themselves, but a hit can still
    // predate a rename or come from another group's chat — so only offer the
    // jump when the chat is one of the ones currently listed.
    const known = chatsCache.some((c) => c.id === hit.chat_id);
    if (hit.chat_title) {
      if (known) {
        const link = document.createElement('button');
        link.className = 'memory-hit-chat';
        link.textContent = hit.chat_title;
        link.addEventListener('click', () => {
          closeMemoryPanel();
          selectChat(hit.chat_id);
        });
        meta.appendChild(link);
      } else {
        const label = document.createElement('span');
        label.textContent = hit.chat_title;
        meta.appendChild(label);
      }
    }

    if (hit.created_at) {
      const when = document.createElement('span');
      when.textContent = hit.created_at.slice(0, 10);
      meta.appendChild(when);
    }

    const score = document.createElement('span');
    score.textContent = hit.score.toFixed(2);
    meta.appendChild(score);

    const body = document.createElement('div');
    body.className = 'memory-hit-text';
    body.textContent = hit.text;

    card.appendChild(meta);
    card.appendChild(body);
    memoryResultsEl.appendChild(card);
  }
}

async function refreshMemoryStatus() {
  try {
    const info = await getJSON(`/groups/${encodeURIComponent(currentGroup)}/memory`);
    if (!info.enabled) {
      setMemoryStatus('Memory is off — set memory.enabled in config.yaml.', true);
    } else if (info.error) {
      setMemoryStatus(`Qdrant unreachable at ${info.url}: ${info.error}`, true);
    } else if (!info.ready) {
      setMemoryStatus('Connecting to Qdrant (the embedding model loads on first use)…');
    } else {
      setMemoryStatus(`${info.points} fragment(s) remembered · ${info.collection} @ ${info.url}`);
    }
  } catch (err) {
    setMemoryStatus(String(err.message || err), true);
  }
}

function openMemoryPanel() {
  if (!currentGroup) return;
  memoryGroupEl.textContent = currentGroup;
  memoryOverlayEl.hidden = false;
  memoryPlaceholder('Search to see what this project remembers.');
  refreshMemoryStatus();
  memoryQueryEl.focus();
  memoryQueryEl.select();
}

function closeMemoryPanel() {
  memoryOverlayEl.hidden = true;
}

memoryBtn.addEventListener('click', openMemoryPanel);
memoryCloseBtn.addEventListener('click', closeMemoryPanel);
memoryOverlayEl.addEventListener('mousedown', (e) => {
  if (e.target === memoryOverlayEl) closeMemoryPanel();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !memoryOverlayEl.hidden) closeMemoryPanel();
});

memorySearchFormEl.addEventListener('submit', async (e) => {
  e.preventDefault();
  const query = memoryQueryEl.value.trim();
  if (!query || !currentGroup) return;
  memoryPlaceholder('Searching…');
  try {
    const hits = await postJSON(`/groups/${encodeURIComponent(currentGroup)}/memory/search`, {
      query,
      limit: 20,
    });
    renderMemoryHits(hits);
  } catch (err) {
    memoryPlaceholder(String(err.message || err));
  }
});

memoryNoteFormEl.addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = memoryNoteEl.value.trim();
  if (!text || !currentGroup) return;
  try {
    await postJSON(`/groups/${encodeURIComponent(currentGroup)}/memory/notes`, {
      text,
      chat_id: currentChatId,
    });
    memoryNoteEl.value = '';
    setMemoryStatus('Saved.');
    refreshMemoryStatus();
  } catch (err) {
    setMemoryStatus(String(err.message || err), true);
  }
});

// ---------------------------------------------------------------------------
// Work report
//
// Pick some days and some projects, and Claude condenses what those projects'
// chats got done into a few bullets — something to read out at a meeting. The
// project selection is remembered between openings.
// ---------------------------------------------------------------------------

const reportOverlayEl = document.getElementById('report-overlay');
const reportCloseBtn = document.getElementById('report-close');
const reportFormEl = document.getElementById('report-form');
const reportFromEl = document.getElementById('report-from');
const reportToEl = document.getElementById('report-to');
const reportGroupsEl = document.getElementById('report-groups');
const reportToggleAllBtn = document.getElementById('report-toggle-all');
const reportStatusEl = document.getElementById('report-status');
const reportCopyBtn = document.getElementById('report-copy');
const reportDownloadBtn = document.getElementById('report-download');
const reportSubmitBtn = document.getElementById('report-submit');
const reportResultEl = document.getElementById('report-result');

const REPORT_GROUPS_KEY = 'report.groups';
let reportSummary = '';
let reportFileName = 'report.txt';

function localDate(daysAgo = 0) {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function setReportStatus(text, isError = false) {
  reportStatusEl.textContent = text;
  reportStatusEl.classList.toggle('error', isError);
}

function savedReportGroups() {
  try {
    const saved = JSON.parse(localStorage.getItem(REPORT_GROUPS_KEY));
    if (Array.isArray(saved)) return new Set(saved);
  } catch {
    // nothing saved yet, or unreadable — fall back to every project
  }
  return new Set(groups.map((g) => g.name));
}

function checkedReportGroups() {
  return [...reportGroupsEl.querySelectorAll('input:checked')].map((el) => el.value);
}

function renderReportGroups() {
  const selected = savedReportGroups();
  reportGroupsEl.replaceChildren();
  for (const g of groups) {
    const label = document.createElement('label');
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.value = g.name;
    box.checked = selected.has(g.name);
    label.appendChild(box);
    label.appendChild(document.createTextNode(g.name));
    reportGroupsEl.appendChild(label);
  }
}

function openReportPanel() {
  if (!reportFromEl.value) reportFromEl.value = localDate(0);
  if (!reportToEl.value) reportToEl.value = localDate(0);
  renderReportGroups();
  reportOverlayEl.hidden = false;
}

function closeReportPanel() {
  reportOverlayEl.hidden = true;
}

reportCloseBtn.addEventListener('click', closeReportPanel);
reportOverlayEl.addEventListener('mousedown', (e) => {
  if (e.target === reportOverlayEl) closeReportPanel();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !reportOverlayEl.hidden) closeReportPanel();
});

for (const btn of reportFormEl.querySelectorAll('.report-presets button')) {
  btn.addEventListener('click', () => {
    const days = Number(btn.dataset.days);
    // "Yesterday" is that one day; "7 days" runs up to and including today.
    reportFromEl.value = localDate(days);
    reportToEl.value = days === 1 ? localDate(1) : localDate(0);
  });
}

reportToggleAllBtn.addEventListener('click', () => {
  const boxes = [...reportGroupsEl.querySelectorAll('input')];
  const check = boxes.some((b) => !b.checked);
  for (const b of boxes) b.checked = check;
});

reportCopyBtn.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(reportSummary);
    setReportStatus('Copied.');
  } catch (err) {
    setReportStatus(String(err.message || err), true);
  }
});

// Saved as plain text: the bold day lines lose their asterisks, the rest of the
// markdown (headings, dashes) reads fine as it is.
reportDownloadBtn.addEventListener('click', () => {
  const blob = new Blob([reportSummary.replace(/\*\*/g, '') + '\n'], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = reportFileName;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

reportFormEl.addEventListener('submit', async (e) => {
  e.preventDefault();
  const selected = checkedReportGroups();
  if (!selected.length) {
    setReportStatus('Pick at least one project.', true);
    return;
  }
  localStorage.setItem(REPORT_GROUPS_KEY, JSON.stringify(selected));

  reportSubmitBtn.disabled = true;
  reportCopyBtn.hidden = true;
  reportDownloadBtn.hidden = true;
  reportResultEl.hidden = true;
  setReportStatus('Asking Claude… this takes a minute on a busy week.');
  try {
    const res = await postJSON('/report', {
      groups: selected,
      date_from: reportFromEl.value,
      date_to: reportToEl.value,
      tz_offset_minutes: -new Date().getTimezoneOffset(),
    });
    if (!res.messages) {
      setReportStatus('No chat activity in those projects on those days.');
      return;
    }
    reportSummary = res.summary;
    reportResultEl.innerHTML = renderMarkdown(res.summary);
    reportResultEl.hidden = false;
    reportCopyBtn.hidden = false;
    reportDownloadBtn.hidden = false;
    reportFileName =
      reportFromEl.value === reportToEl.value
        ? `report_${reportFromEl.value}.txt`
        : `report_${reportFromEl.value}_${reportToEl.value}.txt`;
    setReportStatus(`${res.messages} message(s) across ${res.projects.length} project(s).`);
  } catch (err) {
    let detail = String(err.message || err);
    try {
      detail = JSON.parse(detail).detail || detail;
    } catch {
      // not a JSON error body
    }
    setReportStatus(detail, true);
  } finally {
    reportSubmitBtn.disabled = false;
  }
});
