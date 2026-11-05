import type { CredentialKind, SshCredential } from "./desktop";

export function credentialFromForm(form: Record<string, string>): SshCredential | null {
  const kind = (form._authKind as CredentialKind) || "password";
  if (kind === "agent") return { kind };
  if (kind === "password") return form._password ? { kind, password: form._password } : null;
  // A pasted ssh config gives a path rather than the key itself; the main
  // process reads it at connect time.
  if (form._privateKeyPath) {
    return {
      kind,
      privateKeyPath: form._privateKeyPath,
      passphrase: form._passphrase || undefined,
    };
  }
  return form._privateKey
    ? { kind, privateKey: form._privateKey, passphrase: form._passphrase || undefined }
    : null;
}
