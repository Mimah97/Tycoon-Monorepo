import { Test, TestingModule } from '@nestjs/testing';
import {
  ExecutionContext,
  BadRequestException,
  ConflictException,
  HttpStatus,
} from '@nestjs/common';
import { of, throwError } from 'rxjs';
import { Reflector } from '@nestjs/core';
import { IdempotencyInterceptor } from './idempotency.interceptor';
import { RedisService } from '../../modules/redis/redis.service';
import { IDEMPOTENT_KEY } from '../decorators/idempotent.decorator';

// ── helpers ──────────────────────────────────────────────────────────────────

const mockRedisService = {
  get: jest.fn(),
  set: jest.fn(),
  del: jest.fn(),
  incrementRateLimit: jest.fn(),
};

const buildContext = (
  overrides: {
    headers?: Record<string, string>;
    user?: { id: number } | null;
    statusCode?: number;
    isIdempotent?: boolean;
    body?: unknown;
  } = {},
): ExecutionContext => {
  const res = {
    statusCode: overrides.statusCode ?? HttpStatus.CREATED,
    status: jest.fn().mockReturnThis(),
  };
  const ctx = {
    getHandler: jest.fn().mockReturnValue('handler'),
    switchToHttp: jest.fn().mockReturnValue({
      getRequest: jest.fn().mockReturnValue({
        headers: overrides.headers ?? {},
        user: overrides.user !== undefined ? overrides.user : { id: 1 },
        body: overrides.body ?? {},
      }),
      getResponse: jest.fn().mockReturnValue(res),
    }),
  } as unknown as ExecutionContext;
  return ctx;
};

// ── suite ─────────────────────────────────────────────────────────────────────

