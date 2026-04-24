export type SecretsErrorCode =
  | 'VALIDATION'
  | 'CONFIG'
  | 'NOT_FOUND'
  | 'PERMISSION_DENIED'
  | 'ENVELOPE_ENCRYPT_FAILED'
  | 'ENVELOPE_DECRYPT_FAILED'
  | 'KMS_UNAVAILABLE';

export class SecretsError extends Error {
  readonly code: SecretsErrorCode;

  constructor(code: SecretsErrorCode, message: string, options?: { cause?: Error }) {
    super(message, options);
    this.code = code;
    this.name = 'SecretsError';
  }
}

export class SecretsValidationError extends SecretsError {
  constructor(message: string, options?: { cause?: Error }) {
    super('VALIDATION', message, options);
    this.name = 'SecretsValidationError';
  }
}

export class ConfigError extends SecretsError {
  constructor(message: string, options?: { cause?: Error }) {
    super('CONFIG', message, options);
    this.name = 'ConfigError';
  }
}

export class SecretNotFoundError extends SecretsError {
  constructor(message: string, options?: { cause?: Error }) {
    super('NOT_FOUND', message, options);
    this.name = 'SecretNotFoundError';
  }
}

export class PermissionDeniedError extends SecretsError {
  constructor(message: string, options?: { cause?: Error }) {
    super('PERMISSION_DENIED', message, options);
    this.name = 'PermissionDeniedError';
  }
}

export class EnvelopeEncryptError extends SecretsError {
  constructor(message: string, options?: { cause?: Error }) {
    super('ENVELOPE_ENCRYPT_FAILED', message, options);
    this.name = 'EnvelopeEncryptError';
  }
}

export class EnvelopeDecryptError extends SecretsError {
  constructor(message: string, options?: { cause?: Error }) {
    super('ENVELOPE_DECRYPT_FAILED', message, options);
    this.name = 'EnvelopeDecryptError';
  }
}

export class KmsUnavailableError extends SecretsError {
  constructor(message: string, options?: { cause?: Error }) {
    super('KMS_UNAVAILABLE', message, options);
    this.name = 'KmsUnavailableError';
  }
}
