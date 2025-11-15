(function () {
  const vscode = acquireVsCodeApi();

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
})();
