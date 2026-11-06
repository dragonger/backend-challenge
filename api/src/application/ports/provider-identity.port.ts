/**
 * Authentication extension point (README section 2: authentication is not
 * scored, so only the seam exists).
 *
 * To add real authentication, implement this port against an external
 * Identity Provider (Keycloak or Zitadel via OIDC: validate the bearer JWT
 * with the IdP JWKS and map its claims to a ProviderIdentity) and bind it to
 * PROVIDER_IDENTITY in HttpModule. The global AuthGuard needs no change; a
 * natural next step there is to require that body.providerId equals the
 * authenticated providerId. Domain and use cases never see HTTP or tokens.
 */
export interface ProviderIdentity {
  /** Stable subject of the caller (token `sub`, client id...). */
  subject: string;
  /** Game provider the caller acts for, when known. */
  providerId?: string;
}

export interface IdentityRequest {
  method: string;
  path: string;
  headers: Readonly<Record<string, string | string[] | undefined>>;
}

export interface ProviderIdentityPort {
  /** Returns the caller identity, or null when the request is not authenticated. */
  authenticate(request: IdentityRequest): Promise<ProviderIdentity | null>;
}

export const PROVIDER_IDENTITY = Symbol('PROVIDER_IDENTITY');
