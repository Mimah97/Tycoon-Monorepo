import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { LoggerService } from '../logger/logger.service';

const REDACTED = '[REDACTED]';

// Header names whose values must never reach logs or telemetry labels.
const SENSITIVE_HEADERS = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'api-key',
  'x-auth-token',
  'x-access-token',
  'x-refresh-token',
  'x-shop-api-key',
]);

// Query params that may carry secrets (e.g. rotated API keys).
const SENSITIVE_QUERY_PARAMS = new Set([
  'api_key',
  'apikey',
  'api-key',
  'token',
  'access_token',
  'refresh_token',
  'key',
  'secret',
]);

// Matches bearer tokens, api-key style tokens, and long opaque secrets.
const SECRET_PATTERN =
  /(bearer\s+)[A-Za-z0-9._\-]+|((?:api[-_]?key|token|secret|password)["'\s:=]+)[A-Za-z0-9._\-]{6,}/gi;

function redactSecrets(value: string): string {
  return value.replace(SECRET_PATTERN, (_match, bearerPrefix, keyPrefix) => {
    if (bearerPrefix) {
      return `${bearerPrefix}${REDACTED}`;
    }
    return `${keyPrefix}${REDACTED}`;
  });
}

function redactUrl(rawUrl: unknown): string | undefined {
  if (typeof rawUrl !== 'string' || rawUrl.length === 0) {
    return undefined;
  }

  const [path, query] = rawUrl.split('?');
  if (!query) {
    return redactSecrets(path);
  }

  const redactedQuery = query
    .split('&')
    .map((pair) => {
      const [key] = pair.split('=');
      if (SENSITIVE_QUERY_PARAMS.has(key.toLowerCase())) {
        return `${key}=${REDACTED}`;
      }
      return pair;
    })
    .join('&');

  return redactSecrets(`${path}?${redactedQuery}`);
}

function redactHeaders(headers: Record<string, unknown>): Record<string, unknown> {
  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(headers ?? {})) {
    safe[key] = SENSITIVE_HEADERS.has(key.toLowerCase()) ? REDACTED : value;
  }
  return safe;
}

@Catch()
@Injectable()
export class AllExceptionsFilter implements ExceptionFilter {
  constructor(
    private readonly httpAdapterHost: HttpAdapterHost,
    private readonly logger: LoggerService,
  ) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const { httpAdapter } = this.httpAdapterHost;
    const ctx = host.switchToHttp();
    const request = ctx.getRequest();

    // Propagate the request id end-to-end so error responses and logs can be
    // correlated with the originating shop-api / proxy call.
    const requestId =
      request?.requestId ??
      request?.headers?.['x-request-id'] ??
      request?.headers?.['x-correlation-id'];

    let httpStatus = HttpStatus.INTERNAL_SERVER_ERROR;
    let message = 'Internal server error';
    let error: string | undefined;
    let stack: string | undefined;

    if (exception instanceof HttpException) {
      httpStatus = exception.getStatus();
      const response = exception.getResponse();

      if (typeof response === 'string') {
        message = response;
      } else {
        const responseObj = response as Record<string, unknown>;
        // ValidationPipe emits message as string[] — preserve the array so
        // callers receive all constraint violations, not just the first one.
        const raw = responseObj.message;
        message = Array.isArray(raw)
          ? (raw as string[]).join('; ')
          : (raw as string) || exception.message;
        error = responseObj.error as string | undefined;
      }
      stack = exception.stack;
    } else if (exception instanceof Error) {
      this.logger.error(
        `Unhandled Error: ${redactSecrets(exception.message)}`,
        exception.stack ? redactSecrets(exception.stack) : undefined,
        'AllExceptionsFilter',
      );

      message = exception.message || 'Internal server error';
      stack = exception.stack;

      // Handle common database errors
      const dbError = exception as unknown as Record<string, unknown>;
      if (dbError.code) {
        switch (dbError.code as string) {
          case '23505': // Duplicate key
            httpStatus = HttpStatus.CONFLICT;
            message = 'Duplicate entry';
            break;
          case '23503': // Foreign key violation
            httpStatus = HttpStatus.BAD_REQUEST;
            message = 'Referenced record does not exist';
            break;
          case '23502': // Not null violation
            httpStatus = HttpStatus.BAD_REQUEST;
            message = 'Required field is missing';
            break;
        }
      }
    } else {
      const exceptionStr =
        typeof exception === 'object' && exception !== null
          ? JSON.stringify(exception)
          : String(exception);

      this.logger.error(
        'Unknown exception occurred',
        redactSecrets(exceptionStr),
        'AllExceptionsFilter',
      );
    }

    // Log the error with context. Secrets are redacted and PII (raw IP) is
    // omitted from telemetry labels to keep logs safe for operators.
    const logContext = {
      requestId,
      statusCode: httpStatus,
      method: request.method,
      url: redactUrl(request.url),
      userAgent: request.headers?.['user-agent'],
      headers: redactHeaders(request.headers ?? {}),
      errorMessage: redactSecrets(message),
      error,
      stack: stack ? redactSecrets(stack) : undefined,
    };

    if (httpStatus >= 500) {
      this.logger.logWithMeta('error', 'Server Error', logContext);
    } else if (httpStatus >= 400) {
      this.logger.logWithMeta('warn', 'Client Error', logContext);
    }

    const responseBody: Record<string, unknown> = {
      statusCode: httpStatus,
      timestamp: new Date().toISOString(),
      path: redactUrl(httpAdapter.getRequestUrl(ctx.getRequest())),
      message,
      ...(requestId && { requestId }),
      ...(error && { error }),
    };

    httpAdapter.reply(ctx.getResponse(), responseBody, httpStatus);
  }
}
