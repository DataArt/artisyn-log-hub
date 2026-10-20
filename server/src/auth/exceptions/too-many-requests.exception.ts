import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * 429 with a Retry-After value carried in the response body as
 * `retryAfterSeconds` — HttpExceptionFilter reads that field and sets the
 * actual `Retry-After` response header (see http-exception.filter.ts).
 */
export class TooManyRequestsException extends HttpException {
  constructor(retryAfterSeconds: number) {
    super(
      { message: 'Too Many Requests', retryAfterSeconds },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}
