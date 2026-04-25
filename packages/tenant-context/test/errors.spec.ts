import { describe, it, expect } from 'vitest';
import {
  TenantContextError,
  TenantContextMissingError,
  TenantNotFoundError,
  TenantStatusError,
  TenantValidationError,
} from '../src/errors.js';

describe('TenantContextError', () => {
  it('is an instance of Error', () => {
    const err = new TenantContextError('CONTEXT_MISSING', 'boom');
    expect(err).toBeInstanceOf(Error);
  });

  it('exposes the supplied code on a constructed instance', () => {
    const err = new TenantContextError('CONTEXT_MISSING', 'something missing');
    expect(err.code).toBe('CONTEXT_MISSING');
    expect(err.message).toBe('something missing');
    expect(err.name).toBe('TenantContextError');
  });
});

describe('TenantContextMissingError', () => {
  it('extends TenantContextError, sets default name and message', () => {
    const err = new TenantContextMissingError();
    expect(err).toBeInstanceOf(TenantContextError);
    expect(err.name).toBe('TenantContextMissingError');
    expect(err.message).toBe('Tenant context required but not set');
    expect(err.code).toBe('CONTEXT_MISSING');
  });

  it('accepts a custom message', () => {
    const err = new TenantContextMissingError('please set me');
    expect(err.message).toBe('please set me');
    expect(err.name).toBe('TenantContextMissingError');
  });
});

describe('TenantNotFoundError', () => {
  it('defaults the kind discriminator to id', () => {
    const err = new TenantNotFoundError('tenant-123');
    expect(err.kind).toBe('id');
    expect(err.identifier).toBe('tenant-123');
    expect(err.message).toContain('id=tenant-123');
  });

  it('accepts kind=external_id explicitly', () => {
    const err = new TenantNotFoundError('acme', 'external_id');
    expect(err.kind).toBe('external_id');
    expect(err.identifier).toBe('acme');
    expect(err.message).toContain('external_id=acme');
  });

  it('exposes identifier and kind as readable instance fields', () => {
    const err = new TenantNotFoundError('xyz', 'external_id');
    expect(err).toMatchObject({ identifier: 'xyz', kind: 'external_id' });
    expect(err.code).toBe('TENANT_NOT_FOUND');
  });
});

describe('TenantStatusError', () => {
  it('exposes tenantId, currentStatus, and expectedStatuses', () => {
    const err = new TenantStatusError('tid', 'TERMINATED', ['ACTIVE', 'SUSPENDED']);
    expect(err.tenantId).toBe('tid');
    expect(err.currentStatus).toBe('TERMINATED');
    expect(err.expectedStatuses).toEqual(['ACTIVE', 'SUSPENDED']);
    expect(err.code).toBe('TENANT_STATUS');
    expect(err.message).toContain('TERMINATED');
    expect(err.message).toContain('ACTIVE, SUSPENDED');
  });
});

describe('TenantValidationError', () => {
  it('preserves cause via the super(message, options) pattern', () => {
    const cause = new Error('underlying');
    const err = new TenantValidationError('bad input', { cause });
    expect(err.cause).toBe(cause);
    expect(err.code).toBe('VALIDATION');
    expect(err.name).toBe('TenantValidationError');
  });

  it('has cause undefined when not supplied', () => {
    const err = new TenantValidationError('bad input');
    expect(err.cause).toBeUndefined();
  });
});

describe('subclass identity', () => {
  it('every subclass passes instanceof TenantContextError', () => {
    expect(new TenantContextMissingError()).toBeInstanceOf(TenantContextError);
    expect(new TenantNotFoundError('x')).toBeInstanceOf(TenantContextError);
    expect(new TenantStatusError('x', 'ACTIVE', [])).toBeInstanceOf(TenantContextError);
    expect(new TenantValidationError('x')).toBeInstanceOf(TenantContextError);
  });

  it('every subclass sets its own name (not the base class name)', () => {
    expect(new TenantContextMissingError().name).toBe('TenantContextMissingError');
    expect(new TenantNotFoundError('x').name).toBe('TenantNotFoundError');
    expect(new TenantStatusError('x', 'ACTIVE', []).name).toBe('TenantStatusError');
    expect(new TenantValidationError('x').name).toBe('TenantValidationError');
  });
});
