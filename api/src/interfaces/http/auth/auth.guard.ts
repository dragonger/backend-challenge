import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';

import {
  PROVIDER_IDENTITY,
  type ProviderIdentity,
  type ProviderIdentityPort,
} from '../../../application/ports/provider-identity.port.js';
import { IS_PUBLIC_KEY } from './public.decorator.js';

/** Request enriched with the authenticated identity (for later stages). */
export type AuthenticatedRequest = Request & { providerIdentity?: ProviderIdentity };

/**
 * Global guard. Routes marked @Public() (health, metrics) skip it. Everything
 * else asks the ProviderIdentityPort; the default port accepts everyone, so
 * today this guard changes nothing. Swapping the port (see
 * provider-identity.port.ts) turns authentication on without touching routes.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(PROVIDER_IDENTITY) private readonly identity: ProviderIdentityPort,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean | undefined>(
      IS_PUBLIC_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const identity = await this.identity.authenticate({
      method: request.method,
      path: request.path,
      headers: request.headers,
    });

    if (!identity) {
      throw new UnauthorizedException();
    }

    request.providerIdentity = identity;

    return true;
  }
}
