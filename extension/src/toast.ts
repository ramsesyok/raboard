import * as vscode from 'vscode';

const RETRY_LABEL = 'Retry';

type ToastLevel = 'info' | 'warning' | 'error';

export interface ToastOptions {
  readonly detail?: string;
  readonly onRetry?: () => void | Promise<void>;
}

function formatMessage(message: string, detail: string | undefined): string {
  if (!detail) {
    return message;
  }
  const trimmedDetail = detail.trim();
  if (!trimmedDetail) {
    return message;
  }
  return `${message}\n${trimmedDetail}`;
}

async function runRetry(handler: () => void | Promise<void>): Promise<void> {
  try {
    await handler();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    await showToast('error', 'Retry failed.', { detail });
  }
}

async function showToast(
  level: ToastLevel,
  message: string,
  options?: ToastOptions
): Promise<void> {
  const formatted = formatMessage(message, options?.detail);
  const items = options?.onRetry ? [RETRY_LABEL] : [];
  let selection: string | undefined;

  switch (level) {
    case 'info': {
      selection = await vscode.window.showInformationMessage(formatted, ...items);
      break;
    }
    case 'warning': {
      selection = await vscode.window.showWarningMessage(formatted, ...items);
      break;
    }
    case 'error':
    default: {
      selection = await vscode.window.showErrorMessage(formatted, ...items);
      break;
    }
  }

  if (selection === RETRY_LABEL && options?.onRetry) {
    await runRetry(options.onRetry);
  }
}

export async function showInfoToast(message: string, options?: ToastOptions): Promise<void> {
  await showToast('info', message, options);
}

export async function showWarningToast(message: string, options?: ToastOptions): Promise<void> {
  await showToast('warning', message, options);
}

export async function showErrorToast(message: string, options?: ToastOptions): Promise<void> {
  await showToast('error', message, options);
}
