/**
 * Tests for the inline Cloud Tasks dispatch utility. Pure utility +
 * SDK-mock; no DB dependency. Verifies queue-path construction, taskId
 * format, payload encoding, and env-config behavior.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CloudTasksClient } from '@google-cloud/tasks';
import { __setClientForTesting, dispatchCloudTask } from '../src/cloud-tasks.js';

interface MockClient {
  createTask: ReturnType<typeof vi.fn>;
  queuePath: ReturnType<typeof vi.fn>;
  taskPath: ReturnType<typeof vi.fn>;
}

function createMockClient(): MockClient {
  return {
    createTask: vi.fn().mockResolvedValue([{ name: 'projects/x/tasks/y' }]),
    queuePath: vi
      .fn()
      .mockImplementation(
        (project: string, location: string, queue: string) =>
          `projects/${project}/locations/${location}/queues/${queue}`,
      ),
    taskPath: vi
      .fn()
      .mockImplementation(
        (project: string, location: string, queue: string, taskId: string) =>
          `projects/${project}/locations/${location}/queues/${queue}/tasks/${taskId}`,
      ),
  };
}

describe('dispatchCloudTask', () => {
  let mockClient: MockClient;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.GCP_PROJECT_ID = 'sevyn8-cortex-test';
    delete process.env.GCP_LOCATION;
    mockClient = createMockClient();
    __setClientForTesting(mockClient as unknown as CloudTasksClient);
  });

  afterEach(() => {
    __setClientForTesting(null);
    process.env = { ...originalEnv };
  });

  it('builds queue path with project + asia-south1 default location + queue name', async () => {
    await dispatchCloudTask({
      queueName: 'provisioning-queue',
      taskId: 'provisioning-abc-123',
      targetUrl: 'https://worker.example.com',
      payload: { tenantId: 'abc-123' },
    });

    expect(mockClient.queuePath).toHaveBeenCalledWith(
      'sevyn8-cortex-test',
      'asia-south1',
      'provisioning-queue',
    );
  });

  it('respects GCP_LOCATION env override', async () => {
    process.env.GCP_LOCATION = 'us-central1';
    await dispatchCloudTask({
      queueName: 'lifecycle-queue',
      taskId: 'suspend-tenant-1',
      targetUrl: 'https://worker.example.com',
      payload: {},
    });

    expect(mockClient.queuePath).toHaveBeenCalledWith(
      'sevyn8-cortex-test',
      'us-central1',
      'lifecycle-queue',
    );
  });

  it('builds taskId in canonical <verb>-<id> format', async () => {
    await dispatchCloudTask({
      queueName: 'provisioning-queue',
      taskId: 'provisioning-abc-123',
      targetUrl: 'https://worker.example.com',
      payload: {},
    });

    expect(mockClient.taskPath).toHaveBeenCalledWith(
      'sevyn8-cortex-test',
      'asia-south1',
      'provisioning-queue',
      'provisioning-abc-123',
    );
  });

  it('passes the queue path as createTask parent + builds the named task', async () => {
    await dispatchCloudTask({
      queueName: 'provisioning-queue',
      taskId: 'provisioning-abc-123',
      targetUrl: 'https://worker.example.com',
      payload: {},
    });

    expect(mockClient.createTask).toHaveBeenCalledOnce();
    const callArg = mockClient.createTask.mock.calls[0]?.[0] as {
      parent: string;
      task: { name: string; httpRequest: { url: string; httpMethod: string } };
    };
    expect(callArg.parent).toBe(
      'projects/sevyn8-cortex-test/locations/asia-south1/queues/provisioning-queue',
    );
    expect(callArg.task.name).toBe(
      'projects/sevyn8-cortex-test/locations/asia-south1/queues/provisioning-queue/tasks/provisioning-abc-123',
    );
    expect(callArg.task.httpRequest.url).toBe('https://worker.example.com');
    expect(callArg.task.httpRequest.httpMethod).toBe('POST');
  });

  it('base64-encodes the payload as JSON in the request body', async () => {
    await dispatchCloudTask({
      queueName: 'provisioning-queue',
      taskId: 'provisioning-abc-123',
      targetUrl: 'https://worker.example.com',
      payload: { tenantId: 'abc-123', actorType: 'service', actorId: 'cortex-tenant-lifecycle' },
    });

    const callArg = mockClient.createTask.mock.calls[0]?.[0] as {
      task: { httpRequest: { body: string } };
    };
    const decoded = JSON.parse(
      Buffer.from(callArg.task.httpRequest.body, 'base64').toString('utf8'),
    );
    expect(decoded).toEqual({
      tenantId: 'abc-123',
      actorType: 'service',
      actorId: 'cortex-tenant-lifecycle',
    });
  });

  it('throws when GCP_PROJECT_ID env is missing', async () => {
    delete process.env.GCP_PROJECT_ID;

    await expect(
      dispatchCloudTask({
        queueName: 'provisioning-queue',
        taskId: 'provisioning-abc-123',
        targetUrl: 'https://worker.example.com',
        payload: {},
      }),
    ).rejects.toThrow(/GCP_PROJECT_ID env required/);
  });

  it('throws when GCP_PROJECT_ID env is empty string', async () => {
    process.env.GCP_PROJECT_ID = '';

    await expect(
      dispatchCloudTask({
        queueName: 'provisioning-queue',
        taskId: 'provisioning-abc-123',
        targetUrl: 'https://worker.example.com',
        payload: {},
      }),
    ).rejects.toThrow(/GCP_PROJECT_ID env required/);
  });

  it('Content-Type header is application/json', async () => {
    await dispatchCloudTask({
      queueName: 'provisioning-queue',
      taskId: 'provisioning-abc-123',
      targetUrl: 'https://worker.example.com',
      payload: {},
    });

    const callArg = mockClient.createTask.mock.calls[0]?.[0] as {
      task: { httpRequest: { headers: Record<string, string> } };
    };
    expect(callArg.task.httpRequest.headers['Content-Type']).toBe('application/json');
  });

  // ─────────────────────────────────────────────────────────────────
  // F02 Slice C — scheduleTime extension
  // ─────────────────────────────────────────────────────────────────

  describe('scheduleTime', () => {
    it('omits scheduleTime from the task when not provided (existing behavior preserved)', async () => {
      await dispatchCloudTask({
        queueName: 'provisioning-queue',
        taskId: 'provisioning-abc-123',
        targetUrl: 'https://worker.example.com',
        payload: {},
      });

      const callArg = mockClient.createTask.mock.calls[0]?.[0] as {
        task: { scheduleTime?: unknown };
      };
      expect(callArg.task.scheduleTime).toBeUndefined();
    });

    it('threads scheduleTime through as Timestamp (seconds + nanos)', async () => {
      // 2026-05-15T12:34:56.789Z — fixed instant for deterministic assertions.
      const scheduleTime = new Date('2026-05-15T12:34:56.789Z');
      await dispatchCloudTask({
        queueName: 'lifecycle-queue',
        taskId: 'terminate-abc-123',
        targetUrl: 'https://worker.example.com',
        payload: { tenantId: 'abc-123' },
        scheduleTime,
      });

      const callArg = mockClient.createTask.mock.calls[0]?.[0] as {
        task: { scheduleTime: { seconds: number; nanos: number } };
      };
      const expectedSeconds = Math.floor(scheduleTime.getTime() / 1000);
      const expectedNanos = (scheduleTime.getTime() % 1000) * 1_000_000;
      expect(callArg.task.scheduleTime.seconds).toBe(expectedSeconds);
      expect(callArg.task.scheduleTime.nanos).toBe(expectedNanos);
    });

    it('preserves sub-second precision via the nanos field', async () => {
      // .123 ms suffix must round-trip as 123_000_000 nanos.
      const scheduleTime = new Date(1745308800000 + 123); // arbitrary epoch + 123 ms
      await dispatchCloudTask({
        queueName: 'lifecycle-queue',
        taskId: 'terminate-abc-123',
        targetUrl: 'https://worker.example.com',
        payload: {},
        scheduleTime,
      });

      const callArg = mockClient.createTask.mock.calls[0]?.[0] as {
        task: { scheduleTime: { nanos: number } };
      };
      expect(callArg.task.scheduleTime.nanos).toBe(123_000_000);
    });

    it('whole-second instant produces nanos=0', async () => {
      const scheduleTime = new Date('2026-05-15T12:34:56.000Z');
      await dispatchCloudTask({
        queueName: 'lifecycle-queue',
        taskId: 'terminate-abc-123',
        targetUrl: 'https://worker.example.com',
        payload: {},
        scheduleTime,
      });

      const callArg = mockClient.createTask.mock.calls[0]?.[0] as {
        task: { scheduleTime: { nanos: number } };
      };
      expect(callArg.task.scheduleTime.nanos).toBe(0);
    });

    it('past Date is accepted (server-side validation; client does not pre-reject)', async () => {
      const scheduleTime = new Date('2020-01-01T00:00:00Z');
      await expect(
        dispatchCloudTask({
          queueName: 'lifecycle-queue',
          taskId: 'terminate-abc-123',
          targetUrl: 'https://worker.example.com',
          payload: {},
          scheduleTime,
        }),
      ).resolves.not.toThrow();
    });
  });
});
