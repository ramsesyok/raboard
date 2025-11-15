(function () {
  const vscode = acquireVsCodeApi();

  const timeline = document.querySelector('#timeline');
  const presence = document.querySelector('.presence');

  const ATTACHMENT_PATTERN = /(attachments[\\/][^\s"'`>]+?\.(?:png|jpe?g|svg))/gi;

  function setInlineImageMaxHeight(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric <= 0) {
      return;
    }
    const clamped = Math.max(1, Math.round(numeric));
    document.documentElement.style.setProperty(
      '--timeline-inline-image-max-height',
      `${clamped}px`
    );
  }

  function trimTrailingPunctuation(value) {
    let result = value;
    while (result.length > 0 && /[)>.,;:!?\]]$/.test(result[result.length - 1])) {
      result = result.slice(0, -1);
    }
    return result;
  }

  function normalizeAttachmentRelPath(raw) {
    if (typeof raw !== 'string') {
      return undefined;
    }

    let candidate = raw.trim();
    if (!candidate) {
      return undefined;
    }

    if (
      (candidate.startsWith('"') && candidate.endsWith('"')) ||
      (candidate.startsWith("'") && candidate.endsWith("'"))
    ) {
      candidate = candidate.slice(1, -1);
    }

    candidate = trimTrailingPunctuation(candidate);
    candidate = candidate.replace(/\\/g, '/');

    while (candidate.startsWith('./')) {
      candidate = candidate.slice(2);
    }

    if (candidate.startsWith('/')) {
      return undefined;
    }

    const lowered = candidate.toLowerCase();
    if (!lowered.startsWith('attachments/')) {
      return undefined;
    }

    const segments = candidate.split('/');
    const safeSegments = [];
    for (const segment of segments) {
      const trimmed = segment.trim();
      if (!trimmed) {
        continue;
      }
      if (trimmed === '.' || trimmed === '..') {
        return undefined;
      }
      safeSegments.push(trimmed);
    }

    if (safeSegments.length < 2) {
      return undefined;
    }

    safeSegments[0] = 'attachments';

    const fileName = safeSegments[safeSegments.length - 1];
    const dotIndex = fileName.lastIndexOf('.');
    if (dotIndex === -1) {
      return undefined;
    }

    const ext = fileName.slice(dotIndex).toLowerCase();
    if (!['.png', '.jpg', '.jpeg', '.svg'].includes(ext)) {
      return undefined;
    }

    return safeSegments.join('/');
  }

  function buildAttachmentMetaMap(message) {
    const map = new Map();
    if (!message || !Array.isArray(message.attachments)) {
      return map;
    }

    for (const attachment of message.attachments) {
      if (!attachment || typeof attachment.relPath !== 'string') {
        continue;
      }
      const normalized = normalizeAttachmentRelPath(attachment.relPath);
      if (!normalized) {
        continue;
      }

      map.set(normalized.toLowerCase(), {
        relPath: normalized,
        display: attachment.display === 'link' ? 'link' : 'inline',
        src: typeof attachment.src === 'string' ? attachment.src : undefined,
        href: typeof attachment.href === 'string' ? attachment.href : undefined,
      });
    }

    return map;
  }

  function extractAttachmentRelPaths(text) {
    const matches = [];
    if (typeof text !== 'string' || text.length === 0) {
      return matches;
    }

    const found = new Set();
    for (const match of text.matchAll(ATTACHMENT_PATTERN)) {
      const candidate = match[1] ?? match[0];
      const normalized = normalizeAttachmentRelPath(candidate);
      if (!normalized) {
        continue;
      }
      const key = normalized.toLowerCase();
      if (found.has(key)) {
        continue;
      }
      found.add(key);
      matches.push(normalized);
    }

    return matches;
  }

  function gatherAttachmentEntries(message) {
    const metaMap = buildAttachmentMetaMap(message);
    const entries = [];
    const seen = new Set();

    for (const relPath of extractAttachmentRelPaths(message?.text ?? '')) {
      const key = relPath.toLowerCase();
      if (seen.has(key)) {
        continue;
      }
      const meta = metaMap.get(key);
      entries.push({ relPath: meta?.relPath ?? relPath, meta });
      seen.add(key);
    }

    for (const [key, meta] of metaMap.entries()) {
      if (seen.has(key)) {
        continue;
      }
      entries.push({ relPath: meta.relPath, meta });
      seen.add(key);
    }

    return entries;
  }

  function createAttachmentList(message) {
    const entries = gatherAttachmentEntries(message);
    if (entries.length === 0) {
      return undefined;
    }

    const container = document.createElement('div');
    container.className = 'timeline-attachments';

    for (const entry of entries) {
      const meta = entry.meta;
      const attachment = document.createElement('div');
      attachment.className = 'timeline-attachment';

      const href = meta && typeof meta.href === 'string' ? meta.href : undefined;
      const showInline = !!meta && meta.display === 'inline' && typeof meta.src === 'string';

      if (showInline) {
        const img = document.createElement('img');
        img.className = 'timeline-attachment__image';
        img.alt = meta.relPath;
        img.src = meta.src;
        img.loading = 'lazy';
        attachment.append(img);
      }

      const link = document.createElement('a');
      link.className = 'timeline-attachment__link';
      link.textContent = (meta && meta.relPath) || entry.relPath;
      if (href) {
        link.href = href;
        link.target = '_blank';
        link.rel = 'noreferrer noopener';
      } else {
        link.href = '#';
        link.addEventListener('click', (event) => {
          event.preventDefault();
        });
      }

      attachment.append(link);
      container.append(attachment);
    }

    return container;
  }

  function renderPresence(users) {
    if (!(presence instanceof HTMLElement)) {
      return;
    }

    presence.innerHTML = '';

    const list = Array.isArray(users)
      ? users.filter((user) => typeof user === 'string' && user.trim().length > 0)
      : [];

    if (list.length === 0) {
      const pill = document.createElement('span');
      pill.className = 'presence-pill';
      pill.textContent = 'No active users';
      presence.append(pill);
      return;
    }

    for (const user of list) {
      const pill = document.createElement('span');
      pill.className = 'presence-pill';
      pill.textContent = user;
      presence.append(pill);
    }
  }

  renderPresence([]);

  function removePlaceholder() {
    if (!(timeline instanceof HTMLElement)) {
      return;
    }
    const placeholder = timeline.querySelector('.timeline-placeholder');
    if (placeholder) {
      placeholder.remove();
    }
  }

  function showPlaceholder() {
    if (!(timeline instanceof HTMLElement)) {
      return;
    }
    const placeholder = document.createElement('p');
    placeholder.className = 'timeline-placeholder';
    placeholder.textContent = 'Timeline will appear here.';
    timeline.append(placeholder);
  }

  function appendMessage(message) {
    if (!(timeline instanceof HTMLElement)) {
      return;
    }

    removePlaceholder();

    const item = document.createElement('article');
    item.className = 'timeline-item';

    const header = document.createElement('header');
    header.className = 'timeline-item__header';

    const author = document.createElement('span');
    author.className = 'timeline-item__from';
    author.textContent = message.from;

    const timestamp = document.createElement('time');
    timestamp.className = 'timeline-item__timestamp';
    timestamp.dateTime = message.ts;
    const postedAt = new Date(message.ts);
    timestamp.textContent = Number.isNaN(postedAt.getTime())
      ? message.ts
      : postedAt.toLocaleString();

    header.append(author, timestamp);

    const body = document.createElement('p');
    body.className = 'timeline-item__text';
    body.textContent = typeof message.text === 'string' ? message.text : '';

    item.append(header, body);

    const attachments = createAttachmentList(message);
    if (attachments) {
      item.append(attachments);
    }
    timeline.append(item);
    item.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }

  function resetTimeline(messages) {
    if (!(timeline instanceof HTMLElement)) {
      return;
    }

    timeline.innerHTML = '';
    if (!Array.isArray(messages) || messages.length === 0) {
      showPlaceholder();
      return;
    }

    messages.forEach((message) => {
      appendMessage(message);
    });
  }

  const roomForm = document.querySelector('#room-form');
  const roomInput = document.querySelector('#room-input');
  if (roomForm && roomInput instanceof HTMLInputElement) {
    roomForm.addEventListener('submit', (event) => {
      event.preventDefault();
      const room = roomInput.value.trim();
      if (room) {
        vscode.postMessage({ type: 'switch-room', room });
      }
    });
  }

  const attachmentsButton = document.querySelector('#open-attachments');
  if (attachmentsButton instanceof HTMLButtonElement) {
    attachmentsButton.addEventListener('click', () => {
      vscode.postMessage({ type: 'open-attachments-dir' });
    });
  }

  const messageForm = document.querySelector('#message-form');
  const messageInput = document.querySelector('#message-input');
  if (messageForm && messageInput instanceof HTMLInputElement) {
    messageForm.addEventListener('submit', (event) => {
      event.preventDefault();
      const text = messageInput.value.trim();
      if (text) {
        vscode.postMessage({ type: 'send', text });
        messageInput.value = '';
      }
      messageInput.focus();
    });
  }

  window.addEventListener('message', (event) => {
    const data = event.data;
    if (!data) {
      return;
    }

    if (data.type === 'config') {
      setInlineImageMaxHeight(data.maxInlinePx);
      return;
    }

    if (data.type === 'reset') {
      resetTimeline(data.messages);
      return;
    }

    if (data.type === 'messages' && Array.isArray(data.append)) {
      data.append.forEach((message) => {
        appendMessage(message);
      });
      return;
    }

    if (data.type === 'send' && data.message) {
      appendMessage(data.message);
      return;
    }

    if (data.type === 'presence') {
      renderPresence(data.users);
      return;
    }
  });
})();
