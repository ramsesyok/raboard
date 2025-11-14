(function () {
  const vscode = acquireVsCodeApi?.();

  const sendButton = document.querySelector('.composer-send');
  const input = document.querySelector('.composer-input');

  if (!sendButton || !input) {
    return;
  }

  sendButton.addEventListener('click', () => {
    const value = input.value.trim();
    if (!value) {
      return;
    }

    vscode?.postMessage({ type: 'draft-submitted', payload: value });
    input.value = '';
  });
})();
