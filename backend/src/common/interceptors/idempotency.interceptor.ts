import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  BadRequestException,
  ConflictException,
  HttpStatus,
} from '@nestjs/common';
import { Observable, of } from 'rxjs';
import { tap } from 'rxjs/operators';
import { createHash } from 'crypto';
import { RedisService } from '../../modules/redis/redis.service';
import { Reflector } from '@nestjs/core';
import { IDEMPOTENT_KEY } from '../decorators/idempotent.decorator';

interface StoredIdempotentResponse {
  statusCode: number;
  body: any;
  bodyHash: string;
}

@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(
    private readonly redisService: RedisService,
    private readonly reflector: Reflector,
  ) {}

  async intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Promise<Observable<any>> {
    const isIdempotent = this.reflector.get<boolean>(
      IDEMPOTENT_KEY,
      context.getHandler(),
    );

    if (!isIdempotent) {
      return next.handle();
    }

    const request = context.switchToHttp().getRequest();
    const idempotencyKey =
      request.headers['idempotency-key'] ||
      request.headers['x-idempotency-key'];

    if (!idempotencyKey) {
      // If the decorator is present, we require the key
      throw new BadRequestException('Idempotency-Key header is required');
    }

    const userId = request.user?.id;
    const redisKey = `idempotency:${userId || 'anon'}:${idempotencyKey}`;

    // Hash the request body so replays with a different payload are rejected.
    const bodyHash = this.hashBody(request.body);

    // Check if we have a cached response
    const cachedResponse = (await this.redisService.get(
      redisKey,
    )) as StoredIdempotentResponse | null;
    if (cachedResponse) {
      if (cachedResponse.bodyHash && cachedResponse.bodyHash !== bodyHash) {
        throw new ConflictException(
          'Idempotency-Key was reused with a different request payload',
        );
      }
      const { statusCode, body } = cachedResponse;
      const response = context.switchToHttp().getResponse();
      response.status(statusCode);
      return of(body);
    }

    // Handle concurrent requests with the same key using a temporary lock
    const lockKey = `${redisKey}:lock`;
    const acquiredLock = await this.redisService.incrementRateLimit(
      lockKey,
      10,
    );
    if (acquiredLock > 1) {
      throw new ConflictException(
        'A request with this idempotency key is already in progress',
      );
    }

    return next.handle().pipe(
      tap(async (body) => {
        const response = context.switchToHttp().getResponse();
        const statusCode = response.statusCode || HttpStatus.OK;

        // Cache the response for 24 hours
        await this.redisService.set(
          redisKey,
          { statusCode, body, bodyHash },
          24 * 60 * 60,
        );
        await this.redisService.del(lockKey);
      }),
    );
  }

  private hashBody(body: unknown): string {
    const serialized = this.stableStringify(body ?? null);
    return createHash('sha256').update(serialized).digest('hex');
  }

  private stableStringify(value: unknown): string {
    if (value === null || typeof value !== 'object') {
      return JSON.stringify(value) ?? 'null';
    }
    if (Array.isArray(value)) {
      return `[${value.map((item) => this.stableStringify(item)).join(',')}]`;
    }
    const entries = Object.keys(value as Record<string, unknown>)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${this.stableStringify(
            (value as Record<string, unknown>)[key],
          )}`,
      );
    return `{${entries.join(',')}}`;
  }
}
