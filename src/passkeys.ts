import { startAuthentication, startRegistration, browserSupportsWebAuthn,
  type PublicKeyCredentialCreationOptionsJSON, type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON, type AuthenticationResponseJSON } from '@simplewebauthn/browser';

declare global {
  interface Window {
    CodexPasskeys?: {
      postMessage: (message: string) => void;
      onmessage: ((event: MessageEvent<string>) => void) | null;
    };
  }
}

export const supportsPasskeys = (nativeOnly: boolean) => Boolean(window.CodexPasskeys) || (!nativeOnly && browserSupportsWebAuthn());

function nativeCredential<T>(operation: string, options: unknown): Promise<T> {
  const bridge = window.CodexPasskeys!;
  const id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    bridge.onmessage = event => {
      const result = JSON.parse(event.data) as { id: string; credential: T; error?: string; type?: string };
      if (result.id !== id) return;
      bridge.onmessage = null;
      if (result.error) {
        const error = new Error(result.error);
        error.name = result.type || 'CredentialError';
        if (result.type?.includes('Cancellation')) error.message = '设备验证已取消。';
        if (result.type?.includes('NoCredential')) error.message = '设备中没有可用的通行密钥。请先通过访问密码登录并添加通行密钥。';
        reject(error);
      } else resolve(result.credential);
    };
    bridge.postMessage(JSON.stringify({ id, operation, options }));
  });
}

export function createPasskey(optionsJSON: PublicKeyCredentialCreationOptionsJSON) {
  return window.CodexPasskeys
    ? nativeCredential<RegistrationResponseJSON>('register', optionsJSON)
    : startRegistration({ optionsJSON });
}

export function usePasskey(optionsJSON: PublicKeyCredentialRequestOptionsJSON) {
  return window.CodexPasskeys
    ? nativeCredential<AuthenticationResponseJSON>('authenticate', optionsJSON)
    : startAuthentication({ optionsJSON });
}
