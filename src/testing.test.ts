import { describe, expect, it } from 'vitest';
import { runContract } from './contract';
import { createMockCtx, createMockHarness } from './testing';

// The same scenarios the real platform host must pass.
runContract(createMockHarness, { describe, it });

describe('createMockCtx helpers', () => {
  const manifest = { permissions: ['credits.grant', 'store', 'routes', 'events:user.created'] };

  it('requires a manifest, so a plugin cannot pass tests with permissions it never declared', () => {
    expect(() => createMockCtx({} as any)).toThrow(/manifest/);
  });

  it('collects logs, including the error of a throwing event handler', async () => {
    const mock = createMockCtx({ manifest });
    mock.ctx.on('user.created', () => {
      throw new Error('boom');
    });
    mock.ctx.log.info('hello');
    await mock.emit('user.created', { userId: '1' });
    expect(mock.logs.info).toEqual(['[plugin:mock-plugin] hello']);
    expect(mock.logs.error[0]).toMatch(/\[plugin:mock-plugin\] user\.created handler failed: boom/);
  });

  it('records every grant so a test can assert on them', async () => {
    const mock = createMockCtx({ manifest });
    await mock.ctx.credits.grant('7', { key: 'a', credits: 5 });
    await mock.ctx.credits.grant('7', { key: 'a', credits: 5 });
    expect(mock.grants).toEqual([{ userId: '7', key: 'a', credits: 5 }]);
  });

  it('accepts any user id unless users are listed', async () => {
    const open = createMockCtx({ manifest });
    expect(await open.ctx.credits.grant('anyone', { key: 'k', credits: 1 })).toEqual({
      granted: true,
    });
    const closed = createMockCtx({ manifest, users: ['7'] });
    await expect(closed.ctx.credits.grant('anyone', { key: 'k', credits: 1 })).rejects.toThrow(
      /user/
    );
    expect((await closed.call('GET', '/x', { userId: 'anyone' })).status).toBe(404);
  });

  it('advance() moves the clock that ctx.now(), the store expiry and the daily budget use', () => {
    const mock = createMockCtx({ manifest, now: new Date('2026-10-10T00:00:00Z') });
    mock.advance(60 * 60 * 1000);
    expect(mock.ctx.now().toISOString()).toBe('2026-10-10T01:00:00.000Z');
  });

  it('exposes the config it was given', () => {
    expect(createMockCtx({ manifest, config: { bonus: 3 } }).ctx.config).toEqual({ bonus: 3 });
  });
});