describe('IdempotencyInterceptor (common)', () => {
  let interceptor: IdempotencyInterceptor;
  let reflector: Reflector;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        IdempotencyInterceptor,
        { provide: RedisService, useValue: mockRedisService },
        Reflector,
      ],
    }).compile();

    interceptor = module.get<IdempotencyInterceptor>(IdempotencyInterceptor);
    reflector = module.get<Reflector>(Reflector);
  });

  it('should be defined', () => {
    expect(interceptor).toBeDefined();
  });

  // ── non-idempotent routes ─────────────────────────────────────────────────

  describe('non-idempotent routes', () => {
    it('passes through when route is not marked @Idempotent()', async () => {
      jest.spyOn(reflector, 'get').mockReturnValue(false);
      const ctx = buildContext({ isIdempotent: false });
      const next = { handle: jest.fn().mockReturnValue(of({ id: 1 })) };

      await interceptor.intercept(ctx, next as any);

      expect(next.handle).toHaveBeenCalled();
      expect(mockRedisService.get).not.toHaveBeenCalled();
    });
  });

  // ── missing header ────────────────────────────────────────────────────────

  describe('missing x-idempotency-key header', () => {
    it('throws 400 when header is absent', async () => {
      jest.spyOn(reflector, 'get').mockReturnValue(true);
      const ctx = buildContext({ headers: {} });
      const next = { handle: jest.fn().mockReturnValue(of({})) };

      await expect(interceptor.intercept(ctx, next as any)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('error message mentions X-Idempotency-Key', async () => {
      jest.spyOn(reflector, 'get').mockReturnValue(true);
      const ctx = buildContext({ headers: {} });
      const next = { handle: jest.fn().mockReturnValue(of({})) };

      await expect(interceptor.intercept(ctx, next as any)).rejects.toThrow(
        'X-Idempotency-Key header is required',
      );
    });
  });

  // ── replay — cached response ──────────────────────────────────────────────

  describe('replay — cached response', () => {
    it('returns cached response when idempotency key already exists', async () => {
      jest.spyOn(reflector, 'get').mockReturnValue(true);
      const ctx = buildContext({
        headers: { 'x-idempotency-key': 'test-key-123' },
      });
      const next = { handle: jest.fn() };

      mockRedisService.get.mockResolvedValue({
        statusCode: HttpStatus.CREATED,
        body: { id: 42, code: 'CACHED' },
      });

      const result$ = await interceptor.intercept(ctx, next as any);
      const result = await new Promise((resolve) =>
        result$.subscribe((v) => resolve(v)),
      );

      expect(result).toEqual({ id: 42, code: 'CACHED' });
      expect(next.handle).not.toHaveBeenCalled();
    });

    it('does not call the handler on replay', async () => {
      jest.spyOn(reflector, 'get').mockReturnValue(true);
      const ctx = buildContext({
        headers: { 'x-idempotency-key': 'replay-key' },
      });
      const next = { handle: jest.fn() };

      mockRedisService.get.mockResolvedValue({
        statusCode: HttpStatus.OK,
        body: { replayed: true },
      });

      await interceptor.intercept(ctx, next as any);
      expect(next.handle).not.toHaveBeenCalled();
    });

    it('replays a null body correctly', async () => {
      jest.spyOn(reflector, 'get').mockReturnValue(true);
      const ctx = buildContext({
        headers: { 'x-idempotency-key': 'null-key' },
      });
      const next = { handle: jest.fn() };

      mockRedisService.get.mockResolvedValue({
        statusCode: HttpStatus.NO_CONTENT,
        body: null,
      });

      const result$ = await interceptor.intercept(ctx, next as any);
      const result = await new Promise((resolve) =>
        result$.subscribe((v) => resolve(v)),
      );
      expect(result).toBeNull();
    });
  });

  // ── body hash conflict (ADR-003 purchase field translator) ────────────────

  describe('body hash conflict', () => {
    it('returns stored response on replay when body hash matches', async () => {
      jest.spyOn(reflector, 'get').mockReturnValue(true);
      const body = { sku: 'sku-1', quantity: 2, amountMinor: 500 };
      const ctx = buildContext({
        headers: { 'x-idempotency-key': 'hash-match-key' },
        body,
      });
      const next = { handle: jest.fn() };

      mockRedisService.get.mockResolvedValue({
        statusCode: HttpStatus.CREATED,
        body: { id: 7 },
        bodyHash: expect.any(String),
      });

      const result$ = await interceptor.intercept(ctx, next as any);
      const result = await new Promise((resolve) =>
        result$.subscribe((v) => resolve(v)),
      );

      expect(result).toEqual({ id: 7 });
      expect(next.handle).not.toHaveBeenCalled();
    });

    it('throws 409 when same key is replayed with a different payload', async () => {
      jest.spyOn(reflector, 'get').mockReturnValue(true);
      const ctx = buildContext({
        headers: { 'x-idempotency-key': 'conflict-key' },
        body: { sku: 'sku-1', quantity: 3, amountMinor: 900 },
      });
      const next = { handle: jest.fn() };

      mockRedisService.get.mockResolvedValue({
        statusCode: HttpStatus.CREATED,
        body: { id: 7 },
        bodyHash: 'stale-hash',
      });

      await expect(
        interceptor.intercept(ctx, next as any),
      ).rejects.toThrow(ConflictException);
      expect(next.handle).not.toHaveBeenCalled();
    });
  });

  // ── concurrent request lock ───────────────────────────────────────────────

  describe('concurrent request lock', () => {
    it('throws 400 when concurrent request with same key is in flight', async () => {
      jest.spyOn(reflector, 'get').mockReturnValue(true);
      const ctx = buildContext({
        headers: { 'x-idempotency-key': 'race-key' },
      });
      const next = { handle: jest.fn() };

      mockRedisService.get.mockResolvedValue(null);
      mockRedisService.incrementRateLimit.mockResolvedValue(2);

      await expect(interceptor.intercept(ctx, next as any)).rejects.toThrow(
        'A request with this idempotency key is already in progress',
      );
    });
  });

  // ── first request — cache and pass through ────────────────────────────────

  describe('first request', () => {
    it('caches and passes through on first request', async () => {
      jest.spyOn(reflector, 'get').mockReturnValue(true);
      const ctx = buildContext({
        headers: { 'x-idempotency-key': 'fresh-key' },
      });
      const body = { id: 99 };
      const next = { handle: jest.fn().mockReturnValue(of(body)) };

      mockRedisService.get.mockResolvedValue(null);
      mockRedisService.incrementRateLimit.mockResolvedValue(1);
      mockRedisService.set.mockResolvedValue(undefined);
      mockRedisService.del.mockResolvedValue(undefined);

      const result$ = await interceptor.intercept(ctx, next as any);
      const result = await new Promise((resolve) =>
        result$.subscribe((v) => resolve(v)),
      );

      expect(result).toEqual(body);
      expect(next.handle).toHaveBeenCalled();
    });

    it('stores response with 24-hour TTL', async () => {
      jest.spyOn(reflector, 'get').mockReturnValue(true);
      const ctx = buildContext({ headers: { 'x-idempotency-key': 'ttl-key' } });
      const next = { handle: jest.fn().mockReturnValue(of({ ok: true })) };

      mockRedisService.get.mockResolvedValue(null);
      mockRedisService.incrementRateLimit.mockResolvedValue(1);
      mockRedisService.set.mockResolvedValue(undefined);
      mockRedisService.del.mockResolvedValue(undefined);

      const result$ = await interceptor.intercept(ctx, next as any);
      await new Promise((resolve) =>
        result$.subscribe({ complete: resolve as any }),
      );

      expect(mockRedisService.set).toHaveBeenCalledWith(
        expect.stringContaining('idempotency:'),
        expect.objectContaining({ body: { ok: true } }),
        86400,
      );
    });

    it('scopes the Redis key to the authenticated user', async () => {
      jest.spyOn(reflector, 'get').mockReturnValue(true);
      const ctx = buildContext({
        headers: { 'x-idempotency-key': 'scoped-key' },
        user: { id: 4242 },
      });
      const next = { handle: jest.fn().mockReturnValue(of({ ok: true })) };

      mockRedisService.get.mockResolvedValue(null);
      mockRedisService.incrementRateLimit.mockResolvedValue(1);
      mockRedisService.set.mockResolvedValue(undefined);
      mockRedisService.del.mockResolvedValue(undefined);

      const result$ = await interceptor.intercept(ctx, next as any);
      await new Promise((resolve) =>
        result$.subscribe({ complete: resolve as any }),
      );

      expect(mockRedisService.get).toHaveBeenCalledWith(
        expect.stringContaining('4242'),
      );
    });

    it('releases the in-flight lock when the handler errors', async () => {
      jest.spyOn(reflector, 'get').mockReturnValue(true);
      const ctx = buildContext({
        headers: { 'x-idempotency-key': 'error-key' },
      });
      const next = {
        handle: jest.fn().mockReturnValue(throwError(() => new Error('boom'))),
      };

      mockRedisService.get.mockResolvedValue(null);
      mockRedisService.incrementRateLimit.mockResolvedValue(1);
      mockRedisService.del.mockResolvedValue(undefined);

      const result$ = await interceptor.intercept(ctx, next as any);
      await expect(
        new Promise((resolve, reject) =>
          result$.subscribe({ next: resolve, error: reject }),
        ),
      ).rejects.toThrow('boom');

      expect(mockRedisService.del).toHaveBeenCalled();
    });
  });
});
