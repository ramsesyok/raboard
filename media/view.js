(function () {
  const vscode = acquireVsCodeApi();

  const timeline = document.querySelector('#timeline');

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
    body.textContent = message.text;

    item.append(header, body);
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
    }
  });
})();
